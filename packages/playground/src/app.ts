import {
  buildTransfer,
  buildBulkDistribute,
  PROTOCOL_ID,
  PROTOCOL_COLLECTION_FEE_HBD,
  type SeedAssetWithArtId,
  type HiveOperation,
  ACTION_AUTH_LEVEL,
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
import {
  $,
  log,
  mintLog,
  escapeHtml,
  PLACEHOLDER_SM,
  PLACEHOLDER_LG,
} from "./shared/dom";
import {
  groupInstancesBySeed,
  instanceGroupKey,
  type InstanceGroup,
} from "./inventory-grouping";

let connectedUser: string | null = null;
let _currentStep = 1;
let uploadedSeeds: SeedAssetWithArtId[] = [];
let previewData: any = null;
let broadcastPhase = 0;
let validationPassed = false;
let currentSession: MintingSession | null = null;
let broadcastedCount = 0;
let totalBroadcastOps = 0;
let debugRoutesEnabled = false;

// Public Hive RPC endpoint used for the pre-build HBD balance check. Matches
// the convention of the other Hive RPC calls in the playground (broadcastSignedTransaction,
// marketplace.ts, node.ts) which hardcode this endpoint. The playground owns
// its UX — no SDK/indexer involvement for state queries.
const HIVE_RPC_URL = "https://api.hive.blog";

type CreatorBalanceCheck =
  | { ok: true; hasSufficient: boolean; available: number; required: number }
  | { ok: false; error: string };

// Pre-build UX gate: queries the creator's HBD liquid balance directly from a
// public Hive node. Used to surface a friendly alert before hitting the
// indexer's build endpoint when the creator can't cover PROTOCOL_COLLECTION_FEE_HBD.
// The chain is the ultimate arbiter — this is purely a UX pre-flight, not a
// protocol rule. Failure to fetch does NOT block the build (the chain will
// reject if the balance is genuinely insufficient).
async function checkCreatorHasCollectionFee(
  creator: string,
): Promise<CreatorBalanceCheck> {
  const required = Number.parseFloat(PROTOCOL_COLLECTION_FEE_HBD);
  try {
    const res = await fetch(HIVE_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "condenser_api.get_accounts",
        params: [[creator]],
        id: 1,
      }),
    });
    if (!res.ok) {
      return { ok: false, error: `Hive RPC returned HTTP ${res.status}` };
    }
    const raw = (await res.json()) as
      | { result?: Array<{ hbd_balance?: string }> }
      | null;
    const account = raw?.result?.[0];
    if (!account || typeof account.hbd_balance !== "string") {
      return { ok: false, error: `Hive account '${creator}' not found` };
    }
    const match = /^(\d+)\.(\d{3})\s+HBD$/.exec(account.hbd_balance);
    if (!match) {
      return {
        ok: false,
        error: `Unexpected hbd_balance format: ${account.hbd_balance}`,
      };
    }
    // Integer-units discipline mirrors hiveAmountStringToUnits in the SDK:
    // exact arithmetic on integer parts, avoids parseFloat's forgiving behaviour
    // on edge cases like ".5 HBD" or "1.2.3 HBD".
    const intPart = Number.parseInt(match[1]!, 10);
    const decPart = Number.parseInt(match[2]!, 10);
    const available = intPart + decPart / 1000;
    return {
      ok: true,
      hasSufficient: available >= required,
      available,
      required,
    };
  } catch (cause) {
    return {
      ok: false,
      error: `Hive RPC request failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
}

type CollectionSort = "recent" | "name" | "supply" | "seeds";

type CollectionSummary = {
  id: string;
  name: string;
  symbol: string;
  creator: string;
  totalPotential?: number | null;
  seedCount?: number | null;
  instanceCount?: number | null;
  status?: string | null;
}

type CollectionsResponse = {
  count?: number;
  collections: CollectionSummary[];
}

type UserAssetCounts = {
  total: number;
  seeds: number;
  instances: number;
}

type AssetCardData = {
  id: string;
  collectionId?: string | null;
  edition?: string | number | null;
  owner?: string | null;
  name?: string | null;
  imageUrl?: string | null;
  assetDna?: string | null;
  distributed?: number | null;
  maxSupply?: number | null;
  instanceNumber?: number | null;
  seedId?: string | null;
  listingPrice?: string | null;
  listingCurrency?: string | null;
  status?: string | null;
  isSeed?: boolean;
}

type UserAssetsResponse = {
  counts?: Partial<UserAssetCounts>;
  assets?: AssetCardData[];
}

type UserAssetsResult = {
  counts: UserAssetCounts;
  assets: AssetCardData[];
}

type AssetDetailListingPrice = {
  amount: string;
  currency: string | null;
}

type AssetDetailAsset = {
  id: string;
  name: string;
  imageUrl: string | null;
  owner: string;
  collectionId: string;
  edition: number;
  originDna: string | null;
  assetDna: string | null;
  mintedBy: string | null;
  mintedAt: string | null;
  burned: boolean;
  listed: boolean;
  lent: boolean;
  listingPrice?: AssetDetailListingPrice;
  isSeed: boolean;
  maxSupply: number;
  distributed: number;
  seedId: string | null;
  seedTxId: string | null;
  instanceNumber: number | null;
  dataHash: string | null;
  txId: string;
}

type AssetDetailOriginal = {
  id: string;
  name: string;
  imageUrl: string | null;
  owner: string;
}

type AssetDetailInstance = {
  id: string;
  name: string;
  owner: string;
  instanceNumber: number | null;
}

type AssetDetailResponse = {
  error?: string;
  asset?: AssetDetailAsset;
  original?: AssetDetailOriginal | null;
  instances?: {
    count: number;
    items: AssetDetailInstance[];
  };
}

type KeyType = "Active" | "Posting";

type HiveRpcResponse = {
  error?: { message?: string } | string;
  result?: { id?: string; tx_id?: string; block_num?: number };
}

// ============ FETCH-BACKED HELPERS ============

function keyTypeFromOperation(operation: HiveOperation): KeyType {
  const [, body] = operation;
  return body.required_auths.length > 0 ? "Active" : "Posting";
}

async function broadcastSignedTransaction(signedTx: unknown): Promise<string> {
  const response = await fetch("https://api.hive.blog", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "condenser_api.broadcast_transaction_synchronous",
      params: [signedTx],
      id: 1,
    }),
  });
  const raw: unknown = await response.json();
  const data = raw as HiveRpcResponse;

  if (data.error) {
    const message =
      typeof data.error === "string"
        ? data.error
        : (data.error.message ?? JSON.stringify(data.error));
    throw new Error(message);
  }

  return data.result?.id ?? data.result?.tx_id ?? "unknown";
}

async function fetchJsonOrThrow<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, init);
  const data = (await response.json().catch(() => null)) as {
    error?: string;
    errors?: Array<{ message?: string }>;
  } | null;

  if (!response.ok) {
    const message =
      data?.error ??
      data?.errors
        ?.map((item) => item.message)
        .filter(Boolean)
        .join(", ");
    throw new Error(message || `Request failed (${response.status})`);
  }

  return data as T;
}

function normalizeAssetCounts(data: UserAssetsResponse): UserAssetCounts {
  const assets = data.assets ?? [];
  return {
    total: data.counts?.total ?? assets.length,
    seeds:
      data.counts?.seeds ?? assets.filter((asset) => asset.isSeed === true).length,
    instances:
      data.counts?.instances ??
      assets.filter((asset) => asset.isSeed !== true).length,
  };
}

function formatDisplayDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function getAssetsByOwner(
  owner: string,
  limit = 200,
  offset = 0,
): Promise<UserAssetsResult> {
  const firstData = await fetchJsonOrThrow<UserAssetsResponse>(
    `/api/user/${encodeURIComponent(owner)}?limit=${limit}&offset=${offset}`,
  );
  const counts = normalizeAssetCounts(firstData);
  const allAssets: AssetCardData[] = firstData.assets ?? [];

  if (counts.total > limit) {
    const totalPages = Math.ceil(counts.total / limit);
    const pages = await Promise.all(
      Array.from({ length: totalPages - 1 }, async (_, index) => {
        const page = index + 1;
        const data = await fetchJsonOrThrow<UserAssetsResponse>(
          `/api/user/${encodeURIComponent(owner)}?limit=${limit}&offset=${page * limit}`,
        );
        return data.assets ?? [];
      }),
    );
    for (const assets of pages) allAssets.push(...assets);
  }

  return { assets: allAssets, counts };
}

async function validateTransfer(assetId: string, currentUser: string) {
  try {
    const response = await fetch(
      `/api/assets/${encodeURIComponent(assetId)}/details`,
    );
    const data = await response.json();

    if (data.error) {
      return { valid: false as const, error: data.error };
    }

    const asset = data.asset;

    if (asset.burned) {
      return { valid: false as const, error: "Asset has been burned" };
    }

    if (asset.owner.toLowerCase() !== currentUser.toLowerCase()) {
      return {
        valid: false as const,
        error: `You are not the owner (@${asset.owner})`,
      };
    }

    if (asset.listed) {
      return {
        valid: true as const,
        warning: "Warning: Transfer will unlist Asset from marketplace",
        asset,
      };
    }

    return { valid: true as const, asset };
  } catch (e) {
    return { valid: false as const, error: String(e) };
  }
}

// ============ NAVIGATION ============

let navigationStack: string[] = ["collections"];
let currentCollectionId: string | null = null;
let currentAssetId: string | null = null;
let currentSeedGroupId: string | null = null;

function navigateTo(pageId: string) {
  document
    .querySelectorAll(".page")
    .forEach((p) => p.classList.remove("active"));
  document
    .querySelectorAll(".nav-item")
    .forEach((n) => n.classList.remove("active"));

  const page = $(`page-${pageId}`);
  const nav = document.querySelector(`.nav-item[data-page="${pageId}"]`);

  if (page) page.classList.add("active");
  if (nav) nav.classList.add("active");

  if (pageId === "marketplace") {
    (window as any).loadListings?.();
  }

  if (pageId === "node") {
    (window as any).loadNodeView?.();
  }
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
(window as any).navigateTo = navigateTo;

document.querySelectorAll(".nav-item").forEach((item) => {
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
  if (creatorInput) {
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

let loadedCollections: CollectionSummary[] = [];

function getCollectionSort(): CollectionSort {
  const value = ($("collection-sort") as HTMLSelectElement | null)?.value;
  if (value === "name" || value === "supply" || value === "seeds") return value;
  return "recent";
}

function getCollectionSearchTerm(): string {
  return (($("collection-search") as HTMLInputElement | null)?.value ?? "")
    .trim()
    .toLowerCase();
}

function getCollectionItemCount(collection: CollectionSummary): number {
  return (collection.seedCount ?? 0) + (collection.instanceCount ?? 0);
}

function getCollectionInitial(collection: CollectionSummary): string {
  const value = collection.symbol || collection.name || collection.id;
  return value.slice(0, 2).toUpperCase();
}

function sortCollections(
  collections: CollectionSummary[],
  sort: CollectionSort,
): CollectionSummary[] {
  const sorted = [...collections];
  if (sort === "name") {
    return sorted.sort((a, b) => a.name.localeCompare(b.name));
  }
  if (sort === "supply") {
    return sorted.sort(
      (a, b) => getCollectionItemCount(b) - getCollectionItemCount(a),
    );
  }
  if (sort === "seeds") {
    return sorted.sort((a, b) => (b.seedCount ?? 0) - (a.seedCount ?? 0));
  }
  return sorted;
}

function renderCollections() {
  const container = $("collections-container");
  const countLabel = $("collection-count-label");
  if (!container) return;

  const query = getCollectionSearchTerm();
  const filtered = loadedCollections.filter((collection) => {
    if (!query) return true;
    const searchable = [
      collection.name,
      collection.symbol,
      collection.creator,
      collection.id,
    ]
      .join(" ")
      .toLowerCase();
    return searchable.includes(query);
  });
  const collections = sortCollections(filtered, getCollectionSort());

  if (countLabel) {
    countLabel.textContent = query
      ? `${collections.length} of ${loadedCollections.length} collections match "${query}".`
      : `${collections.length} active collections available.`;
  }

  if (collections.length === 0) {
    container.innerHTML = `
			<div class="empty-state">
				<p class="empty-state-text">No collections match this search.</p>
			</div>
		`;
    return;
  }

  container.innerHTML = collections
    .map((col) => {
      const status = String(col.status || "active");
      const statusClass =
        status === "archived" ? "status-archived" : "status-active";
      const itemCount = getCollectionItemCount(col);

      return `
			<article class="collection-card" data-id="${escapeHtml(col.id)}">
				<div class="collection-card-cover" aria-hidden="true">${escapeHtml(getCollectionInitial(col))}</div>
				<div class="collection-card-header">
					<span class="collection-symbol">${escapeHtml(col.symbol)}</span>
					<span class="status-badge ${statusClass}">${escapeHtml(status.toUpperCase())}</span>
				</div>
				<div class="collection-name">${escapeHtml(col.name)}</div>
				<div class="collection-meta">
					<span class="collection-creator">@${escapeHtml(col.creator)}</span>
				</div>
				<div class="collection-meta" style="margin-top: 8px;">${escapeHtml(col.id)}</div>
				<div class="collection-stats-row">
					<div class="collection-stat">
						<span class="collection-stat-value">${itemCount.toLocaleString()}</span>
						<span class="collection-stat-label">items</span>
					</div>
					<div class="collection-stat">
						<span class="collection-stat-value">${(col.seedCount ?? 0).toLocaleString()}</span>
						<span class="collection-stat-label">seeds</span>
					</div>
					<div class="collection-stat">
						<span class="collection-stat-value">${(col.instanceCount ?? 0).toLocaleString()}</span>
						<span class="collection-stat-label">instances</span>
					</div>
				</div>
			</article>
		`;
    })
    .join("");

  container.querySelectorAll(".collection-card").forEach((card) => {
    card.addEventListener("click", () => {
      const id = (card as HTMLElement).dataset.id;
      if (id) loadCollectionDetail(id);
    });
  });
}

async function loadCollections() {
  const container = $("collections-container");
  if (!container) return;

  container.innerHTML =
    '<div class="empty-state"><p class="empty-state-text">Loading...</p></div>';

  try {
    const data =
      await fetchJsonOrThrow<CollectionsResponse>("/api/collections");
    loadedCollections = data.collections ?? [];

    if (loadedCollections.length === 0) {
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

    renderCollections();
    log(`Loaded ${loadedCollections.length} collections`, "success");
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
$("collection-search")?.addEventListener("input", renderCollections);
$("collection-sort")?.addEventListener("change", renderCollections);

// ============ COLLECTION DETAIL ============

function updateCollectionArchiveActions(
  collection: { creator: string; status: string } | null,
) {
  const actions = $("detail-archive-actions");
  const button = $("btn-archive-collection") as HTMLButtonElement | null;
  const canArchive = Boolean(
    collection &&
    collection.status === "active" &&
    connectedUser &&
    collection.creator.toLowerCase() === connectedUser.toLowerCase(),
  );

  if (actions) actions.style.display = canArchive ? "flex" : "none";
  if (button) {
    button.disabled = !canArchive;
    button.textContent = "Archive Empty Collection";
  }
}

async function loadCollectionDetail(collectionId: string) {
  currentCollectionId = collectionId;
  navigationStack = ["collections", "collection-detail"];
  navigateTo("collection-detail");

  // Show loading state
  const seedsContainer = $("collection-seeds");
  const instancesContainer = $("collection-instances");
  const statusEl = $("detail-status");
  if (seedsContainer)
    seedsContainer.innerHTML =
      '<div class="empty-state"><p class="empty-state-text">Loading...</p></div>';
  if (instancesContainer) instancesContainer.innerHTML = "";
  if (statusEl) {
    statusEl.textContent = "ACTIVE";
    statusEl.className = "status-badge status-active";
  }
  updateCollectionArchiveActions(null);

  try {
    const [collection, assetsData] = await Promise.all([
      fetchJsonOrThrow<any>(`/api/collections/${collectionId}`),
      fetchJsonOrThrow<any>(`/api/collections/${collectionId}/assets`),
    ]);

    // Update header
    const symbolEl = $("detail-symbol");
    const nameEl = $("detail-collection-name");
    const creatorEl = $("detail-creator");
    if (symbolEl) symbolEl.textContent = collection.symbol || "N/A";
    if (nameEl) nameEl.textContent = collection.name || collectionId;
    if (creatorEl)
      creatorEl.textContent = `@${collection.creator || "unknown"}`;
    if (statusEl) {
      statusEl.textContent = String(
        collection.status || "active",
      ).toUpperCase();
      statusEl.className =
        collection.status === "archived"
          ? "status-badge status-archived"
          : "status-badge status-active";
    }
    updateCollectionArchiveActions(collection);

    // Update stats
    const seedsCount = $("detail-seeds-count");
    const instancesCount = $("detail-instances-count");
    const totalCount = $("detail-total-count");
    if (seedsCount) seedsCount.textContent = String(assetsData.seeds?.count || 0);
    if (instancesCount)
      instancesCount.textContent = String(assetsData.instances?.count || 0);
    if (totalCount) totalCount.textContent = String(assetsData.totalCount || 0);

    // Render seeds
    if (seedsContainer) {
      const seeds = assetsData.seeds?.items || [];
      if (seeds.length === 0) {
        seedsContainer.innerHTML =
          '<div class="empty-state"><p class="empty-state-text">No seeds in this collection</p></div>';
      } else {
        seedsContainer.innerHTML = seeds
          .map(
            (asset: any) => `
					<div class="asset-card" data-id="${escapeHtml(asset.id)}">
						<img class="asset-image" src="${escapeHtml(asset.imageUrl)}" onerror="this.src='${PLACEHOLDER_SM}'">
						<div class="asset-card-body">
							<div class="asset-name">${escapeHtml(asset.name)}</div>
							<div class="asset-owner">@${escapeHtml(asset.owner)}</div>
							<div class="asset-meta">
								<span class="asset-meta-supply">${asset.distributed || 0}/${asset.maxSupply}</span>
								<span class="asset-type-badge seed">SEED</span>
							</div>
						</div>
					</div>
				`,
          )
          .join("");

        // Add click handlers
        seedsContainer.querySelectorAll(".asset-card").forEach((card) => {
          card.addEventListener("click", () => {
            const id = (card as HTMLElement).dataset.id;
            if (id) loadAssetDetail(id);
          });
        });
      }
    }

    // Render instances
    if (instancesContainer) {
      const instances = assetsData.instances?.items || [];
      if (instances.length === 0) {
        instancesContainer.innerHTML =
          '<div class="empty-state"><p class="empty-state-text">No instances yet</p></div>';
      } else {
        instancesContainer.innerHTML = instances
          .map(
            (asset: any) => `
					<div class="asset-card" data-id="${escapeHtml(asset.id)}">
						<img class="asset-image" src="${escapeHtml(asset.imageUrl)}" onerror="this.src='${PLACEHOLDER_SM}'">
						<div class="asset-card-body">
							<div class="asset-name">${escapeHtml(asset.name)}</div>
							<div class="asset-owner">@${escapeHtml(asset.owner)}</div>
							<div class="asset-meta">
								<span class="asset-meta-supply">#${asset.instanceNumber || 1}</span>
								<span class="asset-type-badge instance">INSTANCE</span>
							</div>
						</div>
					</div>
				`,
          )
          .join("");

        // Add click handlers
        instancesContainer.querySelectorAll(".asset-card").forEach((card) => {
          card.addEventListener("click", () => {
            const id = (card as HTMLElement).dataset.id;
            if (id) loadAssetDetail(id);
          });
        });
      }
    }

    log(`Loaded collection: ${collection.name || collectionId}`, "success");
  } catch (e) {
    if (seedsContainer) {
      seedsContainer.innerHTML =
        '<div class="empty-state"><p class="empty-state-text">Error loading collection</p></div>';
    }
    updateCollectionArchiveActions(null);
    log(`Error: ${(e as Error).message}`, "error");
  }
}

(window as any).loadCollectionDetail = loadCollectionDetail;

async function archiveCurrentCollection() {
  if (!connectedUser || !currentCollectionId) {
    log("Connect wallet first", "error");
    return;
  }

  if (!(window as any).hive_keychain) {
    log("Install Hive Keychain extension to broadcast operations", "error");
    return;
  }

  const confirmed = window.confirm(
    "Archive this collection? This only succeeds if it has no seeds or instances.",
  );
  if (!confirmed) return;

  const button = $("btn-archive-collection") as HTMLButtonElement | null;
  if (button) {
    button.disabled = true;
    button.textContent = "Archiving...";
  }

  try {
    const result = await fetchJsonOrThrow<{ operation: HiveOperation }>(
      "/api/build/archive-collection",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collectionId: currentCollectionId,
          creator: connectedUser,
        }),
      },
    );

    log(`Archiving collection ${currentCollectionId}...`);
    (window as any).hive_keychain.requestBroadcast(
      connectedUser,
      [result.operation],
      "Posting",
      async (res: any) => {
        if (res.success) {
          log(`Collection ${currentCollectionId} archived`, "success");
          await loadCollections();
          goBackToCollections();
          return;
        }

        const err =
          typeof res.error === "object"
            ? JSON.stringify(res.error)
            : res.error || res.message;
        if (button) {
          button.disabled = false;
          button.textContent = "Archive Empty Collection";
        }
        log(`Archive failed: ${err}`, "error");
      },
    );
  } catch (e) {
    if (button) {
      button.disabled = false;
      button.textContent = "Archive Empty Collection";
    }
    log(`Error: ${(e as Error).message}`, "error");
  }
}

(window as any).archiveCurrentCollection = archiveCurrentCollection;

// ============ Asset DETAIL ============

async function loadAssetDetail(assetId: string) {
  currentAssetId = assetId;
  navigationStack.push("asset-detail");
  navigateTo("asset-detail");

  // Reset sections
  const parentSection = $("parent-section");
  const instancesSection = $("instances-section");
  const seedInfoSection = $("seed-info-section");
  const burnSection = $("asset-burn-section");
  const setDataSection = $("asset-set-data-section");
  if (parentSection) parentSection.style.display = "none";
  if (instancesSection) instancesSection.style.display = "none";
  if (seedInfoSection) seedInfoSection.style.display = "none";
  if (burnSection) burnSection.style.display = "none";
  if (setDataSection) setDataSection.style.display = "none";
  const lendForm = $("asset-action-lend-form");
  const returnForm = $("asset-action-return-form");
  if (lendForm) lendForm.style.display = "none";
  if (returnForm) returnForm.style.display = "none";

  try {
    const data = await fetchJsonOrThrow<AssetDetailResponse>(
      `/api/assets/${encodeURIComponent(assetId)}/details`,
    );

    if (data.error || !data.asset) {
      log(`Asset not found: ${data.error}`, "error");
      return;
    }

    const asset = data.asset;

    // Update basic info
    const imageEl = $("asset-detail-image") as HTMLImageElement;
    const nameEl = $("asset-detail-name");
    const ownerEl = $("asset-detail-owner");
    if (imageEl) {
      imageEl.src = escapeHtml(asset.imageUrl);
      imageEl.onerror = () => {
        imageEl.src = PLACEHOLDER_LG;
      };
    }
    if (nameEl) nameEl.textContent = asset.name;
    if (ownerEl) ownerEl.textContent = `@${asset.owner}`;

    // Update badges
    const badgesEl = $("asset-detail-badges");
    if (badgesEl) {
      const badges: string[] = [];
      if (asset.isSeed) badges.push('<span class="asset-badge seed">SEED</span>');
      if (asset.seedId)
        badges.push(
          '<span class="asset-badge instance">INSTANCE #' +
            (asset.instanceNumber || 1) +
            "</span>",
        );
      if (asset.listed)
        badges.push('<span class="asset-badge listed">LISTED</span>');
      if (asset.lent)
        badges.push('<span class="asset-badge posting">LENT</span>');
      badgesEl.innerHTML = badges.join("");
    }

    // Update DNA info
    const originDnaEl = $("asset-detail-origin-dna");
    const assetDnaEl = $("asset-detail-asset-dna");
    const idEl = $("asset-detail-id");
    const collectionIdEl = $("asset-detail-collection-id");
    if (originDnaEl) originDnaEl.textContent = asset.originDna || "-";
    if (assetDnaEl) assetDnaEl.textContent = asset.assetDna || "-";
    if (idEl) idEl.textContent = asset.id;
    if (collectionIdEl) collectionIdEl.textContent = asset.collectionId;

    // Seed-specific info
    if (asset.isSeed && seedInfoSection) {
      seedInfoSection.style.display = "block";
      const maxSupplyEl = $("asset-detail-max-supply");
      const distributedEl = $("asset-detail-distributed");
      if (maxSupplyEl) maxSupplyEl.textContent = String(asset.maxSupply || 0);
      if (distributedEl)
        distributedEl.textContent = String(asset.distributed || 0);
    }

    // Parent seed for an instance.
    if (data.original && parentSection) {
      const original = data.original;
      parentSection.style.display = "block";
      const parentItem = $("asset-parent-item");
      const parentName = $("asset-parent-name");
      if (parentName) parentName.textContent = original.name;
      if (parentItem) {
        parentItem.onclick = () => loadAssetDetail(original.id);
      }
    }

    // Instances
    if (data.instances && data.instances.count > 0 && instancesSection) {
      instancesSection.style.display = "block";
      const countEl = $("instances-count");
      const listEl = $("asset-instances-list");
      if (countEl) countEl.textContent = String(data.instances.count);
      if (listEl) {
        listEl.innerHTML = data.instances.items
          .map(
            (r) => `
					<div class="instance-item" data-id="${r.id}">
						<span class="instance-num">#${r.instanceNumber || "?"}</span>
						<span class="instance-owner">@${r.owner}</span>
					</div>
				`,
          )
          .join("");

        // Add click handlers
        listEl.querySelectorAll(".instance-item").forEach((item) => {
          item.addEventListener("click", () => {
            const id = (item as HTMLElement).dataset.id;
            if (id) loadAssetDetail(id);
          });
        });
      }
    }

    // Actions section (visible when owner)
    const actionsSection = $("asset-actions-section");
    const actionSeedButtons = $("asset-action-seed-buttons");
    const actionInstanceButtons = $("asset-action-instance-buttons");
    const actionQuantityGroup = $("asset-action-quantity-group");
    const isOwner =
      connectedUser && asset.owner.toLowerCase() === connectedUser.toLowerCase();

    if (actionsSection) {
      if (isOwner) {
        actionsSection.style.display = "block";
        if (asset.isSeed) {
          const remaining = (asset.maxSupply || 0) - (asset.distributed || 0);
          if (actionSeedButtons) actionSeedButtons.style.display = "block";
          if (actionInstanceButtons)
            actionInstanceButtons.style.display = "none";
          const quantityInput = $("asset-action-quantity") as HTMLInputElement;
          const remainingEl = $("asset-action-remaining");
          if (quantityInput) {
            quantityInput.max = String(remaining);
            quantityInput.value = "1";
          }
          if (remainingEl) remainingEl.textContent = `/ ${remaining} remaining`;
        } else {
          if (actionSeedButtons) actionSeedButtons.style.display = "none";
          if (actionInstanceButtons)
            actionInstanceButtons.style.display = "block";
          const listForm = $("asset-action-list-form");
          const unlistForm = $("asset-action-unlist-form");
          const listingInfo = $("asset-action-listing-info");
          if (asset.listed) {
            if (listForm) listForm.style.display = "none";
            if (unlistForm) unlistForm.style.display = "block";
            if (listingInfo && asset.listingPrice) {
              listingInfo.textContent = `Currently listed for ${asset.listingPrice.amount} ${asset.listingPrice.currency}`;
            }
          } else {
            if (listForm) listForm.style.display = "block";
            if (unlistForm) unlistForm.style.display = "none";
          }

          if (asset.lent) {
            if (lendForm) lendForm.style.display = "none";
            if (returnForm) returnForm.style.display = "block";
          } else {
            if (lendForm) lendForm.style.display = "block";
            if (returnForm) returnForm.style.display = "none";
          }
        }
      } else {
        actionsSection.style.display = "none";
      }
    }

    // Burn section (visible when owner)
    if (burnSection && isOwner) {
      burnSection.style.display = "block";
    }

    // Set Mutable Data section (visible when user is the creator)
    const isCreator =
      connectedUser &&
      asset.mintedBy &&
      asset.mintedBy.toLowerCase() === connectedUser.toLowerCase();
    if (setDataSection && isCreator) {
      setDataSection.style.display = "block";
      const setDataIdEl = $("asset-set-data-id") as HTMLInputElement;
      if (setDataIdEl) setDataIdEl.value = asset.id;
    }

    // Provenance
    const mintedByEl = $("asset-detail-minted-by");
    const mintedAtEl = $("asset-detail-minted-at");
    if (mintedByEl)
      mintedByEl.textContent = asset.mintedBy ? `@${asset.mintedBy}` : "-";
    if (mintedAtEl) mintedAtEl.textContent = formatDisplayDate(asset.mintedAt);

    log(`Loaded Asset: ${asset.name}`, "success");
  } catch (e) {
    log(`Error: ${(e as Error).message}`, "error");
  }
}

(window as any).loadAssetDetail = loadAssetDetail;

// ============ NAVIGATION HELPERS ============

function goBackFromAsset() {
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

(window as any).goBackFromAsset = goBackFromAsset;

function goBackToCollections() {
  currentCollectionId = null;
  navigationStack = ["collections"];
  navigateTo("collections");
}

(window as any).goBackToCollections = goBackToCollections;

// ============ INVENTORY ============

async function loadInventory() {
  const container = $("inventory-container");
  const summary = $("inventory-summary");
  if (!container) return;

  if (!connectedUser) {
    if (summary) summary.style.display = "none";
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

  container.innerHTML =
    '<div class="empty-state"><p class="empty-state-text">Loading...</p></div>';

  try {
    const result = await getAssetsByOwner(connectedUser, 200);
    const counts = result.counts;
    const seeds = result.assets.filter((n) => n.isSeed === true);
    const instances = result.assets.filter((n) => n.isSeed !== true);
    const totalCount = counts.total;
    renderInventorySummary(counts, result.assets);

    if (totalCount === 0) {
      container.innerHTML =
        '<div class="empty-state"><p class="empty-state-text">No Assets found</p></div>';
    } else {
      let html = "";

      if (seeds.length > 0) {
        html += `
					<div class="inventory-section">
						<div class="inventory-section-header">
							<span class="inventory-section-title" style="color: var(--accent);">Seeds</span>
							<span class="inventory-section-count" style="background: var(--accent-dim); color: var(--accent);">${counts.seeds}</span>
						</div>
						<div class="asset-grid" id="inventory-seeds"></div>
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
						<div class="asset-grid" id="inventory-instances"></div>
					</div>
				`;
      }

      container.innerHTML = html;

      if (seeds.length > 0) renderAssets(seeds, "inventory-seeds", true);
      if (instances.length > 0) {
        const groups = groupInstancesBySeed(instances);
        renderInstanceGroups(groups, "inventory-instances");
      }
    }

    log(
      `Loaded ${totalCount} Assets (${counts.seeds} seeds, ${counts.instances} instances)`,
      "success",
    );
  } catch (e) {
    log(`Error: ${(e as Error).message}`, "error");
  }
}

(window as any).loadInventory = loadInventory;

async function loadSeedGroup(seedId: string) {
  if (!connectedUser) {
    log("Connect wallet to view your inventory", "error");
    return;
  }
  currentSeedGroupId = seedId;
  navigationStack.push("seed-group");
  navigateTo("seed-group");

  const titleEl = $("seed-group-title");
  const subtitleEl = $("seed-group-subtitle");
  const summaryEl = $("seed-group-summary");
  const tableContainer = $("seed-group-table-container");

  if (titleEl) titleEl.textContent = "Loading seed…";
  if (subtitleEl) subtitleEl.textContent = "";
  if (summaryEl) summaryEl.style.display = "none";
  if (tableContainer) {
    tableContainer.innerHTML =
      '<div class="empty-state"><p class="empty-state-text">Loading…</p></div>';
  }

  try {
    const [seedData, ownerData] = await Promise.all([
      fetchJsonOrThrow<AssetDetailResponse>(
        `/api/assets/${encodeURIComponent(seedId)}/details`,
      ),
      getAssetsByOwner(connectedUser, 200),
    ]);

    if (seedData.error || !seedData.asset) {
      if (titleEl) titleEl.textContent = "Seed not found";
      if (tableContainer) {
        tableContainer.innerHTML = `
					<div class="empty-state">
						<p class="empty-state-text">Could not load seed: ${escapeHtml(seedData.error ?? "unknown error")}</p>
					</div>
				`;
      }
      return;
    }

    const seed = seedData.asset;
    const owned = ownerData.assets.filter(
      (n) => n.isSeed !== true && instanceGroupKey(n) === seedId,
    );

    if (titleEl) titleEl.textContent = seed.name;
    if (subtitleEl) {
      subtitleEl.textContent = `Your owned instances of this seed`;
    }
    if (summaryEl) {
      summaryEl.style.display = "grid";
      const image = $("seed-group-image") as HTMLImageElement | null;
      if (image) {
        image.src = seed.imageUrl ?? PLACEHOLDER_SM;
        image.onerror = () => {
          image.src = PLACEHOLDER_SM;
        };
      }
      const collectionEl = $("seed-group-collection");
      const editionEl = $("seed-group-edition");
      const ownedEl = $("seed-group-owned");
      const totalEl = $("seed-group-total");
      if (collectionEl) collectionEl.textContent = seed.collectionId;
      if (editionEl) editionEl.textContent = String(seed.edition ?? "-");
      if (ownedEl) ownedEl.textContent = String(owned.length);
      if (totalEl) totalEl.textContent = String(seed.distributed ?? 0);
    }

    if (owned.length === 0) {
      if (tableContainer) {
        tableContainer.innerHTML = `
					<div class="empty-state">
						<p class="empty-state-text">You don't own any instance of this seed.</p>
					</div>
				`;
      }
      return;
    }

    renderSeedGroupTable(owned);
  } catch (e) {
    log(`Error loading seed group: ${(e as Error).message}`, "error");
    if (tableContainer) {
      tableContainer.innerHTML = `
				<div class="empty-state">
					<p class="empty-state-text">Failed to load.</p>
				</div>
			`;
    }
  }
}

function renderSeedGroupTable(owned: AssetCardData[]) {
  const tableContainer = $("seed-group-table-container");
  if (!tableContainer) return;

  const sorted = [...owned].sort(
    (a, b) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0),
  );

  const rows = sorted
    .map((asset) => {
      const isLent = (asset.status ?? "").toLowerCase() === "lent";
      const isListed = Boolean(asset.listingPrice);
      const statusText = isLent
        ? "Lent"
        : isListed
          ? `Listed @ ${escapeHtml(asset.listingPrice ?? "")} ${escapeHtml(asset.listingCurrency ?? "")}`
          : "Owned";
      const idAttr = escapeHtml(asset.id);
      const disabled = isLent ? "disabled" : "";
      const lentTip = isLent ? 'title="Lent — cannot modify"' : "";
      const listAction = isListed
        ? `<button class="btn btn-secondary" data-action="unlist" ${disabled} ${lentTip}>Unlist</button>`
        : `<button class="btn btn-secondary" data-action="list" ${disabled} ${lentTip}>List</button>`;
      return `
				<tr data-asset-id="${idAttr}">
					<td>#${asset.instanceNumber ?? "?"}</td>
					<td><span class="seed-group-id">${idAttr}</span></td>
					<td>${statusText}</td>
					<td class="seed-group-actions">
						<button class="btn btn-secondary" data-action="open">Open</button>
						<button class="btn btn-secondary" data-action="transfer" ${disabled} ${lentTip}>Transfer</button>
						${listAction}
					</td>
				</tr>
			`;
    })
    .join("");

  tableContainer.innerHTML = `
		<table class="seed-group-table">
			<thead>
				<tr>
					<th>#</th>
					<th>ID</th>
					<th>Status</th>
					<th>Actions</th>
				</tr>
			</thead>
			<tbody>
				${rows}
			</tbody>
		</table>
	`;

  tableContainer.querySelectorAll("button[data-action]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      if ((btn as HTMLButtonElement).disabled) return;
      const row = btn.closest("tr") as HTMLElement | null;
      const id = row?.dataset.assetId;
      if (!id) return;
      const action = (btn as HTMLElement).dataset.action;
      if (action === "open") (window as any).seedGroupOpen?.(id);
      else if (action === "transfer") (window as any).seedGroupTransferPrompt?.(id);
      else if (action === "list") (window as any).seedGroupListPrompt?.(id);
      else if (action === "unlist") (window as any).seedGroupUnlist?.(id);
    };
  });
}

(window as any).loadSeedGroup = loadSeedGroup;

function seedGroupOpen(assetId: string) {
  loadAssetDetail(assetId);
}

async function seedGroupTransferPrompt(assetId: string) {
  if (!connectedUser) {
    log("Connect wallet first", "error");
    return;
  }
  const to = window
    .prompt(`Transfer ${assetId} to which Hive account?`)
    ?.trim()
    .toLowerCase();
  if (!to) return;

  log(`Validating transfer of ${assetId}…`);
  const validation = await validateTransfer(assetId, connectedUser);
  if (!validation.valid) {
    log(`Cannot transfer: ${validation.error}`, "error");
    return;
  }
  const asset = validation.asset!;
  const buildResult = buildTransfer({
    assetId: asset.id,
    from: connectedUser,
    to,
  });
  if (!buildResult.success) {
    log(`Build transfer failed: ${buildResult.errors.join(", ")}`, "error");
    return;
  }

  log(`Transferring ${assetId} to @${to}…`);
  (window as any).hive_keychain.requestBroadcast(
    connectedUser,
    [buildResult.operations[0]],
    "Posting",
    (res: any) => {
      if (res.success) {
        log(`Transfer successful!`, "success");
        scheduleSeedGroupReload();
      } else {
        const err =
          typeof res.error === "object" ? JSON.stringify(res.error) : res.error;
        log(`Transfer failed: ${err}`, "error");
      }
    },
  );
}

async function seedGroupListPrompt(assetId: string) {
  if (!connectedUser) {
    log("Connect wallet first", "error");
    return;
  }
  const rawPrice = window.prompt(`List ${assetId} for what price?`)?.trim();
  if (!rawPrice) return;
  const parsed = parseFloat(rawPrice);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    log("Invalid price", "error");
    return;
  }
  const currency = (
    window.prompt("Currency? Type HIVE or HBD", "HIVE") ?? "HIVE"
  )
    .trim()
    .toUpperCase();
  if (currency !== "HIVE" && currency !== "HBD") {
    log("Currency must be HIVE or HBD", "error");
    return;
  }
  const rawDays = window.prompt("Duration in days? (7-60)", "30")?.trim();
  const durationDays = parseInt(rawDays ?? "30", 10);
  if (!Number.isFinite(durationDays) || durationDays < 7 || durationDays > 60) {
    log("Duration must be between 7 and 60 days", "error");
    return;
  }
  const price = parsed.toFixed(3);
  const expiresAt = Date.now() + durationDays * 86_400_000;

  try {
    const response = await fetch("/api/build/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assetId,
        owner: connectedUser,
        price: { amount: price, currency },
        expiresAt,
      }),
    });
    const result = await response.json();
    if (!result.success) {
      log(`Error: ${result.errors?.[0]?.message || result.error}`, "error");
      return;
    }

    log(`Listing ${assetId} for ${price} ${currency}…`);
    (window as any).hive_keychain.requestBroadcast(
      connectedUser,
      [result.operation],
      "Posting",
      (res: any) => {
        if (res.success) {
          log(`Listed for ${price} ${currency}!`, "success");
          scheduleSeedGroupReload();
        } else {
          const err =
            typeof res.error === "object"
              ? JSON.stringify(res.error)
              : res.error;
          log(`Listing failed: ${err}`, "error");
        }
      },
    );
  } catch (e) {
    log(`Error: ${(e as Error).message}`, "error");
  }
}

async function seedGroupUnlist(assetId: string) {
  if (!connectedUser) {
    log("Connect wallet first", "error");
    return;
  }
  if (!window.confirm(`Unlist ${assetId}?`)) return;

  try {
    const response = await fetch("/api/build/unlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetId, owner: connectedUser }),
    });
    const result = await response.json();
    if (!result.success) {
      log(`Error: ${result.errors?.[0]?.message || result.error}`, "error");
      return;
    }

    log(`Unlisting ${assetId}…`);
    (window as any).hive_keychain.requestBroadcast(
      connectedUser,
      [result.operation],
      "Posting",
      (res: any) => {
        if (res.success) {
          log("Unlisted!", "success");
          scheduleSeedGroupReload();
        } else {
          const err =
            typeof res.error === "object"
              ? JSON.stringify(res.error)
              : res.error;
          log(`Unlist failed: ${err}`, "error");
        }
      },
    );
  } catch (e) {
    log(`Error: ${(e as Error).message}`, "error");
  }
}

let seedGroupReloadTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSeedGroupReload() {
  if (seedGroupReloadTimer) clearTimeout(seedGroupReloadTimer);
  seedGroupReloadTimer = setTimeout(() => {
    seedGroupReloadTimer = null;
    if (currentSeedGroupId) loadSeedGroup(currentSeedGroupId);
    loadInventory();
  }, 5000);
}

(window as any).seedGroupOpen = seedGroupOpen;
(window as any).seedGroupTransferPrompt = seedGroupTransferPrompt;
(window as any).seedGroupListPrompt = seedGroupListPrompt;
(window as any).seedGroupUnlist = seedGroupUnlist;

function renderInventorySummary(counts: UserAssetCounts, assets: AssetCardData[]) {
  const summary = $("inventory-summary");
  if (!summary) return;

  const listedCount = assets.filter((asset) => Boolean(asset.listingPrice)).length;
  summary.style.display = "grid";
  summary.innerHTML = `
		<div class="inventory-summary-card">
			<div class="stat-label">Owned</div>
			<div class="stat-value">${counts.total.toLocaleString()}</div>
		</div>
		<div class="inventory-summary-card">
			<div class="stat-label">Seeds</div>
			<div class="stat-value">${counts.seeds.toLocaleString()}</div>
		</div>
		<div class="inventory-summary-card">
			<div class="stat-label">Instances</div>
			<div class="stat-value">${counts.instances.toLocaleString()}</div>
		</div>
		<div class="inventory-summary-card">
			<div class="stat-label">Listed</div>
			<div class="stat-value">${listedCount.toLocaleString()}</div>
		</div>
	`;
}

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

  container.innerHTML =
    '<div class="empty-state"><p class="empty-state-text">Searching...</p></div>';

  try {
    const result = await getAssetsByOwner(user);
    renderAssets(result.assets, "search-results");
    log(`Found ${result.assets.length} Assets for @${user}`, "success");
  } catch (e) {
    log(`Error: ${(e as Error).message}`, "error");
  }
}

(window as any).searchUser = searchUser;

// ============ RENDER AssetS ============

function renderAssets(
  assets: AssetCardData[],
  containerId: string,
  selectable = false,
) {
  const container = $(containerId);
  if (!container) return;

  if (assets.length === 0) {
    container.innerHTML = `
			<div class="empty-state">
				<p class="empty-state-text">No Assets found</p>
			</div>
		`;
    return;
  }

  container.innerHTML = assets
    .map((asset) => {
      const isSeed = asset.isSeed === true;
      const typeLabel = isSeed ? "SEED" : "INSTANCE";
      const typeCls = isSeed ? "seed" : "instance";
      const supplyText = isSeed
        ? `${asset.distributed || 0}/${asset.maxSupply || 0}`
        : `#${asset.instanceNumber || 1}`;

      return `
			<div class="asset-card" data-id="${escapeHtml(asset.id)}" data-collection="${escapeHtml(asset.collectionId)}"
				 data-edition="${escapeHtml(String(asset.edition ?? ""))}" data-dna="${escapeHtml(asset.assetDna)}">
				<img class="asset-image" src="${escapeHtml(asset.imageUrl)}" onerror="this.src='${PLACEHOLDER_SM}'">
				<div class="asset-card-body">
					<div class="asset-name">${escapeHtml(asset.name ?? "Untitled Asset")}</div>
					<div class="asset-owner">@${escapeHtml(asset.owner ?? "unknown")}</div>
					<div class="asset-meta">
						<span class="asset-meta-supply">${supplyText}</span>
						<span class="asset-type-badge ${typeCls}">${typeLabel}</span>
					</div>
				</div>
			</div>
		`;
    })
    .join("");

  if (selectable) {
    container.querySelectorAll(".asset-card").forEach((card) => {
      (card as HTMLElement).onclick = () => {
        const id = (card as HTMLElement).dataset.id;
        if (id) loadAssetDetail(id);
      };
    });
  }
}

function renderInstanceGroups(
  groups: InstanceGroup[],
  containerId: string,
) {
  const container = $(containerId);
  if (!container) return;

  if (groups.length === 0) {
    container.innerHTML = `
				<div class="empty-state">
					<p class="empty-state-text">No Assets found</p>
				</div>
			`;
    return;
  }

  container.innerHTML = groups
    .map((g) => {
      const showCount = g.count >= 2;
      const listedChip =
        g.listedCount > 0
          ? `<span class="seed-group-status-chip">${g.listedCount} listed</span>`
          : "";
      return `
				<div class="asset-card" data-seed="${escapeHtml(g.seedId)}">
					${showCount ? `<span class="asset-card-group-badge">x${g.count}</span>` : ""}
					<img class="asset-image" src="${escapeHtml(g.imageUrl)}" onerror="this.src='${PLACEHOLDER_SM}'">
					<div class="asset-card-body">
						<div class="asset-name">${escapeHtml(g.name)}</div>
						<div class="asset-owner">@${escapeHtml(connectedUser ?? "")}</div>
						<div class="asset-meta">
							<span class="asset-meta-supply">${g.count} owned</span>
							<span class="asset-type-badge instance">INSTANCE</span>
						</div>
						${listedChip ? `<div class="asset-meta">${listedChip}</div>` : ""}
					</div>
				</div>
			`;
    })
    .join("");

  container.querySelectorAll(".asset-card").forEach((card) => {
    (card as HTMLElement).onclick = () => {
      const seedId = (card as HTMLElement).dataset.seed;
      if (seedId) loadSeedGroup(seedId);
    };
  });
}

// ============ TRANSFER ============

async function distributeFromSeed(
  seedId: string,
  to: string,
  quantity: number,
) {
  if (!connectedUser) {
    log("Connect wallet first", "error");
    return;
  }

  log(`Fetching seed info...`);
  const response = await fetch(`/api/assets/${seedId}/details`);
  const data = await response.json();

  if (data.error) {
    log(`Seed not found: ${data.error}`, "error");
    return;
  }

  const asset = data.asset;
  if (!asset.isSeed) {
    log("This is not a seed, cannot distribute", "error");
    return;
  }

  if (asset.owner.toLowerCase() !== connectedUser.toLowerCase()) {
    log(`You don't own this seed. Owner: @${asset.owner}`, "error");
    return;
  }

  if (!asset.txId) {
    log("Seed is missing transaction ID", "error");
    return;
  }

  const remaining = (asset.maxSupply || 0) - (asset.distributed || 0);
  if (quantity > remaining) {
    log(`Cannot distribute ${quantity}. Only ${remaining} remaining.`, "error");
    return;
  }

  // Use bulk_distribute: 1 single custom_json instead of 2N operations
  const bulkResult = buildBulkDistribute({
    signer: connectedUser,
    to,
    items: [
      {
        seedId,
        quantity,
        seedTxId: asset.txId,
      },
    ],
  });

  if (!bulkResult.success) {
    log(`Build bulk_distribute failed: ${bulkResult.errors.map((e) => e.message).join(", ")}`, "error");
    return false;
  }

  const operation = bulkResult.operations[0] as HiveOperation;

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
          const err =
            typeof res.error === "object"
              ? JSON.stringify(res.error)
              : res.error;
          log(`Distribution failed: ${err}`, "error");
          resolve(false);
        }
      },
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
  [
    $("step-1-content"),
    $("step-2-content"),
    $("step-3-content"),
    $("minting-progress"),
  ].forEach((el, i) => {
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
    const parsed = JSON.parse(text);

    // Support both formats: unified { collection, seeds } or plain array
    if (parsed.collection && parsed.seeds) {
      uploadedSeeds = parsed.seeds;
      const col = parsed.collection;
      const nameInput = $("col-name") as HTMLInputElement;
      const symbolInput = $("col-symbol") as HTMLInputElement;
      const imageInput = $("col-image") as HTMLInputElement;
      const descInput = $("col-description") as HTMLTextAreaElement;
      if (nameInput) nameInput.value = col.name || "";
      if (symbolInput) symbolInput.value = col.symbol || "";
      if (imageInput) imageInput.value = col.imageUrl || "";
      if (descInput) descInput.value = col.description || "";
      log(
        `Loaded collection "${col.name}" with ${uploadedSeeds.length} seeds from ${file.name}`,
        "success",
      );
    } else if (Array.isArray(parsed)) {
      uploadedSeeds = parsed;
      log(`Loaded ${uploadedSeeds.length} seeds from ${file.name}`, "success");
    } else {
      log(
        "Invalid JSON format: expected array of seeds or { collection, seeds }",
        "error",
      );
      return;
    }

    const uploadText = uploadArea?.querySelector(".upload-text");
    if (uploadText)
      uploadText.textContent = `Loaded: ${file.name} (${uploadedSeeds.length} seeds)`;

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

// ============ LOAD SAMPLE COLLECTION ============

async function loadSampleCollection() {
  const select = $("sample-select") as HTMLSelectElement;
  const sampleFile = select?.value;

  if (!sampleFile) {
    // "Start from scratch" selected — clear sample banner
    const banner = $("sample-loaded-banner");
    if (banner) banner.style.display = "none";
    return;
  }

  try {
    const response = await fetch(sampleFile);
    const data = await response.json();

    // New unified format: { collection: {...}, seeds: [...] }
    const collection = data.collection;
    const seeds = data.seeds;

    if (!collection || !seeds) {
      log("Invalid sample format", "error");
      return;
    }

    // Auto-fill Step 1 fields
    const nameInput = $("col-name") as HTMLInputElement;
    const symbolInput = $("col-symbol") as HTMLInputElement;
    const imageInput = $("col-image") as HTMLInputElement;
    const descInput = $("col-description") as HTMLTextAreaElement;

    if (nameInput) nameInput.value = collection.name || "";
    if (symbolInput) symbolInput.value = collection.symbol || "";
    if (imageInput) imageInput.value = collection.imageUrl || "";
    if (descInput) descInput.value = collection.description || "";

    // Load seeds into uploadedSeeds
    uploadedSeeds = seeds;

    // Reset validation state
    validationPassed = false;
    hideValidationResults();

    // Show banner in Step 2
    const banner = $("sample-loaded-banner");
    if (banner) banner.style.display = "block";

    // Update upload area text
    const uploadText = uploadArea?.querySelector(".upload-text");
    if (uploadText)
      uploadText.textContent = `Sample loaded: ${seeds.length} seeds from ${collection.name}`;

    const totalSupply = seeds.reduce(
      (sum: number, s: any) => sum + (s.maxSupply || 0),
      0,
    );
    log(
      `Loaded "${collection.name}" (${collection.symbol}) — ${seeds.length} seeds, ${totalSupply.toLocaleString()} total supply`,
      "success",
    );
  } catch (e) {
    log(`Error loading sample: ${(e as Error).message}`, "error");
  }
}

(window as any).loadSampleCollection = loadSampleCollection;

// ============ VALIDATION ============

function hideValidationResults() {
  const container = $("validation-results");
  if (container) container.style.display = "none";
}

function showValidationResults() {
  const container = $("validation-results");
  if (container) container.style.display = "block";
}

function showValidationStatus(
  message: string,
  type: "info" | "success" | "error" | "warning",
) {
  const statusEl = $("validation-status");
  if (!statusEl) return;

  const colors = {
    info: { bg: "rgba(59, 130, 246, 0.1)", border: "#3b82f6", text: "#3b82f6" },
    success: {
      bg: "var(--accent-dim)",
      border: "var(--accent)",
      text: "var(--accent)",
    },
    error: {
      bg: "rgba(239, 68, 68, 0.1)",
      border: "var(--error)",
      text: "var(--error)",
    },
    warning: {
      bg: "rgba(245, 158, 11, 0.1)",
      border: "var(--warning)",
      text: "var(--warning)",
    },
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

function applySuffix(seeds: SeedAssetWithArtId[]): SeedAssetWithArtId[] {
  const suffix = getArtIdSuffix();
  if (!suffix) return seeds;
  return seeds.map((s) => ({
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
  const colSymbol =
    ($("col-symbol") as HTMLInputElement)?.value.trim().toUpperCase() ||
    colName
      ?.slice(0, 8)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  const creator =
    ($("col-creator") as HTMLInputElement)?.value.trim().toLowerCase() ||
    connectedUser;
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
    showValidationStatus(
      "Please enter creator username or connect wallet",
      "error",
    );
    goToStep(1);
    return;
  }

  const seedsToValidate = uploadedSeeds;

  if (seedsToValidate.length === 0) {
    showValidationStatus(
      "Please upload a JSON file or select an example in Step 1",
      "error",
    );
    return;
  }

  // Check if artId is present
  const hasArtId = seedsToValidate.every((s: any) => s.artId);
  if (!hasArtId) {
    showValidationStatus(
      "JSON must include <strong>artId</strong> for each seed (max 14 chars)",
      "error",
    );
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
        assets: seedsWithSuffix,
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
          (result.summary.existing > 0
            ? ` (${result.summary.existing} already exist)`
            : ""),
        "success",
      );
    } else {
      showValidationStatus(
        "All seeds already exist on blockchain - nothing new to mint",
        "warning",
      );
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
    seedsList.innerHTML =
      seeds
        .slice(0, 10)
        .map(
          (s: any, i: number) => `
			<div class="validation-item error">
				<span class="validation-status error">MISSING</span>
				<span class="validation-name">${s.name || `Seed #${i + 1}`}</span>
				<span class="validation-artid">${s.artId || "no artId"}</span>
			</div>
		`,
        )
        .join("") +
      (seeds.length > 10
        ? `<div style="color: var(--text-dim); padding: 8px;">...and ${seeds.length - 10} more</div>`
        : "");
  }
}

function showFormatErrors(
  errors: Array<{ index: number; artId: string; name: string; error: string }>,
) {
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
    seedsList.innerHTML = errors
      .map(
        (e) => `
			<div class="validation-item error">
				<span class="validation-status error">ERROR</span>
				<span class="validation-name">${e.name}</span>
				<span class="validation-artid">${e.artId || "(empty)"}</span>
				<span style="color: var(--error); font-size: 12px;">${e.error}</span>
			</div>
		`,
      )
      .join("");
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
    seedsList.innerHTML = duplicates
      .map(
        (d) => `
			<div class="validation-item error">
				<span class="validation-status error">DUPLICATE</span>
				<span class="validation-artid">${d}</span>
			</div>
		`,
      )
      .join("");
  }
}

function showValidationSuccess(result: any) {
  showValidationResults();
  const summary = $("validation-summary");
  const seedsList = $("validation-seeds");

  const colStatus = result.collectionExists ? "EXISTS" : "NEW";
  const colColor = result.collectionExists ? "var(--warning)" : "var(--accent)";

  if (summary) {
    summary.style.background = result.canProceed
      ? "var(--accent-dim)"
      : "rgba(245, 158, 11, 0.1)";
    summary.style.border = result.canProceed
      ? "1px solid var(--accent)"
      : "1px solid var(--warning)";
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
    seedsList.innerHTML = result.seeds
      .map(
        (s: any) => `
			<div class="validation-item ${s.exists ? "exists" : "new"}">
				<span class="validation-status ${s.exists ? "exists" : "new"}">${s.exists ? "EXISTS" : "NEW"}</span>
				<span class="validation-name">${s.name}</span>
				<span class="validation-artid">${s.artId}</span>
				<span class="validation-seedid">${s.seedId}</span>
			</div>
		`,
      )
      .join("");
  }
}

(window as any).validateSeeds = validateSeeds;

// ============ PREVIEW SEEDS ============

async function previewSeeds() {
  const colName = ($("col-name") as HTMLInputElement)?.value.trim();
  const colSymbol =
    ($("col-symbol") as HTMLInputElement)?.value.trim().toUpperCase() ||
    colName
      ?.slice(0, 8)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");

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
  const totalSupply = uploadedSeeds.reduce(
    (sum: number, s: any) => sum + (s.maxSupply || 1),
    0,
  );
  previewData = {
    collection: {
      name: colName,
      symbol: colSymbol.length >= 3 ? colSymbol : colSymbol.padEnd(3, "X"),
      totalPotential: totalSupply,
    },
    seeds: uploadedSeeds.map((s: any) => ({
      artId: s.artId,
      name: s.name,
      maxSupply: s.maxSupply || 1,
    })),
    summary: {
      totalSeeds: uploadedSeeds.length,
      totalPotentialInstances: totalSupply,
    },
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
    tbody.innerHTML = previewData.seeds
      .map(
        (s: any, i: number) => `
			<tr>
				<td>${i + 1}</td>
				<td class="seed-name">${s.name}</td>
				${hasArtId ? `<td style="font-family: var(--mono); font-size: 12px; color: var(--text-dim);">${s.artId}</td>` : ""}
				<td class="seed-supply">${s.maxSupply.toLocaleString()}</td>
			</tr>
		`,
      )
      .join("");
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
  const colSymbol =
    ($("col-symbol") as HTMLInputElement)?.value.trim().toUpperCase() ||
    previewData?.collection?.symbol;
  const creator =
    ($("col-creator") as HTMLInputElement)?.value.trim().toLowerCase() ||
    connectedUser;
  const colImage = ($("col-image") as HTMLInputElement)?.value.trim();
  const colDescription = (
    $("col-description") as HTMLTextAreaElement
  )?.value.trim();

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

  // Surface an honest loading state in the broadcast summary so the user
  // doesn't see the static "@username" placeholder while the build is in
  // flight. The success path below (line 2507) restores the real creator.
  const summaryCreator = $("summary-creator");
  if (summaryCreator) summaryCreator.textContent = "Building…";

  mintLog(`Creating collection "${colName}"...`);

  // Pre-build UX gate: query the creator's HBD balance directly from a Hive
  // RPC node and surface a friendly alert if the balance cannot cover the
  // protocol fee. Soft failure on RPC errors (chain still rejects if the
  // balance is genuinely insufficient) — we never want a flaky Hive RPC to
  // block a legitimate creator from submitting.
  const balanceCheck = await checkCreatorHasCollectionFee(creator);
  if (balanceCheck.ok && !balanceCheck.hasSufficient) {
    mintLog(
      `Tu cuenta @${creator} no tiene suficiente HBD para crear la colección. ` +
        `Disponible: ${balanceCheck.available.toFixed(3)} HBD, requerido: ${balanceCheck.required.toFixed(3)} HBD.`,
      "error",
    );
    if (summaryCreator) summaryCreator.textContent = `@${creator}`;
    return;
  }
  if (!balanceCheck.ok) {
    mintLog(
      `No se pudo verificar el saldo HBD (${balanceCheck.error}). Continuando; la cadena rechazará si el saldo es insuficiente.`,
      "error",
    );
  }

  // Disable the trigger button for the duration of the build to prevent
  // double-click orphaning a parallel build session (other long-running
  // flows like archiveCurrentCollection and the broadcast state machine
  // follow the same pattern). Re-enabled in the finally block below.
  const triggerBtn = $("btn-create-collection") as HTMLButtonElement | null;
  if (triggerBtn) triggerBtn.disabled = true;

  let buildSucceeded = false;
  try {
    // Step 1: Build collection operation
    const colResponse = await fetch("/api/build/collection-multisig", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: colName,
        symbol: colSymbol,
        creator,
        totalPotential:
          previewData?.summary?.totalPotentialInstances || 1000000,
        // 0 = no per-collection cap (default for the playground harness).
        maxInstances: 0,
        metadata: {
          description,
          image: colImage,
        },
        rules: {
          transferable: true,
          burnable: true,
          royaltyPct: 5,
          royaltyRecipient: creator,
        },
      }),
    });

    if (!colResponse.ok) {
      throw new Error(
        `collection-multisig failed (${colResponse.status}): ${await colResponse.text()}`,
      );
    }

    const colData = await colResponse.json();
    if (colData?.success !== true) {
      const errMsg =
        colData?.errors?.map((e: any) => e.message || e).join(", ") ||
        "Unknown collection build error";
      throw new Error(errMsg);
    }

    if (!colData.collectionId) {
      throw new Error("collectionId was not returned by collection-multisig");
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
      }),
    });

    if (!seedsResponse.ok) {
      throw new Error(
        `seed build failed (${seedsResponse.status}): ${await seedsResponse.text()}`,
      );
    }

    const mintData = await seedsResponse.json();
    if (mintData?.success !== true) {
      const errMsg =
        mintData?.errors?.map((e: any) => e.message || e).join(", ") ||
        "Unknown seed build error";
      throw new Error(errMsg);
    }

    if (!mintData.seeds?.length || !mintData.batches?.length) {
      throw new Error("No seed operations were generated");
    }

    mintLog(
      `Generated ${mintData.seeds.length} seed operations in ${mintData.batches.length} batches`,
    );

    // Create session for persistence
    currentSession = await createSession(
      creator,
      colName,
      colSymbol,
      applySuffix(uploadedSeeds),
    );
    saveSession(currentSession);
    const seedIds = mintData.seeds.map((s: any) => s.seedId);
    initializeSeedBatches(
      currentSession.id,
      mintData.batches.map((_: any, i: number) => ({
        batchNumber: i + 1,
        seedIds: seedIds.slice(i * 5, (i + 1) * 5),
      })),
    );
    mintLog(`Session saved: ${currentSession.id}`);

    // Store data globally
    (window as any).__pendingBatches = mintData.batches;
    (window as any).__currentBatchIndex = 0;
    (window as any).__batchCreator = creator;
    (window as any).__collectionOp = colData.operation ?? null;
    (window as any).__collectionTx = colData.transaction;
    (window as any).__collectionNodeSignature = colData.nodeSignature;
    (window as any).__collectionKeyType = colData.keyType;
    (window as any).__collectionName = colName;
    (window as any).__totalSeeds = mintData.seeds.length;
    (window as any).__totalSupply =
      previewData?.summary?.totalPotentialInstances || 0;
    (window as any).__sessionId = currentSession?.id;

    // Reset phase
    broadcastPhase = 0;

    // Update summary section
    const summaryName = $("summary-collection-name");
    const summaryDetails = $("summary-details");
    const summaryCreator = $("summary-creator");
    if (summaryName) summaryName.textContent = colName;
    if (summaryDetails)
      summaryDetails.textContent = `${mintData.seeds.length} seeds · ${(window as any).__totalSupply.toLocaleString()} total supply`;
    if (summaryCreator) summaryCreator.textContent = `@${creator}`;

    // Render batch list
    renderBatchList(mintData.batches);

    // Initialize progress counter (1 collection op + N batch ops)
    broadcastedCount = 0;
    totalBroadcastOps = 1 + mintData.batches.length;
    updateBroadcastProgress();

    mintLog("Ready! Click 'Broadcast' on each item", "success");
    buildSucceeded = true;
  } catch (e) {
    mintLog(`Error: ${(e as Error).message}`, "error");
  } finally {
    // Restore the broadcast summary on every exit path. Without this the UI
    // stays stuck at "Building…" after any build error (only the success path
    // and the insufficient-balance early-return overwrote it before).
    if (!buildSucceeded && summaryCreator) {
      summaryCreator.textContent = `@${creator}`;
    }
    // Re-enable the trigger button regardless of build outcome.
    if (triggerBtn) triggerBtn.disabled = false;
  }
}

(window as any).createCollection = createCollection;

// ============ LOAD PROTOCOL VERSION ============

function syncDebugUi() {
  const debugTab = document.querySelector(
    '.advanced-tab[data-tab="tab-debug"]',
  ) as HTMLElement | null;
  const debugPanel = $("tab-debug");

  if (debugTab) {
    debugTab.style.display = debugRoutesEnabled ? "" : "none";
    debugTab.classList.toggle("active", false);
  }

  if (debugPanel) {
    debugPanel.style.display = debugRoutesEnabled ? "" : "none";
    debugPanel.classList.toggle("active", false);
  }
}

async function loadProtocolVersion() {
  try {
    const response = await fetch("/api/protocol/info");
    const data = await response.json();
    const versionEl = $("protocol-version");
    if (versionEl) versionEl.textContent = `v${data.protocolVersion}`;
    debugRoutesEnabled = data.debugRoutesEnabled === true;
    syncDebugUi();
  } catch (e) {
    console.error("Failed to load protocol version", e);
  }
}

// ============ BATCH BROADCASTING ============

function updateBroadcastProgress() {
  const el = $("broadcast-progress");
  if (el)
    el.textContent = `${broadcastedCount} of ${totalBroadcastOps} operations broadcast`;
}

function renderBatchList(batches: any[]) {
  const container = $("seed-batches-list");
  if (!container) return;

  // Render all batches, but hide buttons until previous is complete
  container.innerHTML = batches
    .map(
      (batch, i) => `
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
	`,
    )
    .join("");
}

function setOpStatus(
  opId: string,
  status: "pending" | "active" | "complete" | "error",
  icon?: string,
) {
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
  const collectionTx = (window as any).__collectionTx;
  const collectionNodeSignature = (window as any).__collectionNodeSignature;
  const collectionKeyType = (window as any).__collectionKeyType as
    | KeyType
    | undefined;
  const sessionId = (window as any).__sessionId;

  if (!collectionOp && !collectionTx) {
    mintLog("No collection operation ready", "error");
    return;
  }

  if (!(window as any).hive_keychain) {
    mintLog("Install Hive Keychain extension to broadcast", "error");
    return;
  }

  setOpStatus("op-collection", "active");
  mintLog("Opening Keychain...");

  const handleSuccess = (txId: string | undefined) => {
    setOpStatus("op-collection", "complete");
    broadcastPhase = 1;
    broadcastedCount++;
    updateBroadcastProgress();
    mintLog("Collection created!", "success");

    if (sessionId) {
      updateCollectionBroadcast(sessionId, "confirmed", txId);
    }

    const firstBatch = $("op-batch-0");
    if (firstBatch) {
      firstBatch.dataset.status = "pending";
      const btn = firstBatch.querySelector(".btn") as HTMLButtonElement;
      if (btn) btn.style.display = "";
    }
  };

  const handleFailure = (message: unknown) => {
    setOpStatus("op-collection", "error");
    mintLog(
      `Failed: ${typeof message === "object" ? JSON.stringify(message) : String(message)}`,
      "error",
    );
    const retryBtn = $("btn-op-collection") as HTMLButtonElement;
    if (retryBtn) {
      retryBtn.textContent = "Retry";
      retryBtn.style.display = "";
      retryBtn.disabled = false;
    }
  };

  if (collectionTx && collectionNodeSignature) {
    const keychain = (window as any).hive_keychain;
    if (!keychain.requestSignTx) {
      handleFailure("Hive Keychain 3.x+ required for collection creation");
      return;
    }

    collectionTx.signatures = [collectionNodeSignature];
    keychain.requestSignTx(
      creator,
      collectionTx,
      "Active",
      async (res: any) => {
        if (!res.success) {
          handleFailure(res.error || res.message);
          return;
        }

        try {
          mintLog("Broadcasting signed collection transaction...");
          const txId = await broadcastSignedTransaction(res.result);
          handleSuccess(txId);
        } catch (err) {
          handleFailure(err instanceof Error ? err.message : String(err));
        }
      },
    );
    return;
  }

  (window as any).hive_keychain.requestBroadcast(
    creator,
    [collectionOp],
    collectionKeyType ?? keyTypeFromOperation(collectionOp as HiveOperation),
    (res: any) => {
      console.log("Keychain response:", res);
      if (res.success) {
        handleSuccess(res.result?.id);
      } else {
        handleFailure(res.message || res.error);
      }
    },
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
        mintLog(
          `Batch ${index + 1} failed: ${res.message || res.error}`,
          "error",
        );
        // Show retry button
        const retryBtn = $(`op-batch-${index}`)?.querySelector(
          ".btn",
        ) as HTMLButtonElement;
        if (retryBtn) {
          retryBtn.textContent = "Retry";
          retryBtn.style.display = "";
          retryBtn.disabled = false;
        }
      }
    },
  );
}

function resetMinting() {
  const confirmed = confirm(
    "Reset the form? Already-broadcast operations are permanent on the blockchain.",
  );
  if (!confirmed) return;

  // Reset global state
  (window as any).__pendingBatches = null;
  (window as any).__currentBatchIndex = 0;
  (window as any).__collectionOp = null;
  (window as any).__collectionTx = null;
  (window as any).__collectionNodeSignature = null;
  (window as any).__collectionKeyType = null;
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

// ============ Asset DETAIL ACTIONS ============

async function assetDetailTransfer() {
  const to = ($("asset-action-instance-to") as HTMLInputElement)?.value
    .trim()
    .toLowerCase();
  if (!to || !connectedUser || !currentAssetId) {
    log("Fill recipient and ensure you're connected", "error");
    return;
  }

  log(`Validating transfer of ${currentAssetId}...`);
  const validation = await validateTransfer(currentAssetId, connectedUser);
  if (!validation.valid) {
    log(`Cannot transfer: ${validation.error}`, "error");
    return;
  }

  const asset = validation.asset!;
  const buildResult = buildTransfer({
    assetId: asset.id,
    from: connectedUser,
    to,
  });

  if (!buildResult.success) {
    log(`Build transfer failed: ${buildResult.errors.join(", ")}`, "error");
    return;
  }

  log(`Transferring to @${to}...`);
  (window as any).hive_keychain.requestBroadcast(
    connectedUser,
    [buildResult.operations[0]],
    "Posting",
    (res: any) => {
      if (res.success) {
        log(`Transfer successful!`, "success");
        loadAssetDetail(currentAssetId!);
        loadInventory();
      } else {
        const err =
          typeof res.error === "object" ? JSON.stringify(res.error) : res.error;
        log(`Transfer failed: ${err}`, "error");
      }
    },
  );
}

async function assetDetailDistribute() {
  const to = ($("asset-action-to") as HTMLInputElement)?.value
    .trim()
    .toLowerCase();
  const quantity = parseInt(
    ($("asset-action-quantity") as HTMLInputElement)?.value || "1",
    10,
  );
  if (!to || !connectedUser || !currentAssetId) {
    log("Fill recipient and ensure you're connected", "error");
    return;
  }
  const success = await distributeFromSeed(currentAssetId, to, quantity);
  if (success) {
    // Wait for indexer to process the transaction
    setTimeout(() => {
      loadAssetDetail(currentAssetId!);
      loadInventory();
    }, 5000);
  }
}

async function assetDetailTransferSeed() {
  const to = ($("asset-action-seed-transfer-to") as HTMLInputElement)?.value
    .trim()
    .toLowerCase();
  if (!to || !connectedUser || !currentAssetId) {
    log("Fill recipient and ensure you're connected", "error");
    return;
  }

  log(`Fetching seed info...`);
  const response = await fetch(`/api/assets/${currentAssetId}/details`);
  const data = await response.json();

  if (data.error) {
    log(`Seed not found: ${data.error}`, "error");
    return;
  }
  const asset = data.asset;
  if (!asset.isSeed) {
    log("This is not a seed", "error");
    return;
  }
  if (asset.owner.toLowerCase() !== connectedUser.toLowerCase()) {
    log(`You don't own this seed. Owner: @${asset.owner}`, "error");
    return;
  }

  const buildResult = buildTransfer({
    assetId: asset.id,
    from: connectedUser,
    to,
  });

  if (!buildResult.success) {
    log(`Build transfer failed: ${buildResult.errors.join(", ")}`, "error");
    return;
  }

  log(`Transferring seed ownership to @${to}...`);
  (window as any).hive_keychain.requestBroadcast(
    connectedUser,
    [buildResult.operations[0]],
    "Posting",
    (res: any) => {
      if (res.success) {
        log(`Seed transferred to @${to}!`, "success");
        loadAssetDetail(currentAssetId!);
      } else {
        const err =
          typeof res.error === "object" ? JSON.stringify(res.error) : res.error;
        log(`Transfer failed: ${err}`, "error");
      }
    },
  );
}

(window as any).assetDetailTransfer = assetDetailTransfer;
(window as any).assetDetailDistribute = assetDetailDistribute;
(window as any).assetDetailTransferSeed = assetDetailTransferSeed;

async function assetDetailList() {
  const rawPrice = ($("asset-action-price") as HTMLInputElement)?.value.trim();
  const currency = ($("asset-action-currency") as HTMLSelectElement)?.value as
    | "HIVE"
    | "HBD";
  if (!rawPrice || !connectedUser || !currentAssetId) {
    log("Fill price and ensure you're connected", "error");
    return;
  }

  const price = parseFloat(rawPrice).toFixed(3);
  const rawDuration = ($("asset-action-duration") as HTMLInputElement)?.value.trim();
  const durationDays = parseInt(rawDuration || "30", 10);
  if (!Number.isFinite(durationDays) || durationDays < 7 || durationDays > 60) {
    log("Duration must be between 7 and 60 days", "error");
    return;
  }
  const expiresAt = Date.now() + durationDays * 86_400_000;

  try {
    const response = await fetch("/api/build/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assetId: currentAssetId,
        owner: connectedUser,
        price: { amount: price, currency },
        expiresAt,
      }),
    });
    const result = await response.json();
    if (!result.success) {
      log(`Error: ${result.errors?.[0]?.message || result.error}`, "error");
      return;
    }

    log(`Listing ${currentAssetId} for ${price} ${currency}...`);
    (window as any).hive_keychain.requestBroadcast(
      connectedUser,
      [result.operation],
      "Posting",
      (res: any) => {
        if (res.success) {
          log(`Listed for ${price} ${currency}!`, "success");
          setTimeout(() => loadAssetDetail(currentAssetId!), 5000);
        } else {
          const err =
            typeof res.error === "object"
              ? JSON.stringify(res.error)
              : res.error;
          log(`Listing failed: ${err}`, "error");
        }
      },
    );
  } catch (e) {
    log(`Error: ${(e as Error).message}`, "error");
  }
}

async function assetDetailUnlist() {
  if (!connectedUser || !currentAssetId) {
    log("Connect wallet first", "error");
    return;
  }

  try {
    const response = await fetch("/api/build/unlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assetId: currentAssetId,
        owner: connectedUser,
      }),
    });
    const result = await response.json();
    if (!result.success) {
      log(`Error: ${result.errors?.[0]?.message || result.error}`, "error");
      return;
    }

    log(`Unlisting ${currentAssetId}...`);
    (window as any).hive_keychain.requestBroadcast(
      connectedUser,
      [result.operation],
      "Posting",
      (res: any) => {
        if (res.success) {
          log("Unlisted!", "success");
          setTimeout(() => loadAssetDetail(currentAssetId!), 5000);
        } else {
          const err =
            typeof res.error === "object"
              ? JSON.stringify(res.error)
              : res.error;
          log(`Unlist failed: ${err}`, "error");
        }
      },
    );
  } catch (e) {
    log(`Error: ${(e as Error).message}`, "error");
  }
}

(window as any).assetDetailList = assetDetailList;
(window as any).assetDetailUnlist = assetDetailUnlist;

async function assetDetailBurn() {
  if (!connectedUser || !currentAssetId) {
    log("Connect wallet first", "error");
    return;
  }

  const confirmed = confirm(
    `Are you sure you want to burn Asset ${currentAssetId}?\n\nThis action is IRREVERSIBLE. The Asset will be permanently destroyed.`,
  );
  if (!confirmed) return;

  try {
    const response = await fetch("/api/build/burn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetId: currentAssetId, owner: connectedUser }),
    });
    const result = await response.json();
    if (!result.success) {
      log(`Error: ${result.errors?.[0]?.message || result.error}`, "error");
      return;
    }

    log(`Burning ${currentAssetId}...`);
    (window as any).hive_keychain.requestBroadcast(
      connectedUser,
      [result.operation],
      "Posting",
      (res: any) => {
        if (res.success) {
          log("Asset burned successfully!", "success");
          loadInventory();
        } else {
          const err =
            typeof res.error === "object"
              ? JSON.stringify(res.error)
              : res.error;
          log(`Burn failed: ${err}`, "error");
        }
      },
    );
  } catch (e) {
    log(`Error: ${(e as Error).message}`, "error");
  }
}

async function assetDetailSetData() {
  if (!connectedUser || !currentAssetId) {
    log("Connect wallet first", "error");
    return;
  }

  const jsonInput = (
    $("asset-set-data-json") as HTMLTextAreaElement
  )?.value.trim();
  const errorEl = $("asset-set-data-error");

  if (!jsonInput) {
    showSetDataError(errorEl, "Please enter JSON data");
    return;
  }

  let parsedData: Record<string, unknown>;
  try {
    parsedData = JSON.parse(jsonInput);
  } catch {
    showSetDataError(errorEl, "Invalid JSON format");
    return;
  }

  if (
    typeof parsedData !== "object" ||
    parsedData === null ||
    Array.isArray(parsedData)
  ) {
    showSetDataError(errorEl, "Data must be a JSON object (key-value pairs)");
    return;
  }

  hideSetDataError(errorEl);

  try {
    const response = await fetch("/api/build/set-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assetId: currentAssetId,
        issuer: connectedUser,
        data: parsedData,
      }),
    });
    const result = await response.json();
    if (!result.success) {
      log(`Error: ${result.errors?.[0]?.message || result.error}`, "error");
      return;
    }

    log(`Setting mutable data on ${currentAssetId}...`);
    (window as any).hive_keychain.requestBroadcast(
      connectedUser,
      [result.operation],
      "Posting",
      (res: any) => {
        if (res.success) {
          log("Mutable data updated!", "success");
          setTimeout(() => loadAssetDetail(currentAssetId!), 5000);
        } else {
          const err =
            typeof res.error === "object"
              ? JSON.stringify(res.error)
              : res.error;
          log(`Set data failed: ${err}`, "error");
        }
      },
    );
  } catch (e) {
    log(`Error: ${(e as Error).message}`, "error");
  }
}

function showSetDataError(el: HTMLElement | null, message: string) {
  if (!el) return;
  el.textContent = message;
  el.style.display = "block";
}

function hideSetDataError(el: HTMLElement | null) {
  if (!el) return;
  el.style.display = "none";
}

(window as any).assetDetailBurn = assetDetailBurn;
(window as any).assetDetailSetData = assetDetailSetData;

// ============ Asset DETAIL — LENDING ============

async function assetDetailLend() {
  const borrower = ($("asset-action-lend-borrower") as HTMLInputElement)?.value
    .trim()
    .toLowerCase();
  if (!borrower || !connectedUser || !currentAssetId) {
    log("Fill borrower and ensure you're connected", "error");
    return;
  }

  const res = await fetch(`/api/build/asset-lend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instanceId: currentAssetId, borrower, owner: connectedUser }),
  });
  const result = await res.json();
  if (!result.success) {
    log(`Build failed: ${result.error ?? result.errors?.[0]?.message}`, "error");
    return;
  }

  log(`Lending ${currentAssetId} to @${borrower}...`);
  (window as any).hive_keychain.requestBroadcast(
    connectedUser,
    [result.operation],
    "Posting",
    (r: any) => {
      if (r.success) {
        log(`Lend successful! @${borrower} can now use the Asset.`, "success");
        setTimeout(() => { loadAssetDetail(currentAssetId!); loadInventory(); }, 4000);
      } else {
        const err = typeof r.error === "object" ? JSON.stringify(r.error) : r.error;
        log(`Lend failed: ${err}`, "error");
      }
    },
  );
}

async function assetDetailReturn() {
  if (!connectedUser || !currentAssetId) {
    log("Connect wallet first", "error");
    return;
  }

  const res = await fetch(`/api/build/asset-return`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instanceId: currentAssetId, signer: connectedUser }),
  });
  const result = await res.json();
  if (!result.success) {
    log(`Build failed: ${result.error ?? result.errors?.[0]?.message}`, "error");
    return;
  }

  log(`Returning ${currentAssetId}...`);
  (window as any).hive_keychain.requestBroadcast(
    connectedUser,
    [result.operation],
    "Posting",
    (r: any) => {
      if (r.success) {
        log(`Return successful! Asset is active again.`, "success");
        setTimeout(() => { loadAssetDetail(currentAssetId!); loadInventory(); }, 4000);
      } else {
        const err = typeof r.error === "object" ? JSON.stringify(r.error) : r.error;
        log(`Return failed: ${err}`, "error");
      }
    },
  );
}

(window as any).assetDetailLend = assetDetailLend;
(window as any).assetDetailReturn = assetDetailReturn;

// ============ ADVANCED TABS ============

document.querySelectorAll(".advanced-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document
      .querySelectorAll(".advanced-tab")
      .forEach((t) => t.classList.remove("active"));
    document
      .querySelectorAll(".advanced-tab-content")
      .forEach((c) => c.classList.remove("active"));
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
import { initPermissions } from "./views/permissions";
import { initDebug } from "./views/debug";
import { initSpv } from "./views/spv";
import { initCollectionOps } from "./views/collection-ops";
import { initNode } from "./views/node";

// ============ DASHBOARD STATS ============

async function loadDashboardStats() {
  const container = $("dashboard-stats");
  if (!container) return;

  try {
    const response = await fetch("/api/stats");
    const stats = await response.json();

    container.innerHTML = `
			<div class="stat-box"><div class="stat-label">Collections</div><div class="stat-value">${stats.total_collections ?? 0}</div></div>
			<div class="stat-box"><div class="stat-label">Assets</div><div class="stat-value">${stats.total_assets ?? 0}</div></div>
			<div class="stat-box"><div class="stat-label">Seeds</div><div class="stat-value">${stats.total_seeds ?? 0}</div></div>
			<div class="stat-box"><div class="stat-label">Instances</div><div class="stat-value">${stats.total_instances ?? 0}</div></div>
			<div class="stat-box"><div class="stat-label">Listed</div><div class="stat-value">${stats.total_listed ?? 0}</div></div>
			<div class="stat-box"><div class="stat-label">Sales</div><div class="stat-value">${stats.total_sales ?? 0}</div></div>
			<div class="stat-box"><div class="stat-label">Owners</div><div class="stat-value">${stats.unique_owners ?? 0}</div></div>
		`;
  } catch {
    /* silently fail */
  }
}

(window as any).loadDashboardStats = loadDashboardStats;

// ============ STEP 1 INLINE VALIDATION ============

function validateField(
  inputId: string,
  validator: (value: string) => string | null,
) {
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

validateField("col-name", (v) =>
  v.length < 1 ? "Collection name is required" : null,
);
validateField("col-symbol", (v) => {
  if (v.length < 3) return "Symbol must be at least 3 characters";
  if (v.length > 8) return "Symbol must be at most 8 characters";
  if (!/^[A-Z0-9]+$/.test(v.toUpperCase())) return "Only letters and numbers";
  return null;
});
validateField("col-creator", (v) =>
  v.length < 3 ? "Username must be at least 3 characters" : null,
);
validateField("col-image", (v) => {
  if (!v) return "Image URL is required for the collection";
  try {
    new URL(v);
    return null;
  } catch {
    return "Must be a valid URL";
  }
});

// ============ INIT ============

setTimeout(checkKeychain, 500);
syncDebugUi();
loadProtocolVersion();
loadCollections();
loadDashboardStats();
initMarketplace();
initPermissions();
initDebug();
initSpv();
initCollectionOps();
initNode();
log("Console ready");
