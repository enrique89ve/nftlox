// Router-level payment validation. Dispatcher maps each PaymentRequirement.kind
// to its validator. `none` and `fixed` / `scaled` run pre-handler in the
// router; `split` stays in the handler because it needs a DB-locked NFT row.

import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import type { PaymentRequirement, PaymentSplit } from "@/protocol/index.ts";
import { validateFixedFee } from "@/utils/fee-oracle.ts";

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

const validateScaled: Validator<"scaled"> = () => {
	throw new Error(
		"validateScaled: not implemented — Spec 2 will wire the maxInstances-based scaler",
	);
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
