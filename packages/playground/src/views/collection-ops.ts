// Collection operations view — Bulk Distribute & Extend Schema
import { $, log, escapeHtml } from "../shared/dom";
import { getConnectedUser } from "../shared/state";
import { broadcastOperation } from "../shared/keychain";

// ============ BULK DISTRIBUTE ============

interface SeedItem {
	seedId: string;
	quantity: number;
	seedTxId: string;
}

let loadedSeeds: Array<{ nft_id: string; tx_id: string; name?: string }> = [];

function addDistributeItemRow() {
	const container = $("bulk-dist-items");
	if (!container) return;

	const index = container.children.length;
	const row = document.createElement("div");
	row.className = "form-row";
	row.dataset.index = String(index);
	row.style.alignItems = "flex-end";

	const seedOptions = loadedSeeds.length > 0
		? loadedSeeds.map(s =>
			`<option value="${escapeHtml(s.nft_id)}" data-txid="${escapeHtml(s.tx_id)}">${escapeHtml(s.name || s.nft_id)}</option>`
		).join("")
		: "";

	row.innerHTML = `
		<div class="form-group" style="flex: 2;">
			<label class="form-label">Seed ID</label>
			<select class="form-input bulk-dist-seed-select">
				<option value="">Select a seed...</option>
				${seedOptions}
			</select>
		</div>
		<div class="form-group" style="flex: 1;">
			<label class="form-label">Quantity</label>
			<input class="form-input bulk-dist-qty" type="number" value="1" min="1">
		</div>
		<div class="form-group" style="flex: 2;">
			<label class="form-label">Seed TX ID</label>
			<input class="form-input bulk-dist-txid" placeholder="Auto-filled on select">
		</div>
		<div class="form-group" style="flex: 0 0 auto;">
			<button class="btn btn-secondary btn-sm bulk-dist-remove" style="margin-bottom: 2px;">Remove</button>
		</div>
	`;

	const select = row.querySelector(".bulk-dist-seed-select") as HTMLSelectElement;
	const txInput = row.querySelector(".bulk-dist-txid") as HTMLInputElement;
	select?.addEventListener("change", () => {
		const selected = select.options[select.selectedIndex];
		const txid = selected?.dataset.txid ?? "";
		if (txInput) txInput.value = txid;
	});

	row.querySelector(".bulk-dist-remove")?.addEventListener("click", () => {
		row.remove();
	});

	container.appendChild(row);
}

function collectDistributeItems(): SeedItem[] {
	const container = $("bulk-dist-items");
	if (!container) return [];

	const items: SeedItem[] = [];
	for (const row of Array.from(container.children)) {
		const seedId = (row.querySelector(".bulk-dist-seed-select") as HTMLSelectElement)?.value.trim();
		const qty = parseInt((row.querySelector(".bulk-dist-qty") as HTMLInputElement)?.value || "0", 10);
		const txId = (row.querySelector(".bulk-dist-txid") as HTMLInputElement)?.value.trim();
		if (seedId && qty > 0 && txId) {
			items.push({ seedId, quantity: qty, seedTxId: txId });
		}
	}
	return items;
}

async function loadSeedsForDistribute() {
	const collectionId = ($ ("bulk-dist-collection") as HTMLInputElement)?.value.trim();
	if (!collectionId) {
		log("Enter a collection ID first", "error");
		return;
	}

	try {
		const response = await fetch(`/api/collection/${encodeURIComponent(collectionId)}/nfts?limit=50`);
		const data = await response.json();

		if (!response.ok) {
			log(`Failed to load seeds: ${data.error || "Unknown error"}`, "error");
			return;
		}

		const nfts: any[] = data.nfts || [];
		loadedSeeds = nfts
			.filter((n: any) => n.type === "seed")
			.map((n: any) => ({ nft_id: n.nft_id, tx_id: n.tx_id, name: n.name }));

		if (loadedSeeds.length === 0) {
			log("No seeds found in this collection", "error");
			return;
		}

		log(`Loaded ${loadedSeeds.length} seeds`, "success");

		// Refresh existing select dropdowns
		refreshSeedSelects();
	} catch (e) {
		log(`Error loading seeds: ${(e as Error).message}`, "error");
	}
}

function refreshSeedSelects() {
	const container = $("bulk-dist-items");
	if (!container) return;

	const options = loadedSeeds.map(s =>
		`<option value="${escapeHtml(s.nft_id)}" data-txid="${escapeHtml(s.tx_id)}">${escapeHtml(s.name || s.nft_id)}</option>`
	).join("");

	for (const select of Array.from(container.querySelectorAll(".bulk-dist-seed-select"))) {
		const sel = select as HTMLSelectElement;
		const current = sel.value;
		sel.innerHTML = `<option value="">Select a seed...</option>${options}`;
		if (current) sel.value = current;
	}
}

async function submitBulkDistribute() {
	const user = getConnectedUser();
	if (!user) {
		log("Connect wallet first", "error");
		return;
	}

	const collectionId = ($("bulk-dist-collection") as HTMLInputElement)?.value.trim();
	const recipientsRaw = ($("bulk-dist-recipients") as HTMLTextAreaElement)?.value.trim();
	const items = collectDistributeItems();

	if (!collectionId) {
		log("Collection ID is required", "error");
		return;
	}
	if (items.length === 0) {
		log("Add at least one seed item", "error");
		return;
	}

	const recipients = recipientsRaw
		.split("\n")
		.map(r => r.trim().toLowerCase())
		.filter(Boolean);

	if (recipients.length === 0) {
		log("Add at least one recipient", "error");
		return;
	}

	const body = {
		collectionId,
		signer: user,
		owner: user,
		items,
		recipients,
	};

	try {
		const response = await fetch("/api/build/bulk-distribute", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const result = await response.json();

		if (!result.success) {
			const errMsg = result.error || result.errors?.map((e: any) => e.message).join(", ");
			log(`Bulk distribute error: ${errMsg}`, "error");
			return;
		}

		log("Bulk distribute preview generated", "success");

		const previewEl = $("bulk-dist-preview");
		if (previewEl) {
			previewEl.style.display = "block";
			const jsonEl = $("bulk-dist-json");
			if (jsonEl) jsonEl.textContent = JSON.stringify(result, null, 2);
		}

		broadcastOperation(
			user,
			[result.operation],
			result.keyType || "Posting",
			() => log("Bulk distribute broadcast successful!", "success"),
			(err) => log(`Bulk distribute failed: ${err}`, "error"),
		);
	} catch (e) {
		log(`Error: ${(e as Error).message}`, "error");
	}
}

// ============ EXTEND SCHEMA ============

function addSchemaFieldRow() {
	const container = $("extend-schema-fields");
	if (!container) return;

	const row = document.createElement("div");
	row.className = "form-row";
	row.style.alignItems = "flex-end";

	row.innerHTML = `
		<div class="form-group" style="flex: 2;">
			<label class="form-label">Field Name</label>
			<input class="form-input ext-field-name" placeholder="e.g. rarity">
		</div>
		<div class="form-group" style="flex: 1;">
			<label class="form-label">Type</label>
			<select class="form-input ext-field-type">
				<option value="string">string</option>
				<option value="number">number</option>
				<option value="boolean">boolean</option>
				<option value="json">json</option>
			</select>
		</div>
		<div class="form-group" style="flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding-bottom: 2px;">
			<input type="checkbox" class="ext-field-mutable">
			<label style="font-size: 13px;">Mutable</label>
		</div>
		<div class="form-group" style="flex: 0 0 auto;">
			<button class="btn btn-secondary btn-sm ext-field-remove" style="margin-bottom: 2px;">Remove</button>
		</div>
	`;

	row.querySelector(".ext-field-remove")?.addEventListener("click", () => {
		row.remove();
	});

	container.appendChild(row);
}

function collectSchemaFields(): Array<{ name: string; type: string; mutable: boolean }> {
	const container = $("extend-schema-fields");
	if (!container) return [];

	const fields: Array<{ name: string; type: string; mutable: boolean }> = [];
	for (const row of Array.from(container.children)) {
		const name = (row.querySelector(".ext-field-name") as HTMLInputElement)?.value.trim();
		const type = (row.querySelector(".ext-field-type") as HTMLSelectElement)?.value;
		const mutable = (row.querySelector(".ext-field-mutable") as HTMLInputElement)?.checked ?? false;
		if (name && type) {
			fields.push({ name, type, mutable });
		}
	}
	return fields;
}

async function loadCurrentSchema() {
	const collectionId = ($("extend-schema-collection") as HTMLInputElement)?.value.trim();
	if (!collectionId) {
		log("Enter a collection ID first", "error");
		return;
	}

	const display = $("extend-schema-current");
	if (display) {
		display.innerHTML = "<p style='color: var(--text-dim);'>Loading...</p>";
		display.style.display = "block";
	}

	try {
		const response = await fetch(`/api/collection/${encodeURIComponent(collectionId)}`);
		const data = await response.json();

		if (!response.ok || data.error) {
			log(`Failed to load schema: ${data.error || "Unknown error"}`, "error");
			if (display) display.style.display = "none";
			return;
		}

		const schema = data.collection?.schema || data.schema;
		if (!schema || (!schema.immutable && !schema.mutable)) {
			log("No schema found for this collection", "error");
			if (display) display.style.display = "none";
			return;
		}

		const renderFields = (fields: Record<string, string>, label: string) => {
			const entries = Object.entries(fields);
			if (entries.length === 0) return "";
			return `
				<div style="margin-bottom: 8px;">
					<strong style="color: var(--text-muted); font-size: 12px; text-transform: uppercase;">${escapeHtml(label)}</strong>
					<div style="margin-top: 4px;">
						${entries.map(([k, v]) =>
							`<span style="display: inline-block; background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; margin: 2px 4px 2px 0; font-family: var(--mono); font-size: 12px;">${escapeHtml(k)}: <span style="color: var(--accent);">${escapeHtml(String(v))}</span></span>`
						).join("")}
					</div>
				</div>
			`;
		};

		if (display) {
			display.innerHTML =
				renderFields(schema.immutable || {}, "Immutable fields") +
				renderFields(schema.mutable || {}, "Mutable fields");
		}

		log("Current schema loaded", "success");
	} catch (e) {
		log(`Error loading schema: ${(e as Error).message}`, "error");
		if (display) display.style.display = "none";
	}
}

async function submitExtendSchema() {
	const user = getConnectedUser();
	if (!user) {
		log("Connect wallet first", "error");
		return;
	}

	const collectionId = ($("extend-schema-collection") as HTMLInputElement)?.value.trim();
	const fields = collectSchemaFields();

	if (!collectionId) {
		log("Collection ID is required", "error");
		return;
	}
	if (fields.length === 0) {
		log("Add at least one new field", "error");
		return;
	}

	const body = {
		collectionId,
		fields,
		creator: user,
	};

	try {
		const response = await fetch("/api/build/extend-schema", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const result = await response.json();

		if (!result.success) {
			const errMsg = result.error || result.errors?.map((e: any) => e.message).join(", ");
			log(`Extend schema error: ${errMsg}`, "error");
			return;
		}

		log("Extend schema preview generated", "success");

		const previewEl = $("extend-schema-preview");
		if (previewEl) {
			previewEl.style.display = "block";
			const jsonEl = $("extend-schema-json");
			if (jsonEl) jsonEl.textContent = JSON.stringify(result, null, 2);
		}

		broadcastOperation(
			user,
			[result.operation],
			result.keyType || "Posting",
			() => log("Extend schema broadcast successful!", "success"),
			(err) => log(`Extend schema failed: ${err}`, "error"),
		);
	} catch (e) {
		log(`Error: ${(e as Error).message}`, "error");
	}
}

// ============ INIT ============

export function initCollectionOps() {
	$("btn-load-seeds")?.addEventListener("click", loadSeedsForDistribute);
	$("btn-add-dist-item")?.addEventListener("click", addDistributeItemRow);
	$("btn-bulk-distribute")?.addEventListener("click", submitBulkDistribute);

	$("btn-load-schema")?.addEventListener("click", loadCurrentSchema);
	$("btn-add-schema-field")?.addEventListener("click", addSchemaFieldRow);
	$("btn-extend-schema")?.addEventListener("click", submitExtendSchema);
}
