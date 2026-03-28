import {
	createAtomicTransferOperations,
	getTrackingAmount,
	createBulkDistributePayload,
	PROTOCOL_ID,
	type SeedNFTWithArtId,
	type HiveOperation,
} from "nftlox-sdk";
import {
	createSession,
	saveSession,
	updateCollectionBroadcast,
	updateSeedBatch,
	initializeSeedBatches,
	type MintingSession,
} from "./persistence";
import { persistUser, clearUser } from "./shared/state";
import { $, log, mintLog, PLACEHOLDER_SM, PLACEHOLDER_LG } from "./shared/dom";

let connectedUser: string | null = null;
let _currentStep = 1;
let uploadedSeeds: SeedNFTWithArtId[] = [];
let previewData: any = null;
let broadcastPhase = 0;
let validationPassed = false;
let currentSession: MintingSession | null = null;
let broadcastedCount = 0;
let totalBroadcastOps = 0;

// ============ FETCH-BACKED HELPERS ============

async function getNFTsByOwner(owner: string, limit = 200, offset = 0) {
	const firstRes = await fetch(`/api/user/${encodeURIComponent(owner)}?limit=${limit}&offset=${offset}`);
	const firstData = await firstRes.json();
	const counts = firstData.counts ?? { total: 0, seeds: 0, instances: 0, replicas: 0 };
	const allNfts: any[] = firstData.nfts || [];

	if (counts.total > limit) {
		const totalPages = Math.ceil(counts.total / limit);
		const fetches = [];
		for (let page = 1; page < totalPages; page++) {
			fetches.push(
				fetch(`/api/user/${encodeURIComponent(owner)}?limit=${limit}&offset=${page * limit}`)
					.then(r => r.json())
					.then(d => d.nfts || [])
			);
		}
		const pages = await Promise.all(fetches);
		for (const nfts of pages) allNfts.push(...nfts);
	}

	return { nfts: allNfts, counts };
}

async function validateTransfer(nftId: string, currentUser: string) {
	try {
		const response = await fetch(`/api/nft/${encodeURIComponent(nftId)}/details`);
		const data = await response.json();

		if (data.error) {
			return { valid: false as const, error: data.error };
		}

		const nft = data.nft;

		if (nft.burned) {
			return { valid: false as const, error: "NFT has been burned" };
		}

		if (nft.owner.toLowerCase() !== currentUser.toLowerCase()) {
			return { valid: false as const, error: `You are not the owner (@${nft.owner})` };
		}

		if (nft.listed) {
			return { valid: true as const, warning: "Warning: Transfer will unlist NFT from marketplace", nft };
		}

		return { valid: true as const, nft };
	} catch (e) {
		return { valid: false as const, error: String(e) };
	}
}

// ============ NAVIGATION ============

let navigationStack: string[] = ["collections"];
let currentCollectionId: string | null = null;
let currentNftId: string | null = null;

function navigateTo(pageId: string) {
	document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
	document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));

	const page = $(`page-${pageId}`);
	const nav = document.querySelector(`.nav-item[data-page="${pageId}"]`);

	if (page) page.classList.add("active");
	if (nav) nav.classList.add("active");
}

function showPage(pageId: string) {
	navigationStack.push(pageId);
	navigateTo(pageId);
}

function goBack() {
	navigationStack.pop();
	const prevPage = navigationStack[navigationStack.length - 1] || "collections";
	navigateTo(prevPage);
}

(window as any).showPage = showPage;
(window as any).goBack = goBack;

document.querySelectorAll(".nav-item").forEach(item => {
	item.addEventListener("click", () => {
		const page = (item as HTMLElement).dataset.page;
		if (page) {
			navigationStack = [page];
			navigateTo(page);
		}
	});
});

// ============ KEYCHAIN & CONNECTION ============

function checkKeychain() {
	const dot = $("keychain-dot");
	if (!dot) return;

	if ((window as any).hive_keychain) {
		dot.classList.add("connected");
		log("Keychain detected", "success");
	} else {
		dot.classList.add("error");
		log("Keychain not found - install Hive Keychain extension", "error");
	}
}

$("btn-connect")?.addEventListener("click", () => {
	if (!(window as any).hive_keychain) {
		log("Keychain not available", "error");
		return;
	}

	(window as any).hive_keychain.requestHandshake(() => {
		const user = prompt("Enter your Hive username:");
		if (user) {
			connectedUser = user.toLowerCase();
			persistUser(connectedUser);
			showConnectedUI(connectedUser);
			log(`Connected as @${connectedUser}`, "success");
			loadInventory();
		}
	});
});

function showConnectedUI(user: string) {
	const display = $("user-display");
	const dot = $("keychain-dot");
	const btnConnect = $("btn-connect");
	const btnDisconnect = $("btn-disconnect");
	if (display) display.textContent = `@${user}`;
	if (dot) dot.classList.add("connected");
	if (btnConnect) btnConnect.style.display = "none";
	if (btnDisconnect) btnDisconnect.style.display = "";

	// Auto-fill creator field
	const creatorInput = $("col-creator") as HTMLInputElement;
	if (creatorInput && !creatorInput.value) {
		creatorInput.value = user;
	}
}

function resetDisconnectedUI() {
	const display = $("user-display");
	const dot = $("keychain-dot");
	const btnConnect = $("btn-connect");
	const btnDisconnect = $("btn-disconnect");
	if (display) display.textContent = "Not connected";
	if (dot) dot.classList.remove("connected");
	if (btnConnect) btnConnect.style.display = "";
	if (btnDisconnect) btnDisconnect.style.display = "none";
}

$("btn-disconnect")?.addEventListener("click", () => {
	connectedUser = null;
	clearUser();
	resetDisconnectedUI();
	log("Disconnected", "info");
});

// Restore session from localStorage on load
(function restoreSession() {
	const saved = localStorage.getItem("nftlox_user");
	if (saved) {
		connectedUser = saved;
		(window as any).__connectedUser = saved;
		showConnectedUI(saved);
		log(`Session restored: @${saved}`, "success");
		loadInventory();
	}
})();

// ============ COLLECTIONS ============

async function loadCollections() {
	const container = $("collections-container");
	if (!container) return;

	container.innerHTML = '<div class="empty-state"><p class="empty-state-text">Loading...</p></div>';

	try {
		const response = await fetch("/api/collections");
		const data = await response.json();

		if (data.collections.length === 0) {
			container.innerHTML = `
				<div class="empty-state">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<rect x="3" y="3" width="18" height="18" rx="2"/>
						<path d="M3 9h18M9 21V9"/>
					</svg>
					<p class="empty-state-text">No collections found</p>
				</div>
			`;
			return;
		}

		container.innerHTML = data.collections.map((col: any) => `
			<div class="collection-card" data-id="${col.id}">
				<span class="collection-symbol">${col.symbol}</span>
				<div class="collection-name">${col.name}</div>
				<div class="collection-meta">
					<span class="collection-creator">@${col.creator}</span>
				</div>
				<div class="collection-meta" style="margin-top: 4px;">${col.id}</div>
			</div>
		`).join("");

		log(`Loaded ${data.collections.length} collections`, "success");

		// Add click handlers to collection cards
		container.querySelectorAll(".collection-card").forEach(card => {
			card.addEventListener("click", () => {
				const id = (card as HTMLElement).dataset.id;
				if (id) loadCollectionDetail(id);
			});
		});
	} catch (e) {
		container.innerHTML = `
			<div class="empty-state">
				<p class="empty-state-text">Error loading collections</p>
			</div>
		`;
		log(`Error: ${(e as Error).message}`, "error");
	}
}

// Make it globally available
(window as any).loadCollections = loadCollections;

// ============ COLLECTION DETAIL ============

async function loadCollectionDetail(collectionId: string) {
	currentCollectionId = collectionId;
	navigationStack = ["collections", "collection-detail"];
	navigateTo("collection-detail");

	// Show loading state
	const seedsContainer = $("collection-seeds");
	const instancesContainer = $("collection-instances");
	if (seedsContainer) seedsContainer.innerHTML = '<div class="empty-state"><p class="empty-state-text">Loading...</p></div>';
	if (instancesContainer) instancesContainer.innerHTML = "";

	try {
		// Fetch collection info and NFTs
		const [colResponse, nftsResponse] = await Promise.all([
			fetch("/api/collections"),
			fetch(`/api/collection/${collectionId}/nfts`),
		]);

		const colData = await colResponse.json();
		const nftsData = await nftsResponse.json();

		// Find the collection info
		const collection = colData.collections?.find((c: any) => c.id === collectionId);

		// Update header
		const symbolEl = $("detail-symbol");
		const nameEl = $("detail-collection-name");
		const creatorEl = $("detail-creator");
		if (symbolEl) symbolEl.textContent = collection?.symbol || "N/A";
		if (nameEl) nameEl.textContent = collection?.name || collectionId;
		if (creatorEl) creatorEl.textContent = `@${collection?.creator || "unknown"}`;

		// Update stats
		const seedsCount = $("detail-seeds-count");
		const instancesCount = $("detail-instances-count");
		const totalCount = $("detail-total-count");
		if (seedsCount) seedsCount.textContent = String(nftsData.seeds?.count || 0);
		if (instancesCount) instancesCount.textContent = String(nftsData.instances?.count || 0);
		if (totalCount) totalCount.textContent = String(nftsData.totalCount || 0);

		// Render seeds
		if (seedsContainer) {
			const seeds = nftsData.seeds?.items || [];
			if (seeds.length === 0) {
				seedsContainer.innerHTML = '<div class="empty-state"><p class="empty-state-text">No seeds in this collection</p></div>';
			} else {
				seedsContainer.innerHTML = seeds.map((nft: any) => `
					<div class="nft-card" data-id="${nft.id}">
						<img class="nft-image" src="${nft.imageUrl}" onerror="this.src='${PLACEHOLDER_SM}'">
						<div class="nft-card-body">
							<div class="nft-name">${nft.name}</div>
							<div class="nft-owner">@${nft.owner}</div>
							<div class="nft-meta">
								<span class="nft-meta-supply">${nft.distributed || 0}/${nft.maxSupply}</span>
								<span class="nft-type-badge seed">SEED</span>
							</div>
						</div>
					</div>
				`).join("");

				// Add click handlers
				seedsContainer.querySelectorAll(".nft-card").forEach(card => {
					card.addEventListener("click", () => {
						const id = (card as HTMLElement).dataset.id;
						if (id) loadNftDetail(id);
					});
				});
			}
		}

		// Render instances
		if (instancesContainer) {
			const instances = nftsData.instances?.items || [];
			if (instances.length === 0) {
				instancesContainer.innerHTML = '<div class="empty-state"><p class="empty-state-text">No instances yet</p></div>';
			} else {
				instancesContainer.innerHTML = instances.map((nft: any) => `
					<div class="nft-card" data-id="${nft.id}">
						<img class="nft-image" src="${nft.imageUrl}" onerror="this.src='${PLACEHOLDER_SM}'">
						<div class="nft-card-body">
							<div class="nft-name">${nft.name}</div>
							<div class="nft-owner">@${nft.owner}</div>
							<div class="nft-meta">
								<span class="nft-meta-supply">#${nft.instanceNumber || 1}</span>
								<span class="nft-type-badge instance">INSTANCE</span>
							</div>
						</div>
					</div>
				`).join("");

				// Add click handlers
				instancesContainer.querySelectorAll(".nft-card").forEach(card => {
					card.addEventListener("click", () => {
						const id = (card as HTMLElement).dataset.id;
						if (id) loadNftDetail(id);
					});
				});
			}
		}

		log(`Loaded collection: ${collection?.name || collectionId}`, "success");
	} catch (e) {
		if (seedsContainer) {
			seedsContainer.innerHTML = '<div class="empty-state"><p class="empty-state-text">Error loading collection</p></div>';
		}
		log(`Error: ${(e as Error).message}`, "error");
	}
}

(window as any).loadCollectionDetail = loadCollectionDetail;

// ============ NFT DETAIL ============

async function loadNftDetail(nftId: string) {
	currentNftId = nftId;
	navigationStack.push("nft-detail");
	navigateTo("nft-detail");

	// Reset sections
	const parentSection = $("parent-section");
	const replicasSection = $("replicas-section");
	const seedInfoSection = $("seed-info-section");
	if (parentSection) parentSection.style.display = "none";
	if (replicasSection) replicasSection.style.display = "none";
	if (seedInfoSection) seedInfoSection.style.display = "none";

	try {
		const response = await fetch(`/api/nft/${nftId}/details`);
		const data = await response.json();

		if (data.error) {
			log(`NFT not found: ${data.error}`, "error");
			return;
		}

		const nft = data.nft;

		// Update basic info
		const imageEl = $("nft-detail-image") as HTMLImageElement;
		const nameEl = $("nft-detail-name");
		const ownerEl = $("nft-detail-owner");
		if (imageEl) {
			imageEl.src = nft.imageUrl;
			imageEl.onerror = () => { imageEl.src = PLACEHOLDER_LG; };
		}
		if (nameEl) nameEl.textContent = nft.name;
		if (ownerEl) ownerEl.textContent = `@${nft.owner}`;

		// Update badges
		const badgesEl = $("nft-detail-badges");
		if (badgesEl) {
			const badges: string[] = [];
			if (nft.isSeed) badges.push('<span class="nft-badge seed">SEED</span>');
			if (nft.seedId) badges.push('<span class="nft-badge instance">INSTANCE #' + (nft.instanceNumber || 1) + '</span>');
			if (nft.isReplica) badges.push('<span class="nft-badge replica">REPLICA</span>');
			if (nft.listed) badges.push('<span class="nft-badge listed">LISTED</span>');
			badgesEl.innerHTML = badges.join("");
		}

		// Update DNA info
		const originDnaEl = $("nft-detail-origin-dna");
		const instanceDnaEl = $("nft-detail-instance-dna");
		const idEl = $("nft-detail-id");
		const collectionIdEl = $("nft-detail-collection-id");
		if (originDnaEl) originDnaEl.textContent = nft.originDna || "-";
		if (instanceDnaEl) instanceDnaEl.textContent = nft.instanceDna || "-";
		if (idEl) idEl.textContent = nft.id;
		if (collectionIdEl) collectionIdEl.textContent = nft.collectionId;

		// Seed-specific info
		if (nft.isSeed && seedInfoSection) {
			seedInfoSection.style.display = "block";
			const maxSupplyEl = $("nft-detail-max-supply");
			const distributedEl = $("nft-detail-distributed");
			if (maxSupplyEl) maxSupplyEl.textContent = String(nft.maxSupply || 0);
			if (distributedEl) distributedEl.textContent = String(nft.distributed || 0);
		}

		// Parent NFT (if instance/replica)
		if (data.original && parentSection) {
			parentSection.style.display = "block";
			const parentItem = $("nft-parent-item");
			const parentName = $("nft-parent-name");
			if (parentName) parentName.textContent = data.original.name;
			if (parentItem) {
				parentItem.onclick = () => loadNftDetail(data.original.id);
			}
		}

		// Replicas/Instances
		if (data.replicas && data.replicas.count > 0 && replicasSection) {
			replicasSection.style.display = "block";
			const countEl = $("replicas-count");
			const listEl = $("nft-replicas-list");
			if (countEl) countEl.textContent = String(data.replicas.count);
			if (listEl) {
				listEl.innerHTML = data.replicas.items.map((r: any) => `
					<div class="replica-item" data-id="${r.id}">
						<span class="replica-num">#${r.instanceNumber || "?"}</span>
						<span class="replica-owner">@${r.owner}</span>
					</div>
				`).join("");

				// Add click handlers
				listEl.querySelectorAll(".replica-item").forEach(item => {
					item.addEventListener("click", () => {
						const id = (item as HTMLElement).dataset.id;
						if (id) loadNftDetail(id);
					});
				});
			}
		}

		// Actions section (visible when owner)
		const actionsSection = $("nft-actions-section");
		const actionSeedButtons = $("nft-action-seed-buttons");
		const actionInstanceButtons = $("nft-action-instance-buttons");
		const actionQuantityGroup = $("nft-action-quantity-group");
		const isOwner = connectedUser && nft.owner.toLowerCase() === connectedUser.toLowerCase();

		if (actionsSection) {
			if (isOwner) {
				actionsSection.style.display = "block";
				if (nft.isSeed) {
					const remaining = (nft.maxSupply || 0) - (nft.distributed || 0);
					if (actionSeedButtons) actionSeedButtons.style.display = "block";
					if (actionInstanceButtons) actionInstanceButtons.style.display = "none";
					const quantityInput = $("nft-action-quantity") as HTMLInputElement;
					const remainingEl = $("nft-action-remaining");
					if (quantityInput) { quantityInput.max = String(remaining); quantityInput.value = "1"; }
					if (remainingEl) remainingEl.textContent = `/ ${remaining} remaining`;
				} else {
					if (actionSeedButtons) actionSeedButtons.style.display = "none";
					if (actionInstanceButtons) actionInstanceButtons.style.display = "block";
					const listForm = $("nft-action-list-form");
					const unlistForm = $("nft-action-unlist-form");
					const listingInfo = $("nft-action-listing-info");
					if (nft.listed) {
						if (listForm) listForm.style.display = "none";
						if (unlistForm) unlistForm.style.display = "block";
						if (listingInfo && nft.listingPrice) {
							listingInfo.textContent = `Currently listed for ${nft.listingPrice.amount} ${nft.listingPrice.currency}`;
						}
					} else {
						if (listForm) listForm.style.display = "block";
						if (unlistForm) unlistForm.style.display = "none";
					}
				}
			} else {
				actionsSection.style.display = "none";
			}
		}

		// Provenance
		const mintedByEl = $("nft-detail-minted-by");
		const mintedAtEl = $("nft-detail-minted-at");
		if (mintedByEl) mintedByEl.textContent = nft.mintedBy ? `@${nft.mintedBy}` : "-";
		if (mintedAtEl) mintedAtEl.textContent = nft.mintedAt ? new Date(nft.mintedAt).toLocaleDateString() : "-";

		log(`Loaded NFT: ${nft.name}`, "success");
	} catch (e) {
		log(`Error: ${(e as Error).message}`, "error");
	}
}

(window as any).loadNftDetail = loadNftDetail;

// ============ NAVIGATION HELPERS ============

function goBackFromNft() {
	navigationStack.pop();
	const prevPage = navigationStack[navigationStack.length - 1] || "collections";

	if (prevPage === "collection-detail" && currentCollectionId) {
		navigateTo("collection-detail");
	} else {
		currentCollectionId = null;
		navigationStack = ["collections"];
		navigateTo("collections");
	}
}

(window as any).goBackFromNft = goBackFromNft;

function goBackToCollections() {
	currentCollectionId = null;
	navigationStack = ["collections"];
	navigateTo("collections");
}

(window as any).goBackToCollections = goBackToCollections;

// ============ INVENTORY ============

async function loadInventory() {
	const container = $("inventory-container");
	if (!container) return;

	if (!connectedUser) {
		container.innerHTML = `
			<div class="empty-state">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
				</svg>
				<p class="empty-state-text">Connect wallet to view inventory</p>
			</div>
		`;
		return;
	}

	container.innerHTML = '<div class="empty-state"><p class="empty-state-text">Loading...</p></div>';

	try {
		const result = await getNFTsByOwner(connectedUser, 200);
		const counts = result.counts;
		const seeds = result.nfts.filter((n: any) => n.isSeed);
		const instances = result.nfts.filter((n: any) => !n.isSeed);
		const totalCount = counts.total;

		if (totalCount === 0) {
			container.innerHTML = '<div class="empty-state"><p class="empty-state-text">No NFTs found</p></div>';
		} else {
			let html = "";

			if (seeds.length > 0) {
				html += `
					<div class="inventory-section">
						<div class="inventory-section-header">
							<span class="inventory-section-title" style="color: var(--accent);">Seeds</span>
							<span class="inventory-section-count" style="background: var(--accent-dim); color: var(--accent);">${counts.seeds}</span>
						</div>
						<div class="nft-grid" id="inventory-seeds"></div>
					</div>
				`;
			}

			if (instances.length > 0) {
				html += `
					<div class="inventory-section">
						<div class="inventory-section-header">
							<span class="inventory-section-title" style="color: #3b82f6;">Instances</span>
							<span class="inventory-section-count" style="background: rgba(59, 130, 246, 0.15); color: #3b82f6;">${counts.instances}</span>
						</div>
						<div class="nft-grid" id="inventory-instances"></div>
					</div>
				`;
			}

			container.innerHTML = html;

			if (seeds.length > 0) renderNfts(seeds, "inventory-seeds", true);
			if (instances.length > 0) renderNfts(instances, "inventory-instances", true);
		}

		log(`Loaded ${totalCount} NFTs (${counts.seeds} seeds, ${counts.instances} instances)`, "success");
	} catch (e) {
		log(`Error: ${(e as Error).message}`, "error");
	}
}

(window as any).loadInventory = loadInventory;

// ============ SEARCH ============

async function searchUser() {
	const input = $("search-user") as HTMLInputElement;
	const user = input?.value.trim().toLowerCase();
	if (!user) {
		log("Enter a username", "error");
		return;
	}

	const container = $("search-results");
	if (!container) return;

	container.innerHTML = '<div class="empty-state"><p class="empty-state-text">Searching...</p></div>';

	try {
		const result = await getNFTsByOwner(user);
		renderNfts(result.nfts, "search-results");
		log(`Found ${result.nfts.length} NFTs for @${user}`, "success");
	} catch (e) {
		log(`Error: ${(e as Error).message}`, "error");
	}
}

(window as any).searchUser = searchUser;

// ============ RENDER NFTS ============

function renderNfts(nfts: any[], containerId: string, selectable = false) {
	const container = $(containerId);
	if (!container) return;

	if (nfts.length === 0) {
		container.innerHTML = `
			<div class="empty-state">
				<p class="empty-state-text">No NFTs found</p>
			</div>
		`;
		return;
	}

	container.innerHTML = nfts.map(nft => {
		const isSeed = nft.isSeed;
		const typeLabel = isSeed ? "SEED" : "INSTANCE";
		const typeCls = isSeed ? "seed" : "instance";
		const supplyText = isSeed
			? `${nft.distributed || 0}/${nft.maxSupply || 0}`
			: `#${nft.instanceNumber || 1}`;

		return `
			<div class="nft-card" data-id="${nft.id}" data-collection="${nft.collectionId}"
				 data-edition="${nft.edition}" data-dna="${nft.instanceDna || ""}">
				<img class="nft-image" src="${nft.imageUrl || ""}" onerror="this.src='${PLACEHOLDER_SM}'">
				<div class="nft-card-body">
					<div class="nft-name">${nft.name}</div>
					<div class="nft-owner">@${nft.owner}</div>
					<div class="nft-meta">
						<span class="nft-meta-supply">${supplyText}</span>
						<span class="nft-type-badge ${typeCls}">${typeLabel}</span>
					</div>
				</div>
			</div>
		`;
	}).join("");

	if (selectable) {
		container.querySelectorAll(".nft-card").forEach(card => {
			(card as HTMLElement).onclick = () => {
				const id = (card as HTMLElement).dataset.id;
				if (id) loadNftDetail(id);
			};
		});
	}
}

// ============ TRANSFER ============

async function distributeFromSeed(seedId: string, to: string, quantity: number) {
	if (!connectedUser) {
		log("Connect wallet first", "error");
		return;
	}

	log(`Fetching seed info...`);
	const response = await fetch(`/api/nft/${seedId}/details`);
	const data = await response.json();

	if (data.error) {
		log(`Seed not found: ${data.error}`, "error");
		return;
	}

	const nft = data.nft;
	if (!nft.isSeed) {
		log("This is not a seed, cannot distribute", "error");
		return;
	}

	if (nft.owner.toLowerCase() !== connectedUser.toLowerCase()) {
		log(`You don't own this seed. Owner: @${nft.owner}`, "error");
		return;
	}

	const remaining = (nft.maxSupply || 0) - (nft.distributed || 0);
	if (quantity > remaining) {
		log(`Cannot distribute ${quantity}. Only ${remaining} remaining.`, "error");
		return;
	}

	// Use bulk_distribute: 1 single custom_json instead of 2N operations
	const payload = createBulkDistributePayload({
		to,
		items: [{ seedId, quantity }],
	});

	const operation: HiveOperation = [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [connectedUser],
			id: PROTOCOL_ID,
			json: JSON.stringify(payload),
		},
	];

	log(`Distributing ${quantity} instance(s) to @${to} via bulk_distribute...`);

	return new Promise<boolean>((resolve) => {
		(window as any).hive_keychain.requestBroadcast(
			connectedUser,
			[operation],
			"Posting",
			(res: any) => {
				if (res.success) {
					log(`Distributed ${quantity} instance(s) to @${to}!`, "success");
					resolve(true);
				} else {
					const err = typeof res.error === "object" ? JSON.stringify(res.error) : res.error;
					log(`Distribution failed: ${err}`, "error");
					resolve(false);
				}
			}
		);
	});
}

(window as any).distributeFromSeed = distributeFromSeed;


// ============ CREATE COLLECTION - STEPPER ============

function goToStep(step: number) {
	_currentStep = step;

	// Update stepper UI
	document.querySelectorAll(".step").forEach((s, i) => {
		s.classList.remove("active", "done");
		if (i + 1 < step) s.classList.add("done");
		if (i + 1 === step) s.classList.add("active");
	});

	// Show/hide content (step 4 = minting-progress card)
	[$("step-1-content"), $("step-2-content"), $("step-3-content"), $("minting-progress")].forEach((el, i) => {
		if (el) el.style.display = i + 1 === step ? "block" : "none";
	});
}

(window as any).goToStep = goToStep;

// ============ FILE UPLOAD ============

const uploadArea = $("upload-area");
const fileInput = $("file-input") as HTMLInputElement;

uploadArea?.addEventListener("click", () => fileInput?.click());

uploadArea?.addEventListener("dragover", (e) => {
	e.preventDefault();
	uploadArea.style.borderColor = "var(--accent)";
	uploadArea.style.background = "var(--accent-dim)";
});

uploadArea?.addEventListener("dragleave", () => {
	uploadArea.style.borderColor = "";
	uploadArea.style.background = "";
});

uploadArea?.addEventListener("drop", (e) => {
	e.preventDefault();
	uploadArea.style.borderColor = "";
	uploadArea.style.background = "";

	const file = (e as DragEvent).dataTransfer?.files[0];
	if (file) handleFileUpload(file);
});

fileInput?.addEventListener("change", () => {
	const file = fileInput.files?.[0];
	if (file) handleFileUpload(file);
});

async function handleFileUpload(file: File) {
	try {
		const text = await file.text();
		uploadedSeeds = JSON.parse(text);
		log(`Loaded ${uploadedSeeds.length} seeds from ${file.name}`, "success");

		const uploadText = uploadArea?.querySelector(".upload-text");
		if (uploadText) uploadText.textContent = `Loaded: ${file.name} (${uploadedSeeds.length} seeds)`;

		// Reset validation state
		validationPassed = false;
		const validateBtn = $("btn-validate") as HTMLButtonElement;
		if (validateBtn) {
			validateBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg> Validate Seeds`;
			validateBtn.onclick = () => validateSeeds();
		}
		hideValidationResults();
	} catch (e) {
		log(`Error parsing JSON: ${(e as Error).message}`, "error");
	}
}

// ============ VALIDATION ============

function hideValidationResults() {
	const container = $("validation-results");
	if (container) container.style.display = "none";
}

function showValidationResults() {
	const container = $("validation-results");
	if (container) container.style.display = "block";
}

function showValidationStatus(message: string, type: "info" | "success" | "error" | "warning") {
	const statusEl = $("validation-status");
	if (!statusEl) return;

	const colors = {
		info: { bg: "rgba(59, 130, 246, 0.1)", border: "#3b82f6", text: "#3b82f6" },
		success: { bg: "var(--accent-dim)", border: "var(--accent)", text: "var(--accent)" },
		error: { bg: "rgba(239, 68, 68, 0.1)", border: "var(--error)", text: "var(--error)" },
		warning: { bg: "rgba(245, 158, 11, 0.1)", border: "var(--warning)", text: "var(--warning)" },
	};

	const c = colors[type];
	statusEl.style.display = "block";
	statusEl.style.background = c.bg;
	statusEl.style.border = `1px solid ${c.border}`;
	statusEl.style.color = c.text;
	statusEl.innerHTML = message;
}

// ============ ARTID SUFFIX ============

function getArtIdSuffix(): string {
	return ($("artid-suffix") as HTMLInputElement)?.value.trim() || "";
}

function applySuffix(seeds: SeedNFTWithArtId[]): SeedNFTWithArtId[] {
	const suffix = getArtIdSuffix();
	if (!suffix) return seeds;
	return seeds.map(s => ({
		...s,
		artId: `${s.artId}-${suffix}`,
	}));
}

function randomizeSuffix() {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let result = "";
	for (let i = 0; i < 4; i++) {
		result += chars[Math.floor(Math.random() * chars.length)];
	}
	const input = $("artid-suffix") as HTMLInputElement;
	if (input) input.value = result;
}

(window as any).randomizeSuffix = randomizeSuffix;

async function validateSeeds() {
	const colName = ($("col-name") as HTMLInputElement)?.value.trim();
	const colSymbol = ($("col-symbol") as HTMLInputElement)?.value.trim().toUpperCase() ||
		colName?.slice(0, 8).toUpperCase().replace(/[^A-Z0-9]/g, "");
	const creator = ($("col-creator") as HTMLInputElement)?.value.trim().toLowerCase() || connectedUser;
	const sampleFile = ($("sample-select") as HTMLSelectElement)?.value;

	// Reset validate button to default state
	const validateBtn = $("btn-validate") as HTMLButtonElement;
	if (validateBtn) {
		validateBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg> Validate Seeds`;
		validateBtn.onclick = () => validateSeeds();
	}

	if (!colName) {
		showValidationStatus("Please enter a collection name first", "error");
		goToStep(1);
		return;
	}

	if (!creator) {
		showValidationStatus("Please enter creator username or connect wallet", "error");
		goToStep(1);
		return;
	}

	let seedsToValidate = uploadedSeeds;

	// Load from sample file if selected
	if (sampleFile && seedsToValidate.length === 0) {
		showValidationStatus("Loading sample file...", "info");
		try {
			const response = await fetch(sampleFile);
			seedsToValidate = await response.json();
			uploadedSeeds = seedsToValidate;
		} catch (e) {
			showValidationStatus(`Error loading sample: ${(e as Error).message}`, "error");
			return;
		}
	}

	if (seedsToValidate.length === 0) {
		showValidationStatus("Please upload a JSON file or select a sample", "error");
		return;
	}

	// Check if artId is present
	const hasArtId = seedsToValidate.every((s: any) => s.artId);
	if (!hasArtId) {
		showValidationStatus("JSON must include <strong>artId</strong> for each seed (max 14 chars)", "error");
		showValidationError("Missing artId", seedsToValidate);
		return;
	}

	// Apply artId suffix if set (to avoid blockchain duplicates)
	const seedsWithSuffix = applySuffix(seedsToValidate);
	const suffix = getArtIdSuffix();
	if (suffix) {
		log(`Applying artId suffix: "-${suffix}"`, "info");
	}

	showValidationStatus("Validating seeds against blockchain...", "info");

	try {
		const response = await fetch("/api/validate/pre-mint", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				creator,
				collectionName: colName,
				collectionSymbol: colSymbol,
				nfts: seedsWithSuffix,
			}),
		});
		const result = await response.json();

		if (result.error) {
			showValidationStatus(`Validation error: ${result.error}`, "error");
			return;
		}

		if (!result.valid && result.stage === "format") {
			showValidationStatus("Format errors found - check artId values", "error");
			showFormatErrors(result.errors);
			return;
		}

		if (!result.valid && result.stage === "uniqueness") {
			showValidationStatus("Duplicate artIds found in your JSON", "error");
			showDuplicateErrors(result.duplicates);
			return;
		}

		// Success - show results
		showValidationSuccess(result);

		if (result.canProceed) {
			validationPassed = true;
			// Transform validate button into "Next" action
			const validateBtn = $("btn-validate") as HTMLButtonElement;
			if (validateBtn) {
				validateBtn.textContent = "Next: Review Collection";
				validateBtn.onclick = () => previewSeeds();
			}
			showValidationStatus(
				`<strong>Validation passed!</strong> ${result.summary.new} new seeds ready to mint` +
				(result.summary.existing > 0 ? ` (${result.summary.existing} already exist)` : ""),
				"success"
			);
		} else {
			showValidationStatus("All seeds already exist on blockchain - nothing new to mint", "warning");
		}
	} catch (e) {
		showValidationStatus(`Validation failed: ${(e as Error).message}`, "error");
	}
}

function showValidationError(title: string, seeds: any[]) {
	showValidationResults();
	const summary = $("validation-summary");
	const seedsList = $("validation-seeds");

	if (summary) {
		summary.style.background = "rgba(239, 68, 68, 0.1)";
		summary.style.border = "1px solid var(--error)";
		summary.innerHTML = `<strong style="color: var(--error);">${title}</strong>
			<div style="font-size: 13px; color: var(--text-muted); margin-top: 4px;">
				Each seed must have an artId field (max 14 chars, letters/numbers/hyphens only)
			</div>`;
	}

	if (seedsList) {
		seedsList.innerHTML = seeds.slice(0, 10).map((s: any, i: number) => `
			<div class="validation-item error">
				<span class="validation-status error">MISSING</span>
				<span class="validation-name">${s.name || `Seed #${i + 1}`}</span>
				<span class="validation-artid">${s.artId || "no artId"}</span>
			</div>
		`).join("") + (seeds.length > 10 ? `<div style="color: var(--text-dim); padding: 8px;">...and ${seeds.length - 10} more</div>` : "");
	}
}

function showFormatErrors(errors: Array<{ index: number; artId: string; name: string; error: string }>) {
	showValidationResults();
	const summary = $("validation-summary");
	const seedsList = $("validation-seeds");

	if (summary) {
		summary.style.background = "rgba(239, 68, 68, 0.1)";
		summary.style.border = "1px solid var(--error)";
		summary.innerHTML = `<strong style="color: var(--error);">${errors.length} format error(s) found</strong>
			<div style="font-size: 13px; color: var(--text-muted); margin-top: 4px;">
				Fix the artId values and re-validate
			</div>`;
	}

	if (seedsList) {
		seedsList.innerHTML = errors.map(e => `
			<div class="validation-item error">
				<span class="validation-status error">ERROR</span>
				<span class="validation-name">${e.name}</span>
				<span class="validation-artid">${e.artId || "(empty)"}</span>
				<span style="color: var(--error); font-size: 12px;">${e.error}</span>
			</div>
		`).join("");
	}
}

function showDuplicateErrors(duplicates: string[]) {
	showValidationResults();
	const summary = $("validation-summary");
	const seedsList = $("validation-seeds");

	if (summary) {
		summary.style.background = "rgba(245, 158, 11, 0.1)";
		summary.style.border = "1px solid var(--warning)";
		summary.innerHTML = `<strong style="color: var(--warning);">Duplicate artIds found</strong>
			<div style="font-size: 13px; color: var(--text-muted); margin-top: 4px;">
				Each artId must be unique within the collection
			</div>`;
	}

	if (seedsList) {
		seedsList.innerHTML = duplicates.map(d => `
			<div class="validation-item error">
				<span class="validation-status error">DUPLICATE</span>
				<span class="validation-artid">${d}</span>
			</div>
		`).join("");
	}
}

function showValidationSuccess(result: any) {
	showValidationResults();
	const summary = $("validation-summary");
	const seedsList = $("validation-seeds");

	const colStatus = result.collectionExists ? "EXISTS" : "NEW";
	const colColor = result.collectionExists ? "var(--warning)" : "var(--accent)";

	if (summary) {
		summary.style.background = result.canProceed ? "var(--accent-dim)" : "rgba(245, 158, 11, 0.1)";
		summary.style.border = result.canProceed ? "1px solid var(--accent)" : "1px solid var(--warning)";
		summary.innerHTML = `
			<div style="display: flex; justify-content: space-between; align-items: center;">
				<div>
					<strong style="color: ${result.canProceed ? "var(--accent)" : "var(--warning)"};">
						${result.canProceed ? "Ready to mint" : "Nothing new to mint"}
					</strong>
					<div style="font-size: 13px; color: var(--text-muted); margin-top: 4px;">
						Collection: <span style="color: ${colColor}">${colStatus}</span> ·
						${result.summary.new} new · ${result.summary.existing} existing
					</div>
				</div>
				<div style="text-align: right;">
					<div style="font-family: var(--mono); font-size: 11px; color: var(--text-dim);">
						${result.collectionId}
					</div>
				</div>
			</div>`;
	}

	if (seedsList) {
		seedsList.innerHTML = result.seeds.map((s: any) => `
			<div class="validation-item ${s.exists ? "exists" : "new"}">
				<span class="validation-status ${s.exists ? "exists" : "new"}">${s.exists ? "EXISTS" : "NEW"}</span>
				<span class="validation-name">${s.name}</span>
				<span class="validation-artid">${s.artId}</span>
				<span class="validation-seedid">${s.seedId}</span>
			</div>
		`).join("");
	}
}

(window as any).validateSeeds = validateSeeds;

// ============ PREVIEW SEEDS ============

async function previewSeeds() {
	const colName = ($("col-name") as HTMLInputElement)?.value.trim();
	const colSymbol = ($("col-symbol") as HTMLInputElement)?.value.trim().toUpperCase() ||
		colName?.slice(0, 8).toUpperCase().replace(/[^A-Z0-9]/g, "");

	if (!colName) {
		log("Enter collection name first", "error");
		goToStep(1);
		return;
	}

	if (!validationPassed) {
		log("Please validate seeds first", "error");
		return;
	}

	if (uploadedSeeds.length === 0) {
		log("Upload a JSON file or select a sample", "error");
		return;
	}

	// Calculate preview from uploaded data
	const totalSupply = uploadedSeeds.reduce((sum: number, s: any) => sum + (s.maxSupply || s.maxReplicas || 1), 0);
	previewData = {
		collection: {
			name: colName,
			symbol: colSymbol.length >= 3 ? colSymbol : colSymbol.padEnd(3, "X"),
			totalPotential: totalSupply
		},
		seeds: uploadedSeeds.map((s: any) => ({
			artId: s.artId,
			name: s.name,
			maxSupply: s.maxSupply || s.maxReplicas || 1
		})),
		summary: {
			totalSeeds: uploadedSeeds.length,
			totalPotentialInstances: totalSupply
		}
	};

	// Render preview
	const statsContainer = $("preview-stats");
	if (statsContainer) {
		statsContainer.innerHTML = `
			<div class="stat-box">
				<div class="stat-label">Total Seeds</div>
				<div class="stat-value">${previewData.summary.totalSeeds}</div>
			</div>
			<div class="stat-box">
				<div class="stat-label">Max Instances</div>
				<div class="stat-value">${previewData.summary.totalPotentialInstances.toLocaleString()}</div>
			</div>
			<div class="stat-box">
				<div class="stat-label">Symbol</div>
				<div class="stat-value">${previewData.collection.symbol}</div>
			</div>
		`;
	}

	const tbody = $("seeds-preview-body");
	if (tbody) {
		const hasArtId = previewData.seeds[0]?.artId;
		tbody.innerHTML = previewData.seeds.map((s: any, i: number) => `
			<tr>
				<td>${i + 1}</td>
				<td class="seed-name">${s.name}</td>
				${hasArtId ? `<td style="font-family: var(--mono); font-size: 12px; color: var(--text-dim);">${s.artId}</td>` : ""}
				<td class="seed-supply">${s.maxSupply.toLocaleString()}</td>
			</tr>
		`).join("");
	}

	goToStep(3);
}

(window as any).previewSeeds = previewSeeds;

// ============ CREATE COLLECTION ============

async function createCollection() {
	if (!(window as any).hive_keychain) {
		log("Install Hive Keychain extension to broadcast operations", "error");
		return;
	}

	const colName = ($("col-name") as HTMLInputElement)?.value.trim();
	const colSymbol = ($("col-symbol") as HTMLInputElement)?.value.trim().toUpperCase() || previewData?.collection?.symbol;
	const creator = ($("col-creator") as HTMLInputElement)?.value.trim().toLowerCase() || connectedUser;
	const colImage = ($("col-image") as HTMLInputElement)?.value.trim();
	const colDescription = ($("col-description") as HTMLTextAreaElement)?.value.trim();

	if (!creator) {
		log("Enter creator username or connect wallet", "error");
		return;
	}

	if (!colName || !colSymbol) {
		log("Collection name and symbol required", "error");
		return;
	}

	if (!colImage) {
		log("Collection image URL is required", "error");
		return;
	}

	const description = colDescription || `${colName} collection`;

	// Show progress via step 4
	goToStep(4);

	mintLog(`Creating collection "${colName}"...`);

	try {
		// Step 1: Build collection operation
		const colResponse = await fetch("/api/build/collection", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonId: `json_${Date.now()}`,
				name: colName,
				symbol: colSymbol,
				creator,
				totalPotential: previewData?.summary?.totalPotentialInstances || 1000000,
				metadata: {
					description,
					image: colImage,
				},
				rules: {
					transferable: true,
					burnable: true,
					replicable: true,
					royaltyPct: 5,
					royaltyRecipient: creator,
				},
			})
		});
		const colData = await colResponse.json();
		if (colData.success === false) {
			const errMsg = colData.errors?.map((e: any) => e.message || e).join(", ") || "Unknown error";
			throw new Error(errMsg);
		}

		mintLog(`Collection ID: ${colData.collectionId}`, "success");
		mintLog(`Origin DNA: ${colData.generatedIds?.originDna}`);

		// Step 2: Build seed operations
		mintLog("Generating seed mint operations...");

		const seedsResponse = await fetch("/api/build/seeds", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				collectionId: colData.collectionId,
				owner: creator,
				seeds: applySuffix(uploadedSeeds),
			})
		});
		const mintData = await seedsResponse.json();
		if (mintData.success === false) {
			const errMsg = mintData.errors?.map((e: any) => e.message || e).join(", ") || "Unknown error";
			throw new Error(errMsg);
		}

		mintLog(`Generated ${mintData.seeds.length} seed operations in ${mintData.batches.length} batches`);

		// Create session for persistence
		currentSession = createSession(creator, colName, colSymbol, applySuffix(uploadedSeeds));
		saveSession(currentSession);
		const seedIds = mintData.seeds.map((s: any) => s.seedId);
		initializeSeedBatches(currentSession.id, mintData.batches.map((_: any, i: number) => ({
			batchNumber: i + 1,
			seedIds: seedIds.slice(i * 5, (i + 1) * 5),
		})));
		mintLog(`Session saved: ${currentSession.id}`);

		// Store data globally
		(window as any).__pendingBatches = mintData.batches;
		(window as any).__currentBatchIndex = 0;
		(window as any).__batchCreator = creator;
		(window as any).__collectionOp = colData.operation;
		(window as any).__collectionName = colName;
		(window as any).__totalSeeds = mintData.seeds.length;
		(window as any).__totalSupply = previewData?.summary?.totalPotentialInstances || 0;
		(window as any).__sessionId = currentSession?.id;

		// Reset phase
		broadcastPhase = 0;

		// Update summary section
		const summaryName = $("summary-collection-name");
		const summaryDetails = $("summary-details");
		const summaryCreator = $("summary-creator");
		if (summaryName) summaryName.textContent = colName;
		if (summaryDetails) summaryDetails.textContent = `${mintData.seeds.length} seeds · ${(window as any).__totalSupply.toLocaleString()} total supply`;
		if (summaryCreator) summaryCreator.textContent = `@${creator}`;

		// Render batch list
		renderBatchList(mintData.batches);

		// Initialize progress counter (1 collection op + N batch ops)
		broadcastedCount = 0;
		totalBroadcastOps = 1 + mintData.batches.length;
		updateBroadcastProgress();

		mintLog("Ready! Click 'Broadcast' on each item", "success");

	} catch (e) {
		mintLog(`Error: ${(e as Error).message}`, "error");
	}
}

(window as any).createCollection = createCollection;

// ============ LOAD PROTOCOL VERSION ============

async function loadProtocolVersion() {
	try {
		const response = await fetch("/api/protocol/version");
		const data = await response.json();
		const versionEl = $("protocol-version");
		if (versionEl) versionEl.textContent = `v${data.protocolVersion}`;
	} catch (e) {
		console.error("Failed to load protocol version", e);
	}
}

// ============ BATCH BROADCASTING ============

function updateBroadcastProgress() {
	const el = $("broadcast-progress");
	if (el) el.textContent = `${broadcastedCount} of ${totalBroadcastOps} operations broadcast`;
}

function renderBatchList(batches: any[]) {
	const container = $("seed-batches-list");
	if (!container) return;

	// Render all batches, but hide buttons until previous is complete
	container.innerHTML = batches.map((batch, i) => `
		<div class="op-item" id="op-batch-${i}" data-status="pending">
			<div class="op-status">
				<div class="op-icon pending">${i + 1}</div>
			</div>
			<div class="op-info">
				<div class="op-title">Batch ${i + 1} of ${batches.length}</div>
				<div class="op-desc">${batch.operations.length} seed operations</div>
			</div>
			<button class="btn btn-primary btn-sm" onclick="broadcastBatch(${i})" style="display: none;">
				Broadcast
			</button>
		</div>
	`).join("");
}

function setOpStatus(opId: string, status: "pending" | "active" | "complete" | "error", icon?: string) {
	const el = $(opId);
	if (!el) return;

	el.dataset.status = status;
	const iconEl = el.querySelector(".op-icon");
	if (iconEl) {
		iconEl.className = `op-icon ${status}`;
		if (status === "complete") iconEl.textContent = "✓";
		else if (status === "error") iconEl.textContent = "✗";
		else if (status === "active") iconEl.textContent = "●";
		else iconEl.textContent = icon || "○";
	}

	// Update button visibility
	const btn = el.querySelector(".btn") as HTMLButtonElement;
	if (btn) {
		if (status === "complete") {
			btn.style.display = "none";
		} else if (status === "active") {
			btn.disabled = true;
			btn.textContent = "Broadcasting...";
		}
	}
}

function broadcastCollection() {
	const creator = (window as any).__batchCreator;
	const collectionOp = (window as any).__collectionOp;
	const sessionId = (window as any).__sessionId;

	if (!collectionOp) {
		mintLog("No collection operation ready", "error");
		return;
	}

	if (!(window as any).hive_keychain) {
		mintLog("Install Hive Keychain extension to broadcast", "error");
		return;
	}

	setOpStatus("op-collection", "active");
	mintLog("Opening Keychain...");

	(window as any).hive_keychain.requestBroadcast(
		creator,
		[collectionOp],
		"Posting",
		(res: any) => {
			console.log("Keychain response:", res);
			if (res.success) {
				setOpStatus("op-collection", "complete");
				broadcastPhase = 1;
				broadcastedCount++;
				updateBroadcastProgress();
				mintLog("Collection created!", "success");

				// Update session persistence
				if (sessionId) {
					updateCollectionBroadcast(sessionId, "confirmed", res.result?.id);
				}

				// Enable first batch
				const firstBatch = $("op-batch-0");
				if (firstBatch) {
					firstBatch.dataset.status = "pending";
					const btn = firstBatch.querySelector(".btn") as HTMLButtonElement;
					if (btn) btn.style.display = "";
				}
			} else {
				setOpStatus("op-collection", "error");
				mintLog(`Failed: ${res.message || res.error}`, "error");
				// Show retry button
				const retryBtn = $("btn-op-collection") as HTMLButtonElement;
				if (retryBtn) {
					retryBtn.textContent = "Retry";
					retryBtn.style.display = "";
					retryBtn.disabled = false;
				}
			}
		}
	);
}

function broadcastBatch(index: number) {
	const batches = (window as any).__pendingBatches || [];
	const creator = (window as any).__batchCreator;
	const sessionId = (window as any).__sessionId;

	if (broadcastPhase !== 1) {
		mintLog("Broadcast collection first!", "error");
		return;
	}

	if (index >= batches.length) {
		mintLog("Invalid batch index", "error");
		return;
	}

	// Check previous batch is complete
	if (index > 0) {
		const prevBatch = $(`op-batch-${index - 1}`);
		if (prevBatch && prevBatch.dataset.status !== "complete") {
			mintLog(`Complete batch ${index} first`, "error");
			return;
		}
	}

	if (!(window as any).hive_keychain) {
		mintLog("Install Hive Keychain extension", "error");
		return;
	}

	const batch = batches[index];
	setOpStatus(`op-batch-${index}`, "active");
	mintLog(`Broadcasting batch ${index + 1}...`);

	(window as any).hive_keychain.requestBroadcast(
		creator,
		batch.operations,
		"Posting",
		(res: any) => {
			console.log(`Batch ${index + 1} response:`, res);
			if (res.success) {
				setOpStatus(`op-batch-${index}`, "complete");
				broadcastedCount++;
				updateBroadcastProgress();
				mintLog(`Batch ${index + 1} complete!`, "success");

				// Update session persistence
				if (sessionId) {
					updateSeedBatch(sessionId, index + 1, "confirmed", res.result?.id);
				}

				// Enable next batch button
				const nextBatch = $(`op-batch-${index + 1}`);
				if (nextBatch) {
					const btn = nextBatch.querySelector(".btn") as HTMLButtonElement;
					if (btn) btn.style.display = "";
				}

				// Check if all done
				if (index + 1 >= batches.length) {
					broadcastPhase = 2;
					mintLog("All seeds minted!", "success");
					loadCollections();
				}
			} else {
				setOpStatus(`op-batch-${index}`, "error");
				mintLog(`Batch ${index + 1} failed: ${res.message || res.error}`, "error");
				// Show retry button
				const retryBtn = $(`op-batch-${index}`)?.querySelector(".btn") as HTMLButtonElement;
				if (retryBtn) {
					retryBtn.textContent = "Retry";
					retryBtn.style.display = "";
					retryBtn.disabled = false;
				}
			}
		}
	);
}

function resetMinting() {
	const confirmed = confirm("Reset the form? Already-broadcast operations are permanent on the blockchain.");
	if (!confirmed) return;

	// Reset global state
	(window as any).__pendingBatches = null;
	(window as any).__currentBatchIndex = 0;
	(window as any).__collectionOp = null;
	broadcastPhase = 0;
	broadcastedCount = 0;
	totalBroadcastOps = 0;

	// Hide progress, show step 1
	const progressCard = $("minting-progress");
	if (progressCard) progressCard.style.display = "none";

	// Clear batch list
	const batchList = $("seed-batches-list");
	if (batchList) batchList.innerHTML = "";

	// Reset collection item
	setOpStatus("op-collection", "pending");
	const colBtn = $("btn-op-collection") as HTMLButtonElement;
	if (colBtn) {
		colBtn.style.display = "";
		colBtn.disabled = false;
		colBtn.textContent = "Broadcast";
	}

	// Clear log
	const logEl = $("mint-log");
	if (logEl) logEl.innerHTML = "";

	// Go back to step 1
	goToStep(1);
}

// Export for button clicks
(window as any).broadcastCollection = broadcastCollection;
(window as any).broadcastBatch = broadcastBatch;
(window as any).resetMinting = resetMinting;

// ============ HIVE NFT TRACKER (BlockTrades Standard) ============

function nftTrackerLog(msg: string, type = "info") {
	log(msg, type, "nft-tracker-log");
}

function getNftTrackerFormData(action: string): Record<string, unknown> | null {
	if (action === "register") {
		const creator = ($("nft-reg-creator") as HTMLInputElement)?.value.trim().toLowerCase();
		const symbol = ($("nft-reg-symbol") as HTMLInputElement)?.value.trim().toUpperCase();
		const name = ($("nft-reg-name") as HTMLInputElement)?.value.trim();
		const maxCount = parseInt(($("nft-reg-max") as HTMLInputElement)?.value || "0", 10);
		const issuersRaw = ($("nft-reg-issuers") as HTMLInputElement)?.value.trim();

		if (!creator || !symbol || !name) {
			nftTrackerLog("Fill creator, symbol, and name", "error");
			return null;
		}

		const issuers = [creator];
		if (issuersRaw) {
			issuersRaw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean).forEach(s => {
				if (!issuers.includes(s)) issuers.push(s);
			});
		}

		return {
			creator,
			symbol: `${creator}/${symbol}`,
			name,
			maxCount: maxCount || null,
			issuers,
		};
	}

	if (action === "issue") {
		const issuer = ($("nft-issue-issuer") as HTMLInputElement)?.value.trim().toLowerCase();
		const symbol = ($("nft-issue-symbol") as HTMLInputElement)?.value.trim();
		const holder = ($("nft-issue-holder") as HTMLInputElement)?.value.trim().toLowerCase();
		const dataRaw = ($("nft-issue-data") as HTMLTextAreaElement)?.value.trim();
		const soulbound = ($("nft-issue-soulbound") as HTMLInputElement)?.checked || false;

		if (!issuer || !symbol || !holder) {
			nftTrackerLog("Fill issuer, symbol, and holder", "error");
			return null;
		}

		let data: Record<string, unknown> = {};
		if (dataRaw) {
			try { data = JSON.parse(dataRaw); }
			catch { nftTrackerLog("Invalid JSON in data field", "error"); return null; }
		}

		return { issuer, symbol, holder, data, soulbound };
	}

	if (action === "transfer") {
		const from = ($("nft-xfer-from") as HTMLInputElement)?.value.trim().toLowerCase();
		const to = ($("nft-xfer-to") as HTMLInputElement)?.value.trim().toLowerCase();
		const symbol = ($("nft-xfer-symbol") as HTMLInputElement)?.value.trim();
		const idsRaw = ($("nft-xfer-ids") as HTMLInputElement)?.value.trim();

		if (!from || !to || !symbol || !idsRaw) {
			nftTrackerLog("Fill all transfer fields", "error");
			return null;
		}

		const ids = idsRaw.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
		if (ids.length === 0) {
			nftTrackerLog("At least one valid ID is required", "error");
			return null;
		}

		return { from, to, symbol, ids };
	}

	return null;
}

async function nftTrackerPreview(action: string) {
	const formData = getNftTrackerFormData(action);
	if (!formData) return;

	try {
		const response = await fetch(`/api/nft-tracker/${action}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(formData),
		});
		const result = await response.json();

		if (result.error) {
			nftTrackerLog(`Error: ${result.error}`, "error");
			return;
		}

		// Show the preview card
		const card = $("nft-tracker-preview-card");
		const jsonEl = $("nft-tracker-json");
		if (card) card.style.display = "block";
		if (jsonEl) jsonEl.textContent = JSON.stringify(result, null, 2);

		nftTrackerLog(`Preview generated for "${action}" action`, "success");
	} catch (e) {
		nftTrackerLog(`Request failed: ${(e as Error).message}`, "error");
	}
}

async function nftTrackerBroadcast(action: string) {
	const formData = getNftTrackerFormData(action);
	if (!formData) return;

	if (!(window as any).hive_keychain) {
		nftTrackerLog("Hive Keychain not detected. Install the extension.", "error");
		return;
	}

	try {
		const response = await fetch(`/api/nft-tracker/${action}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(formData),
		});
		const result = await response.json();

		if (result.error) {
			nftTrackerLog(`Error: ${result.error}`, "error");
			return;
		}

		// Show preview
		const card = $("nft-tracker-preview-card");
		const jsonEl = $("nft-tracker-json");
		if (card) card.style.display = "block";
		if (jsonEl) jsonEl.textContent = JSON.stringify(result, null, 2);

		// Get the broadcaster account
		const broadcaster =
			(formData.creator as string) ||
			(formData.issuer as string) ||
			(formData.from as string) ||
			connectedUser;

		if (!broadcaster) {
			nftTrackerLog("No account specified for broadcasting", "error");
			return;
		}

		nftTrackerLog(`Broadcasting "${action}" as @${broadcaster}...`);

		const ops = [result.operation];
		(window as any).hive_keychain.requestBroadcast(
			broadcaster,
			ops,
			"Active",
			(res: any) => {
				if (res.success) {
					nftTrackerLog(`✅ "${action}" broadcast successful! TxID: ${res.result?.id || "confirmed"}`, "success");
				} else {
					const err = typeof res.error === "object" ? JSON.stringify(res.error) : res.error;
					nftTrackerLog(`❌ Broadcast failed: ${err}`, "error");
				}
			}
		);
	} catch (e) {
		nftTrackerLog(`Request failed: ${(e as Error).message}`, "error");
	}
}

// Auto-fill creator fields when connected
function autoFillNftTracker() {
	if (!connectedUser) return;
	const fields = ["nft-reg-creator", "nft-issue-issuer", "nft-xfer-from"];
	for (const id of fields) {
		const el = $(id) as HTMLInputElement;
		if (el && !el.value) el.value = connectedUser;
	}
}

// ---- Sample Bulls Loader ----

let sampleBulls: any[] = [];

async function loadSampleBulls() {
	try {
		const response = await fetch("/playground/sample-bulls.json");
		sampleBulls = await response.json();

		// Pre-fill Register form
		const creator = connectedUser || "enrique89";
		const setVal = (id: string, val: string) => {
			const el = $(id) as HTMLInputElement;
			if (el) el.value = val;
		};
		setVal("nft-reg-creator", creator);
		setVal("nft-reg-symbol", "BULLS");
		setVal("nft-reg-name", "HiveBull Warriors");
		const totalSupply = sampleBulls.reduce((sum: number, b: any) => sum + (b.maxSupply || 0), 0);
		setVal("nft-reg-max", String(totalSupply));

		// Pre-fill Issue form defaults
		setVal("nft-issue-issuer", creator);
		setVal("nft-issue-symbol", `${creator}/BULLS`);
		setVal("nft-issue-holder", creator);

		// Render bull cards
		const container = $("nft-tracker-bulls");
		const grid = $("nft-tracker-bulls-grid");
		if (container) container.style.display = "block";
		if (grid) {
			grid.innerHTML = sampleBulls.map((bull: any, i: number) => `
				<div class="nft-card" data-bull-idx="${i}" onclick="selectBullForIssue(${i})" style="cursor: pointer;">
					<img class="nft-image" src="${bull.imageUrl}" onerror="this.src='${PLACEHOLDER_SM}'">
					<div class="nft-name">${bull.name}</div>
					<div class="nft-owner" style="color: var(--text-muted); font-size: 11px;">${bull.brief}</div>
					<div class="nft-id" style="display: flex; justify-content: space-between; margin-top: 6px;">
						<span style="color: var(--accent);">${bull.artId}</span>
						<span>Supply: ${bull.maxSupply}</span>
					</div>
				</div>
			`).join("");
		}

		nftTrackerLog(`Loaded ${sampleBulls.length} bulls. Register form pre-filled. Click a bull to fill Issue form.`, "success");
	} catch (e) {
		nftTrackerLog(`Failed to load sample bulls: ${(e as Error).message}`, "error");
	}
}

function selectBullForIssue(index: number) {
	const bull = sampleBulls[index];
	if (!bull) return;

	const creator = ($("nft-reg-creator") as HTMLInputElement)?.value.trim() || connectedUser || "enrique89";
	const setVal = (id: string, val: string) => {
		const el = $(id) as HTMLInputElement | HTMLTextAreaElement;
		if (el) el.value = val;
	};

	setVal("nft-issue-issuer", creator);
	setVal("nft-issue-symbol", `${creator}/BULLS`);
	setVal("nft-issue-holder", creator);
	setVal("nft-issue-data", JSON.stringify({
		artId: bull.artId,
		name: bull.name,
		brief: bull.brief,
		image: bull.imageUrl,
		maxSupply: bull.maxSupply,
	}, null, 2));

	// Highlight selected card
	document.querySelectorAll("#nft-tracker-bulls-grid .nft-card").forEach(c => c.classList.remove("selected"));
	const card = document.querySelector(`#nft-tracker-bulls-grid .nft-card[data-bull-idx="${index}"]`);
	if (card) card.classList.add("selected");

	nftTrackerLog(`Selected: ${bull.name} (${bull.artId}) — Issue form pre-filled`, "success");
}

// Export for HTML onclick handlers
(window as any).nftTrackerPreview = nftTrackerPreview;
(window as any).nftTrackerBroadcast = nftTrackerBroadcast;
(window as any).loadSampleBulls = loadSampleBulls;
(window as any).selectBullForIssue = selectBullForIssue;

// ============ NFT DETAIL ACTIONS ============

async function nftDetailTransfer() {
	const to = ($("nft-action-instance-to") as HTMLInputElement)?.value.trim().toLowerCase();
	if (!to || !connectedUser || !currentNftId) {
		log("Fill recipient and ensure you're connected", "error");
		return;
	}

	log(`Validating transfer of ${currentNftId}...`);
	const validation = await validateTransfer(currentNftId, connectedUser);
	if (!validation.valid) {
		log(`Cannot transfer: ${validation.error}`, "error");
		return;
	}

	const nft = validation.nft!;
	const ops = createAtomicTransferOperations({
		nftId: nft.id,
		collectionId: nft.collectionId,
		edition: nft.edition,
		instanceDna: nft.instanceDna || nft.dna || "",
		from: connectedUser,
		to,
		imageUrl: nft.imageUrl ?? undefined,
		imageHash: nft.imageHash ?? undefined,
	});

	log(`Transferring to @${to}...`);
	(window as any).hive_keychain.requestBroadcast(
		connectedUser, ops, "Active",
		(res: any) => {
			if (res.success) {
				log(`Transfer successful! ${getTrackingAmount()} sent`, "success");
				loadNftDetail(currentNftId!);
				loadInventory();
			} else {
				const err = typeof res.error === "object" ? JSON.stringify(res.error) : res.error;
				log(`Transfer failed: ${err}`, "error");
			}
		}
	);
}

async function nftDetailDistribute() {
	const to = ($("nft-action-to") as HTMLInputElement)?.value.trim().toLowerCase();
	const quantity = parseInt(($("nft-action-quantity") as HTMLInputElement)?.value || "1", 10);
	if (!to || !connectedUser || !currentNftId) {
		log("Fill recipient and ensure you're connected", "error");
		return;
	}
	const success = await distributeFromSeed(currentNftId, to, quantity);
	if (success) {
		// Wait for indexer to process the transaction
		setTimeout(() => {
			loadNftDetail(currentNftId!);
			loadInventory();
		}, 5000);
	}
}

async function nftDetailTransferSeed() {
	const to = ($("nft-action-seed-transfer-to") as HTMLInputElement)?.value.trim().toLowerCase();
	if (!to || !connectedUser || !currentNftId) {
		log("Fill recipient and ensure you're connected", "error");
		return;
	}

	log(`Fetching seed info...`);
	const response = await fetch(`/api/nft/${currentNftId}/details`);
	const data = await response.json();

	if (data.error) { log(`Seed not found: ${data.error}`, "error"); return; }
	const nft = data.nft;
	if (!nft.isSeed) { log("This is not a seed", "error"); return; }
	if (nft.owner.toLowerCase() !== connectedUser.toLowerCase()) {
		log(`You don't own this seed. Owner: @${nft.owner}`, "error");
		return;
	}

	const ops = createAtomicTransferOperations({
		nftId: nft.id,
		collectionId: nft.collectionId,
		edition: nft.edition,
		instanceDna: nft.instanceDna || nft.dna,
		from: connectedUser,
		to,
		imageUrl: nft.imageUrl,
		imageHash: nft.imageHash,
	});

	log(`Transferring seed ownership to @${to}...`);
	(window as any).hive_keychain.requestBroadcast(
		connectedUser, ops, "Active",
		(res: any) => {
			if (res.success) {
				log(`Seed transferred to @${to}!`, "success");
				loadNftDetail(currentNftId!);
			} else {
				const err = typeof res.error === "object" ? JSON.stringify(res.error) : res.error;
				log(`Transfer failed: ${err}`, "error");
			}
		}
	);
}

(window as any).nftDetailTransfer = nftDetailTransfer;
(window as any).nftDetailDistribute = nftDetailDistribute;
(window as any).nftDetailTransferSeed = nftDetailTransferSeed;

async function nftDetailList() {
	const price = ($("nft-action-price") as HTMLInputElement)?.value.trim();
	const currency = ($("nft-action-currency") as HTMLSelectElement)?.value as "HIVE" | "HBD";
	if (!price || !connectedUser || !currentNftId) {
		log("Fill price and ensure you're connected", "error");
		return;
	}

	try {
		const response = await fetch("/api/build/list", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				nftId: currentNftId,
				owner: connectedUser,
				price: { amount: price, currency },
			}),
		});
		const result = await response.json();
		if (!result.success) {
			log(`Error: ${result.errors?.[0]?.message || result.error}`, "error");
			return;
		}

		log(`Listing ${currentNftId} for ${price} ${currency}...`);
		(window as any).hive_keychain.requestBroadcast(
			connectedUser,
			[result.operation],
			"Posting",
			(res: any) => {
				if (res.success) {
					log(`Listed for ${price} ${currency}!`, "success");
					setTimeout(() => loadNftDetail(currentNftId!), 5000);
				} else {
					const err = typeof res.error === "object" ? JSON.stringify(res.error) : res.error;
					log(`Listing failed: ${err}`, "error");
				}
			}
		);
	} catch (e) {
		log(`Error: ${(e as Error).message}`, "error");
	}
}

async function nftDetailUnlist() {
	if (!connectedUser || !currentNftId) {
		log("Connect wallet first", "error");
		return;
	}

	try {
		const response = await fetch("/api/build/unlist", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				nftId: currentNftId,
				owner: connectedUser,
			}),
		});
		const result = await response.json();
		if (!result.success) {
			log(`Error: ${result.errors?.[0]?.message || result.error}`, "error");
			return;
		}

		log(`Unlisting ${currentNftId}...`);
		(window as any).hive_keychain.requestBroadcast(
			connectedUser,
			[result.operation],
			"Posting",
			(res: any) => {
				if (res.success) {
					log("Unlisted!", "success");
					setTimeout(() => loadNftDetail(currentNftId!), 5000);
				} else {
					const err = typeof res.error === "object" ? JSON.stringify(res.error) : res.error;
					log(`Unlist failed: ${err}`, "error");
				}
			}
		);
	} catch (e) {
		log(`Error: ${(e as Error).message}`, "error");
	}
}

(window as any).nftDetailList = nftDetailList;
(window as any).nftDetailUnlist = nftDetailUnlist;

// ============ ADVANCED TABS ============

document.querySelectorAll(".advanced-tab").forEach(tab => {
	tab.addEventListener("click", () => {
		document.querySelectorAll(".advanced-tab").forEach(t => t.classList.remove("active"));
		document.querySelectorAll(".advanced-tab-content").forEach(c => c.classList.remove("active"));
		tab.classList.add("active");
		const target = (tab as HTMLElement).dataset.tab;
		if (target) {
			const panel = $(target);
			if (panel) panel.classList.add("active");
		}
	});
});

// ============ NEW VIEW MODULES ============

import { initMarketplace } from "./views/marketplace";
import { initPacks } from "./views/packs";
import { initPermissions } from "./views/permissions";
import { initDebug } from "./views/debug";
import { initSpv } from "./views/spv";


// ============ DASHBOARD STATS ============

async function loadDashboardStats() {
	const container = $("dashboard-stats");
	if (!container) return;

	try {
		const response = await fetch("/api/stats");
		const stats = await response.json();

		container.innerHTML = `
			<div class="stat-box"><div class="stat-label">Collections</div><div class="stat-value">${stats.total_collections ?? 0}</div></div>
			<div class="stat-box"><div class="stat-label">NFTs</div><div class="stat-value">${stats.total_nfts ?? 0}</div></div>
			<div class="stat-box"><div class="stat-label">Seeds</div><div class="stat-value">${stats.total_seeds ?? 0}</div></div>
			<div class="stat-box"><div class="stat-label">Instances</div><div class="stat-value">${stats.total_instances ?? 0}</div></div>
			<div class="stat-box"><div class="stat-label">Listed</div><div class="stat-value">${stats.total_listed ?? 0}</div></div>
			<div class="stat-box"><div class="stat-label">Sales</div><div class="stat-value">${stats.total_sales ?? 0}</div></div>
			<div class="stat-box"><div class="stat-label">Owners</div><div class="stat-value">${stats.unique_owners ?? 0}</div></div>
		`;
	} catch { /* silently fail */ }
}

(window as any).loadDashboardStats = loadDashboardStats;

// ============ USER ACTIVITY ============

async function loadUserActivity() {
	const container = $("user-activity-container");
	if (!container || !connectedUser) return;

	container.innerHTML = '<div class="empty-state"><p class="empty-state-text">Loading...</p></div>';

	try {
		const response = await fetch(`/api/user/${connectedUser}/activity?limit=20`);
		const data = await response.json();
		const events = data.events || [];

		if (events.length === 0) {
			container.innerHTML = '<div class="empty-state"><p class="empty-state-text">No activity yet</p></div>';
			return;
		}

		container.innerHTML = `<table class="data-table">
			<thead><tr><th>Event</th><th>NFT</th><th>From</th><th>To</th><th>Date</th></tr></thead>
			<tbody>${events.map((e: any) => `
				<tr>
					<td>${e.event_type}</td>
					<td style="font-family: var(--mono); font-size: 11px;">${e.nft_id}</td>
					<td>${e.from_account ? `@${e.from_account}` : "-"}</td>
					<td>${e.to_account ? `@${e.to_account}` : "-"}</td>
					<td style="color: var(--text-dim);">${new Date(e.timestamp).toLocaleDateString()}</td>
				</tr>
			`).join("")}</tbody>
		</table>`;
	} catch (e) {
		container.innerHTML = '<div class="empty-state"><p class="empty-state-text">Error loading activity</p></div>';
	}
}

(window as any).loadUserActivity = loadUserActivity;

// ============ STEP 1 INLINE VALIDATION ============

function validateField(inputId: string, validator: (value: string) => string | null) {
	const input = $(inputId) as HTMLInputElement;
	const errorEl = $(`${inputId}-error`);
	if (!input) return;

	input.addEventListener("blur", () => {
		const error = validator(input.value.trim());
		if (errorEl) {
			errorEl.textContent = error || "";
			errorEl.style.display = error ? "block" : "none";
		}
		input.style.borderColor = error ? "var(--error)" : "";
	});
}

validateField("col-name", (v) => v.length < 1 ? "Collection name is required" : null);
validateField("col-symbol", (v) => {
	if (v.length < 3) return "Symbol must be at least 3 characters";
	if (v.length > 8) return "Symbol must be at most 8 characters";
	if (!/^[A-Z0-9]+$/.test(v.toUpperCase())) return "Only letters and numbers";
	return null;
});
validateField("col-creator", (v) => v.length < 3 ? "Username must be at least 3 characters" : null);
validateField("col-image", (v) => {
	if (!v) return "Image URL is required for the collection";
	try { new URL(v); return null; } catch { return "Must be a valid URL"; }
});

// ============ INIT ============

setTimeout(checkKeychain, 500);
loadProtocolVersion();
loadCollections();
loadDashboardStats();
initMarketplace();
initPacks();
initPermissions();
initDebug();
initSpv();
log("Console ready");

