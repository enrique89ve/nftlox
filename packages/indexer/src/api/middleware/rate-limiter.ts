// NOTE: In-memory rate limiter — not shared across instances.
// For multi-node deployments, replace with Redis-backed or PostgreSQL-backed rate limiting.

const MAX_REQUESTS_PER_WINDOW = 1000;
const WINDOW_MS = 60_000; // 1 minute
const CLEANUP_INTERVAL_MS = 300_000; // 5 minutes

interface BucketEntry {
	count: number;
	resetAt: number;
}

const buckets = new Map<string, BucketEntry>();

const cleanupTimer = setInterval(() => {
	const now = Date.now();
	for (const [key, entry] of buckets) {
		if (now >= entry.resetAt) {
			buckets.delete(key);
		}
	}
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

/**
 * Checks rate limit for a request. Returns 429 response data if exceeded, undefined otherwise.
 * Sets X-RateLimit-* headers on the response.
 *
 * @param socketIp — The actual TCP connection IP from the server (cannot be spoofed).
 *                   Pass this when running behind a reverse proxy to prevent header spoofing.
 */
export function checkRateLimit(
	request: Request,
	headers: Record<string, string | number>,
	socketIp?: string,
): { error: string; retryAfterSec: number } | undefined {
	const ip = extractIp(request, socketIp);
	const now = Date.now();

	let bucket = buckets.get(ip);
	if (!bucket || now >= bucket.resetAt) {
		bucket = { count: 0, resetAt: now + WINDOW_MS };
		buckets.set(ip, bucket);
	}

	bucket.count++;

	const remaining = Math.max(0, MAX_REQUESTS_PER_WINDOW - bucket.count);
	const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);

	headers["X-RateLimit-Limit"] = String(MAX_REQUESTS_PER_WINDOW);
	headers["X-RateLimit-Remaining"] = String(remaining);
	headers["X-RateLimit-Reset"] = String(bucket.resetAt);

	if (bucket.count > MAX_REQUESTS_PER_WINDOW) {
		headers["Retry-After"] = String(retryAfterSec);
		return { error: "Too many requests", retryAfterSec };
	}
}

/**
 * Extracts the real client IP from proxy headers, with socket IP as safe fallback.
 * Priority: CF-Connecting-IP > X-Real-IP > X-Forwarded-For > Socket IP
 *
 * IMPORTANT: Proxy headers (cf-connecting-ip, x-real-ip, x-forwarded-for) are
 * only trustworthy when running behind a reverse proxy (nginx, Cloudflare) that
 * overwrites them. Without a proxy, clients can spoof these headers to bypass
 * rate limiting. The socketIp fallback uses the actual TCP connection address.
 */
function extractIp(request: Request, socketIp?: string): string {
	return request.headers.get("cf-connecting-ip")
		?? request.headers.get("x-real-ip")
		?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
		?? socketIp
		?? "unknown";
}
