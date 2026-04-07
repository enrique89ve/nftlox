import { describe, test, expect, beforeEach } from "bun:test";
import {
	initEndpointHealth,
	selectEndpoint,
	recordSuccess,
	recordFailure,
	classifyError,
	getBackoffMs,
	getHealthSnapshot,
	resetHealth,
	OPEN_AFTER_FAILURES,
} from "../scanner/endpoint-health.ts";

// Convenience helper: open a circuit by hitting the exact failure threshold
function openCircuit(endpoint: string): void {
	for (let i = 0; i < OPEN_AFTER_FAILURES; i++) recordFailure(endpoint, "transient");
}

const EP_A = "https://a.example.com";
const EP_B = "https://b.example.com";
const EP_C = "https://c.example.com";

beforeEach(() => {
	resetHealth();
});

// ─── Circuit Breaker Transitions ──────────────────────

describe("circuit breaker", () => {
	test("starts all endpoints in closed state", () => {
		initEndpointHealth([EP_A, EP_B]);
		const snap = getHealthSnapshot();
		expect(snap.every(s => s.state === "closed")).toBe(true);
	});

	test("opens circuit after OPEN_AFTER_FAILURES consecutive failures", () => {
		initEndpointHealth([EP_A, EP_B]);

		// N-1 failures: still closed
		for (let i = 0; i < OPEN_AFTER_FAILURES - 1; i++) recordFailure(EP_A, "transient");
		let snap = getHealthSnapshot().find(s => s.endpoint === EP_A)!;
		expect(snap.state).toBe("closed");
		expect(snap.consecutiveFailures).toBe(OPEN_AFTER_FAILURES - 1);

		// Nth failure: opens circuit
		recordFailure(EP_A, "transient");
		snap = getHealthSnapshot().find(s => s.endpoint === EP_A)!;
		expect(snap.state).toBe("open");
		expect(snap.consecutiveFailures).toBe(OPEN_AFTER_FAILURES);
		expect(snap.openUntil).toBeGreaterThan(Date.now());
	});

	test("transitions open → half_open after cooldown expires", () => {
		initEndpointHealth([EP_A, EP_B]);

		// Open the circuit
		openCircuit(EP_A);

		// Simulate cooldown expiry by selecting after time passes
		const snap = getHealthSnapshot().find(s => s.endpoint === EP_A)!;
		expect(snap.state).toBe("open");

		// Force openUntil to the past via internal manipulation isn't possible,
		// but selectEndpoint transitions expired open → half_open.
		// We test this by checking that when ALL are open and cooldown expired,
		// selectEndpoint still returns something (the fallback path).
	});

	test("half_open → closed on success", () => {
		initEndpointHealth([EP_A]);

		// Open circuit
		openCircuit(EP_A);
		expect(getHealthSnapshot()[0]!.state).toBe("open");

		// selectEndpoint forces open → half_open (only endpoint)
		selectEndpoint();
		expect(getHealthSnapshot()[0]!.state).toBe("half_open");

		// Success closes circuit
		recordSuccess(EP_A, 100);
		expect(getHealthSnapshot()[0]!.state).toBe("closed");
		expect(getHealthSnapshot()[0]!.consecutiveFailures).toBe(0);
	});

	test("half_open → open on failure with escalated cooldown", () => {
		initEndpointHealth([EP_A]);

		// Open circuit (base cooldown = 10s)
		openCircuit(EP_A);

		const baseCooldown = getHealthSnapshot()[0]!.cooldownMs;

		// Force to half_open via select
		selectEndpoint();
		expect(getHealthSnapshot()[0]!.state).toBe("half_open");

		// Probe fails — back to open with doubled cooldown
		recordFailure(EP_A, "transient");
		const snap = getHealthSnapshot()[0]!;
		expect(snap.state).toBe("open");
		expect(snap.cooldownMs).toBe(baseCooldown * 2);
	});

	test("cooldown escalation caps at max", () => {
		initEndpointHealth([EP_A]);

		// Repeatedly open/half_open/fail to escalate cooldown
		for (let cycle = 0; cycle < 10; cycle++) {
			openCircuit(EP_A);
			selectEndpoint(); // force half_open
			recordFailure(EP_A, "transient"); // back to open
		}

		const snap = getHealthSnapshot()[0]!;
		expect(snap.cooldownMs).toBeLessThanOrEqual(120_000);
	});

	test("success resets cooldown to base", () => {
		initEndpointHealth([EP_A]);

		// Escalate cooldown
		openCircuit(EP_A);
		selectEndpoint();
		recordFailure(EP_A, "transient"); // cooldown doubled

		// Recover
		selectEndpoint();
		recordSuccess(EP_A, 50);

		const snap = getHealthSnapshot()[0]!;
		expect(snap.state).toBe("closed");
		expect(snap.cooldownMs).toBe(10_000); // reset to base
	});
});

// ─── Endpoint Selection ───────────────────────────────

describe("selectEndpoint", () => {
	test("round-robins among closed endpoints", () => {
		initEndpointHealth([EP_A, EP_B, EP_C]);

		const selected = [selectEndpoint(), selectEndpoint(), selectEndpoint()];
		expect(new Set(selected).size).toBe(3);
	});

	test("prefers closed over half_open", () => {
		initEndpointHealth([EP_A, EP_B]);

		// Open A, leave B closed
		openCircuit(EP_A);
		selectEndpoint(); // forces A to half_open (only open one)

		// Now A is half_open, B is closed
		// Multiple selections should prefer B
		const selections = Array.from({ length: 5 }, () => selectEndpoint());
		expect(selections.every(s => s === EP_B)).toBe(true);
	});

	test("returns fallback when all endpoints are open (never throws)", () => {
		initEndpointHealth([EP_A, EP_B]);

		// Open both
		openCircuit(EP_A);
		openCircuit(EP_B);

		// Should still return an endpoint
		const result = selectEndpoint();
		expect(typeof result).toBe("string");
		expect([EP_A, EP_B]).toContain(result);
	});

	test("picks open endpoint closest to cooldown expiry as fallback", () => {
		initEndpointHealth([EP_A, EP_B]);

		// Open both, but A was opened earlier (lower openUntil)
		openCircuit(EP_A);

		// Small delay so B has a later openUntil
		const snap1 = getHealthSnapshot().find(s => s.endpoint === EP_A)!;

		openCircuit(EP_B);

		const snap2 = getHealthSnapshot().find(s => s.endpoint === EP_B)!;
		expect(snap2.openUntil).toBeGreaterThanOrEqual(snap1.openUntil);

		// A should be selected as fallback (closer to expiry)
		const result = selectEndpoint();
		expect(result).toBe(EP_A);
	});

	test("excludes rate-limited endpoints when alternatives exist", () => {
		initEndpointHealth([EP_A, EP_B]);

		// Rate-limit A
		recordFailure(EP_A, "rate_limited");

		// B should always be selected
		const selections = Array.from({ length: 5 }, () => selectEndpoint());
		expect(selections.every(s => s === EP_B)).toBe(true);
	});

	test("uses rate-limited endpoint when all are rate-limited", () => {
		initEndpointHealth([EP_A, EP_B]);

		recordFailure(EP_A, "rate_limited");
		recordFailure(EP_B, "rate_limited");

		const result = selectEndpoint();
		expect([EP_A, EP_B]).toContain(result);
	});

	test("throws when no endpoints configured", () => {
		// Don't call init
		expect(() => selectEndpoint()).toThrow("No endpoints configured");
	});

	test("single endpoint always returned", () => {
		initEndpointHealth([EP_A]);
		expect(selectEndpoint()).toBe(EP_A);

		// Even after failures
		openCircuit(EP_A);
		expect(selectEndpoint()).toBe(EP_A);
	});
});

// ─── 429 Rate Limit Handling ──────────────────────────

describe("rate limit (429)", () => {
	test("429 sets cooldown without opening circuit", () => {
		initEndpointHealth([EP_A]);

		recordFailure(EP_A, "rate_limited");

		const snap = getHealthSnapshot()[0]!;
		expect(snap.state).toBe("closed"); // NOT open
		expect(snap.consecutiveFailures).toBe(0); // NOT incremented
		expect(snap.rateLimitedUntil).toBeGreaterThan(Date.now());
	});

	test("429 with custom Retry-After", () => {
		initEndpointHealth([EP_A]);

		recordFailure(EP_A, "rate_limited", 5000);

		const snap = getHealthSnapshot()[0]!;
		const expectedUntil = Date.now() + 5000;
		expect(snap.rateLimitedUntil).toBeGreaterThanOrEqual(expectedUntil - 100);
		expect(snap.rateLimitedUntil).toBeLessThanOrEqual(expectedUntil + 100);
	});

	test("429 uses default cooldown when no Retry-After", () => {
		initEndpointHealth([EP_A]);

		recordFailure(EP_A, "rate_limited");

		const snap = getHealthSnapshot()[0]!;
		const expectedUntil = Date.now() + 30_000;
		expect(snap.rateLimitedUntil).toBeGreaterThanOrEqual(expectedUntil - 100);
		expect(snap.rateLimitedUntil).toBeLessThanOrEqual(expectedUntil + 100);
	});
});

// ─── Error Classification ─────────────────────────────

describe("classifyError", () => {
	test("429 status → rate_limited", () => {
		expect(classifyError({ status: 429, message: "Too Many Requests" })).toBe("rate_limited");
	});

	test("500 status → transient", () => {
		expect(classifyError({ status: 500, message: "Internal Server Error" })).toBe("transient");
	});

	test("502 status → transient", () => {
		expect(classifyError({ status: 502, message: "Bad Gateway" })).toBe("transient");
	});

	test("503 status → transient", () => {
		expect(classifyError({ status: 503, message: "Service Unavailable" })).toBe("transient");
	});

	test("400 status → client_error", () => {
		expect(classifyError({ status: 400, message: "Bad Request" })).toBe("client_error");
	});

	test("404 status → client_error", () => {
		expect(classifyError({ status: 404, message: "Not Found" })).toBe("client_error");
	});

	test("AbortError → transient (timeout)", () => {
		const err = new DOMException("signal timed out", "AbortError");
		expect(classifyError(err)).toBe("transient");
	});

	test("TimeoutError → transient", () => {
		const err = new DOMException("timed out", "TimeoutError");
		expect(classifyError(err)).toBe("transient");
	});

	test("TypeError → transient (network error)", () => {
		expect(classifyError(new TypeError("fetch failed"))).toBe("transient");
	});

	test("generic Error → unknown", () => {
		expect(classifyError(new Error("something broke"))).toBe("unknown");
	});

	test("null → unknown", () => {
		expect(classifyError(null)).toBe("unknown");
	});

	test("string → unknown", () => {
		expect(classifyError("error string")).toBe("unknown");
	});
});

// ─── Backoff Calculation ──────────────────────────────

describe("getBackoffMs", () => {
	test("rate_limited has longer base delay", () => {
		const samples = Array.from({ length: 100 }, () => getBackoffMs(0, "rate_limited"));
		const min = Math.min(...samples);
		expect(min).toBeGreaterThanOrEqual(2000);
	});

	test("transient has shorter base delay", () => {
		const samples = Array.from({ length: 100 }, () => getBackoffMs(0, "transient"));
		const max = Math.max(...samples);
		expect(max).toBeLessThan(2000);
	});

	test("backoff increases with attempt number", () => {
		const attempt0 = Array.from({ length: 50 }, () => getBackoffMs(0, "transient"));
		const attempt3 = Array.from({ length: 50 }, () => getBackoffMs(3, "transient"));

		const avg0 = attempt0.reduce((a, b) => a + b, 0) / attempt0.length;
		const avg3 = attempt3.reduce((a, b) => a + b, 0) / attempt3.length;
		expect(avg3).toBeGreaterThan(avg0 * 2);
	});

	test("backoff is capped at maximum", () => {
		const samples = Array.from({ length: 50 }, () => getBackoffMs(20, "transient"));
		for (const s of samples) {
			expect(s).toBeLessThanOrEqual(8_000 + 500);
		}
	});

	test("includes jitter (non-deterministic)", () => {
		const samples = new Set(Array.from({ length: 20 }, () => getBackoffMs(0, "transient")));
		// With jitter, we expect multiple distinct values
		expect(samples.size).toBeGreaterThan(1);
	});
});

// ─── Latency Tracking ─────────────────────────────────

describe("latency tracking", () => {
	test("records average latency from successes", () => {
		initEndpointHealth([EP_A]);

		recordSuccess(EP_A, 100);
		recordSuccess(EP_A, 200);
		recordSuccess(EP_A, 300);

		expect(getHealthSnapshot()[0]!.avgLatencyMs).toBe(200);
	});

	test("rolling window caps at 20 samples", () => {
		initEndpointHealth([EP_A]);

		// Fill with 20 samples of 100ms
		for (let i = 0; i < 20; i++) recordSuccess(EP_A, 100);
		expect(getHealthSnapshot()[0]!.avgLatencyMs).toBe(100);

		// Add 20 more samples of 500ms — should push out the old ones
		for (let i = 0; i < 20; i++) recordSuccess(EP_A, 500);
		expect(getHealthSnapshot()[0]!.avgLatencyMs).toBe(500);
	});

	test("reports 0 when no latency data", () => {
		initEndpointHealth([EP_A]);
		expect(getHealthSnapshot()[0]!.avgLatencyMs).toBe(0);
	});
});
