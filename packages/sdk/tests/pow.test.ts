import { describe, expect, test } from "bun:test";

import {
	MULTISIG_POW_VERSION,
	NFTLOX_POW_HEADER,
	canonicalPowJson,
	hashJsonPayload,
	hashMultisigPowToken,
	hasLeadingZeroBits,
	solveMultisigPow,
} from "../src/index";

describe("multisig Proof of Work", () => {
	test("canonicalizes object keys before hashing", () => {
		expect(canonicalPowJson({
			z: 1,
			a: { d: 4, b: 2 },
			list: [{ y: true, x: false }],
		})).toBe('{"a":{"b":2,"d":4},"list":[{"x":false,"y":true}],"z":1}');
	});

	test("checks partial hash collisions by bit count", () => {
		expect(hasLeadingZeroBits("00abcdef", 8)).toBe(true);
		expect(hasLeadingZeroBits("007bcdef", 9)).toBe(true);
		expect(hasLeadingZeroBits("000bcdef", 12)).toBe(true);
		expect(hasLeadingZeroBits("000bcdef", 13)).toBe(false);
		expect(hasLeadingZeroBits("10abcdef", 1)).toBe(false);
	});

	test("solves a valid low-difficulty token for a payload", async () => {
		const payload = {
			buyer: "alice",
			nftId: "nft-1",
			transaction: { operations: [], extensions: [], signatures: [] },
		};

		const token = await solveMultisigPow(payload, 4);
		const [version, bits, , payloadHash] = token.split(":");

		expect(NFTLOX_POW_HEADER).toBe("X-NFTLox-PoW");
		expect(version).toBe(MULTISIG_POW_VERSION);
		expect(bits).toBe("4");
		expect(payloadHash).toBe(await hashJsonPayload(payload));
		expect(hasLeadingZeroBits(await hashMultisigPowToken(token), 4)).toBe(true);
	});
});
