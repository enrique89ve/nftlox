// Packs view — browse, create, buy, open, transfer packs
import { $, log, escapeHtml, PLACEHOLDER_SM } from "../shared/dom";
import { getConnectedUser } from "../shared/state";
import { broadcastOperation } from "../shared/keychain";

let dropTableEntryCount = 0;

export function initPacks() {
	loadPacks();
	$("btn-load-packs")?.addEventListener("click", loadPacks);
}

async function loadPacks() {
	const container = $("packs-container");
	if (!container) return;

	container.innerHTML = '<div class="empty-state"><p class="empty-state-text">Loading...</p></div>';

	try {
		const response = await fetch("/api/packs?limit=50");
		const data = await response.json();
		const packs = data.packs || [];

		if (packs.length === 0) {
			container.innerHTML = '<div class="empty-state"><p class="empty-state-text">No packs available</p></div>';
			return;
		}

		container.innerHTML = packs.map((pack: any) => `
			<div class="nft-card pack-card" data-id="${escapeHtml(pack.id)}" onclick="loadPackDetail('${escapeHtml(pack.id)}')">
				${pack.image_url ? `<img class="nft-image" src="${escapeHtml(pack.image_url)}" onerror="this.src='${PLACEHOLDER_SM}'">` : `<div class="nft-image" style="background: var(--surface-2); display: flex; align-items: center; justify-content: center; font-size: 32px;">📦</div>`}
				<div class="nft-name">${escapeHtml(pack.name)}</div>
				<div class="nft-owner">@${escapeHtml(pack.creator)}</div>
				<div class="nft-id" style="display: flex; justify-content: space-between; font-size: 12px;">
					<span>${pack.current_supply}/${pack.max_supply} minted</span>
					${pack.price_amount ? `<span style="color: var(--accent);">${escapeHtml(pack.price_amount)} ${escapeHtml(pack.price_currency)}</span>` : '<span style="color: var(--text-dim);">Free</span>'}
				</div>
				<div style="font-size: 11px; color: var(--text-dim); margin-top: 4px;">${pack.items_per_pack} items/pack</div>
			</div>
		`).join("");

		log(`Loaded ${packs.length} packs`, "success");
	} catch (e) {
		container.innerHTML = '<div class="empty-state"><p class="empty-state-text">Error loading packs</p></div>';
		log(`Error: ${(e as Error).message}`, "error");
	}
}

async function loadPackDetail(packId: string) {
	const detailCard = $("pack-detail-card");
	if (!detailCard) return;

	detailCard.style.display = "block";

	try {
		const [packRes, historyRes] = await Promise.all([
			fetch(`/api/pack/${packId}`),
			fetch(`/api/pack/${packId}/history?limit=20`),
		]);
		const pack = await packRes.json();
		const historyData = await historyRes.json();

		// Pack info
		const nameEl = $("pack-detail-name");
		const creatorEl = $("pack-detail-creator");
		const statsEl = $("pack-detail-stats");
		const dropTableEl = $("pack-drop-table");
		const actionsEl = $("pack-detail-actions");
		const historyEl = $("pack-detail-history");

		if (nameEl) nameEl.textContent = pack.name;
		if (creatorEl) creatorEl.textContent = `@${pack.creator}`;

		if (statsEl) {
			statsEl.innerHTML = `
				<div class="stat-box"><div class="stat-label">Supply</div><div class="stat-value">${pack.current_supply}/${pack.max_supply}</div></div>
				<div class="stat-box"><div class="stat-label">Opened</div><div class="stat-value">${pack.total_opened}</div></div>
				<div class="stat-box"><div class="stat-label">Items/Pack</div><div class="stat-value">${pack.items_per_pack}</div></div>
				${pack.price_amount ? `<div class="stat-box"><div class="stat-label">Price</div><div class="stat-value">${pack.price_amount} ${pack.price_currency}</div></div>` : ""}
			`;
		}

		// Drop table
		if (dropTableEl && pack.drop_table) {
			const totalWeight = pack.drop_table.reduce((sum: number, e: any) => sum + e.weight, 0);
			dropTableEl.innerHTML = `<table class="data-table">
				<thead><tr><th>Seed ID</th><th>Weight</th><th>Probability</th></tr></thead>
				<tbody>${pack.drop_table.map((entry: any) => `
					<tr>
						<td style="font-family: var(--mono); font-size: 12px;">${escapeHtml(entry.seedId)}</td>
						<td>${entry.weight}</td>
						<td style="color: var(--accent);">${((entry.weight / totalWeight) * 100).toFixed(1)}%</td>
					</tr>
				`).join("")}</tbody>
			</table>`;
		}

		// Actions
		if (actionsEl && getConnectedUser()) {
			actionsEl.innerHTML = `
				<div style="display: flex; gap: 8px; flex-wrap: wrap;">
					<button class="btn btn-primary btn-sm" onclick="packAction('buy', '${packId}')">Buy</button>
					<button class="btn btn-secondary btn-sm" onclick="packAction('open', '${packId}')">Open</button>
					<button class="btn btn-secondary btn-sm" onclick="packAction('transfer', '${packId}')">Transfer</button>
				</div>
			`;
		}

		// History
		if (historyEl) {
			const history = historyData.history || [];
			if (history.length > 0) {
				historyEl.innerHTML = `<table class="data-table">
					<thead><tr><th>Event</th><th>Account</th><th>Qty</th><th>Date</th></tr></thead>
					<tbody>${history.map((h: any) => `
						<tr>
							<td>${escapeHtml(h.event_type)}</td>
							<td>@${escapeHtml(h.account)}</td>
							<td>${h.quantity}</td>
							<td style="color: var(--text-dim);">${new Date(h.timestamp).toLocaleDateString()}</td>
						</tr>
					`).join("")}</tbody>
				</table>`;
			} else {
				historyEl.innerHTML = '<p style="color: var(--text-dim);">No history yet</p>';
			}
		}

		log(`Loaded pack: ${pack.name}`, "success");
	} catch (e) {
		log(`Error: ${(e as Error).message}`, "error");
	}
}

async function packAction(action: "buy" | "open" | "transfer", packId: string) {
	const user = getConnectedUser();
	if (!user) {
		log("Connect wallet first", "error");
		return;
	}

	let endpoint = "";
	let body: Record<string, unknown> = {};

	if (action === "buy") {
		const quantity = parseInt(prompt("Quantity to buy:") || "1", 10);
		if (isNaN(quantity) || quantity < 1) return;
		endpoint = "/api/build/pack-buy";
		body = { packId, buyer: user, quantity };
	} else if (action === "open") {
		const quantity = parseInt(prompt("Quantity to open:") || "1", 10);
		if (isNaN(quantity) || quantity < 1) return;
		endpoint = "/api/build/pack-open";
		body = { packId, opener: user, quantity };
	} else if (action === "transfer") {
		const to = prompt("Transfer to (username):");
		if (!to) return;
		const quantity = parseInt(prompt("Quantity:") || "1", 10);
		if (isNaN(quantity) || quantity < 1) return;
		endpoint = "/api/build/pack-transfer";
		body = { packId, from: user, to: to.toLowerCase(), quantity };
	}

	try {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const result = await response.json();

		if (!result.success) {
			log(`Error: ${result.errors?.[0]?.message || result.error}`, "error");
			return;
		}

		broadcastOperation(
			user,
			[result.operation],
			result.keyType || "Posting",
			() => {
				log(`Pack ${action} successful!`, "success");
				loadPackDetail(packId);
			},
			(err) => log(`Pack ${action} failed: ${err}`, "error"),
		);
	} catch (e) {
		log(`Error: ${(e as Error).message}`, "error");
	}
}

async function renderUserPacks(containerId: string) {
	const container = $(containerId);
	if (!container || !getConnectedUser()) return;

	container.innerHTML = '<div class="empty-state"><p class="empty-state-text">Loading...</p></div>';

	try {
		const response = await fetch(`/api/user/${getConnectedUser()}/packs`);
		const data = await response.json();
		const packs = data.packs || [];

		if (packs.length === 0) {
			container.innerHTML = '<div class="empty-state"><p class="empty-state-text">No packs owned</p></div>';
			return;
		}

		container.innerHTML = packs.map((p: any) => `
			<div class="nft-card" onclick="loadPackDetail('${escapeHtml(p.pack_id)}')">
				<div class="nft-name">${escapeHtml(p.name)}</div>
				<div class="nft-id" style="display: flex; justify-content: space-between;">
					<span>Balance: <strong>${p.balance}</strong></span>
					<span style="color: var(--accent);">${p.items_per_pack} items/pack</span>
				</div>
			</div>
		`).join("");

		log(`Loaded ${packs.length} pack balances`, "success");
	} catch (e) {
		log(`Error: ${(e as Error).message}`, "error");
	}
}

async function loadUserPacks() {
	await renderUserPacks("user-packs-container");
}

async function loadUserPacksOnPacksPage() {
	await renderUserPacks("packs-page-user-container");
}

// ============ PACK CREATION ============

function togglePackCreateForm() {
	const form = $("pack-create-form");
	const btn = $("btn-toggle-pack-form");
	if (!form || !btn) return;

	const isHidden = form.style.display === "none";
	form.style.display = isHidden ? "block" : "none";
	btn.textContent = isHidden ? "Hide Form" : "Show Form";

	if (isHidden && dropTableEntryCount === 0) {
		addDropTableEntry();
	}
}

function addDropTableEntry(seedId = "", weight = 100, seedName = "") {
	const container = $("pack-drop-table-entries");
	if (!container) return;

	const index = dropTableEntryCount++;
	const row = document.createElement("div");
	row.style.cssText = "display: flex; gap: 8px; align-items: center;";
	row.id = `drop-entry-${index}`;
	row.innerHTML = `
		<input type="text" class="form-input" id="drop-seed-${index}" placeholder="Seed ID" value="${escapeHtml(seedId)}" style="flex: 2;">
		${seedName ? `<span style="color: var(--text-muted); font-size: 12px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(seedName)}">${escapeHtml(seedName)}</span>` : ""}
		<input type="number" class="form-input" id="drop-weight-${index}" placeholder="Weight" value="${weight}" min="1" max="10000" style="width: 100px;">
		<button class="btn btn-sm" style="color: var(--error); padding: 4px 8px;" onclick="removeDropTableEntry(${index})">x</button>
	`;
	container.appendChild(row);
	updateDropPreview();
}

function removeDropTableEntry(index: number) {
	const row = $(`drop-entry-${index}`);
	if (row) row.remove();
	updateDropPreview();
}

function updateDropPreview() {
	const entries = getDropTableEntries();
	const preview = $("pack-drop-preview");
	const content = $("pack-drop-preview-content");
	if (!preview || !content) return;

	if (entries.length === 0) {
		preview.style.display = "none";
		return;
	}

	const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
	preview.style.display = "block";
	content.innerHTML = entries.map(e => {
		const pct = ((e.weight / totalWeight) * 100).toFixed(1);
		return `<div style="display: flex; justify-content: space-between; font-size: 12px; font-family: var(--mono); padding: 2px 0;">
			<span style="color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; max-width: 70%;">${escapeHtml(e.seedId)}</span>
			<span style="color: var(--accent);">${pct}%</span>
		</div>`;
	}).join("");
}

function getDropTableEntries(): Array<{ seedId: string; weight: number }> {
	const entries: Array<{ seedId: string; weight: number }> = [];
	for (let i = 0; i < dropTableEntryCount; i++) {
		const seedEl = $(`drop-seed-${i}`) as HTMLInputElement | null;
		const weightEl = $(`drop-weight-${i}`) as HTMLInputElement | null;
		if (!seedEl || !weightEl) continue;
		const seedId = seedEl.value.trim();
		const weight = parseInt(weightEl.value, 10);
		if (seedId && weight > 0) {
			entries.push({ seedId, weight });
		}
	}
	return entries;
}

async function loadCollectionsForPack() {
	const user = getConnectedUser();
	if (!user) {
		log("Connect wallet first", "error");
		return;
	}

	try {
		const response = await fetch(`/api/user/${encodeURIComponent(user)}/collections`);
		const data = await response.json();
		const collections = data.collections || [];

		const select = $("pack-collection-select") as HTMLSelectElement | null;
		if (!select) return;

		select.innerHTML = '<option value="">Select a collection...</option>';
		for (const col of collections) {
			const opt = document.createElement("option");
			opt.value = col.id;
			opt.textContent = `${col.name} (${col.symbol})`;
			select.appendChild(opt);
		}
		select.style.display = "block";
		log(`Loaded ${collections.length} collections`, "success");
	} catch (e) {
		log(`Error loading collections: ${(e as Error).message}`, "error");
	}
}

function selectCollectionForPack() {
	const select = $("pack-collection-select") as HTMLSelectElement | null;
	const input = $("pack-collection-id") as HTMLInputElement | null;
	if (!select || !input) return;

	if (select.value) {
		input.value = select.value;
	}
}

async function loadSeedsForDropTable() {
	const collectionId = ($("pack-collection-id") as HTMLInputElement | null)?.value.trim();
	if (!collectionId) {
		log("Enter a Collection ID first", "error");
		return;
	}

	try {
		const response = await fetch(`/api/collection/${encodeURIComponent(collectionId)}/nfts?limit=50`);
		const data = await response.json();
		const nfts = (data.nfts || []).filter((n: any) => n.nft_type === "seed");

		if (nfts.length === 0) {
			log("No seeds found in this collection", "error");
			return;
		}

		// Clear existing entries
		const container = $("pack-drop-table-entries");
		if (container) container.innerHTML = "";
		dropTableEntryCount = 0;

		for (const seed of nfts) {
			addDropTableEntry(seed.id, 100, seed.name);
		}
		log(`Loaded ${nfts.length} seeds into drop table`, "success");
	} catch (e) {
		log(`Error loading seeds: ${(e as Error).message}`, "error");
	}
}

async function submitPackCreate() {
	const user = getConnectedUser();
	if (!user) {
		log("Connect wallet first", "error");
		return;
	}

	const collectionId = ($("pack-collection-id") as HTMLInputElement)?.value.trim();
	const name = ($("pack-name") as HTMLInputElement)?.value.trim();
	const description = ($("pack-description") as HTMLTextAreaElement)?.value.trim();
	const imageUrl = ($("pack-image-url") as HTMLInputElement)?.value.trim();
	const itemsPerPack = parseInt(($("pack-items-per-pack") as HTMLInputElement)?.value, 10);
	const maxSupply = parseInt(($("pack-max-supply") as HTMLInputElement)?.value, 10);
	const priceAmount = ($("pack-price-amount") as HTMLInputElement)?.value.trim();
	const priceCurrency = ($("pack-price-currency") as HTMLSelectElement)?.value;

	const dropTable = getDropTableEntries();

	if (!collectionId || !name) {
		log("Collection ID and Pack Name are required", "error");
		return;
	}
	if (dropTable.length === 0) {
		log("Add at least one entry to the drop table", "error");
		return;
	}
	if (isNaN(itemsPerPack) || itemsPerPack < 1) {
		log("Items per pack must be at least 1", "error");
		return;
	}

	const body: Record<string, unknown> = {
		collectionId,
		name,
		dropTable,
		itemsPerPack,
		maxSupply: isNaN(maxSupply) ? 0 : maxSupply,
		creator: user,
	};

	if (description) body.description = description;
	if (imageUrl) body.imageUrl = imageUrl;
	if (priceAmount) {
		body.price = { amount: priceAmount, currency: priceCurrency || "HIVE" };
	}

	try {
		const response = await fetch("/api/build/pack-create", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const result = await response.json();

		if (!result.success) {
			const msg = result.errors?.map((e: any) => e.message).join(", ") || "Unknown error";
			log(`Pack create error: ${msg}`, "error");
			return;
		}

		const resultDiv = $("pack-create-result");
		if (resultDiv) {
			resultDiv.style.display = "block";
			resultDiv.innerHTML = `
				<strong>Pack ID:</strong> <span style="font-family: var(--mono); font-size: 12px;">${escapeHtml(result.packId)}</span><br>
				<span style="color: var(--text-muted);">Broadcasting via Keychain...</span>
			`;
		}

		broadcastOperation(
			user,
			[result.operation],
			result.keyType || "Posting",
			() => {
				log(`Pack "${name}" created! ID: ${result.packId}`, "success");
				if (resultDiv) {
					resultDiv.innerHTML = `
						<strong>Pack created successfully!</strong><br>
						<strong>Pack ID:</strong> <span style="font-family: var(--mono); font-size: 12px;">${escapeHtml(result.packId)}</span>
					`;
				}
				loadPacks();
			},
			(err) => {
				log(`Pack create broadcast failed: ${err}`, "error");
				if (resultDiv) {
					resultDiv.style.background = "rgba(239, 68, 68, 0.15)";
					resultDiv.style.borderColor = "var(--error)";
					resultDiv.innerHTML = `<strong>Broadcast failed:</strong> ${escapeHtml(String(err))}`;
				}
			},
		);
	} catch (e) {
		log(`Error: ${(e as Error).message}`, "error");
	}
}

(window as any).loadPacks = loadPacks;
(window as any).loadPackDetail = loadPackDetail;
(window as any).packAction = packAction;
(window as any).loadUserPacks = loadUserPacks;
(window as any).loadUserPacksOnPacksPage = loadUserPacksOnPacksPage;
(window as any).togglePackCreateForm = togglePackCreateForm;
(window as any).addDropTableEntry = addDropTableEntry;
(window as any).removeDropTableEntry = removeDropTableEntry;
(window as any).loadCollectionsForPack = loadCollectionsForPack;
(window as any).selectCollectionForPack = selectCollectionForPack;
(window as any).loadSeedsForDropTable = loadSeedsForDropTable;
(window as any).submitPackCreate = submitPackCreate;
