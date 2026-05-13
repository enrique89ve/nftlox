// Multisig <-> handler payload parity for `buy`.
//
// Sister to multisig-collection-payload-parity.test.ts. Handler-side
// `handleBuy` calls `requireString` on `nftId` / `listingId` / `listTxId`,
// which rejects empty strings. The multisig pre-broadcast path must reject
// the same payloads to avoid the fee-orphan vector: a co-signed but
// chain-bouncing buy_commitment forfeits the buyer's fee transfer.
//
// `parseBuyPayload` is the public seam; we exercise it directly with
// hand-built JSON so a future refactor of the calling chain cannot mask
// regressions.

import { describe, expect, test } from "bun:test";

import {
	ACTION_BUY,
	MIN_PROTOCOL_VERSION,
	PROTOCOL_ID,
} from "@/protocol/index.ts";
import { parseBuyPayload } from "@/api/services/multisig/transaction.ts";
import { isMultisigError } from "@/api/services/multisig/errors.ts";

function buildJson(data: Record<string, unknown>): string {
	return JSON.stringify({
		protocol: PROTOCOL_ID,
		version: MIN_PROTOCOL_VERSION,
		action: ACTION_BUY,
		data,
	});
}

const VALID = {
	nftId: "nft_abc123",
	listingId: "list_xyz789",
	listTxId: "tx_deadbeef",
};

describe("parseBuyPayload — handler parity on required id fields", () => {
	test("accepts a fully-populated buy payload", () => {
		const result = parseBuyPayload(buildJson(VALID), PROTOCOL_ID);
		expect(result.action).toBe(ACTION_BUY);
		expect(result.data.nftId).toBe(VALID.nftId);
		expect(result.data.listingId).toBe(VALID.listingId);
		expect(result.data.listTxId).toBe(VALID.listTxId);
	});

	test.each([
		["nftId", { ...VALID, nftId: "" }],
		["listingId", { ...VALID, listingId: "" }],
		["listTxId", { ...VALID, listTxId: "" }],
	])("rejects empty %s with INVALID_PROTOCOL_PAYLOAD", (field, data) => {
		try {
			parseBuyPayload(buildJson(data), PROTOCOL_ID);
			throw new Error(`expected parseBuyPayload to throw for empty ${field}`);
		} catch (err) {
			expect(isMultisigError(err)).toBe(true);
			if (isMultisigError(err)) {
				expect(err.code).toBe("INVALID_PROTOCOL_PAYLOAD");
				// Anchor the `Payload data.<field>` prefix so a future refactor
				// that drops the field-name context can't slip past the substring
				// match.
				expect(err.message).toContain(`data.${field}`);
			}
		}
	});
});
