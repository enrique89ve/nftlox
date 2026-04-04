// Advanced operations view — Replicate NFT, Set Owner Data
import { $, log } from "../shared/dom";
import { getConnectedUser } from "../shared/state";
import { broadcastOperation } from "../shared/keychain";

export function initAdvancedOps() {
	$("btn-replicate-load-nft")?.addEventListener("click", loadNftDetails);
	$("btn-replicate-submit")?.addEventListener("click", submitReplicate);
	$("btn-owner-data-submit")?.addEventListener("click", submitSetOwnerData);
}

function val(id: string): string {
	return ($(id) as HTMLInputElement)?.value.trim() ?? "";
}

function showPreview(data: unknown) {
	const previewEl = $("advanced-ops-preview");
	const jsonEl = $("advanced-ops-json");
	if (previewEl) previewEl.style.display = "block";
	if (jsonEl) jsonEl.textContent = JSON.stringify(data, null, 2);
}

async function loadNftDetails() {
	const nftId = val("adv-replicate-nft-id");
	if (!nftId) {
		log("Enter an NFT ID first", "error");
		return;
	}

	try {
		log(`Loading NFT details for ${nftId}...`);
		const response = await fetch(`/api/nft/${encodeURIComponent(nftId)}/details`);
		const data = await response.json();

		if (!response.ok || data.error) {
			log(`Error: ${data.error || "NFT not found"}`, "error");
			return;
		}

		const originDnaInput = $("adv-replicate-origin-dna") as HTMLInputElement;
		const instanceDnaInput = $("adv-replicate-instance-dna") as HTMLInputElement;

		if (originDnaInput && data.origin_dna) {
			originDnaInput.value = data.origin_dna;
		}
		if (instanceDnaInput && data.instance_dna) {
			instanceDnaInput.value = data.instance_dna;
		}

		log(`NFT loaded: ${nftId}`, "success");
	} catch (e) {
		log(`Error loading NFT: ${(e as Error).message}`, "error");
	}
}

async function submitReplicate() {
	const user = getConnectedUser();
	if (!user) {
		log("Connect wallet first", "error");
		return;
	}

	const formData = {
		originalId: val("adv-replicate-nft-id"),
		originDna: val("adv-replicate-origin-dna"),
		originalInstanceDna: val("adv-replicate-instance-dna"),
		newOwner: val("adv-replicate-new-owner"),
		currentOwner: user,
	};

	if (!formData.originalId || !formData.originDna || !formData.originalInstanceDna || !formData.newOwner) {
		log("All fields are required for replicate", "error");
		return;
	}

	try {
		const response = await fetch("/api/build/replicate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(formData),
		});
		const result = await response.json();

		if (!result.success) {
			log(`Error: ${result.error || result.errors?.[0]?.message}`, "error");
			return;
		}

		showPreview(result);
		log("Replicate preview generated", "success");

		broadcastOperation(
			user,
			[result.operation],
			result.keyType || "Posting",
			() => log("Replicate broadcast successful!", "success"),
			(err) => log(`Replicate failed: ${err}`, "error"),
		);
	} catch (e) {
		log(`Error: ${(e as Error).message}`, "error");
	}
}

async function submitSetOwnerData() {
	const user = getConnectedUser();
	if (!user) {
		log("Connect wallet first", "error");
		return;
	}

	const collectionId = val("adv-owner-data-collection");
	const key = val("adv-owner-data-key");
	const rawValue = val("adv-owner-data-value");

	if (!collectionId || !key) {
		log("Collection ID and Key are required", "error");
		return;
	}

	let value: unknown = rawValue;
	try {
		value = JSON.parse(rawValue);
	} catch {
		// Not JSON, use as plain string
	}

	const formData = { collectionId, key, value, owner: user };

	try {
		const response = await fetch("/api/build/set-owner-data", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(formData),
		});
		const result = await response.json();

		if (!result.success) {
			log(`Error: ${result.error || result.errors?.[0]?.message}`, "error");
			return;
		}

		showPreview(result);
		log("Set Owner Data preview generated", "success");

		broadcastOperation(
			user,
			[result.operation],
			result.keyType || "Posting",
			() => log("Set Owner Data broadcast successful!", "success"),
			(err) => log(`Set Owner Data failed: ${err}`, "error"),
		);
	} catch (e) {
		log(`Error: ${(e as Error).message}`, "error");
	}
}
