// Debug view — multisig flow proof-of-concept
import { $, log } from "../shared/dom";
import { getConnectedUser } from "../shared/state";

const HIVE_RPC_NODE = "https://api.hive.blog";

export function initDebug() {
	$("btn-debug-direct")?.addEventListener("click", directServerTransfer);
	$("btn-debug-multisig")?.addEventListener("click", multisigBuyFlow);
}

// === Direct: server-only signing (no Keychain) ===

async function directServerTransfer() {
	log("Server signing and broadcasting transfer...");

	try {
		const response = await fetch("/api/debug/server-transfer", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ authorizedBy: "direct-test" }),
		});
		const data = await response.json();

		if (data.success) {
			log(`Transfer OK! TX: ${data.txId} (${data.status})`, "success");
			log(`${data.from} -> ${data.to}: ${data.amount}`, "info");
		} else {
			log(`Failed: ${data.error}`, "error");
		}
	} catch (err) {
		log(`Error: ${(err as Error).message}`, "error");
	}
}

// === Multisig buy: playground builds tx, indexer signs, Keychain signs, broadcast ===

async function multisigBuyFlow() {
	const user = getConnectedUser();
	if (!user) {
		log("Connect wallet first", "error");
		return;
	}

	const nftIdInput = $("multisig-nft-id") as HTMLInputElement | null;
	const nftId = nftIdInput?.value.trim();
	if (!nftId) {
		log("Enter an NFT ID to buy", "error");
		return;
	}

	const keychain = (window as any).hive_keychain;
	if (!keychain) {
		log("Hive Keychain not detected", "error");
		return;
	}

	if (!keychain.requestSignTx) {
		log("Keychain requestSignTx not available. Update Keychain to 3.x+", "error");
		return;
	}

	// Step 1: Ask playground server to build the unsigned tx and get node multisig signature
	log(`Step 1: Building transaction and requesting multisig for ${nftId}...`);

	let transaction: any;
	let nodeSignature: string;
	let paymentInfo: any;

	try {
		const res = await fetch("/api/debug/multisig-buy", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ buyer: user, nftId }),
		});
		const data = await res.json();

		if (!data.success) {
			log(`Multisig failed: ${data.error}${data.code ? ` [${data.code}]` : ""}`, "error");
			return;
		}

		transaction = data.transaction;
		nodeSignature = data.nodeSignature;
		paymentInfo = data.paymentInfo;

		log(`Multisig OK! Digest: ${data.digest.substring(0, 20)}...`, "success");
		log(`Payment: ${paymentInfo.totalPrice} ${paymentInfo.currency} to @${paymentInfo.seller}`, "info");

		if (paymentInfo.royaltyAmount > 0) {
			log(`  Royalty: ${paymentInfo.royaltyAmount.toFixed(3)} to @${paymentInfo.royaltyRecipient}`, "info");
		}
		if (paymentInfo.feeAmount > 0) {
			log(`  Fee: ${paymentInfo.feeAmount.toFixed(3)} to @${paymentInfo.feeAccount}`, "info");
		}
	} catch (err) {
		log(`Error: ${(err as Error).message}`, "error");
		return;
	}

	// Step 2: Add node signature to the transaction, then ask Keychain to add buyer's
	log("Step 2: Adding node signature and requesting Keychain sign...");

	// The multisig service returns the tx with empty signatures.
	// We add the node's signature before handing off to Keychain.
	transaction.signatures = [nodeSignature];

	keychain.requestSignTx(
		user,
		transaction,
		"Active",
		async (res: any) => {
			if (!res.success) {
				const err = typeof res.error === "object" ? JSON.stringify(res.error) : res.error;
				log(`Keychain failed: ${err}`, "error");
				return;
			}

			const signedTx = res.result;
			const signatures: string[] = signedTx?.signatures ?? [];
			log(`Keychain signed! Total signatures: ${signatures.length}`, "success");

			// Step 3: Broadcast the fully-signed transaction
			log("Step 3: Broadcasting fully-signed transaction...");
			await broadcastSignedTx(signedTx);
		},
	);
}

// === Broadcast helper: sends a signed tx directly to a Hive RPC node ===

async function broadcastSignedTx(signedTx: unknown) {
	try {
		const response = await fetch(HIVE_RPC_NODE, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				method: "condenser_api.broadcast_transaction_synchronous",
				params: [signedTx],
				id: 1,
			}),
		});
		const data = await response.json();

		if (data.error) {
			log(`Broadcast rejected: ${data.error.message ?? JSON.stringify(data.error)}`, "error");
			return;
		}

		const txId = data.result?.id ?? data.result?.tx_id ?? "unknown";
		log(`Broadcast OK! TX: ${txId}`, "success");
		log(`Block: ${data.result?.block_num ?? "pending"}`, "info");
	} catch (err) {
		log(`Broadcast error: ${(err as Error).message}`, "error");
	}
}
