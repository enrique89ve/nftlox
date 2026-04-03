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

const PRIVATE_IP_PREFIXES = ["10.", "172.16.", "172.17.", "172.18.", "172.19.", "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.", "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.", "192.168.", "127.", "::1", "::ffff:127."];

function isPrivateIp(ip: string): boolean {
	return PRIVATE_IP_PREFIXES.some(prefix => ip.startsWith(prefix));
}

/**
 * Extracts the real client IP.
 *
 * When socketIp is a private/loopback address, a reverse proxy is in front —
 * trust proxy headers (CF-Connecting-IP > X-Real-IP > X-Forwarded-For).
 *
 * When socketIp is public, the client connects directly — use socketIp
 * (proxy headers are spoofable and MUST be ignored).
 */
function extractIp(request: Request, socketIp?: string): string {
	if (socketIp && !isPrivateIp(socketIp)) {
		return socketIp;
	}

	return request.headers.get("cf-connecting-ip")
		?? request.headers.get("x-real-ip")
		?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
		?? socketIp
		?? "unknown";
}
