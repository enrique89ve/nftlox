// Packs view — browse, create, buy, open, transfer packs
import { $, log, escapeHtml, PLACEHOLDER_SM } from "../shared/dom";
import { getConnectedUser } from "../shared/state";
import { broadcastOperation } from "../shared/keychain";

let dropTableEntryCount = 0;
let loadedSeedData: Array<{ id: string; name: string; maxSupply: number; distributed: number }> = [];

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
	detailCard.scrollIntoView({ behavior: "smooth", block: "start" });

	try {
		const packRes = await fetch(`/api/pack/${packId}`);
		const pack = await packRes.json();

		// Pack info
		const nameEl = $("pack-detail-name");
		const creatorEl = $("pack-detail-creator");
		const statsEl = $("pack-detail-stats");
		const dropTableEl = $("pack-drop-table");
		const actionsEl = $("pack-detail-actions");

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
		const dropEntries = pack.drop_table || pack.dropTable || [];
		if (dropTableEl && dropEntries.length > 0) {
			const totalWeight = dropEntries.reduce((sum: number, e: any) => sum + e.weight, 0);
			dropTableEl.innerHTML = `<table class="data-table">
				<thead><tr><th>Seed ID</th><th>Weight</th><th>Probability</th></tr></thead>
				<tbody>${dropEntries.map((entry: any) => `
					<tr>
						<td style="font-family: var(--mono); font-size: 12px;">${escapeHtml(entry.seedId || entry.seed_id)}</td>
						<td>${entry.weight}</td>
						<td style="color: var(--accent);">${((entry.weight / totalWeight) * 100).toFixed(1)}%</td>
					</tr>
				`).join("")}</tbody>
			</table>`;
		} else if (dropTableEl) {
			dropTableEl.innerHTML = '<p style="color: var(--text-dim); font-size: 13px;">No drop table data</p>';
		}

		// Actions — always render, check connection on click
		if (actionsEl) {
			actionsEl.innerHTML = `
				<div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px;">
					<button class="btn btn-primary btn-sm" onclick="showPackActionForm('buy', '${packId}')">Buy</button>
					<button class="btn btn-secondary btn-sm" onclick="showPackActionForm('open', '${packId}')">Open</button>
					<button class="btn btn-secondary btn-sm" onclick="showPackActionForm('transfer', '${packId}')">Transfer</button>
				</div>
				<div id="pack-action-form" style="display: none; padding: 14px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px;"></div>
			`;
		}

		log(`Loaded pack: ${pack.name}`, "success");
	} catch (e) {
		log(`Error: ${(e as Error).message}`, "error");
	}
}

function showPackActionForm(action: "buy" | "open" | "transfer", packId: string) {
	const formEl = $("pack-action-form");
	if (!formEl) return;

	const labels: Record<string, string> = { buy: "Buy Packs", open: "Open Packs", transfer: "Transfer Packs" };
	const transferFields = action === "transfer"
		? `<div class="form-group" style="margin-bottom: 10px;">
				<label class="form-label">Recipient</label>
				<input type="text" class="form-input" id="pack-action-recipient" placeholder="username" style="font-size: 12px; padding: 8px 10px;">
			</div>`
		: "";

	formEl.style.display = "block";
	formEl.innerHTML = `
		<div style="font-size: 13px; font-weight: 500; margin-bottom: 10px; color: var(--text);">${labels[action]}</div>
		${transferFields}
		<div class="form-group" style="margin-bottom: 10px;">
			<label class="form-label">Quantity</label>
			<input type="number" class="form-input" id="pack-action-qty" value="1" min="1" style="width: 100px; font-size: 12px; padding: 8px 10px;">
		</div>
		<div style="display: flex; gap: 8px;">
			<button class="btn btn-primary btn-sm" onclick="executePackAction('${action}', '${packId}')">Confirm</button>
			<button class="btn btn-secondary btn-sm" onclick="document.getElementById('pack-action-form').style.display='none'">Cancel</button>
		</div>
	`;
	formEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function executePackAction(action: "buy" | "open" | "transfer", packId: string) {
	const user = getConnectedUser();
	if (!user) {
		log("Connect wallet first", "error");
		return;
	}

	const quantity = parseInt(($("pack-action-qty") as HTMLInputElement)?.value || "1", 10);
	if (isNaN(quantity) || quantity < 1) {
		log("Quantity must be at least 1", "error");
		return;
	}

	let endpoint = "";
	let body: Record<string, unknown> = {};

	if (action === "buy") {
		endpoint = "/api/build/pack-buy";
		body = { packId, buyer: user, quantity };
	} else if (action === "open") {
		endpoint = "/api/build/pack-open";
		body = { packId, opener: user, quantity };
	} else if (action === "transfer") {
		const to = ($("pack-action-recipient") as HTMLInputElement)?.value.trim().toLowerCase();
		if (!to) {
			log("Enter a recipient username", "error");
			return;
		}
		endpoint = "/api/build/pack-transfer";
		body = { packId, from: user, to, quantity };
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

		const formEl = $("pack-action-form");
		if (formEl) formEl.style.display = "none";

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
	const seed = loadedSeedData.find(s => s.id === seedId);
	const available = seed ? seed.maxSupply - seed.distributed : 0;
	const supplyLabel = seed ? `${available.toLocaleString()} avail` : "";
	const displayName = seedName || (seed?.name ?? "");

	const row = document.createElement("div");
	row.id = `drop-entry-${index}`;
	row.style.cssText = "display: grid; grid-template-columns: 1fr auto auto auto; gap: 8px; align-items: center; padding: 8px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; transition: border-color 0.15s;";

	row.innerHTML = `
		<div style="min-width: 0;">
			<input type="text" class="form-input" id="drop-seed-${index}" value="${escapeHtml(seedId)}" placeholder="Seed ID" style="font-size: 12px; padding: 6px 10px; margin-bottom: 2px;" oninput="recalculateSupply()">
			${displayName ? `<div style="font-size: 11px; color: var(--text-muted); padding-left: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</div>` : ""}
		</div>
		<div style="text-align: center;">
			<input type="number" class="form-input" id="drop-weight-${index}" value="${weight}" min="1" max="10000" style="width: 80px; font-size: 12px; padding: 6px 8px; text-align: center;" oninput="recalculateSupply()">
			<div style="font-size: 10px; color: var(--text-dim); margin-top: 2px;">weight</div>
		</div>
		${supplyLabel ? `<div style="font-family: var(--mono); font-size: 11px; color: var(--accent); white-space: nowrap; padding: 0 4px;">${supplyLabel}</div>` : '<div></div>'}
		<button class="btn btn-sm" style="color: var(--text-dim); padding: 4px 6px; font-size: 14px; line-height: 1;" onclick="removeDropTableEntry(${index})" title="Remove">&times;</button>
	`;
	container.appendChild(row);
	recalculateSupply();
}

function removeDropTableEntry(index: number) {
	const row = $(`drop-entry-${index}`);
	if (row) row.remove();
	recalculateSupply();
}

function recalculateSupply() {
	const entries = getDropTableEntries();
	const panel = $("pack-supply-analysis");
	const barsEl = $("pack-supply-bars");
	const summaryEl = $("pack-supply-summary");
	const statusEl = $("pack-supply-status");
	const hintEl = $("pack-max-supply-hint");

	if (!panel || !barsEl || !summaryEl || !statusEl) return;

	if (entries.length === 0 || loadedSeedData.length === 0) {
		panel.style.display = "none";
		if (hintEl) hintEl.textContent = "";
		return;
	}

	const itemsPerPack = parseInt(($("pack-items-per-pack") as HTMLInputElement)?.value, 10) || 3;
	const maxSupply = parseInt(($("pack-max-supply") as HTMLInputElement)?.value, 10) || 0;
	const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);

	if (totalWeight === 0) {
		panel.style.display = "none";
		return;
	}

	panel.style.display = "block";

	let bottleneckMax = Infinity;
	let bottleneckName = "";
	let hasError = false;

	const bars = entries.map(entry => {
		const seed = loadedSeedData.find(s => s.id === entry.seedId);
		if (!seed) return "";

		const maxReplicas = seed.maxSupply;
		const remaining = maxReplicas > 0 ? maxReplicas - seed.distributed : Infinity;
		const probability = entry.weight / totalWeight;
		const expectedDemand = maxSupply > 0 ? Math.ceil(maxSupply * itemsPerPack * probability) : 0;

		// How many packs this seed can support
		const seedMaxPacks = maxReplicas > 0
			? Math.floor((remaining * totalWeight) / (entry.weight * itemsPerPack))
			: Infinity;

		if (seedMaxPacks < bottleneckMax) {
			bottleneckMax = seedMaxPacks;
			bottleneckName = seed.name || seed.id;
		}

		const isOverflow = maxReplicas > 0 && expectedDemand > remaining;
		if (isOverflow) hasError = true;

		const barPct = maxReplicas > 0 ? Math.min(100, (expectedDemand / maxReplicas) * 100) : 0;
		const usedPct = maxReplicas > 0 ? Math.min(100, (seed.distributed / maxReplicas) * 100) : 0;
		const barColor = isOverflow ? "var(--error)" : "var(--accent)";

		return `<div style="margin-bottom: 10px;">
			<div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 3px;">
				<span style="font-size: 12px; color: var(--text); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 55%;">${escapeHtml(seed.name || seed.id)}</span>
				<span style="font-family: var(--mono); font-size: 11px; color: ${isOverflow ? 'var(--error)' : 'var(--text-muted)'};">
					${expectedDemand > 0 ? `~${expectedDemand.toLocaleString()} needed` : ""} / ${remaining === Infinity ? "unlimited" : remaining.toLocaleString() + " avail"}
				</span>
			</div>
			<div style="height: 6px; background: var(--surface); border-radius: 3px; overflow: hidden; position: relative;">
				<div style="position: absolute; left: 0; top: 0; height: 100%; width: ${usedPct}%; background: var(--text-dim); border-radius: 3px; opacity: 0.4;"></div>
				<div style="position: absolute; left: ${usedPct}%; top: 0; height: 100%; width: ${Math.min(barPct, 100 - usedPct)}%; background: ${barColor}; border-radius: 3px; transition: width 0.3s, background 0.3s;"></div>
			</div>
			<div style="display: flex; justify-content: space-between; margin-top: 2px;">
				<span style="font-size: 10px; color: var(--text-dim);">${(probability * 100).toFixed(1)}% chance</span>
				<span style="font-size: 10px; color: var(--text-dim);">cap: ${maxReplicas > 0 ? maxReplicas.toLocaleString() : "unlimited"}</span>
			</div>
		</div>`;
	}).filter(Boolean).join("");

	barsEl.innerHTML = bars;

	if (hasError) {
		statusEl.textContent = "OVER CAPACITY";
		statusEl.style.cssText = "font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; background: rgba(239,68,68,0.15); color: var(--error);";
		summaryEl.innerHTML = `<span style="color: var(--error);">Reduce max supply or adjust weights. Some seeds don't have enough remaining supply.</span>`;
	} else {
		statusEl.textContent = "OK";
		statusEl.style.cssText = "font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; background: var(--accent-dim); color: var(--accent);";
		if (bottleneckMax < Infinity) {
			summaryEl.innerHTML = `Bottleneck: <strong style="color: var(--text);">${escapeHtml(bottleneckName)}</strong> limits to <strong style="color: var(--accent);">${bottleneckMax.toLocaleString()}</strong> packs max.`;
		} else {
			summaryEl.innerHTML = `All seeds have unlimited supply.`;
		}
	}

	if (hintEl && bottleneckMax < Infinity && bottleneckMax > 0) {
		hintEl.textContent = `(max ${bottleneckMax.toLocaleString()})`;
	} else if (hintEl) {
		hintEl.textContent = "";
	}
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
		const response = await fetch(`/api/collection/${encodeURIComponent(collectionId)}/nfts`);
		const data = await response.json();
		const seeds = data.seeds?.items || [];

		if (seeds.length === 0) {
			log("No seeds found in this collection", "error");
			return;
		}

		// Store seed data for supply analysis
		loadedSeedData = seeds.map((s: any) => ({
			id: s.id,
			name: s.name || s.id,
			maxSupply: s.maxSupply ?? 0,
			distributed: s.distributed ?? 0,
		}));

		// Clear existing entries
		const container = $("pack-drop-table-entries");
		if (container) container.innerHTML = "";
		dropTableEntryCount = 0;

		for (const seed of loadedSeedData) {
			addDropTableEntry(seed.id, 100, seed.name);
		}

		// Auto-set max supply to bottleneck value
		autoSetMaxSupply();
		log(`Loaded ${seeds.length} seeds into drop table`, "success");
	} catch (e) {
		log(`Error loading seeds: ${(e as Error).message}`, "error");
	}
}

function autoSetMaxSupply() {
	const entries = getDropTableEntries();
	const itemsPerPack = parseInt(($("pack-items-per-pack") as HTMLInputElement)?.value, 10) || 3;
	const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
	if (totalWeight === 0 || entries.length === 0) return;

	let bottleneck = Infinity;
	for (const entry of entries) {
		const seed = loadedSeedData.find(s => s.id === entry.seedId);
		if (!seed || seed.maxSupply === 0) continue;
		const remaining = seed.maxSupply - seed.distributed;
		const maxPacks = Math.floor((remaining * totalWeight) / (entry.weight * itemsPerPack));
		if (maxPacks < bottleneck) bottleneck = maxPacks;
	}

	const maxSupplyInput = $("pack-max-supply") as HTMLInputElement | null;
	if (maxSupplyInput && bottleneck > 0 && bottleneck < Infinity) {
		maxSupplyInput.value = String(bottleneck);
	}
	recalculateSupply();
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
(window as any).showPackActionForm = showPackActionForm;
(window as any).executePackAction = executePackAction;
(window as any).loadUserPacks = loadUserPacks;
(window as any).loadUserPacksOnPacksPage = loadUserPacksOnPacksPage;
(window as any).togglePackCreateForm = togglePackCreateForm;
(window as any).addDropTableEntry = addDropTableEntry;
(window as any).removeDropTableEntry = removeDropTableEntry;
(window as any).loadCollectionsForPack = loadCollectionsForPack;
(window as any).selectCollectionForPack = selectCollectionForPack;
(window as any).loadSeedsForDropTable = loadSeedsForDropTable;
(window as any).recalculateSupply = recalculateSupply;
(window as any).submitPackCreate = submitPackCreate;
