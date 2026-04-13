// Endpoint health tracking with circuit breaker, latency-based selection,
// and 429 rate-limit awareness. Pure state module — no I/O, no project imports.

// ============ TYPES ============

export type CircuitState = "closed" | "open" | "half_open";
export type ErrorCategory = "transient" | "rate_limited" | "client_error" | "unknown";

export interface EndpointHealthSnapshot {
	readonly endpoint: string;
	readonly state: CircuitState;
	readonly consecutiveFailures: number;
	readonly cooldownMs: number;
	readonly openUntil: number;
	readonly rateLimitedUntil: number;
	readonly avgLatencyMs: number;
}

export interface EndpointHealthPool {
	readonly init: (urls: readonly string[]) => void;
	readonly selectEndpoint: () => string;
	readonly recordSuccess: (endpoint: string, latencyMs: number) => void;
	readonly recordFailure: (endpoint: string, category: ErrorCategory, retryAfterMs?: number) => void;
	readonly getHealthSnapshot: () => readonly EndpointHealthSnapshot[];
	readonly reset: () => void;
}

// ============ CONSTANTS ============

// Circuit opens after this many consecutive failures.
// Set to 8 so intermittent WSL/network socket resets don't open the circuit
// within a single failover cycle (6 attempts across 3 endpoints).
// A truly dead endpoint will still open reliably across 2+ cycles.
export const OPEN_AFTER_FAILURES = 8;
const COOLDOWN_BASE_MS = 10_000;
const COOLDOWN_MAX_MS = 120_000;
const COOLDOWN_MULTIPLIER = 2;
const RATE_LIMIT_DEFAULT_MS = 30_000;
const LATENCY_WINDOW = 20;

// ============ INTERNAL STATE ============

interface EndpointState {
	endpoint: string;
	state: CircuitState;
	consecutiveFailures: number;
	cooldownMs: number;
	openUntil: number;
	rateLimitedUntil: number;
	latencies: number[];
	lastSuccessTime: number;
	lastFailureTime: number;
}

function createEndpointState(endpoint: string): EndpointState {
	return {
		endpoint,
		state: "closed",
		consecutiveFailures: 0,
		cooldownMs: COOLDOWN_BASE_MS,
		openUntil: 0,
		rateLimitedUntil: 0,
		latencies: [],
		lastSuccessTime: 0,
		lastFailureTime: 0,
	};
}

// ============ INITIALIZATION ============

export function createEndpointHealthPool(initialUrls: readonly string[] = []): EndpointHealthPool {
	const endpoints: EndpointState[] = [];
	let roundRobinIndex = 0;

	function init(urls: readonly string[]): void {
		endpoints.length = 0;
		roundRobinIndex = 0;
		for (const url of urls) {
			endpoints.push(createEndpointState(url));
		}
	}

	function pickRoundRobin(pool: readonly EndpointState[]): string {
		const idx = roundRobinIndex % pool.length;
		roundRobinIndex++;
		return pool[idx]!.endpoint;
	}

	function findEndpoint(url: string): EndpointState | undefined {
		return endpoints.find(ep => ep.endpoint === url);
	}

	function avgLatency(ep: EndpointState): number {
		if (ep.latencies.length === 0) return 0;
		const sum = ep.latencies.reduce((a, b) => a + b, 0);
		return Math.round(sum / ep.latencies.length);
	}

	function getHealthSnapshot(): readonly EndpointHealthSnapshot[] {
		return endpoints.map(ep => ({
			endpoint: ep.endpoint,
			state: ep.state,
			consecutiveFailures: ep.consecutiveFailures,
			cooldownMs: ep.cooldownMs,
			openUntil: ep.openUntil,
			rateLimitedUntil: ep.rateLimitedUntil,
			avgLatencyMs: avgLatency(ep),
		}));
	}

	function reset(): void {
		endpoints.length = 0;
		roundRobinIndex = 0;
	}

	/**
	 * Select the best available endpoint. Never throws — always returns a URL.
	 * Priority: closed (round-robin by latency) > half_open (probe) > open (least-bad).
	 */
	function selectEndpoint(): string {
		if (endpoints.length === 0) {
			throw new Error("No endpoints configured — call initEndpointHealth() first");
		}

		const now = Date.now();

		// Transition expired open circuits to half_open
		for (const ep of endpoints) {
			if (ep.state === "open" && now >= ep.openUntil) {
				ep.state = "half_open";
			}
		}

		if (endpoints.length === 1) {
			// Single endpoint: force open → half_open for probe even before cooldown
			const ep = endpoints[0]!;
			if (ep.state === "open") {
				ep.state = "half_open";
			}
			return ep.endpoint;
		}

		// Filter out rate-limited endpoints (unless all are rate-limited)
		const notRateLimited = endpoints.filter(ep => ep.rateLimitedUntil <= now);
		const candidates = notRateLimited.length > 0 ? notRateLimited : endpoints;

		// Prefer closed, then half_open, then open
		const closed = candidates.filter(ep => ep.state === "closed");
		if (closed.length > 0) {
			return pickRoundRobin(closed);
		}

		const halfOpen = candidates.filter(ep => ep.state === "half_open");
		if (halfOpen.length > 0) {
			return halfOpen[0]!.endpoint;
		}

		// All open — pick the one closest to cooldown expiry, transition to half_open
		const sorted = [...candidates].sort((a, b) => a.openUntil - b.openUntil);
		const leastBad = sorted[0]!;
		leastBad.state = "half_open";
		return leastBad.endpoint;
	}

	function recordSuccess(endpoint: string, latencyMs: number): void {
		const ep = findEndpoint(endpoint);
		if (!ep) return;

		ep.consecutiveFailures = 0;
		ep.lastSuccessTime = Date.now();

		// half_open → closed on success, reset cooldown
		if (ep.state === "half_open") {
			ep.state = "closed";
			ep.cooldownMs = COOLDOWN_BASE_MS;
		}

		// Rolling latency window
		ep.latencies.push(latencyMs);
		if (ep.latencies.length > LATENCY_WINDOW) {
			ep.latencies.shift();
		}
	}

	function recordFailure(endpoint: string, category: ErrorCategory, retryAfterMs?: number): void {
		const ep = findEndpoint(endpoint);
		if (!ep) return;

		ep.lastFailureTime = Date.now();

		if (category === "rate_limited") {
			// 429 does NOT trip the circuit — endpoint is alive, just throttling
			const cooldown = retryAfterMs ?? RATE_LIMIT_DEFAULT_MS;
			ep.rateLimitedUntil = Date.now() + cooldown;
			return;
		}

		ep.consecutiveFailures++;

		if (ep.state === "half_open") {
			// Probe failed — reopen with escalated cooldown
			ep.cooldownMs = Math.min(ep.cooldownMs * COOLDOWN_MULTIPLIER, COOLDOWN_MAX_MS);
			ep.state = "open";
			ep.openUntil = Date.now() + ep.cooldownMs;
			return;
		}

		if (ep.state === "closed" && ep.consecutiveFailures >= OPEN_AFTER_FAILURES) {
			ep.state = "open";
			ep.openUntil = Date.now() + ep.cooldownMs;
		}
	}

	if (initialUrls.length > 0) {
		init(initialUrls);
	}

	return { init, selectEndpoint, recordSuccess, recordFailure, getHealthSnapshot, reset };
}

const defaultEndpointHealth = createEndpointHealthPool();

export function initEndpointHealth(urls: readonly string[]): void {
	defaultEndpointHealth.init(urls);
}

// ============ ENDPOINT SELECTION ============

export const selectEndpoint = defaultEndpointHealth.selectEndpoint;

// ============ HEALTH RECORDING ============

export const recordSuccess = defaultEndpointHealth.recordSuccess;

export const recordFailure = defaultEndpointHealth.recordFailure;

// ============ ERROR CLASSIFICATION ============

/**
 * Classify an error by duck-typing. Works with FetchError (has .status)
 * and native fetch errors (AbortError for timeout, TypeError for network).
 */
export function classifyError(err: unknown): ErrorCategory {
	if (typeof err === "object" && err !== null) {
		const statusErr = err as { status?: unknown; name?: string };

		// FetchError or any error with numeric .status
		if (typeof statusErr.status === "number") {
			if (statusErr.status === 429) return "rate_limited";
			if (statusErr.status >= 500) return "transient";
			if (statusErr.status >= 400) return "client_error";
		}

		// AbortError from AbortSignal.timeout
		if (statusErr.name === "AbortError" || statusErr.name === "TimeoutError") {
			return "transient";
		}
	}

	// TypeError from fetch = network error (DNS, connection refused, etc.)
	if (err instanceof TypeError) return "transient";

	// Bun throws plain Error (not TypeError) for TCP socket resets.
	// Detect by message pattern — these are transient network events, not server errors.
	if (err instanceof Error && err.message.includes("socket connection was closed")) {
		return "transient";
	}

	return "unknown";
}

// ============ BACKOFF ============

/**
 * Exponential backoff with jitter, scaled by error category.
 * Rate-limited: longer delays (endpoint asked us to slow down).
 * Transient/unknown: fast retry with escalation.
 */
export function getBackoffMs(attempt: number, category: ErrorCategory): number {
	if (category === "rate_limited") {
		return Math.min(2000 * 2 ** attempt, 30_000) + jitter(2000);
	}
	return Math.min(300 * 2 ** attempt, 8_000) + jitter(500);
}

function jitter(maxMs: number): number {
	return Math.floor(Math.random() * maxMs);
}

// ============ DIAGNOSTICS ============

export function getHealthSnapshot(): readonly EndpointHealthSnapshot[] {
	return defaultEndpointHealth.getHealthSnapshot();
}

// ============ TEST HELPERS ============

export function resetHealth(): void {
	defaultEndpointHealth.reset();
}
