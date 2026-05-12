// Mirrors the on-chain operation parser's prototype-pollution defense
// (see operation-parser.ts `prototypePollutionReviver`) for the multisig
// HTTP path. Both boundaries consume untrusted JSON; both must strip
// `__proto__` and `constructor` at parse time.
//
// The JSON payloads here are built as raw string literals — never via
// `JSON.stringify({ __proto__: ... })`. The object-literal form treats
// `__proto__` as a prototype setter, so stringify drops the key and the
// test would pass even without the reviver. Hand-built strings ensure
// `JSON.parse` actually sees the dangerous key.

import { describe, expect, test } from "bun:test";

import { PROTOCOL_ID, MIN_PROTOCOL_VERSION, ACTION_CREATE_COLLECTION } from "@/protocol/index.ts";
import { parseCollectionPayload } from "@/api/services/multisig/transaction.ts";

describe("multisig payload prototype-pollution guard", () => {
	test("strips __proto__ from payload data", () => {
		const json = `{
			"protocol": "${PROTOCOL_ID}",
			"version": "${MIN_PROTOCOL_VERSION}",
			"action": "${ACTION_CREATE_COLLECTION}",
			"data": {
				"name": "ok",
				"__proto__": { "polluted": true }
			}
		}`;

		const result = parseCollectionPayload(json, PROTOCOL_ID);

		expect(Object.prototype.hasOwnProperty.call(result.data, "__proto__")).toBe(false);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	test("strips constructor from payload data", () => {
		const json = `{
			"protocol": "${PROTOCOL_ID}",
			"version": "${MIN_PROTOCOL_VERSION}",
			"action": "${ACTION_CREATE_COLLECTION}",
			"data": {
				"name": "ok",
				"constructor": { "prototype": { "polluted": true } }
			}
		}`;

		const result = parseCollectionPayload(json, PROTOCOL_ID);

		expect(Object.prototype.hasOwnProperty.call(result.data, "constructor")).toBe(false);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});
});
