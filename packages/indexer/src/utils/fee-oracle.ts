import { createLogger } from "./logger.ts";
import { config } from "@/config.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import { DEFAULT_FEE_ACCOUNT } from "@/protocol/constants.ts";

const log = createLogger("fee-oracle");

interface FeedHistory {
	current_median_history: {
		base: string;
		quote: string;
	};
}

const PRICE_POLL_INTERVAL_MS = 3_600_000;
const PRICE_STALE_THRESHOLD_MS = 14_400_000;

// Fee tolerance for HIVE payments. Absorbs the price-drift window between
// the bot's /api/status read and the handler's validateFee call. 2% (200 bps)
// covers typical intra-hour HIVE/HBD volatility while leaving a hostile actor
// no meaningful discount. HBD payments have no tolerance — they're pegged.
export const FEE_TOLERANCE_BPS = 200;
const FEE_TOLERANCE_MULTIPLIER = 1 - FEE_TOLERANCE_BPS / 10_000;

let cachedPrice: { hbdPerHive: number; fetchedAt: number } | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchMedianPrice(): Promise<number | null> {
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

		return baseAmount / quoteAmount;
	} catch (err) {
		log.warn("Failed to fetch feed history", { error: err instanceof Error ? err.message : String(err) });
		return null;
	}
}

export async function refreshPrice(): Promise<void> {
	const price = await fetchMedianPrice();
	if (price !== null) {
		cachedPrice = { hbdPerHive: price, fetchedAt: Date.now() };
		log.info("HIVE/HBD price updated", { hbdPerHive: price });
	} else if (cachedPrice) {
		log.warn("Price fetch failed — using cached price", {
			hbdPerHive: cachedPrice.hbdPerHive,
			ageMs: Date.now() - cachedPrice.fetchedAt,
			stale: !isPriceFresh(),
		});
	} else {
		log.warn("Price fetch failed — no cached price available, HIVE payments will be rejected");
	}
}

export function startPricePoller(): void {
	refreshPrice().catch(() => {});
	if (pollTimer !== null) return;
	pollTimer = setInterval(() => {
		refreshPrice().catch(() => {});
	}, PRICE_POLL_INTERVAL_MS);
	pollTimer.unref();
}

export function stopPricePoller(): void {
	if (pollTimer !== null) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}

function isPriceFresh(): boolean {
	if (!cachedPrice) return false;
	return (Date.now() - cachedPrice.fetchedAt) < PRICE_STALE_THRESHOLD_MS;
}

export function getMedianPrice(): number | null {
	if (!isPriceFresh()) return null;
	return cachedPrice!.hbdPerHive;
}

export function getPriceStatus(): Readonly<{
	available: boolean;
	hbdPerHive: number | null;
	fetchedAt: number | null;
	stale: boolean;
	toleranceBps: number;
}> {
	return {
		available: cachedPrice !== null,
		hbdPerHive: cachedPrice?.hbdPerHive ?? null,
		fetchedAt: cachedPrice?.fetchedAt ?? null,
		stale: !isPriceFresh(),
		toleranceBps: FEE_TOLERANCE_BPS,
	};
}

export const feeOracle = {
	async validateFee(requiredHbd: string, paidAmount: number, paidCurrency: string): Promise<boolean> {
		const target = parseFloat(requiredHbd);
		if (Number.isNaN(target)) throw new Error("Invalid required HBD format");

		if (paidCurrency === "HBD") {
			return paidAmount >= target;
		}

		if (paidCurrency === "HIVE") {
			const hbdPerHive = getMedianPrice();
			if (hbdPerHive === null) return false;
			const hiveRequired = target / hbdPerHive;
			return paidAmount >= (hiveRequired * FEE_TOLERANCE_MULTIPLIER);
		}

		return false;
	},

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

		if (!isPriceFresh()) {
			throw new Error(`Cannot validate HIVE fee: price feed unavailable or stale. Required: ${requiredHbd} HBD`);
		}

		throw new Error(`Insufficient fee paid: no transfer meets the requirement of ${requiredHbd} HBD`);
	}
};
