import { z } from "zod";
import { Transaction } from "hive-tx";
import {
	buildBuy,
	fetchPaymentInfo,
	requestBuyMultisig,
	usernameSchema,
	type HiveTransactionObject,
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

const TX_EXPIRATION_MS = 60_000;

type RouteHandler = (req: Request) => Promise<Response>;

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

				const built = buildBuy({
					buyer,
					seller: info.seller,
					nftId,
					listingId: info.listingId,
					listTxId: info.listTxId,
					txId: info.txId,
					nodeAccount: info.nodeAccount,
					...(info.seedTxId && { seedTxId: info.seedTxId }),
					paymentSplit: {
						sellerAmount: info.sellerAmount,
						royaltyAmount: info.royaltyAmount,
						royaltyRecipient: info.royaltyRecipient,
						feeAmount: info.feeAmount,
						feeAccount: info.feeAccount,
						totalPrice: info.totalPrice,
						currency: info.currency as "HIVE" | "HBD",
					},
				});

				if (!built.success) {
					return json({ success: false, error: built.errors }, 400);
				}

				const tx = new Transaction({ expiration: TX_EXPIRATION_MS });
				for (const [opName, opBody] of built.operations) {
					await tx.addOperation(
						opName as Parameters<Transaction["addOperation"]>[0],
						opBody as unknown as Parameters<Transaction["addOperation"]>[1],
					);
				}

				if (!tx.transaction) {
					return json({ success: false, error: "Transaction building failed" }, 500);
				}

				const multisigRequest = {
					buyer,
					nftId,
					listingId: info.listingId,
					listTxId: info.listTxId,
					transaction: tx.transaction as unknown as HiveTransactionObject,
				};
				const multisigResult = await requestBuyMultisig(INDEXER_URL, multisigRequest);

				if (!multisigResult.ok) {
					return json({ success: false, error: multisigResult.message, code: multisigResult.code }, 400);
				}

				return json({
					success: true,
					transaction: tx.transaction,
					nodeSignature: multisigResult.signature,
					digest: multisigResult.digest,
					paymentInfo: info,
					coSigners: built.coSigners,
				});
			} catch (err) {
				return json({ success: false, error: String(err instanceof Error ? err.message : err) }, 500);
			}
		},
	},
};
