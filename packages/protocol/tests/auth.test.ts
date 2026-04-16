import { describe, it, expect } from "bun:test";
import {
	ACTION_AUTH_LEVEL,
	ACTIVE_AUTH_ACTIONS,
	POSTING_AUTH_ACTIONS,
	getAuthLevel,
	getKeyType,
	getAuthMismatchReason,
} from "../src/auth.ts";
import {
	ALL_ACTIONS,
	ACTION_CREATE_COLLECTION,
	ACTION_BUY,
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

		it("has exactly 2 active actions", () => {
			expect(ACTIVE_AUTH_ACTIONS.length).toBe(2);
		});

		it("has exactly 16 posting actions", () => {
			expect(POSTING_AUTH_ACTIONS.length).toBe(16);
		});
	});

	describe("getAuthLevel", () => {
		it("returns 'active' for create_collection", () => {
			expect(getAuthLevel(ACTION_CREATE_COLLECTION)).toBe("active");
		});

		it("returns 'active' for buy", () => {
			expect(getAuthLevel(ACTION_BUY)).toBe("active");
		});

		it("returns 'posting' for mint", () => {
			expect(getAuthLevel(ACTION_MINT)).toBe("posting");
		});

		it("returns 'posting' for transfer", () => {
			expect(getAuthLevel(ACTION_TRANSFER)).toBe("posting");
		});
	});

	describe("getKeyType", () => {
		it("returns 'Active' (capitalised) for active actions", () => {
			expect(getKeyType(ACTION_CREATE_COLLECTION)).toBe("Active");
			expect(getKeyType(ACTION_BUY)).toBe("Active");
		});

		it("returns 'Posting' (capitalised) for posting actions", () => {
			expect(getKeyType(ACTION_MINT)).toBe("Posting");
			expect(getKeyType(ACTION_TRANSFER)).toBe("Posting");
		});

		it("returns Keychain-compatible strings for all actions", () => {
			const valid = new Set(["Active", "Posting"]);
			for (const action of ALL_ACTIONS) {
				expect(valid.has(getKeyType(action))).toBe(true);
			}
		});
	});

	describe("getAuthMismatchReason", () => {
		it("returns null when auth level matches", () => {
			expect(getAuthMismatchReason(ACTION_CREATE_COLLECTION, "active")).toBeNull();
			expect(getAuthMismatchReason(ACTION_MINT, "posting")).toBeNull();
		});

		it("returns a descriptive string when auth level mismatches", () => {
			const reason = getAuthMismatchReason(ACTION_CREATE_COLLECTION, "posting");
			expect(reason).not.toBeNull();
			expect(reason).toContain("create_collection");
			expect(reason).toContain("active");
		});
	});
});
