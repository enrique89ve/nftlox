import { createLogger } from "./logger.ts";
import { config } from "@/config.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { DEFAULT_FEE_ACCOUNT } from "@/protocol/constants.ts";

const log = createLogger("fee-oracle");

// Lightweight ad-hoc interface for the RPC call
interface FeedHistory {
	current_median_history: {
		base: string; // e.g. "0.280 HBD"
		quote: string; // e.g. "1.000 HIVE"
	};
}

let cachedPrice: { hbdPerHive: number; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache since median price moves slowly (every 3.5 days)

/**
 * Fetches the current median HBD per HIVE price from the blockchain.
 * Uses a built-in fetch with the primary endpoint. For full failover,
 * this would normally tie into `callWithFailover` in `hive-client.ts`.
 */
export async function getMedianPrice(): Promise<number> {
	if (cachedPrice && Date.now() < cachedPrice.expiresAt) {
		return cachedPrice.hbdPerHive;
	}

	const endpoint = config.hiveEndpoints[0] || "https://api.hive.blog";
	
	try {
		const response = await fetch(endpoint, {
			method: "POST",
			signal: AbortSignal.timeout(10_000),
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				method: "condenser_api.get_feed_history",
				params: [],
				id: 1,
			}),
		});

		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		
		const json = await response.json() as { result?: FeedHistory };
		if (!json.result?.current_median_history) {
			throw new Error("Invalid get_feed_history response");
		}

		const median = json.result.current_median_history;
		if (!median.base || !median.quote) {
			throw new Error("Missing base/quote in price feed");
		}
		
		const baseAmount = parseFloat(median.base.split(" ")[0]!);
		const quoteAmount = parseFloat(median.quote.split(" ")[0]!);

		if (Number.isNaN(baseAmount) || Number.isNaN(quoteAmount) || quoteAmount === 0) {
			throw new Error("Invalid price feed format");
		}

		const hbdPerHive = baseAmount / quoteAmount;

		cachedPrice = {
			hbdPerHive,
			expiresAt: Date.now() + CACHE_TTL_MS,
		};

		return hbdPerHive;
	} catch (err) {
		log.warn("Failed to fetch feed history", { error: err instanceof Error ? err.message : String(err) });
		// Fallback to a safe estimate if the node is down
		return 0.3; 
	}
}

export const feeOracle = {
	/**
	 * Validates if the paid amount (HBD or HIVE) meets the required HBD constant fee.
	 * @param requiredHbd - The constant string value, e.g. "100.000"
	 * @param paidAmount - The amount of tokens paid as a number
	 * @param paidCurrency - "HBD" or "HIVE"
	 */
	async validateFee(requiredHbd: string, paidAmount: number, paidCurrency: string): Promise<boolean> {
		const target = parseFloat(requiredHbd);
		if (Number.isNaN(target)) throw new Error("Invalid required HBD format");

		if (paidCurrency === "HBD") {
			return paidAmount >= target;
		}

		if (paidCurrency === "HIVE") {
			const hbdPerHive = await getMedianPrice();
			const hiveRequired = target / hbdPerHive;
			
			// We allow a small 0.5% margin of error due to price fluctuations
			return paidAmount >= (hiveRequired * 0.995);
		}

		return false;
	},

	/**
	 * Requires the operation to have a valid paired transfer fulfilling the required fee.
	 */
	async requireDynamicFee(
		op: ParsedOperation,
		requiredHbd: string,
		targetAccount: string = DEFAULT_FEE_ACCOUNT,
		payerAccount: string = op.signer,
	): Promise<{ amount: number; currency: string }> {
		const transfers = op.pairedTransfers ?? [];
		if (transfers.length === 0) {
			throw new Error(`Operation requires a fee of ${requiredHbd} HBD`);
		}

		const consumed = op.transferPool?.consumed;
		let sawCandidate = false;
		for (let index = 0; index < transfers.length; index++) {
			if (consumed?.has(index)) continue;
			const transfer = transfers[index];
			if (!transfer || transfer.from !== payerAccount || transfer.to !== targetAccount) continue;

			sawCandidate = true;
			const isValid = await this.validateFee(
				requiredHbd,
				transfer.amount,
				transfer.currency,
			);
			if (!isValid) continue;

			consumed?.add(index);
			return { amount: transfer.amount, currency: transfer.currency };
		}

		if (!sawCandidate) {
			throw new Error(`Fee must be paid by ${payerAccount} to the treasury (${targetAccount})`);
		}
		throw new Error(`Insufficient fee paid: no transfer meets the requirement of ${requiredHbd} HBD`);
	}
};
