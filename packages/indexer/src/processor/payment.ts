// Router-level payment validation. Dispatcher maps each PaymentRequirement.kind
// to its validator. `none` and `fixed` / `scaled` run pre-handler in the
// router; `split` stays in the handler because it needs a DB-locked NFT row.

import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import type { PaymentRequirement, PaymentSplit } from "@/protocol/index.ts";
import { validateFixedFee } from "@/utils/fee-oracle.ts";

// Compute the prepaid scaled fee in HBD for a given declared `count` against a
// `scaled` requirement. Mirrors the SDK `computeCollectionFeeHbd` helper so the
// indexer accepts exactly what the SDK builder asks the user to pay. `count`
// MUST already be validated as a non-negative integer that is either 0 or a
// multiple of `unitDenominator` (the handler/multisig path enforces this).
function computeScaledRequiredHbd(
	requirement: Extract<PaymentRequirement, { kind: "scaled" }>,
	count: number,
): string {
	const base = Number.parseFloat(requirement.baseHbd);
	if (count <= 0) return base.toFixed(3);
	const unit = Number.parseFloat(requirement.unitHbd);
	const chunks = Math.ceil(count / requirement.unitDenominator);
	return (base + unit * chunks).toFixed(3);
}

// Pull the scaling source out of the parsed payload using `requirement.countFrom`.
// Adding a new countFrom variant becomes a compile error here — the switch is
// exhaustive over the union literal type.
function readScalingCount(
	op: ParsedOperation,
	countFrom: Extract<PaymentRequirement, { kind: "scaled" }>["countFrom"],
): number {
	switch (countFrom) {
		case "payload:maxInstances": {
			const raw = op.data.maxInstances;
			if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
				throw new Error(
					`validateScaled: payload.maxInstances must be a non-negative integer, got ${String(raw)}`,
				);
			}
			return raw;
		}
		default: {
			const _exhaustive: never = countFrom;
			throw new Error(`validateScaled: unhandled countFrom: ${String(_exhaustive)}`);
		}
	}
}

export type PaymentMatch =
	| { readonly kind: "none"; readonly consumedIndices: readonly [] }
	| {
		readonly kind: "fixed";
		readonly payer: string;
		readonly amount: number;
		readonly currency: string;
		readonly consumedIndices: readonly [number];
	}
	| {
		readonly kind: "scaled";
		readonly payer: string;
		readonly amount: number;
		readonly currency: string;
		readonly consumedIndices: readonly [number];
	}
	| {
		readonly kind: "split";
		readonly payer: string;
		readonly split: PaymentSplit;
		readonly consumedIndices: readonly number[];
	};

export type PaymentValidationContext = {
	readonly targetAccount: string;
	// Memo is computed by the caller (router, after resolving the payload's
	// natural key per requirement.memoKey). Ignored for `none` and `split`.
	readonly expectedMemo?: string;
};

type Validator<K extends PaymentRequirement["kind"]> = (
	op: ParsedOperation,
	requirement: Extract<PaymentRequirement, { kind: K }>,
	ctx: PaymentValidationContext,
) => PaymentMatch;

const validateNone: Validator<"none"> = () => ({
	kind: "none",
	consumedIndices: [],
});

const validateFixed: Validator<"fixed"> = (op, req, ctx) => {
	if (!ctx.expectedMemo) {
		throw new Error("validateFixed: expectedMemo required");
	}
	const match = validateFixedFee({
		op,
		requiredHbd: req.amountHbd,
		targetAccount: ctx.targetAccount,
		expectedMemo: ctx.expectedMemo,
	});
	return {
		kind: "fixed",
		payer: match.payer,
		amount: match.amount,
		currency: match.currency,
		consumedIndices: [match.index],
	};
};

const validateScaled: Validator<"scaled"> = (op, req, ctx) => {
	if (!ctx.expectedMemo) {
		throw new Error("validateScaled: expectedMemo required");
	}
	const count = readScalingCount(op, req.countFrom);
	const requiredHbd = computeScaledRequiredHbd(req, count);
	const match = validateFixedFee({
		op,
		requiredHbd,
		targetAccount: ctx.targetAccount,
		expectedMemo: ctx.expectedMemo,
	});
	return {
		kind: "scaled",
		payer: match.payer,
		amount: match.amount,
		currency: match.currency,
		consumedIndices: [match.index],
	};
};

const validateSplit: Validator<"split"> = () => {
	throw new Error(
		"validateSplit: split payment is validated in the handler, not the router",
	);
};

export const PAYMENT_VALIDATORS: {
	readonly [K in PaymentRequirement["kind"]]: Validator<K>;
} = {
	none: validateNone,
	fixed: validateFixed,
	scaled: validateScaled,
	split: validateSplit,
};
