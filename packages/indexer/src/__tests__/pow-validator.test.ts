import { beforeEach, describe, expect, test } from "bun:test";

import {
	clearMultisigPowReplayCache,
	hashJsonPayload,
	hashMultisigPowToken,
	hasLeadingZeroBits,
	validateMultisigPow,
	MULTISIG_POW_VERSION,
} from "@/api/middleware/pow-validator.ts";

const NOW_MS = 1_800_000_000_000;
const TTL_MS = 300_000;
const MAX_FUTURE_SKEW_MS = 30_000;
const REPLAY_CACHE_MAX = 100;

const basePayload = {
	buyer: "alice",
	nftId: "nft-1",
	listingId: "list-1",
	listTxId: "a".repeat(40),
	transaction: { operations: [], extensions: [], signatures: [] },
};

async function solveToken(payload: unknown, bits: number, timestampMs = NOW_MS): Promise<string> {
	const payloadHash = await hashJsonPayload(payload);
	for (let nonce = 0; nonce < 100_000; nonce++) {
		const token = `${MULTISIG_POW_VERSION}:${bits}:${timestampMs}:${payloadHash}:abcdef0123456789:${nonce}`;
		if (hasLeadingZeroBits(await hashMultisigPowToken(token), bits)) {
			return token;
		}
	}
	throw new Error("test PoW token not found");
}

function validate(header: string | null, body: unknown = basePayload, requiredBits = 4) {
	return validateMultisigPow({
		body,
		header,
		requiredBits,
		ttlMs: TTL_MS,
		maxFutureSkewMs: MAX_FUTURE_SKEW_MS,
		replayCacheMax: REPLAY_CACHE_MAX,
		nowMs: NOW_MS,
	});
}

describe("multisig PoW validator", () => {
	beforeEach(() => {
		clearMultisigPowReplayCache();
	});

	test("requires the PoW header", async () => {
		await expect(validate(null)).resolves.toEqual({
			ok: false,
			code: "POW_REQUIRED",
			message: "Proof of Work required",
		});
	});

	test("accepts a valid token and rejects replay", async () => {
		const token = await solveToken(basePayload, 4);

		await expect(validate(token)).resolves.toEqual({ ok: true });
		await expect(validate(token)).resolves.toEqual({
			ok: false,
			code: "POW_REPLAYED",
			message: "Proof of Work token was already used",
		});
	});

	test("rejects insufficient difficulty", async () => {
		const token = await solveToken(basePayload, 4);

		await expect(validate(token, basePayload, 8)).resolves.toEqual({
			ok: false,
			code: "INVALID_POW",
			message: "Proof of Work difficulty is too low",
		});
	});

	test("rejects payload tampering", async () => {
		const token = await solveToken(basePayload, 4);

		await expect(validate(token, { ...basePayload, buyer: "mallory" })).resolves.toEqual({
			ok: false,
			code: "INVALID_POW",
			message: "Proof of Work payload hash mismatch",
		});
	});

	test("rejects expired tokens", async () => {
		const token = await solveToken(basePayload, 4, NOW_MS - TTL_MS - 1);

		await expect(validate(token)).resolves.toEqual({
			ok: false,
			code: "POW_EXPIRED",
			message: "Proof of Work token expired",
		});
	});
});
