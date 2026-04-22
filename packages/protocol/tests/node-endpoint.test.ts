import { describe, expect, test } from "bun:test";
import { normalizeNodeEndpoint, validateNodeEndpoint } from "../src/index.ts";

describe("node endpoint normalization", () => {
	test("normalizes full https URL to canonical endpoint without scheme", () => {
		expect(normalizeNodeEndpoint("https://Node.Example.com/rpc/")).toBe("node.example.com/rpc");
	});

	test("accepts bare hosts and preserves query strings", () => {
		expect(normalizeNodeEndpoint("node.example.com/api?v=1")).toBe("node.example.com/api?v=1");
	});

	test("rejects credentials and fragments", () => {
		expect(validateNodeEndpoint("https://user:pass@node.example.com")).not.toBeNull();
		expect(validateNodeEndpoint("https://node.example.com/path#frag")).not.toBeNull();
	});
});
