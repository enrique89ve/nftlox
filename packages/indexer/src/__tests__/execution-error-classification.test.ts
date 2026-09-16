import { describe, expect, test } from "bun:test";
import {
	classifyExecutionError,
	protocolReject,
} from "@/processor/protocol-rejection.ts";
import { getExecutionRetryDelay } from "@/scanner/sync-engine.ts";

describe("execution error classification", () => {
	test("keeps deterministic protocol rejection typed and stable", () => {
		const error = protocolReject(
			"Delegated Asset transfers cannot target the burn account",
			"BURN_RECIPIENT_DELEGATION_FORBIDDEN",
		);

		expect(classifyExecutionError(error)).toEqual({
			kind: "rejected",
			code: "BURN_RECIPIENT_DELEGATION_FORBIDDEN",
			message: "Delegated Asset transfers cannot target the burn account",
		});
	});

	test("classifies PostgreSQL statement timeout as transient execution failure", () => {
		const error = Object.assign(new Error("canceling statement due to statement timeout"), {
			code: "57014",
		});

		expect(classifyExecutionError(error)).toEqual({
			kind: "fatal",
			transient: true,
			message: "canceling statement due to statement timeout",
		});
	});

	test("does not downgrade an unknown error to a protocol rejection", () => {
		expect(classifyExecutionError(new Error("unexpected state"))).toEqual({
			kind: "fatal",
			transient: false,
			message: "unexpected state",
		});
	});

	test("uses bounded exponential retry only for transient failures", () => {
		expect(getExecutionRetryDelay(1000, 0, true)).toBe(1000);
		expect(getExecutionRetryDelay(1000, 5, true)).toBe(30_000);
		expect(getExecutionRetryDelay(1000, 99, true)).toBe(30_000);
		expect(getExecutionRetryDelay(1000, 4, false)).toBe(2000);
	});
});
