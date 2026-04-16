// NFTLox SDK -- Multisig Client Functions
// Pure async functions for interacting with an indexer node's multisig endpoints.
//
// Endpoints exposed (all via shared postMultisig core):
//   - POST /api/multisig             → requestBuyMultisig            (digital ownership transfer, critical path)
//   - POST /api/multisig/collection  → requestCreateCollectionMultisig
//
// Response shape is identical across endpoints (MultisigResponse discriminated union).
// Future endpoints (e.g. /api/multisig/node) should add a typed wrapper around postMultisig.

import type {
	PaymentInfo,
	BuyMultisigRequest,
	CreateCollectionMultisigRequest,
	MultisigResponse,
} from "@nftlox/protocol";
import { NFTLOX_POW_HEADER, solveMultisigPow } from "./pow.ts";

export type RequestMultisigOptions = Readonly<{
	powBits?: number;
}>;

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function extractErrorMessage(body: unknown): string {
	if (isObject(body) && "error" in body) {
		return String(body.error);
	}
	return "Unknown error";
}

const PAYMENT_INFO_STRING_FIELDS = [
	"nftId",
	"listingId",
	"listTxId",
	"seller",
	"currency",
	"feeAccount",
	"nodeAccount",
	"txId",
] as const;

const PAYMENT_INFO_NUMBER_FIELDS = [
	"totalPrice",
	"sellerAmount",
	"royaltyAmount",
	"feeAmount",
] as const;

function assertPaymentInfo(raw: unknown): asserts raw is PaymentInfo {
	if (!isObject(raw)) {
		throw new Error("Payment info malformed: not an object");
	}
	const r = raw;
	for (const k of PAYMENT_INFO_STRING_FIELDS) {
		if (typeof r[k] !== "string") {
			throw new Error(`Payment info malformed: ${k} must be string`);
		}
	}
	for (const k of PAYMENT_INFO_NUMBER_FIELDS) {
		if (typeof r[k] !== "number" || !Number.isFinite(r[k])) {
			throw new Error(`Payment info malformed: ${k} must be finite number`);
		}
	}
	if (r.royaltyRecipient !== null && typeof r.royaltyRecipient !== "string") {
		throw new Error("Payment info malformed: royaltyRecipient must be string|null");
	}
	if (r.seedTxId !== null && typeof r.seedTxId !== "string") {
		throw new Error("Payment info malformed: seedTxId must be string|null");
	}
}

function assertMultisigResponse(raw: unknown): asserts raw is MultisigResponse {
	if (!isObject(raw)) {
		throw new Error("Multisig response malformed: not an object");
	}
	const r = raw;
	if (typeof r.ok !== "boolean") {
		throw new Error("Multisig response malformed: ok must be boolean");
	}
	if (r.ok === true) {
		if (typeof r.signature !== "string") {
			throw new Error("Multisig response malformed: signature required on ok:true");
		}
		if (typeof r.digest !== "string") {
			throw new Error("Multisig response malformed: digest required on ok:true");
		}
		if (typeof r.expiration !== "string") {
			throw new Error("Multisig response malformed: expiration required on ok:true");
		}
	} else {
		if (typeof r.code !== "string") {
			throw new Error("Multisig response malformed: code required on ok:false");
		}
		if (typeof r.message !== "string") {
			throw new Error("Multisig response malformed: message required on ok:false");
		}
	}
}

/**
 * Fetch payment split info from an indexer node.
 * Used by the client to build the buy transaction with correct
 * seller/royalty/fee splits before requesting multisig signing.
 */
export async function fetchPaymentInfo(
	indexerUrl: string,
	nftId: string,
): Promise<PaymentInfo> {
	const res = await fetch(`${indexerUrl}/api/payment-info/${encodeURIComponent(nftId)}`);
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(`Payment info failed (${res.status}): ${extractErrorMessage(body)}`);
	}
	const raw: unknown = await res.json();
	assertPaymentInfo(raw);
	return raw;
}

/**
 * Shared multisig POST core — POW-protected, schema-validated.
 * Endpoint-agnostic: wrappers below supply the URL and request type.
 */
async function postMultisig(
	url: string,
	request: unknown,
	options: RequestMultisigOptions,
): Promise<MultisigResponse> {
	const powToken = await solveMultisigPow(request, options.powBits);
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", [NFTLOX_POW_HEADER]: powToken },
		body: JSON.stringify(request),
	});
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(`Multisig request failed (${res.status}): ${extractErrorMessage(body)}`);
	}
	const raw: unknown = await res.json();
	assertMultisigResponse(raw);
	return raw;
}

/**
 * Request multisig signing for a BUY transaction (digital ownership transfer).
 * Critical path: validates payment split and co-signs with node active key.
 */
export async function requestBuyMultisig(
	indexerUrl: string,
	request: BuyMultisigRequest,
	options: RequestMultisigOptions = {},
): Promise<MultisigResponse> {
	return postMultisig(`${indexerUrl}/api/multisig`, request, options);
}

/**
 * Request multisig signing for a CREATE_COLLECTION transaction.
 * Validates collection fee transfer + create_collection payload.
 */
export async function requestCreateCollectionMultisig(
	indexerUrl: string,
	request: CreateCollectionMultisigRequest,
	options: RequestMultisigOptions = {},
): Promise<MultisigResponse> {
	return postMultisig(`${indexerUrl}/api/multisig/collection`, request, options);
}
