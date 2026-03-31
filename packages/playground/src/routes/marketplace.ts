// Marketplace routes — multisig buy flow (public, not debug-gated)
import { Transaction } from "hive-tx";
import {
	PROTOCOL_ID,
	PROTOCOL_VERSION,
	ACTION_BUY,
	MEMO_PREFIX_BUY,
	MEMO_PREFIX_ROYALTY,
	MEMO_PREFIX_FEE,
	type PaymentInfo,
	type MultisigResponse,
} from "nftlox-sdk";
import { INDEXER_URL } from "../shared/indexer";

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
				const body = await req.json() as { buyer: string; nftId: string };
				if (!body.buyer || !body.nftId) {
					return json({ success: false, error: "buyer and nftId are required" }, 400);
				}

				const infoRes = await fetch(`${INDEXER_URL}/api/payment-info/${encodeURIComponent(body.nftId)}`);
				if (!infoRes.ok) {
					const err = await infoRes.json().catch(() => ({ error: "Payment info unavailable" }));
					return json({ success: false, error: `Payment info failed: ${err.error}` }, 400);
				}
				const info = await infoRes.json() as PaymentInfo;

				const tx = new Transaction({ expiration: TX_EXPIRATION_MS });

				if (info.sellerAmount > 0) {
					await tx.addOperation("transfer", {
						from: body.buyer,
						to: info.seller,
						amount: `${info.sellerAmount.toFixed(3)} ${info.currency}`,
						memo: `${MEMO_PREFIX_BUY}${body.nftId}`,
					});
				}

				if (info.royaltyAmount > 0 && info.royaltyRecipient) {
					await tx.addOperation("transfer", {
						from: body.buyer,
						to: info.royaltyRecipient,
						amount: `${info.royaltyAmount.toFixed(3)} ${info.currency}`,
						memo: `${MEMO_PREFIX_ROYALTY}${body.nftId}`,
					});
				}

				if (info.feeAmount > 0) {
					await tx.addOperation("transfer", {
						from: body.buyer,
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
							txId: info.txId,
							...(info.seedTxId && { seedTxId: info.seedTxId }),
						},
					}),
				});

				const multisigRes = await fetch(`${INDEXER_URL}/api/multisig`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						buyer: body.buyer,
						nftId: body.nftId,
						listingId: info.listingId,
						listTxId: info.listTxId,
						transaction: tx.transaction,
					}),
				});
				const multisigResult = await multisigRes.json() as MultisigResponse;

				if (!multisigResult.ok) {
					return json({ success: false, error: multisigResult.message, code: multisigResult.code }, 400);
				}

				return json({
					success: true,
					transaction: tx.transaction,
					nodeSignature: multisigResult.signature,
					digest: multisigResult.digest,
					paymentInfo: info,
				});
			} catch (err) {
				return json({ success: false, error: String(err instanceof Error ? err.message : err) }, 500);
			}
		},
	},
};
