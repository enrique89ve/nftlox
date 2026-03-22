/**
 * Runtime validation helpers for extracting typed values from unknown data.
 * Replaces blind `as` casts with fail-fast runtime checks at system boundaries.
 */

import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { calculatePaymentSplit, validateHiveUsername, type PaymentSplit } from "nftlox-sdk";

// ============ TRANSFER VERIFICATION (source-agnostic) ============

export interface TransferRecord {
	from: string;
	to: string;
	amount: number;
	currency: string;
}

export interface VerifyTransfersParams {
	transfers: TransferRecord[];
	buyer: string;
	seller: string;
	totalPrice: number;
	currency: string;
	royaltyPct: number;
	royaltyRecipient: string | null;
	feeAccount: string;
}

/**
 * Verify that a set of transfers satisfies the payment split.
 * Source-agnostic: works with pairedTransfers, getTransfersInTransaction, or any transfer array.
 * Reusable for multisig pre-signing verification.
 */
export function verifyTransfers(params: VerifyTransfersParams): PaymentSplit {
	const { transfers, buyer, seller, totalPrice, currency, royaltyPct, royaltyRecipient, feeAccount } = params;

	if (transfers.length === 0) {
		throw new Error("No transfers found. Payment split is required.");
	}

	const split = calculatePaymentSplit(totalPrice, currency, royaltyPct, royaltyRecipient, seller, feeAccount);

	function expectTransfer(to: string, expectedAmount: number, label: string): void {
		const found = transfers.find(t =>
			t.from === buyer &&
			t.to === to &&
			t.currency === currency &&
			t.amount >= expectedAmount
		);
		if (!found) {
			throw new Error(
				`Missing ${label}: expected >= ${expectedAmount} ${currency} from @${buyer} to @${to}`
			);
		}
	}

	if (split.sellerAmount > 0) {
		expectTransfer(seller, split.sellerAmount, "seller payment");
	}

	if (split.royaltyAmount > 0 && split.royaltyRecipient) {
		expectTransfer(split.royaltyRecipient, split.royaltyAmount, "royalty payment");
	}

	if (split.feeAmount > 0) {
		expectTransfer(split.feeAccount, split.feeAmount, "marketplace fee");
	}

	return split;
}

/**
 * Convenience wrapper: verify payment split against pairedTransfers in a ParsedOperation.
 * Used by multisig verification where transfers come from the same atomic transaction.
 */
export function verifyPaymentSplit(params: {
	op: ParsedOperation;
	seller: string;
	totalPrice: number;
	currency: string;
	royaltyPct: number;
	royaltyRecipient: string | null;
	feeAccount: string;
}): void {
	const { op, ...rest } = params;
	verifyTransfers({
		transfers: op.pairedTransfers ?? [],
		buyer: op.signer,
		...rest,
	});
}

export function requireString(value: unknown, fieldName: string): string {
	if (typeof value !== "string" || value === "") {
		throw new Error(`Missing or invalid ${fieldName}: expected non-empty string`);
	}
	return value;
}

export function requireUsername(value: unknown, fieldName: string): string {
	const str = requireString(value, fieldName);
	const error = validateHiveUsername(str);
	if (error) {
		throw new Error(`Invalid Hive username for ${fieldName} ("${str}"): ${error}`);
	}
	return str;
}

const HIVE_DECIMAL_REGEX = /^(0|[1-9]\d*)\.\d{3}$/;

type HiveCurrency = "HIVE" | "HBD";

export function requireHiveAmount(value: unknown, fieldName: string): { amount: string; currency: HiveCurrency } {
	const price = requirePrice(value, fieldName);
	if (!HIVE_DECIMAL_REGEX.test(price.amount)) {
		throw new Error(`Invalid Hive decimal format for ${fieldName}.amount: "${price.amount}" (expected 3 decimal places, e.g. "1.000")`);
	}
	const currency = price.currency.toUpperCase();
	if (currency !== "HIVE" && currency !== "HBD") {
		throw new Error(`Invalid currency for ${fieldName}: "${price.currency}" (expected "HIVE" or "HBD")`);
	}
	return { amount: price.amount, currency };
}

export function requireNumber(value: unknown, fieldName: string): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		throw new Error(`Missing or invalid ${fieldName}: expected number`);
	}
	return value;
}

export function optionalString(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") return null;
	return value;
}

export function optionalNumber(value: unknown, fallback?: number): number | null {
	if (value === undefined || value === null) return fallback ?? null;
	if (typeof value !== "number" || Number.isNaN(value)) return fallback ?? null;
	return value;
}

export function optionalBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	return fallback;
}

export function requireObject(value: unknown, fieldName: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Missing or invalid ${fieldName}: expected object`);
	}
	return value as Record<string, unknown>;
}

export function optionalObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

export function optionalStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	return value.filter((v): v is string => typeof v === "string");
}

export function requireBoolean(value: unknown, fieldName: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`Missing or invalid ${fieldName}: expected boolean`);
	}
	return value;
}

export function requireArray(value: unknown, fieldName: string): unknown[] {
	if (!Array.isArray(value)) {
		throw new Error(`Missing or invalid ${fieldName}: expected array`);
	}
	return value;
}

export function requirePrice(value: unknown, fieldName: string): { amount: string; currency: string } {
	const obj = requireObject(value, fieldName);
	return {
		amount: requireString(obj.amount, `${fieldName}.amount`),
		currency: requireString(obj.currency, `${fieldName}.currency`),
	};
}
