// NFTLox SDK -- Multisig Client Functions
// Pure async functions for interacting with an indexer node's multisig endpoints.

import type { PaymentInfo, MultisigRequest, MultisigResponse } from "./types";
import { NFTLOX_POW_HEADER, solveMultisigPow } from "./pow.ts";

export type RequestMultisigOptions = Readonly<{
	powBits?: number;
}>;

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
		const body = await res.json().catch(() => ({ error: "Unknown error" }));
		throw new Error(
			`Payment info failed (${res.status}): ${(body as Record<string, unknown>).error ?? "Unknown"}`,
		);
	}
	return res.json() as Promise<PaymentInfo>;
}

/**
 * Request multisig signing from an indexer node.
 * Sends the buyer's unsigned transaction (with correct payment splits)
 * and receives the node's signature if validation passes.
 */
export async function requestMultisig(
	indexerUrl: string,
	request: MultisigRequest,
	options: RequestMultisigOptions = {},
): Promise<MultisigResponse> {
	const powToken = await solveMultisigPow(request, options.powBits);
	const res = await fetch(`${indexerUrl}/api/multisig`, {
		method: "POST",
		headers: { "Content-Type": "application/json", [NFTLOX_POW_HEADER]: powToken },
		body: JSON.stringify(request),
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({ error: "Unknown error" }));
		throw new Error(
			`Multisig request failed (${res.status}): ${(body as Record<string, unknown>).error ?? "Unknown"}`,
		);
	}
	return res.json() as Promise<MultisigResponse>;
}
