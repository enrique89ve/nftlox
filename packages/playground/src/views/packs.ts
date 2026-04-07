// Packs view — browse, create, buy, open, transfer packs
import { $, log, escapeHtml, PLACEHOLDER_SM } from "../shared/dom";
import { getConnectedUser } from "../shared/state";
import { broadcastOperation } from "../shared/keychain";

let dropTableEntryCount = 0;
let loadedSeedData: Array<{ id: string; name: string; maxSupply: number; distributed: number }> = [];

interface PackDropEntry {
	seedId?: string;
	seed_id?: string;
	weight: number;
}

interface PackRecord {
	id: string;
	creator: string;
	name: string;
	description: string | null;
	image_url: string | null;
	items_per_pack: number;
	price_amount: string | null;
	price_currency: string | null;
	max_supply: number;
	current_supply: number;
	total_opened: number;
	status: string;
	drop_table?: PackDropEntry[] | string | null;
	dropTable?: PackDropEntry[] | string | null;
}

interface UserPackBalanceRecord {
	pack_id: string;
	balance: number;
	name: string;
	description: string | null;
	image_url: string | null;
	collection_id: string;
	items_per_pack: number;
	price_amount: string | null;
	price_currency: string | null;
	max_supply: number;
	current_supply: number;
	status: string;
}

interface PacksResponse {
	packs?: PackRecord[];
}

interface UserPacksResponse {
	packs?: UserPackBalanceRecord[];
}

type PackAction = "buy" | "open" | "transfer" | "distribute";

const USER_PACK_CONTAINER_IDS = ["user-packs-container", "packs-page-user-container"] as const;
const CONNECT_WALLET_PACKS_MESSAGE = "Connect wallet to view your pack balances";
const EMPTY_PACK_WALLET_MESSAGE = "No packs in your wallet";

export function initPacks() {
	void refreshPackViews();
	$("btn-load-packs")?.addEventListener("click", () => void refreshPackViews());
}

export async function refreshPackViews(activePackId?: string) {
	await Promise.all([
		loadPacks(),
		syncUserPackSections(),
		...(activePackId ? [loadPackDetail(activePackId)] : []),
	]);
}

function getCurrentUser(): string | null {
	return getConnectedUser()?.trim().toLowerCase() ?? null;
}

function renderPackImage(imageUrl: string | null, packName: string): string {
	if (!imageUrl) {
		return `<div class="nft-image" style="background: var(--surface-2); display: flex; align-items: center; justify-content: center; font-size: 32px;" aria-label="Pack placeholder">📦</div>`;
	}

	return `<img class="nft-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(packName)} pack cover" onerror="this.src='${PLACEHOLDER_SM}'">`;
}

function getPackSupplyLabel(pack: Pick<PackRecord, "current_supply" | "max_supply">): string {
	return pack.max_supply > 0
		? `${pack.current_supply}/${pack.max_supply}`
		: `${pack.current_supply}/unlimited`;
}

function getPackUnopenedSupply(pack: Pick<PackRecord, "current_supply" | "total_opened">): number {
	return Math.max(pack.current_supply - pack.total_opened, 0);
}

function getPackPriceText(pack: Pick<PackRecord, "price_amount" | "price_currency">): string {
	return pack.price_amount
		? `${pack.price_amount} ${pack.price_currency ?? ""}`.trim()
		: "Free";
}

function createUserPackLookup(packs: UserPackBalanceRecord[]): Map<string, UserPackBalanceRecord> {
	return new Map(packs.map((pack) => [pack.pack_id, pack]));
}

async function fetchUserPackBalances(username: string): Promise<UserPackBalanceRecord[]> {
	const response = await fetch(`/api/user/${encodeURIComponent(username)}/packs`);
	if (!response.ok) {
		throw new Error(`Pack balance request failed (${response.status})`);
	}

	const data = await response.json() as UserPacksResponse;
	return Array.isArray(data.packs) ? data.packs : [];
}

function setUserPackContainersMessage(message: string) {
	for (const containerId of USER_PACK_CONTAINER_IDS) {
		const container = $(containerId);
		if (!container) continue;

		container.innerHTML = `<div class="empty-state"><p class="empty-state-text">${escapeHtml(message)}</p></div>`;
	}
}

async function syncUserPackSections() {
	const user = getCurrentUser();
	if (!user) {
		setUserPackContainersMessage(CONNECT_WALLET_PACKS_MESSAGE);
		return;
	}

	await Promise.all([
		renderUserPacks("user-packs-container"),
		renderUserPacks("packs-page-user-container"),
	]);
}

function renderPackCard(pack: PackRecord, currentUser: string | null, walletPack?: UserPackBalanceRecord): string {
	const walletBalance = walletPack?.balance ?? 0;
	const unopenedSupply = getPackUnopenedSupply(pack);
	const isCreator = currentUser !== null && currentUser === pack.creator.toLowerCase();

	const balanceBanner = walletBalance > 0
		? `
			<div style="margin-top: 10px; padding: 10px 12px; border-radius: 10px; background: ${isCreator ? "rgba(59, 130, 246, 0.12)" : "rgba(34, 197, 94, 0.12)"}; border: 1px solid ${isCreator ? "rgba(59, 130, 246, 0.24)" : "rgba(34, 197, 94, 0.24)"};">
				<div style="font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">${isCreator ? "Available to transfer" : "In your wallet"}</div>
				<div style="font-size: 18px; font-weight: 700; color: var(--text);">${walletBalance}</div>
			</div>
		`
		: isCreator
			? `
				<div style="margin-top: 10px; padding: 10px 12px; border-radius: 10px; background: rgba(148, 163, 184, 0.08); border: 1px solid var(--border);">
					<div style="font-size: 12px; color: var(--text-muted);">Your transferable balance is 0 right now</div>
				</div>
			`
			: "";

	return `
		<div class="nft-card pack-card" data-id="${escapeHtml(pack.id)}" onclick="loadPackDetail('${escapeHtml(pack.id)}')">
			${renderPackImage(pack.image_url, pack.name)}
			<div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">
				<div class="nft-name" style="margin-bottom: 0;">${escapeHtml(pack.name)}</div>
				${isCreator ? '<span style="font-size: 10px; padding: 4px 8px; border-radius: 999px; background: rgba(59, 130, 246, 0.12); color: var(--accent); border: 1px solid rgba(59, 130, 246, 0.24);">Creator</span>' : ""}
			</div>
			<div class="nft-owner">@${escapeHtml(pack.creator)}</div>
			${balanceBanner}
			<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 10px;">
				<div style="padding: 8px 10px; border-radius: 8px; background: var(--bg); border: 1px solid var(--border);">
					<div style="font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.06em;">Unopened</div>
					<div style="font-size: 15px; font-weight: 600; color: var(--text); margin-top: 2px;">${unopenedSupply}</div>
				</div>
				<div style="padding: 8px 10px; border-radius: 8px; background: var(--bg); border: 1px solid var(--border);">
					<div style="font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.06em;">Items/Pack</div>
					<div style="font-size: 15px; font-weight: 600; color: var(--text); margin-top: 2px;">${pack.items_per_pack}</div>
				</div>
			</div>
			<div class="nft-id" style="display: flex; justify-content: space-between; font-size: 12px; margin-top: 10px;">
				<span>${escapeHtml(getPackSupplyLabel(pack))} minted</span>
				<span style="color: ${pack.price_amount ? "var(--accent)" : "var(--text-dim)"};">${escapeHtml(getPackPriceText(pack))}</span>
			</div>
		</div>
	`;
}

function renderUserPackCard(pack: UserPackBalanceRecord): string {
	const totalItemsInside = pack.balance * pack.items_per_pack;

	return `
		<article class="nft-card" onclick="loadPackDetail('${escapeHtml(pack.pack_id)}')">
			${renderPackImage(pack.image_url, pack.name)}
			<div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">
				<div class="nft-name" style="margin-bottom: 0;">${escapeHtml(pack.name)}</div>
				<span style="font-size: 11px; padding: 4px 8px; border-radius: 999px; background: rgba(34, 197, 94, 0.12); border: 1px solid rgba(34, 197, 94, 0.24); color: var(--text);">
					${pack.balance} pack${pack.balance === 1 ? "" : "s"}
				</span>
			</div>
			<div style="font-size: 12px; color: var(--text-muted); margin-top: 6px;">Available to transfer or open right now</div>
			<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 10px;">
				<div style="padding: 8px 10px; border-radius: 8px; background: var(--bg); border: 1px solid var(--border);">
					<div style="font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.06em;">Wallet Balance</div>
					<div style="font-size: 15px; font-weight: 600; color: var(--text); margin-top: 2px;">${pack.balance}</div>
				</div>
				<div style="padding: 8px 10px; border-radius: 8px; background: var(--bg); border: 1px solid var(--border);">
					<div style="font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.06em;">Items Inside</div>
					<div style="font-size: 15px; font-weight: 600; color: var(--text); margin-top: 2px;">${totalItemsInside}</div>
				</div>
			</div>
			<div class="nft-id" style="display: flex; justify-content: space-between; font-size: 12px; margin-top: 10px;">
				<span>${pack.items_per_pack} items/pack</span>
				<span style="color: ${pack.price_amount ? "var(--accent)" : "var(--text-dim)"};">${escapeHtml(getPackPriceText(pack))}</span>
			</div>
		</article>
	`;
}

function isPackDropEntry(value: unknown): value is PackDropEntry {
	if (typeof value !== "object" || value === null) return false;

	const candidate = value as Partial<PackDropEntry>;
	return typeof candidate.weight === "number";
}

async function loadPacks() {
	const container = $("packs-container");
	if (!container) return;

	container.innerHTML = '<div class="empty-state"><p class="empty-state-text">Loading...</p></div>';

	try {
		const currentUser = getCurrentUser();
		const [response, userPacks] = await Promise.all([
			fetch("/api/packs?limit=50"),
			currentUser ? fetchUserPackBalances(currentUser) : Promise.resolve([]),
		]);
		if (!response.ok) {
			throw new Error(`Pack request failed (${response.status})`);
		}

		const data = await response.json() as PacksResponse;
		const packs = Array.isArray(data.packs) ? data.packs : [];
		const userPackLookup = createUserPackLookup(userPacks);

		if (packs.length === 0) {
			container.innerHTML = '<div class="empty-state"><p class="empty-state-text">No packs available</p></div>';
			return;
		}

		container.innerHTML = packs
			.map((pack) => renderPackCard(pack, currentUser, userPackLookup.get(pack.id)))
			.join("");

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
		const currentUser = getCurrentUser();
		const [packRes, userPacks] = await Promise.all([
			fetch(`/api/pack/${packId}`),
			currentUser ? fetchUserPackBalances(currentUser) : Promise.resolve([]),
		]);
		if (!packRes.ok) {
			throw new Error(`Pack detail request failed (${packRes.status})`);
		}

		const pack = await packRes.json() as PackRecord;
		const walletBalance = createUserPackLookup(userPacks).get(packId)?.balance ?? 0;
		const unopenedSupply = getPackUnopenedSupply(pack);
		const isCreator = currentUser !== null && currentUser === pack.creator.toLowerCase();

		// Pack info
		const nameEl = $("pack-detail-name");
		const creatorEl = $("pack-detail-creator");
		const statsEl = $("pack-detail-stats");
		const dropTableEl = $("pack-drop-table");
		const actionsEl = $("pack-detail-actions");

		if (nameEl) nameEl.textContent = pack.name;
		if (creatorEl) {
			creatorEl.innerHTML = `
				<span>@${escapeHtml(pack.creator)}</span>
				${walletBalance > 0 ? `<span style="margin-left: 10px; color: var(--accent);">Wallet balance: ${walletBalance}</span>` : ""}
			`;
		}

		if (statsEl) {
			statsEl.innerHTML = `
				<div class="stat-box"><div class="stat-label">Minted</div><div class="stat-value">${escapeHtml(getPackSupplyLabel(pack))}</div></div>
				<div class="stat-box"><div class="stat-label">Unopened</div><div class="stat-value">${unopenedSupply}</div></div>
				<div class="stat-box"><div class="stat-label">Opened</div><div class="stat-value">${pack.total_opened}</div></div>
				<div class="stat-box"><div class="stat-label">Items/Pack</div><div class="stat-value">${pack.items_per_pack}</div></div>
				<div class="stat-box"><div class="stat-label">Price</div><div class="stat-value">${escapeHtml(getPackPriceText(pack))}</div></div>
			`;
		}

		// Drop table — may come as JSON string from DB
		const rawDrop = pack.drop_table ?? pack.dropTable ?? [];
		let dropEntries: PackDropEntry[] = [];
		try {
			const parsed = typeof rawDrop === "string" ? JSON.parse(rawDrop) as unknown : rawDrop;
			if (Array.isArray(parsed)) {
				dropEntries = parsed.filter(isPackDropEntry);
			}
		} catch { /* invalid JSON, leave empty */ }
		if (dropTableEl && dropEntries.length > 0) {
			const totalWeight = dropEntries.reduce((sum, entry) => sum + entry.weight, 0);
			dropTableEl.innerHTML = `<table class="data-table">
				<thead><tr><th>Seed ID</th><th>Weight</th><th>Probability</th></tr></thead>
				<tbody>${dropEntries.map((entry) => `
					<tr>
						<td style="font-family: var(--mono); font-size: 12px;">${escapeHtml(entry.seedId ?? entry.seed_id ?? "")}</td>
						<td>${entry.weight}</td>
						<td style="color: var(--accent);">${totalWeight > 0 ? `${((entry.weight / totalWeight) * 100).toFixed(1)}%` : "0.0%"}</td>
					</tr>
				`).join("")}</tbody>
			</table>`;
		} else if (dropTableEl) {
			dropTableEl.innerHTML = '<p style="color: var(--text-dim); font-size: 13px;">No drop table data</p>';
		}

		// Actions — context-aware based on user role
		if (actionsEl) {
			const actionButtons = buildPackActionButtons(packId, walletBalance, isCreator, currentUser !== null);
			actionsEl.innerHTML = `
				${actionButtons}
				<div id="pack-action-form" style="display: none; padding: 14px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px;"></div>
			`;
		}

		log(`Loaded pack: ${pack.name}`, "success");
	} catch (e) {
		log(`Error: ${(e as Error).message}`, "error");
	}
}

function buildPackActionButtons(packId: string, walletBalance: number, isCreator: boolean, isConnected: boolean): string {
	const escapedPackId = escapeHtml(packId);
	if (!isConnected) {
		return '<p style="font-size: 13px; color: var(--text-muted);">Connect wallet to see your transferable balance for this pack</p>';
	}

	const walletLabel = isCreator ? "Available to transfer or distribute" : "Available to open or transfer";
	const walletDescription = walletBalance > 0
		? walletLabel
		: isCreator
			? "Your creator wallet does not have packs available to transfer right now"
			: "This wallet does not currently hold any packs from this drop";

	const actionButtons: string[] = [];
	if (walletBalance > 0) {
		if (isCreator) {
			actionButtons.push(
				`<button class="btn btn-secondary btn-sm" onclick="showPackActionForm('transfer', '${escapedPackId}', ${walletBalance})">Transfer</button>`,
				`<button class="btn btn-primary btn-sm" onclick="showPackActionForm('distribute', '${escapedPackId}', ${walletBalance})">Distribute</button>`,
			);
		} else {
			actionButtons.push(
				`<button class="btn btn-primary btn-sm" onclick="showPackActionForm('open', '${escapedPackId}', ${walletBalance})">Open</button>`,
				`<button class="btn btn-secondary btn-sm" onclick="showPackActionForm('transfer', '${escapedPackId}', ${walletBalance})">Transfer</button>`,
			);
		}
	}

	if (isCreator) {
		actionButtons.push(`<button class="btn btn-danger btn-sm" onclick="destroyPack('${escapedPackId}')">Destroy Pack</button>`);
	}

	return `
		<div style="display: grid; gap: 12px;">
			<div style="padding: 14px 16px; border-radius: 10px; background: var(--bg); border: 1px solid var(--border);">
				<div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-dim); margin-bottom: 6px;">
					${isCreator ? "Creator Wallet" : "Connected Wallet"}
				</div>
				<div style="font-size: 26px; font-weight: 700; line-height: 1; color: ${walletBalance > 0 ? "var(--accent)" : "var(--text)"};">${walletBalance}</div>
				<div style="font-size: 12px; color: var(--text-muted); margin-top: 6px;">${walletDescription}</div>
			</div>
			${actionButtons.length > 0 ? `<div style="display: flex; gap: 8px; flex-wrap: wrap;">${actionButtons.join("")}</div>` : ""}
		</div>
	`;
}

function showPackActionForm(action: PackAction, packId: string, availableBalance = 0) {
	const formEl = $("pack-action-form");
	if (!formEl) return;
	const escapedPackId = escapeHtml(packId);

	if (action !== "buy" && availableBalance < 1) {
		log("No pack balance available for this action", "error");
		return;
	}

	formEl.style.display = "block";

	if (action === "distribute") {
		formEl.innerHTML = `
			<div style="font-size: 13px; font-weight: 500; margin-bottom: 10px; color: var(--text);">Distribute Packs</div>
			<div style="margin-bottom: 12px; padding: 10px 12px; border-radius: 8px; background: rgba(34, 197, 94, 0.12); border: 1px solid rgba(34, 197, 94, 0.24); font-size: 12px; color: var(--text);">
				Available to transfer now: <strong>${availableBalance}</strong>
			</div>
			<div class="form-group" style="margin-bottom: 10px;">
				<label class="form-label">Recipients (one username per line)</label>
				<textarea class="form-input" id="pack-distribute-recipients" rows="5" placeholder="user1&#10;user2&#10;user3" style="font-size: 12px; padding: 8px 10px; resize: vertical;"></textarea>
			</div>
			<div class="form-group" style="margin-bottom: 10px;">
				<label class="form-label">Quantity per user</label>
				<input type="number" class="form-input" id="pack-distribute-qty" value="1" min="1" max="${availableBalance}" style="width: 100px; font-size: 12px; padding: 8px 10px;">
			</div>
			<div style="display: flex; gap: 8px;">
				<button class="btn btn-primary btn-sm" onclick="distributePacksToUsers('${escapedPackId}', ${availableBalance})">Distribute</button>
				<button class="btn btn-secondary btn-sm" onclick="document.getElementById('pack-action-form').style.display='none'">Cancel</button>
			</div>
			<div id="pack-distribute-progress" style="margin-top: 10px; display: none;"></div>
		`;
		formEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
		return;
	}

	const labels: Record<string, string> = { buy: "Buy Packs", open: "Open Packs", transfer: "Transfer Packs" };
	const balanceSummary = action === "buy"
		? ""
		: `
			<div style="margin-bottom: 12px; padding: 10px 12px; border-radius: 8px; background: rgba(34, 197, 94, 0.12); border: 1px solid rgba(34, 197, 94, 0.24); font-size: 12px; color: var(--text);">
				Available right now: <strong>${availableBalance}</strong>
			</div>
		`;
	const transferFields = action === "transfer"
		? `<div class="form-group" style="margin-bottom: 10px;">
				<label class="form-label">Recipient</label>
				<input type="text" class="form-input" id="pack-action-recipient" placeholder="username" style="font-size: 12px; padding: 8px 10px;">
			</div>`
		: "";

	formEl.innerHTML = `
		<div style="font-size: 13px; font-weight: 500; margin-bottom: 10px; color: var(--text);">${labels[action]}</div>
		${balanceSummary}
		${transferFields}
		<div class="form-group" style="margin-bottom: 10px;">
			<label class="form-label">Quantity</label>
			<input type="number" class="form-input" id="pack-action-qty" value="1" min="1" ${action === "buy" ? "" : `max="${availableBalance}"`} style="width: 100px; font-size: 12px; padding: 8px 10px;">
		</div>
		<div style="display: flex; gap: 8px;">
			<button class="btn btn-primary btn-sm" onclick="executePackAction('${action}', '${escapedPackId}', ${availableBalance})">Confirm</button>
			<button class="btn btn-secondary btn-sm" onclick="document.getElementById('pack-action-form').style.display='none'">Cancel</button>
		</div>
	`;
	formEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function executePackAction(action: "buy" | "open" | "transfer", packId: string, availableBalance = 0) {
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
	if (action !== "buy" && quantity > availableBalance) {
		log(`Only ${availableBalance} pack(s) are available for this action`, "error");
		return;
	}

	let endpoint = "";
	let body: Record<string, unknown> = {};

	if (action === "buy") {
		endpoint = "/api/build/pack-buy";
		body = { packId, buyer: user, quantity };
	} else if (action === "open") {
		endpoint = "/api/build/pack-open";
		body = { packId, owner: user, quantity };
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
			() => void refreshPackViews(packId).then(() => {
				log(`Pack ${action} successful!`, "success");
			}).catch((error: Error) => {
				log(`Pack ${action} succeeded, but refresh failed: ${error.message}`, "error");
			}),
			(err) => log(`Pack ${action} failed: ${err}`, "error"),
		);
	} catch (e) {
		log(`Error: ${(e as Error).message}`, "error");
	}
}

async function distributePacksToUsers(packId: string, availableBalance = 0) {
	const user = getConnectedUser();
	if (!user) {
		log("Connect wallet first", "error");
		return;
	}

	const recipientsRaw = ($("pack-distribute-recipients") as HTMLTextAreaElement)?.value ?? "";
	const quantity = parseInt(($("pack-distribute-qty") as HTMLInputElement)?.value || "1", 10);

	const recipients = recipientsRaw
		.split("\n")
		.map((line) => line.trim().toLowerCase())
		.filter((line) => line.length > 0);

	if (recipients.length === 0) {
		log("Enter at least one recipient", "error");
		return;
	}
	if (isNaN(quantity) || quantity < 1) {
		log("Quantity must be at least 1", "error");
		return;
	}

	const totalRequired = recipients.length * quantity;
	if (totalRequired > availableBalance) {
		log(`Need ${totalRequired} packs to distribute, but only ${availableBalance} are available`, "error");
		return;
	}

	const progressEl = $("pack-distribute-progress");
	if (progressEl) {
		progressEl.style.display = "block";
		progressEl.innerHTML = `<p style="font-size: 12px; color: var(--text-muted);">Starting distribution to ${recipients.length} users...</p>`;
	}

	let successCount = 0;
	let failCount = 0;

	for (const recipient of recipients) {
		try {
			const response = await fetch("/api/build/pack-transfer", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ packId, from: user, to: recipient, quantity }),
			});
			const result = await response.json();

			if (!result.success) {
				const msg = result.errors?.[0]?.message || result.error || "Unknown error";
				log(`Distribute to @${recipient} failed: ${msg}`, "error");
				failCount++;
				continue;
			}

			await broadcastOperationAsync(
				user,
				[result.operation],
				result.keyType || "Posting",
			);

			successCount++;
			log(`Transferred ${quantity} pack(s) to @${recipient}`, "success");
		} catch (e) {
			failCount++;
			log(`Distribute to @${recipient} error: ${(e as Error).message}`, "error");
		}

		if (progressEl) {
			const done = successCount + failCount;
			progressEl.innerHTML = `<p style="font-size: 12px; color: var(--text-muted);">Progress: ${done}/${recipients.length} (${successCount} ok, ${failCount} failed)</p>`;
		}
	}

	log(`Distribution complete: ${successCount} succeeded, ${failCount} failed`, successCount > 0 ? "success" : "error");

	const formEl = $("pack-action-form");
	if (formEl) formEl.style.display = "none";

	await refreshPackViews(packId);
}

function broadcastOperationAsync(
	user: string,
	operations: unknown[],
	keyType: "Posting" | "Active",
): Promise<void> {
	return new Promise((resolve, reject) => {
		broadcastOperation(
			user,
			operations,
			keyType,
			() => resolve(),
			(err) => reject(new Error(err)),
		);
	});
}

async function renderUserPacks(containerId: string) {
	const container = $(containerId);
	if (!container) return;

	const user = getCurrentUser();
	if (!user) {
		container.innerHTML = `<div class="empty-state"><p class="empty-state-text">${escapeHtml(CONNECT_WALLET_PACKS_MESSAGE)}</p></div>`;
		return;
	}

	container.innerHTML = '<div class="empty-state"><p class="empty-state-text">Loading...</p></div>';

	try {
		const packs = await fetchUserPackBalances(user);

		if (packs.length === 0) {
			container.innerHTML = `<div class="empty-state"><p class="empty-state-text">${EMPTY_PACK_WALLET_MESSAGE}</p></div>`;
			return;
		}

		container.innerHTML = `
			<div class="nft-grid">
				${packs.map((pack) => renderUserPackCard(pack)).join("")}
			</div>
		`;

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
			const errors = Array.isArray(result.errors)
				? result.errors
					.map((error: { message?: string }) => error.message)
					.filter((message: string | undefined): message is string => typeof message === "string" && message.length > 0)
				: [];
			const msg = errors.join(", ") || "Unknown error";
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
				void refreshPackViews();
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

async function destroyPack(packId: string) {
	const user = getConnectedUser();
	if (!user) {
		log("Connect wallet first", "error");
		return;
	}

	const confirmed = confirm(
		`Are you sure you want to destroy this pack?\n\nAll remaining balances will be invalidated and reserved seed supply will be released. This cannot be undone.`
	);
	if (!confirmed) return;

	try {
		const response = await fetch("/api/build/pack-destroy", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ packId, creator: user }),
		});
		const result = await response.json();

		if (!result.success) {
			const errors = Array.isArray(result.errors)
				? result.errors
					.map((error: { message?: string }) => error.message)
					.filter((message: string | undefined): message is string => typeof message === "string" && message.length > 0)
				: [];
			const msg = errors.join(", ") || result.error;
			log(`Destroy error: ${msg}`, "error");
			return;
		}

		broadcastOperation(
			user,
			[result.operation],
			result.keyType || "Posting",
			() => {
				log(`Pack destroyed successfully`, "success");
				const detailCard = $("pack-detail-card");
				if (detailCard) detailCard.style.display = "none";
				void refreshPackViews();
			},
			(err) => log(`Destroy failed: ${err}`, "error"),
		);
	} catch (e) {
		log(`Error: ${(e as Error).message}`, "error");
	}
}

(window as any).destroyPack = destroyPack;
(window as any).loadPacks = loadPacks;
(window as any).loadPackDetail = loadPackDetail;
(window as any).showPackActionForm = showPackActionForm;
(window as any).executePackAction = executePackAction;
(window as any).distributePacksToUsers = distributePacksToUsers;
(window as any).loadUserPacks = loadUserPacks;
(window as any).loadUserPacksOnPacksPage = loadUserPacksOnPacksPage;
(window as any).refreshPackViews = refreshPackViews;
(window as any).togglePackCreateForm = togglePackCreateForm;
(window as any).addDropTableEntry = addDropTableEntry;
(window as any).removeDropTableEntry = removeDropTableEntry;
(window as any).loadCollectionsForPack = loadCollectionsForPack;
(window as any).selectCollectionForPack = selectCollectionForPack;
(window as any).loadSeedsForDropTable = loadSeedsForDropTable;
(window as any).recalculateSupply = recalculateSupply;
(window as any).submitPackCreate = submitPackCreate;
