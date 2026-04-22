// Debug routes — multisig flow proof-of-concept with hive-tx
import { Transaction, PrivateKey } from "hive-tx";
import {
	PROTOCOL_ID,
	PROTOCOL_VERSION,
	ACTION_BUY,
	MEMO_PREFIX_BUY,
	MEMO_PREFIX_ROYALTY,
	MEMO_PREFIX_FEE,
	fetchPaymentInfo,
	requestBuyMultisig,
	type PaymentInfo,
	type BuyMultisigRequest,
	type BuyMultisigResponse,
} from "nftlox-sdk";
import { playgroundConfig } from "../config";
import { INDEXER_URL } from "../shared/indexer";

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json" },
	});

const SERVER_ACCOUNT = process.env.HIVE_ACCOUNT ?? "";
const ACTIVE_KEY = process.env.ACTIVE_KEY ?? "";
const TRANSFER_TO = "enrique89.test";
const TRANSFER_AMOUNT = "0.001 HIVE";
const TX_EXPIRATION_MS = 60_000;

type RouteHandler = (req: Request) => Promise<Response>;

export const debugRoutes: Record<string, { POST: RouteHandler }> = {

	// Direct: server-only signing (no Keychain)
	"/api/debug/server-transfer": {
		POST: async (req: Request) => {
			try {
				if (!playgroundConfig.debugRoutesEnabled) {
					return json({ error: "Not Found" }, 404);
				}

				if (!SERVER_ACCOUNT || !ACTIVE_KEY) {
					return json({ error: "HIVE_ACCOUNT or ACTIVE_KEY not configured in .env" }, 500);
				}

				const body = await req.json() as { authorizedBy?: string; memo?: string };

				const tx = new Transaction({ expiration: TX_EXPIRATION_MS });
				await tx.addOperation("transfer", {
					from: SERVER_ACCOUNT,
					to: TRANSFER_TO,
					amount: TRANSFER_AMOUNT,
					memo: body.memo ?? `Debug test by @${body.authorizedBy ?? "unknown"}`,
				});

				const key = PrivateKey.from(ACTIVE_KEY);
				tx.sign(key);
				const result = await tx.broadcast(true);

				return json({
					success: true,
					txId: result.tx_id,
					status: result.status,
					from: SERVER_ACCOUNT,
					to: TRANSFER_TO,
					amount: TRANSFER_AMOUNT,
				});
			} catch (err) {
				return json({ success: false, error: String(err instanceof Error ? err.message : err) }, 500);
			}
		},
	},

	// Server-side buy smoke test: build the unsigned buy tx, request the node
	// co-signature, add the buyer signature locally, then broadcast the single tx.
	"/api/debug/multisig-buy": {
		POST: async (req: Request) => {
			try {
				if (!playgroundConfig.debugRoutesEnabled) {
					return json({ error: "Not Found" }, 404);
				}
				if (!SERVER_ACCOUNT || !ACTIVE_KEY) {
					return json({ success: false, error: "HIVE_ACCOUNT or ACTIVE_KEY not configured" }, 500);
				}

				const body = await req.json() as { nftId: string };
				if (!body.nftId) {
					return json({ success: false, error: "nftId is required" }, 400);
				}
				const buyer = SERVER_ACCOUNT;

				const info: PaymentInfo = await fetchPaymentInfo(INDEXER_URL, body.nftId);

				const tx = new Transaction({ expiration: TX_EXPIRATION_MS });
				if (info.sellerAmount > 0) {
					await tx.addOperation("transfer", {
						from: buyer,
						to: info.seller,
						amount: `${info.sellerAmount.toFixed(3)} ${info.currency}`,
						memo: `${MEMO_PREFIX_BUY}${body.nftId}`,
					});
				}
				if (info.royaltyAmount > 0 && info.royaltyRecipient) {
					await tx.addOperation("transfer", {
						from: buyer,
						to: info.royaltyRecipient,
						amount: `${info.royaltyAmount.toFixed(3)} ${info.currency}`,
						memo: `${MEMO_PREFIX_ROYALTY}${body.nftId}`,
					});
				}
				if (info.feeAmount > 0) {
					await tx.addOperation("transfer", {
						from: buyer,
						to: info.feeAccount,
						amount: `${info.feeAmount.toFixed(3)} ${info.currency}`,
						memo: `${MEMO_PREFIX_FEE}${body.nftId}`,
					});
				}

				await tx.addOperation("custom_json", {
					required_auths: [info.nodeAccount],
					required_posting_auths: [],
					id: PROTOCOL_ID,
					json: JSON.stringify({
						protocol: PROTOCOL_ID,
						version: PROTOCOL_VERSION,
						action: ACTION_BUY,
						data: {
							nftId: body.nftId,
							listingId: info.listingId,
							listTxId: info.listTxId,
						},
					}),
				});

				if (!tx.transaction) {
					return json({ success: false, error: "Transaction building failed" }, 500);
				}

				// Node-last buy: the buyer (this debug account) signs first with
				// active key, then the indexer receives the partially-signed tx,
				// broadcasts a `buy_commitment`, waits for its block to win the
				// cross-node ordering race, co-signs, and broadcasts.
				tx.sign(PrivateKey.from(ACTIVE_KEY));

				const multisigResult: BuyMultisigResponse = await requestBuyMultisig(INDEXER_URL, {
					transaction: tx.transaction as unknown as BuyMultisigRequest["transaction"],
				});

				if (!multisigResult.ok) {
					return json({ success: false, error: multisigResult.message, code: multisigResult.code }, 400);
				}

				return json({
					success: true,
					txId: multisigResult.txId,
					commitmentOpTxId: multisigResult.commitmentOpTxId,
					paymentInfo: info,
				});
			} catch (err) {
				return json({ success: false, error: String(err instanceof Error ? err.message : err) }, 500);
			}
		},
	},
};
