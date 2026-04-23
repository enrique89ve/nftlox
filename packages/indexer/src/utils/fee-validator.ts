import type { ParsedOperation } from "@/scanner/operation-parser.ts";

// ----------------------------------------------------------------------------
// Protocol fee validation. HBD-only — deterministic because HBD is pegged.
//
// Any HIVE↔HBD conversion would require a live feed lookup, which is
// non-deterministic across nodes syncing at different wall-clock times
// (each observes the feed of *their* now, not of the op's block). Until a
// deterministic L1 historical feed read is wired (HAF table lookup at
// `op.blockNum`), the consensus path refuses HIVE for protocol fees entirely.
// ----------------------------------------------------------------------------

export type FixedFeeMatch = {
	readonly payer: string;
	readonly amount: number;
	readonly currency: string;
	readonly index: number;
};

// HBD amounts on Hive L1 are always 3-decimal (see hive-client.ts:parseHiveAsset).
// Canonicalize both sides with .toFixed(3) and compare strings — exact equality,
// zero tolerance, no float-compare epsilon.
function hbdAmountMatches(paid: number, required: number): boolean {
	return paid.toFixed(3) === required.toFixed(3);
}

function parseRequiredHbd(requiredHbd: string): number {
	const required = Number.parseFloat(requiredHbd);
	if (!Number.isFinite(required)) {
		throw new Error(`Invalid required HBD format: ${requiredHbd}`);
	}
	return required;
}

// ----------------------------------------------------------------------------
// validateFixedFee — memo-aware fixed-amount fee validation.
//
// Finds the single transfer in `op.pairedTransfers` that:
//   - is not consumed,
//   - goes to `targetAccount`,
//   - has memo === expectedMemo,
//   - pays exactly `requiredHbd` in HBD (pegged, deterministic — no overpay,
//     no HIVE path).
//
// Returns the match. CALLER (action-router) is responsible for adding
// `match.index` to `op.transferPool.consumed` only AFTER the handler's
// savepoint closes successfully — centralizing that step keeps a failed
// handler from leaking consumed indices.
// ----------------------------------------------------------------------------

export function validateFixedFee(params: {
	op: ParsedOperation;
	requiredHbd: string;
	targetAccount: string;
	expectedMemo: string;
}): FixedFeeMatch {
	const { op, requiredHbd, targetAccount, expectedMemo } = params;
	const required = parseRequiredHbd(requiredHbd);

	const transfers = op.pairedTransfers ?? [];
	const consumed = op.transferPool?.consumed;

	const candidates: Array<{ idx: number; t: (typeof transfers)[number] }> = [];
	for (let idx = 0; idx < transfers.length; idx++) {
		const t = transfers[idx];
		if (!t) continue;
		if (consumed?.has(idx)) continue;
		if (t.to !== targetAccount) continue;
		if (t.memo !== expectedMemo) continue;
		candidates.push({ idx, t });
	}

	if (candidates.length === 0) {
		throw new Error(
			`No fee transfer found matching memo '${expectedMemo}' to @${targetAccount}`,
		);
	}
	if (candidates.length > 1) {
		throw new Error(
			`Ambiguous fee transfers — ${candidates.length} memo matches for '${expectedMemo}'`,
		);
	}

	const match = candidates[0]!;
	const t = match.t;

	// t.currency is L1-authoritative (parsed from NAI / asset-string in
	// hive-client.ts), so the signer cannot declare "HBD" while paying HIVE.
	if (t.currency !== "HBD") {
		throw new Error(
			`Protocol fees must be paid in HBD, got ${t.currency}. Required: ${requiredHbd} HBD`,
		);
	}
	if (!hbdAmountMatches(t.amount, required)) {
		throw new Error(
			`Fee amount mismatch — HBD payment must equal ${requiredHbd}, got ${t.amount.toFixed(3)}`,
		);
	}

	return { payer: t.from, amount: t.amount, currency: t.currency, index: match.idx };
}

// Amount-only fee validation for contexts where memo-binding is enforced
// elsewhere (multisig pre-signing validates (from, to, memo) before calling
// this). HBD-only — non-HBD returns false so the caller emits the appropriate
// rejection error.
export const feeValidator = {
	async validateFee(requiredHbd: string, paidAmount: number, paidCurrency: string): Promise<boolean> {
		const required = parseRequiredHbd(requiredHbd);
		if (paidCurrency !== "HBD") return false;
		return hbdAmountMatches(paidAmount, required);
	},
};
