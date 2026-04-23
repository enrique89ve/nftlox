import type { AccountLiquidBalance } from "@/scanner/hive-client.ts";
import { createMultisigError } from "@/api/services/multisig/errors.ts";
import type { ValidatedTransferOp } from "./types.ts";

export type FetchBalance = (account: string) => Promise<AccountLiquidBalance>;

/**
 * Sums the buyer's outgoing transfers grouped by currency. Defensive against
 * any transfer whose `from` is not the buyer (upstream validation should
 * already enforce buyer-only transfers, but the sum stays correct regardless).
 */
export function sumBuyerOutgoing(
	buyer: string,
	transfers: ReadonlyArray<ValidatedTransferOp>,
): { hive: number; hbd: number } {
	let hive = 0;
	let hbd = 0;
	for (const op of transfers) {
		if (op.from !== buyer) continue;
		if (op.parsedAmount.currency === "HIVE") hive += op.parsedAmount.amount;
		else if (op.parsedAmount.currency === "HBD") hbd += op.parsedAmount.amount;
	}
	return { hive, hbd };
}

/**
 * Anti-grief gate: refuses to broadcast a buy_commitment when the buyer cannot
 * cover the transfers. Hive consensus would reject the buy-tx anyway at block
 * production, but the commitment IS broadcast first and locks the NFT in
 * `pending_sale` until BUY_COMMITMENT_TTL_BLOCKS expires (~30s). Without this
 * gate an attacker with empty accounts can grief popular listings at zero cost.
 *
 * `fetchBalance` is injected so the gate is testable in isolation; production
 * passes `getAccountLiquidBalance` from `hive-client.ts`, which uses the
 * `callWithFailover` infrastructure (multi-endpoint, backoff, retry-after).
 *
 * Asymmetric trust against a lying endpoint:
 *   - understates balance → false negative (legit buyer rejected, retries)
 *   - overstates balance  → regresses to today's behavior (Hive consensus
 *                           rejects the transfer at block production)
 */
export async function assertBuyerSolvent(
	buyer: string,
	transfers: ReadonlyArray<ValidatedTransferOp>,
	fetchBalance: FetchBalance,
): Promise<void> {
	const required = sumBuyerOutgoing(buyer, transfers);

	// Skip the RPC if the tx demands nothing from the buyer's liquid balance.
	if (required.hive === 0 && required.hbd === 0) return;

	let balance: AccountLiquidBalance;
	try {
		balance = await fetchBalance(buyer);
	} catch (cause) {
		throw createMultisigError(
			"INTERNAL_ERROR",
			`Could not fetch Hive balance for buyer '${buyer}'`,
			{ cause },
		);
	}

	if (required.hive > balance.hive) {
		throw createMultisigError(
			"INSUFFICIENT_BALANCE",
			`Buyer '${buyer}' has ${balance.hive.toFixed(3)} HIVE liquid; ${required.hive.toFixed(3)} HIVE required`,
		);
	}
	if (required.hbd > balance.hbd) {
		throw createMultisigError(
			"INSUFFICIENT_BALANCE",
			`Buyer '${buyer}' has ${balance.hbd.toFixed(3)} HBD liquid; ${required.hbd.toFixed(3)} HBD required`,
		);
	}
}
