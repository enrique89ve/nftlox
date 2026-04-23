/**
 * End-to-end smoke: buyer signs the full buy tx with active key, POSTs to the
 * local indexer's /api/multisig/buy, waits for the node-last orchestration
 * (broadcast commitment → win race → co-sign → broadcast completed buy) and
 * reports the final tx_id.
 *
 * Reads from packages/indexer/.env:
 *   INDEXER_URL                 (default http://localhost:3050)
 *   TEST_BUYER_ACCOUNT          (buyer account)
 *   TEST_BUYER_ACTIVE_KEY       (buyer active WIF)
 *
 * Pass the target NFT id as argv[2] (default: the one listed during smoke
 * bootstrap).
 */
import { Transaction, PrivateKey, config as hiveConfig } from "hive-tx";
import {
	solveMultisigPow,
	NFTLOX_POW_HEADER,
	fetchPaymentInfo,
	RECOMMENDED_BUY_TX_EXPIRATION_MS,
} from "nftlox-sdk";

const INDEXER = process.env.INDEXER_URL ?? "http://localhost:3050";
const BUYER = requireEnv("TEST_BUYER_ACCOUNT");
const BUYER_KEY = requireEnv("TEST_BUYER_ACTIVE_KEY");
const NFT_ID = process.argv[2] ?? "nft_838eb4d40542257c43e3_1";

hiveConfig.nodes = [
	"https://api.syncad.com",
	"https://rpc.mahdiyari.info",
	"https://api.hive.blog",
];

type PaymentInfo = Awaited<ReturnType<typeof fetchPaymentInfo>>;

type BuyResponse =
	| { ok: true; txId: string; commitmentOpTxId: string }
	| { ok: false; code: string; message: string; retryAfterMs?: number };

async function main(): Promise<void> {
	console.log(`[smoke] buyer=${BUYER} nft=${NFT_ID} indexer=${INDEXER}`);
	const info = await fetchPaymentInfo(INDEXER, NFT_ID);
	console.log("[smoke] payment-info:", {
		listingId: info.listingId,
		totalPrice: info.totalPrice,
		currency: info.currency,
		seller: info.seller,
		royaltyRecipient: info.royaltyRecipient,
		nodeAccount: info.nodeAccount,
	});

	const unsignedTx = await buildUnsignedBuyTx(info);
	console.log("[smoke] unsigned tx built; ref_block_num=", unsignedTx.transaction?.ref_block_num);

	const signedTx = new Transaction({ transaction: unsignedTx.transaction });
	signedTx.sign(PrivateKey.from(BUYER_KEY));
	const buyerSig = signedTx.transaction?.signatures?.[0];
	if (!buyerSig) throw new Error("Failed to obtain buyer signature");
	console.log("[smoke] buyer signed. sig prefix=", buyerSig.slice(0, 16), "...");

	const body = { transaction: { ...unsignedTx.transaction, signatures: [buyerSig] } };
	const pow = await solveMultisigPow(body);
	console.log("[smoke] PoW solved; posting to /api/multisig/buy ...");

	const t0 = Date.now();
	const res = await fetch(`${INDEXER}/api/multisig/buy`, {
		method: "POST",
		headers: { "Content-Type": "application/json", [NFTLOX_POW_HEADER]: pow },
		body: JSON.stringify(body),
	});
	const elapsed = Date.now() - t0;
	const json = (await res.json().catch(() => null)) as BuyResponse | null;
	console.log(`[smoke] response in ${elapsed}ms: HTTP ${res.status}`);
	console.log(JSON.stringify(json, null, 2));

	if (!json || !res.ok || !json.ok) {
		process.exit(1);
	}
	console.log(`[smoke] ✓ Buy settled. tx_id=${json.txId} commitment_op_tx_id=${json.commitmentOpTxId}`);
}

async function buildUnsignedBuyTx(info: PaymentInfo): Promise<Transaction> {
	const tx = new Transaction({ expiration: RECOMMENDED_BUY_TX_EXPIRATION_MS });

	await tx.addOperation("transfer", {
		from: BUYER,
		to: info.seller,
		amount: `${info.sellerAmount.toFixed(3)} ${info.currency}`,
		memo: `NFTLox BUY:${NFT_ID}`,
	});
	if (info.royaltyAmount > 0 && info.royaltyRecipient) {
		await tx.addOperation("transfer", {
			from: BUYER,
			to: info.royaltyRecipient,
			amount: `${info.royaltyAmount.toFixed(3)} ${info.currency}`,
			memo: `NFTLox ROY:${NFT_ID}`,
		});
	}
	if (info.feeAmount > 0) {
		await tx.addOperation("transfer", {
			from: BUYER,
			to: info.feeAccount,
			amount: `${info.feeAmount.toFixed(3)} ${info.currency}`,
			memo: `NFTLox FEE:${NFT_ID}`,
		});
	}
	await tx.addOperation("custom_json", {
		required_auths: [info.nodeAccount],
		required_posting_auths: [],
		id: "nftlox_testnet",
		json: JSON.stringify({
			protocol: "nftlox_testnet",
			version: "0.7.0",
			action: "buy",
			data: {
				nftId: NFT_ID,
				listingId: info.listingId,
				listTxId: info.listTxId,
			},
		}),
	});

	return tx;
}

function requireEnv(key: string): string {
	const value = process.env[key];
	if (!value) throw new Error(`Missing env var: ${key}`);
	return value;
}

void main();
