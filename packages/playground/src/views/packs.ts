// Packs view — browse, create, buy, open, transfer packs
import { $, log, PLACEHOLDER_SM } from "../shared/dom";
import { getConnectedUser } from "../shared/state";
import { broadcastOperation } from "../shared/keychain";

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
			<div class="nft-card pack-card" data-id="${pack.id}" onclick="loadPackDetail('${pack.id}')">
				${pack.image_url ? `<img class="nft-image" src="${pack.image_url}" onerror="this.src='${PLACEHOLDER_SM}'">` : `<div class="nft-image" style="background: var(--surface-2); display: flex; align-items: center; justify-content: center; font-size: 32px;">📦</div>`}
				<div class="nft-name">${pack.name}</div>
				<div class="nft-owner">@${pack.creator}</div>
				<div class="nft-id" style="display: flex; justify-content: space-between; font-size: 12px;">
					<span>${pack.current_supply}/${pack.max_supply} minted</span>
					${pack.price_amount ? `<span style="color: var(--accent);">${pack.price_amount} ${pack.price_currency}</span>` : '<span style="color: var(--text-dim);">Free</span>'}
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
						<td style="font-family: var(--mono); font-size: 12px;">${entry.seedId}</td>
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
							<td>${h.event_type}</td>
							<td>@${h.account}</td>
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
			<div class="nft-card" onclick="loadPackDetail('${p.pack_id}')">
				<div class="nft-name">${p.name}</div>
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

(window as any).loadPacks = loadPacks;
(window as any).loadPackDetail = loadPackDetail;
(window as any).packAction = packAction;
(window as any).loadUserPacks = loadUserPacks;
(window as any).loadUserPacksOnPacksPage = loadUserPacksOnPacksPage;
