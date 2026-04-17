/**
 * Unit tests for secret redaction helpers.
 *
 * Defends against a specific attack: a malicious input triggers a low-level
 * error whose message/stack contains a private WIF (or similar secret) that
 * later gets written to logs or re-thrown to upstream handlers. Redacting
 * at the signer boundary ensures no beekeeper-sourced error can leak WIFs
 * even if `@hiveio/beekeeper` itself is careless about error strings.
 */

import { describe, expect, test } from "bun:test";
import { redactSecrets, redactError } from "@/utils/redact.ts";

// Fixtures use the real base58 alphabet (no 0, O, I, l). Hive mainnet WIFs
// are 51 chars starting with `5`; K/L-prefixed compressed variants are 52.
const FAKE_WIF = "5JQrpQnLJcsUsVjLpbYrb3g9LvV1qUy7UH6n2VKTKcMTFFxsjgp";
const FAKE_WIF_K = "K123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrs";
const FAKE_WIF_L = "L123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrs";
const FAKE_PUBKEY = "STM7cYysJ2zFak6kP9toCBuWYt5t58FKW3kJg3T3MG1MrRE4geDyL";

describe("redactSecrets", () => {
	test("redacts a bare Hive mainnet WIF starting with 5", () => {
		const input = `failed to import key: ${FAKE_WIF}`;
		expect(redactSecrets(input)).toBe("failed to import key: [REDACTED]");
	});

	test("redacts K-prefixed compressed WIFs", () => {
		expect(redactSecrets(`key=${FAKE_WIF_K} failed`)).toBe("key=[REDACTED] failed");
	});

	test("redacts L-prefixed compressed WIFs", () => {
		expect(redactSecrets(`key=${FAKE_WIF_L} failed`)).toBe("key=[REDACTED] failed");
	});

	test("redacts multiple WIFs in the same string", () => {
		const input = `active=${FAKE_WIF} posting=${FAKE_WIF_K}`;
		expect(redactSecrets(input)).toBe("active=[REDACTED] posting=[REDACTED]");
	});

	test("leaves public keys (STM...) untouched — they are not secret", () => {
		const input = `key ${FAKE_PUBKEY} not found in wallet`;
		expect(redactSecrets(input)).toBe(input);
	});

	test("leaves hex digests untouched — they can legitimately appear in logs", () => {
		const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
		expect(redactSecrets(`digest ${digest}`)).toBe(`digest ${digest}`);
	});

	test("leaves ordinary error messages untouched", () => {
		const msg = "wallet is not unlocked";
		expect(redactSecrets(msg)).toBe(msg);
	});

	test("handles empty string", () => {
		expect(redactSecrets("")).toBe("");
	});

	test("handles input where the WIF is embedded in JSON", () => {
		const json = `{"reason":"bad import","wif":"${FAKE_WIF}"}`;
		expect(redactSecrets(json)).toBe(`{"reason":"bad import","wif":"[REDACTED]"}`);
	});

	test("does not over-match short base58 strings", () => {
		// 10-char string starting with 5 — should NOT be redacted
		const input = "error code 5ABC1234ef";
		expect(redactSecrets(input)).toBe(input);
	});
});

describe("redactError", () => {
	test("returns an Error with a redacted message", () => {
		const raw = new Error(`unable to import ${FAKE_WIF}`);
		const safe = redactError(raw);

		expect(safe).toBeInstanceOf(Error);
		expect(safe.message).toBe("unable to import [REDACTED]");
		expect(safe.message).not.toContain(FAKE_WIF);
	});

	test("redacts the stack trace too, since WIFs can appear in argument dumps", () => {
		const raw = new Error("x");
		raw.stack = `Error: ${FAKE_WIF}\n    at frame (${FAKE_WIF})`;
		const safe = redactError(raw);

		expect(safe.stack).toBeDefined();
		expect(safe.stack).not.toContain(FAKE_WIF);
		expect(safe.stack).toContain("[REDACTED]");
	});

	test("wraps non-Error throwables (strings, objects) into a sanitized Error", () => {
		const safe = redactError(`thrown string with ${FAKE_WIF} inside`);

		expect(safe).toBeInstanceOf(Error);
		expect(safe.message).toBe("thrown string with [REDACTED] inside");
	});

	test("passes ordinary errors through with identical message", () => {
		const raw = new Error("wallet is not unlocked");
		const safe = redactError(raw);

		expect(safe.message).toBe("wallet is not unlocked");
	});

	test("handles null / undefined by producing a safe generic Error", () => {
		const fromNull = redactError(null);
		const fromUndef = redactError(undefined);

		expect(fromNull).toBeInstanceOf(Error);
		expect(fromUndef).toBeInstanceOf(Error);
		expect(fromNull.message).toBe("unknown error");
		expect(fromUndef.message).toBe("unknown error");
	});
});
