import { describe, it, expect } from "bun:test";
import {
	ACTION_AUTH_LEVEL,
	ACTIVE_AUTH_ACTIONS,
	POSTING_AUTH_ACTIONS,
	NODE_SIGNED_ACTIONS,
	requiresActiveNodeSigner,
	getAuthLevel,
	getKeyType,
	getAuthMismatchReason,
} from "../src/auth.ts";
import {
	ALL_ACTIONS,
	ACTION_CREATE_COLLECTION,
	ACTION_BUY,
	ACTION_BUY_COMMITMENT,
	ACTION_MINT,
	ACTION_TRANSFER,
} from "../src/constants.ts";

describe("auth", () => {
	describe("ACTION_AUTH_LEVEL", () => {
		it("covers ALL_ACTIONS exactly — no missing, no extra", () => {
			const mappedActions = Object.keys(ACTION_AUTH_LEVEL);
			expect(mappedActions.sort()).toEqual([...ALL_ACTIONS].sort());
		});

		it("values are only 'active' or 'posting'", () => {
			const valid = new Set(["active", "posting"]);
			for (const level of Object.values(ACTION_AUTH_LEVEL)) {
				expect(valid.has(level)).toBe(true);
			}
		});
	});

	describe("ACTIVE_AUTH_ACTIONS + POSTING_AUTH_ACTIONS", () => {
		it("union equals ALL_ACTIONS with no overlap", () => {
			const combined = [...ACTIVE_AUTH_ACTIONS, ...POSTING_AUTH_ACTIONS];
			expect(combined.sort()).toEqual([...ALL_ACTIONS].sort());
		});

		it("has no overlap between active and posting", () => {
			const activeSet = new Set<string>(ACTIVE_AUTH_ACTIONS);
			for (const action of POSTING_AUTH_ACTIONS) {
				expect(activeSet.has(action)).toBe(false);
			}
		});

		it("has exactly 11 active actions", () => {
			expect(ACTIVE_AUTH_ACTIONS.length).toBe(11);
		});

		it("has exactly 10 posting actions", () => {
			expect(POSTING_AUTH_ACTIONS.length).toBe(10);
		});

		it("keeps every custody and delegation action on active authority", () => {
			expect(new Set(ACTIVE_AUTH_ACTIONS)).toEqual(new Set([
				"create_collection",
				"transfer",
				"list",
				"unlist",
				"buy_commitment",
				"buy",
				"nft_approve",
				"nft_approve_all",
				"nft_transfer_from",
				"nft_lend",
				"nft_return",
			]));
		});
	});

	describe("getAuthLevel", () => {
		it("returns 'active' for create_collection", () => {
			expect(getAuthLevel(ACTION_CREATE_COLLECTION)).toBe("active");
		});

		it("returns 'active' for buy (node co-signs tx2's custom_json with active key)", () => {
			expect(getAuthLevel(ACTION_BUY)).toBe("active");
		});

		it("returns 'posting' for mint", () => {
			expect(getAuthLevel(ACTION_MINT)).toBe("posting");
		});

		it("returns 'active' for transfer", () => {
			expect(getAuthLevel(ACTION_TRANSFER)).toBe("active");
		});
	});

	describe("getKeyType", () => {
		it("returns 'Active' (capitalised) for active actions", () => {
			expect(getKeyType(ACTION_CREATE_COLLECTION)).toBe("Active");
		});

		it("returns Keychain strings for posting and custody actions", () => {
			expect(getKeyType(ACTION_MINT)).toBe("Posting");
			expect(getKeyType(ACTION_TRANSFER)).toBe("Active");
		});

		it("returns 'Active' for buy", () => {
			expect(getKeyType(ACTION_BUY)).toBe("Active");
		});

		it("returns Keychain-compatible strings for all actions", () => {
			const valid = new Set(["Active", "Posting"]);
			for (const action of ALL_ACTIONS) {
				expect(valid.has(getKeyType(action))).toBe(true);
			}
		});
	});

	describe("getAuthMismatchReason", () => {
		it("returns ok when auth level matches", () => {
			expect(getAuthMismatchReason(ACTION_CREATE_COLLECTION, "active")).toEqual({ ok: true });
			expect(getAuthMismatchReason(ACTION_MINT, "posting")).toEqual({ ok: true });
		});

		it("returns a descriptive mismatch result when auth level differs", () => {
			const result = getAuthMismatchReason(ACTION_CREATE_COLLECTION, "posting");
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("unreachable");
			expect(result.reason).toBe("auth_mismatch");
			expect(result.message).toContain("create_collection");
			expect(result.message).toContain("active");
		});

		it("returns unknown_action for non-ProtocolAction strings", () => {
			const result = getAuthMismatchReason("not_a_real_action", "posting");
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("unreachable");
			expect(result.reason).toBe("unknown_action");
			expect(result.message).toContain("not_a_real_action");
		});
	});

	describe("NODE_SIGNED_ACTIONS + requiresActiveNodeSigner", () => {
		it("contains exactly buy_commitment and buy", () => {
			expect([...NODE_SIGNED_ACTIONS].sort()).toEqual(
				[ACTION_BUY_COMMITMENT, ACTION_BUY].sort(),
			);
		});

		it("every node-signed action has active auth level (invariant)", () => {
			for (const action of NODE_SIGNED_ACTIONS) {
				expect(ACTION_AUTH_LEVEL[action]).toBe("active");
			}
		});

		it("requiresActiveNodeSigner agrees with NODE_SIGNED_ACTIONS membership for ALL_ACTIONS", () => {
			const members = new Set<string>(NODE_SIGNED_ACTIONS);
			for (const action of ALL_ACTIONS) {
				expect(requiresActiveNodeSigner(action)).toBe(members.has(action));
			}
		});

		it("create_collection is NOT node-signed (its node gate comes from PaymentRequirement)", () => {
			expect(requiresActiveNodeSigner(ACTION_CREATE_COLLECTION)).toBe(false);
		});

		it("no posting-auth action is node-signed", () => {
			for (const action of POSTING_AUTH_ACTIONS) {
				expect(requiresActiveNodeSigner(action)).toBe(false);
			}
		});
	});
});
