import {
	HIVE_AMOUNT_EPSILON,
	HIVE_DECIMALS,
	HIVE_PRECISION,
	MAX_ROYALTY_PCT,
	MIN_PRICE_AMOUNT,
	BASIS_POINTS_DENOMINATOR,
	PROTOCOL_FEE_BPS,
	type SupportedCurrency,
} from "./constants";
import type { PaymentSplit } from "./types";

function assertFiniteNumber(value: number, fieldName: string): void {
	if (!Number.isFinite(value)) {
		throw new Error(`${fieldName} must be a finite number, got ${value}`);
	}
}

function toRoundedHiveUnits(value: number, fieldName: string): number {
	assertFiniteNumber(value, fieldName);
	const units = Math.round(value * HIVE_PRECISION);
	if (!Number.isSafeInteger(units)) {
		throw new Error(`${fieldName} is outside the safe Hive amount range: ${value}`);
	}
	return units;
}

function toExactHiveUnits(value: number, fieldName: string): number {
	const units = toRoundedHiveUnits(value, fieldName);
	const canonical = units / HIVE_PRECISION;
	if (Math.abs(value - canonical) > HIVE_AMOUNT_EPSILON) {
		throw new Error(
			`${fieldName} must use at most ${HIVE_DECIMALS} decimal places, got ${value}`,
		);
	}
	return units;
}

function fromHiveUnits(units: number): number {
	if (!Number.isSafeInteger(units)) {
		throw new Error(`Hive amount units outside safe integer range: ${units}`);
	}
	return units / HIVE_PRECISION;
}

function assertBasisPoints(value: number, fieldName: string): void {
	assertFiniteNumber(value, fieldName);
	if (!Number.isInteger(value) || value < 0 || value > BASIS_POINTS_DENOMINATOR) {
		throw new Error(
			`${fieldName} must be an integer between 0 and ${BASIS_POINTS_DENOMINATOR}, got ${value}`,
		);
	}
}

function calculateBasisPointsUnits(totalUnits: number, basisPoints: number): number {
	assertBasisPoints(basisPoints, "basisPoints");
	const product = totalUnits * basisPoints;
	if (!Number.isSafeInteger(product)) {
		throw new Error("Basis-point calculation exceeds safe integer range");
	}
	return Math.round(product / BASIS_POINTS_DENOMINATOR);
}

const MIN_PRICE_UNITS = toExactHiveUnits(Number(MIN_PRICE_AMOUNT), "MIN_PRICE_AMOUNT");

export function roundHive(n: number): number {
	return fromHiveUnits(toRoundedHiveUnits(n, "amount"));
}

export function percentageToBasisPoints(percentage: number): number {
	assertFiniteNumber(percentage, "percentage");
	if (percentage < 0 || percentage > 100) {
		throw new Error(`percentage must be between 0 and 100, got ${percentage}`);
	}
	const basisPoints = Math.round(percentage * 100);
	assertBasisPoints(basisPoints, "basisPoints");
	return basisPoints;
}

export function calculateBasisPointsAmount(
	totalAmount: number,
	basisPoints: number,
): number {
	const totalUnits = toRoundedHiveUnits(totalAmount, "totalAmount");
	return fromHiveUnits(calculateBasisPointsUnits(totalUnits, basisPoints));
}

// Pure royalty resolution: returns zero units when the royalty is not
// payable (no recipient, zero percent, or the recipient equals the seller —
// self-royalty is collapsed to "no royalty" so the seller receives the full
// residual). Caller guarantees royaltyPct ∈ [0, MAX_ROYALTY_PCT].
function computeRoyalty(
	totalUnits: number,
	royaltyPct: number,
	royaltyRecipient: string | null,
	seller: string,
): { readonly royaltyUnits: number; readonly effectiveRoyaltyRecipient: string | null } {
	if (!royaltyRecipient || royaltyPct <= 0 || royaltyRecipient === seller) {
		return { royaltyUnits: 0, effectiveRoyaltyRecipient: null };
	}
	return {
		royaltyUnits: calculateBasisPointsUnits(
			totalUnits,
			percentageToBasisPoints(royaltyPct),
		),
		effectiveRoyaltyRecipient: royaltyRecipient,
	};
}

/**
 * Integer-units primitive of the payment split. Pure function of `totalUnits`
 * (already validated by the caller) plus the listing rules. Every observable
 * — counts, equality checks, presence of optional legs — must derive from
 * this output to stay deterministic across SDK, indexer, and SPV verifier.
 *
 * Optional-leg rules baked in:
 *  - `royaltyUnits === 0` when `royaltyRecipient` is null, `royaltyPct <= 0`,
 *    or `royaltyRecipient === seller` (self-royalty collapses into the seller
 *    leg). `effectiveRoyaltyRecipient` is null in all three cases so the
 *    caller can branch with a single check.
 *  - `feeUnits === 0` when `feeAccount === seller` (the seller IS the fee
 *    account; emitting a self-transfer would be redundant).
 *
 * Drivers that compare against on-chain transfers MUST decide leg presence
 * by `units > 0`, never by a float-tolerance threshold — see
 * [[project_determinism_audit]].
 */
export type PaymentSplitUnits = Readonly<{
	readonly sellerUnits: number;
	readonly royaltyUnits: number;
	readonly effectiveRoyaltyRecipient: string | null;
	readonly feeUnits: number;
	readonly totalUnits: number;
}>;

export function calculatePaymentSplitFromUnits(
	totalUnits: number,
	royaltyPct: number,
	royaltyRecipient: string | null,
	seller: string,
	feeAccount: string,
): PaymentSplitUnits {
	if (!Number.isSafeInteger(totalUnits)) {
		throw new Error(`totalUnits must be a safe integer, got ${totalUnits}`);
	}
	if (totalUnits < MIN_PRICE_UNITS) {
		throw new Error(
			`totalUnits ${totalUnits} below MIN_PRICE_AMOUNT (${MIN_PRICE_AMOUNT} = ${MIN_PRICE_UNITS} units)`,
		);
	}
	assertFiniteNumber(royaltyPct, "royaltyPct");
	if (royaltyPct < 0 || royaltyPct > MAX_ROYALTY_PCT) {
		throw new Error(
			`royaltyPct out of range: ${royaltyPct} (max ${MAX_ROYALTY_PCT})`,
		);
	}

	const feeUnits = feeAccount === seller
		? 0
		: calculateBasisPointsUnits(totalUnits, PROTOCOL_FEE_BPS);

	const { royaltyUnits, effectiveRoyaltyRecipient } = computeRoyalty(
		totalUnits,
		royaltyPct,
		royaltyRecipient,
		seller,
	);

	const sellerUnits = totalUnits - royaltyUnits - feeUnits;
	if (sellerUnits < 0) {
		throw new Error("Payment split produced a negative seller amount");
	}

	return {
		sellerUnits,
		royaltyUnits,
		effectiveRoyaltyRecipient,
		feeUnits,
		totalUnits,
	};
}

export function calculatePaymentSplit(
	totalPrice: number,
	currency: SupportedCurrency,
	royaltyPct: number,
	royaltyRecipient: string | null,
	seller: string,
	feeAccount: string,
): PaymentSplit {
	const totalUnits = toExactHiveUnits(totalPrice, "totalPrice");
	const split = calculatePaymentSplitFromUnits(
		totalUnits,
		royaltyPct,
		royaltyRecipient,
		seller,
		feeAccount,
	);

	return {
		sellerAmount: fromHiveUnits(split.sellerUnits),
		royaltyAmount: fromHiveUnits(split.royaltyUnits),
		royaltyRecipient: split.effectiveRoyaltyRecipient,
		feeAmount: fromHiveUnits(split.feeUnits),
		feeAccount,
		totalPrice: fromHiveUnits(split.totalUnits),
		currency,
	};
}
