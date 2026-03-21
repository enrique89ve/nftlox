// Permissions view — NFT approvals, pack approvals, lending, data operators
import { $, log } from "../shared/dom";
import { getConnectedUser } from "../shared/state";
import { broadcastOperation } from "../shared/keychain";

export function initPermissions() {
	// Form submit handlers
	$("btn-nft-approve")?.addEventListener("click", () => submitPermission("nft-approve"));
	$("btn-nft-approve-all")?.addEventListener("click", () => submitPermission("nft-approve-all"));
	$("btn-nft-transfer-from")?.addEventListener("click", () => submitPermission("nft-transfer-from"));
	$("btn-pack-approve")?.addEventListener("click", () => submitPermission("pack-approve"));
	$("btn-pack-transfer-from")?.addEventListener("click", () => submitPermission("pack-transfer-from"));
	$("btn-nft-lend")?.addEventListener("click", () => submitPermission("nft-lend"));
	$("btn-nft-return")?.addEventListener("click", () => submitPermission("nft-return"));
	$("btn-data-operator-approve")?.addEventListener("click", () => submitPermission("data-operator-approve"));
	$("btn-set-data-from")?.addEventListener("click", () => submitPermission("set-data-from"));
}

function getFormData(action: string): Record<string, unknown> | null {
	const val = (id: string) => ($(id) as HTMLInputElement)?.value.trim();
	const checked = (id: string) => ($(id) as HTMLInputElement)?.checked ?? false;

	switch (action) {
		case "nft-approve":
			return {
				instanceId: val("perm-nft-approve-instance"),
				spender: val("perm-nft-approve-spender"),
				approved: checked("perm-nft-approve-approved"),
				owner: getConnectedUser(),
			};
		case "nft-approve-all":
			return {
				collectionId: val("perm-nft-approve-all-collection"),
				spender: val("perm-nft-approve-all-spender"),
				approved: checked("perm-nft-approve-all-approved"),
				owner: getConnectedUser(),
			};
		case "nft-transfer-from":
			return {
				from: val("perm-nft-xfer-from"),
				to: val("perm-nft-xfer-to"),
				instanceId: val("perm-nft-xfer-instance"),
				spender: getConnectedUser(),
			};
		case "pack-approve":
			return {
				spender: val("perm-pack-approve-spender"),
				packId: val("perm-pack-approve-pack"),
				quantity: parseInt(val("perm-pack-approve-quantity") || "0", 10),
				approved: checked("perm-pack-approve-approved"),
				owner: getConnectedUser(),
			};
		case "pack-transfer-from":
			return {
				from: val("perm-pack-xfer-from"),
				to: val("perm-pack-xfer-to"),
				packId: val("perm-pack-xfer-pack"),
				quantity: parseInt(val("perm-pack-xfer-quantity") || "0", 10),
				spender: getConnectedUser(),
			};
		case "nft-lend":
			return {
				instanceId: val("perm-lend-instance"),
				borrower: val("perm-lend-borrower"),
				owner: getConnectedUser(),
			};
		case "nft-return":
			return {
				instanceId: val("perm-return-instance"),
				signer: getConnectedUser(),
			};
		case "data-operator-approve":
			return {
				collectionId: val("perm-data-op-collection"),
				operator: val("perm-data-op-operator"),
				approved: checked("perm-data-op-approved"),
				creator: getConnectedUser(),
			};
		case "set-data-from": {
			let data: Record<string, unknown> = {};
			const dataStr = val("perm-set-data-from-data");
			if (dataStr) {
				try { data = JSON.parse(dataStr); }
				catch { log("Invalid JSON in data field", "error"); return null; }
			}
			const tagsStr = val("perm-set-data-from-tags");
			const tags = tagsStr ? tagsStr.split(",").map(t => t.trim()).filter(Boolean) : undefined;
			return {
				nftId: val("perm-set-data-from-nft"),
				instanceDna: val("perm-set-data-from-dna"),
				data,
				tags,
				operator: getConnectedUser(),
			};
		}
		default:
			return null;
	}
}

async function submitPermission(action: string) {
	const user = getConnectedUser();
	if (!user) {
		log("Connect wallet first", "error");
		return;
	}

	const formData = getFormData(action);
	if (!formData) return;

	const previewEl = $("permissions-preview");

	try {
		const response = await fetch(`/api/build/${action}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(formData),
		});
		const result = await response.json();

		if (!result.success) {
			log(`Error: ${result.error || result.errors?.[0]?.message}`, "error");
			return;
		}

		// Show preview
		if (previewEl) {
			previewEl.style.display = "block";
			const jsonEl = $("permissions-json");
			if (jsonEl) jsonEl.textContent = JSON.stringify(result, null, 2);
		}

		log(`Preview generated for ${action}`, "success");

		broadcastOperation(
			user,
			[result.operation],
			result.keyType || "Active",
			() => log(`${action} broadcast successful!`, "success"),
			(err) => log(`${action} failed: ${err}`, "error"),
		);
	} catch (e) {
		log(`Error: ${(e as Error).message}`, "error");
	}
}
