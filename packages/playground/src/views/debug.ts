// Debug view — server-side buy smoke test
import { $, log } from "../shared/dom";

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

// === Server-side buy smoke test ===

async function multisigBuyFlow() {
	const nftIdInput = $("multisig-nft-id") as HTMLInputElement | null;
	const nftId = nftIdInput?.value.trim();
	if (!nftId) {
		log("Enter an NFT ID to buy", "error");
		return;
	}

	log(`Submitting server-side buy smoke test for ${nftId}...`);

	try {
		const res = await fetch("/api/debug/multisig-buy", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ nftId }),
		});
		const data = await res.json();

		if (!data.success) {
			log(`Buy smoke test failed: ${data.error}${data.code ? ` [${data.code}]` : ""}`, "error");
			return;
		}

		const paymentInfo = data.paymentInfo;
		log(`Buy OK! tx1=${data.tx1Id} tx2=${data.tx2Id}`, "success");
		log(`Payment: ${paymentInfo.totalPrice} ${paymentInfo.currency} to @${paymentInfo.seller}`, "info");
		if (paymentInfo.royaltyAmount > 0 && paymentInfo.royaltyRecipient) {
			log(`Royalty: ${paymentInfo.royaltyAmount.toFixed(3)} to @${paymentInfo.royaltyRecipient}`, "info");
		}
		if (paymentInfo.feeAmount > 0) {
			log(`Fee: ${paymentInfo.feeAmount.toFixed(3)} to @${paymentInfo.feeAccount}`, "info");
		}
	} catch (err) {
		log(`Error: ${(err as Error).message}`, "error");
	}
}
