import { z } from "zod";
import { Transaction } from "hive-tx";
import {
	PROTOCOL_ID,
	PROTOCOL_VERSION,
	ACTION_BUY,
	MEMO_PREFIX_BUY,
	MEMO_PREFIX_ROYALTY,
	MEMO_PREFIX_FEE,
	fetchPaymentInfo,
	usernameSchema,
} from "nftlox-sdk";
import { INDEXER_URL } from "../shared/indexer";

const buyRequestSchema = z.object({
	buyer: usernameSchema,
	nftId: z.string().min(1),
});

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json" },
	});

// Tx2 must outlive the sale_lock wait (~180s) + cosign + broadcast; indexer
// enforces ≥ BUY_TX_TTL_MS / 2 remaining at submission time.
const TX_EXPIRATION_MS = 240_000;

type RouteHandler = (req: Request) => Promise<Response>;

// POST /api/marketplace/buy — server-side prep for the new /api/buy flow.
// Fetches payment-info, assembles tx2 (transfers + buy custom_json with
// required_auths=[nodeAccount]), and returns an unsigned hive-tx
// TransactionType. The browser signs it with Keychain ("Active") and POSTs
// the serialized signed tx to the indexer's /api/buy endpoint directly.
export const marketplaceRoutes: Record<string, { POST: RouteHandler }> = {
	"/api/marketplace/buy": {
		POST: async (req: Request) => {
			try {
				const parse = buyRequestSchema.safeParse(await req.json());
				if (!parse.success) {
					return json({ success: false, error: parse.error.issues }, 400);
				}
				const { buyer, nftId } = parse.data;

				const info = await fetchPaymentInfo(INDEXER_URL, nftId);

				const tx = new Transaction({ expiration: TX_EXPIRATION_MS });
				if (info.sellerAmount > 0) {
					await tx.addOperation("transfer", {
						from: buyer,
						to: info.seller,
						amount: `${info.sellerAmount.toFixed(3)} ${info.currency}`,
						memo: `${MEMO_PREFIX_BUY}${nftId}`,
					});
				}
				if (info.royaltyAmount > 0 && info.royaltyRecipient) {
					await tx.addOperation("transfer", {
						from: buyer,
						to: info.royaltyRecipient,
						amount: `${info.royaltyAmount.toFixed(3)} ${info.currency}`,
						memo: `${MEMO_PREFIX_ROYALTY}${nftId}`,
					});
				}
				if (info.feeAmount > 0) {
					await tx.addOperation("transfer", {
						from: buyer,
						to: info.feeAccount,
						amount: `${info.feeAmount.toFixed(3)} ${info.currency}`,
						memo: `${MEMO_PREFIX_FEE}${nftId}`,
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
							nftId,
							listingId: info.listingId,
							listTxId: info.listTxId,
						},
					}),
				});

				if (!tx.transaction) {
					return json({ success: false, error: "Transaction building failed" }, 500);
				}

				return json({
					success: true,
					transaction: tx.transaction,
					paymentInfo: info,
					indexerUrl: INDEXER_URL,
				});
			} catch (err) {
				return json({ success: false, error: String(err instanceof Error ? err.message : err) }, 500);
			}
		},
	},
};
