import { describe, expect, test } from "bun:test";

import {
	ACTION_AUTH_LEVEL,
	ACTION_BUY,
	ACTION_NODE_REGISTER,
	ACTIVE_AUTH_ACTIONS,
	ALL_ACTIONS,
	POSTING_AUTH_ACTIONS,
} from "@/protocol/index.ts";

describe("protocol auth map", () => {
	test("node_register uses posting custom_json auth", () => {
		expect(ACTION_AUTH_LEVEL[ACTION_NODE_REGISTER]).toBe("posting");
		expect(POSTING_AUTH_ACTIONS).toContain(ACTION_NODE_REGISTER);
		expect(ACTIVE_AUTH_ACTIONS).not.toContain(ACTION_NODE_REGISTER);
	});

	test("only buy uses active custom_json auth", () => {
		expect(ACTION_AUTH_LEVEL[ACTION_BUY]).toBe("active");
		expect(ACTIVE_AUTH_ACTIONS).toEqual([ACTION_BUY]);
		expect(POSTING_AUTH_ACTIONS).toHaveLength(17);
		expect(ALL_ACTIONS).toHaveLength(18);
	});

	test("pack actions are not native indexer protocol actions", () => {
		for (const action of ALL_ACTIONS) {
			expect(action).not.toContain("pack");
		}
	});
});
