// Permissions view — Asset approvals, lending, data operators
import { $, log } from "../shared/dom";
import { getConnectedUser } from "../shared/state";
import { broadcastOperation } from "../shared/keychain";

export function initPermissions() {
	// Form submit handlers
	$("btn-asset-approve")?.addEventListener("click", () => submitPermission("asset-approve"));
	$("btn-asset-approve-all")?.addEventListener("click", () => submitPermission("asset-approve-all"));
	$("btn-asset-transfer-from")?.addEventListener("click", () => submitPermission("asset-transfer-from"));
	$("btn-asset-lend")?.addEventListener("click", () => submitPermission("asset-lend"));
	$("btn-asset-return")?.addEventListener("click", () => submitPermission("asset-return"));
	$("btn-data-operator-approve")?.addEventListener("click", () => submitPermission("data-operator-approve"));
	$("btn-set-data-from")?.addEventListener("click", () => submitPermission("set-data-from"));
}

function getFormData(action: string): Record<string, unknown> | null {
	const val = (id: string) => ($(id) as HTMLInputElement)?.value.trim();
	const checked = (id: string) => ($(id) as HTMLInputElement)?.checked ?? false;

	switch (action) {
		case "asset-approve":
			return {
				instanceId: val("perm-asset-approve-instance"),
				spender: val("perm-asset-approve-spender"),
				approved: checked("perm-asset-approve-approved"),
				owner: getConnectedUser(),
			};
		case "asset-approve-all":
			return {
				collectionId: val("perm-asset-approve-all-collection"),
				spender: val("perm-asset-approve-all-spender"),
				approved: checked("perm-asset-approve-all-approved"),
				owner: getConnectedUser(),
			};
		case "asset-transfer-from":
			return {
				from: val("perm-asset-xfer-from"),
				to: val("perm-asset-xfer-to"),
				instanceId: val("perm-asset-xfer-instance"),
				spender: getConnectedUser(),
			};
		case "asset-lend":
			return {
				instanceId: val("perm-lend-instance"),
				borrower: val("perm-lend-borrower"),
				owner: getConnectedUser(),
			};
		case "asset-return":
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
			return {
				assetId: val("perm-set-data-from-asset"),
				assetDna: val("perm-set-data-from-dna"),
				data,
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
