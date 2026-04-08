/**
 * Per-account rate limiter for multisig requests.
 * Uses closures instead of classes — state lives in the factory's scope.
 */

const CLEANUP_INTERVAL_MS = 300_000; // 5 minutes

export type RateLimitResult =
	| { readonly allowed: true }
	| { readonly allowed: false; readonly retryAfterMs: number };

export function createMultisigRateLimiter(
	maxRequests: number,
	windowMs: number,
): {
	readonly check: (account: string) => RateLimitResult;
	readonly destroy: () => void;
} {
	const buckets = new Map<string, number[]>();

	const cleanupTimer = setInterval(() => {
		const now = Date.now();
		for (const [account, timestamps] of buckets) {
			const valid = timestamps.filter(t => t <= now && now - t < windowMs);
			if (valid.length === 0) {
				buckets.delete(account);
			} else {
				buckets.set(account, valid);
			}
		}
	}, CLEANUP_INTERVAL_MS);
	cleanupTimer.unref();

	const check = (account: string): RateLimitResult => {
		const now = Date.now();
		const timestamps = buckets.get(account) ?? [];
		const valid = timestamps.filter(t => t <= now && now - t < windowMs);

		if (valid.length >= maxRequests) {
			const oldest = valid[0]!;
			const retryAfterMs = oldest + windowMs - now;
			buckets.set(account, valid);
			return { allowed: false, retryAfterMs };
		}

		valid.push(now);
		buckets.set(account, valid);
		return { allowed: true };
	};

	const destroy = (): void => {
		clearInterval(cleanupTimer);
		buckets.clear();
	};

	return { check, destroy } as const;
}
