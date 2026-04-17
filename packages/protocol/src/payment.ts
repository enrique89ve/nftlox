import {
	MAX_ROYALTY_PCT,
	PROTOCOL_FEE_BPS,
	BASIS_POINTS_DENOMINATOR,
	type SupportedCurrency,
} from "./constants.ts";
import type { PaymentSplit } from "./types.ts";

export function roundHive(n: number): number {
	return Math.round(n * 1000) / 1000;
}

export function percentageToBasisPoints(percentage: number): number {
	return Math.round(percentage * 100);
}

export function calculateBasisPointsAmount(
	totalAmount: number,
	basisPoints: number,
): number {
	return roundHive((totalAmount * basisPoints) / BASIS_POINTS_DENOMINATOR);
}

export function calculatePaymentSplit(
	totalPrice: number,
	currency: SupportedCurrency,
	royaltyPct: number,
	royaltyRecipient: string | null,
	seller: string,
	feeAccount: string,
): PaymentSplit {
	if (royaltyPct < 0 || royaltyPct > MAX_ROYALTY_PCT) {
		throw new Error(
			`royaltyPct out of range: ${royaltyPct} (max ${MAX_ROYALTY_PCT})`,
		);
	}

	const feeAmount = calculateBasisPointsAmount(totalPrice, PROTOCOL_FEE_BPS);

	let royaltyAmount = 0;
	let effectiveRoyaltyRecipient: string | null = null;
	if (royaltyRecipient && royaltyPct > 0) {
		if (royaltyRecipient === seller) {
			royaltyAmount = 0;
			effectiveRoyaltyRecipient = null;
		} else {
			royaltyAmount = calculateBasisPointsAmount(
				totalPrice,
				percentageToBasisPoints(royaltyPct),
			);
			effectiveRoyaltyRecipient = royaltyRecipient;
		}
	}

	let effectiveFee = feeAmount;
	if (feeAccount === seller) {
		effectiveFee = 0;
	}

	const sellerAmount = roundHive(
		Math.max(0, totalPrice - royaltyAmount - effectiveFee),
	);

	return {
		sellerAmount,
		royaltyAmount,
		royaltyRecipient: effectiveRoyaltyRecipient,
		feeAmount: effectiveFee,
		feeAccount,
		totalPrice,
		currency,
	};
}
