# Inventory Grouping by Seed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the playground inventory, group owned NFT instances by `seedId` and add a dedicated "seed group" page that lists every owned instance of a seed with per-row actions (Open, Transfer, List/Unlist).

**Architecture:** All work is client-side in `packages/playground` — no backend, SDK, indexer, or protocol changes. A pure function `groupInstancesBySeed` produces `InstanceGroup[]` from the existing `getNFTsByOwner` response. Inventory renders one card per group with an `xN` badge (hidden when count=1). Click navigates to a new `seed-group` page that fetches seed metadata via the existing `/api/nft/:id/details` endpoint and reuses the existing `validateTransfer`/`buildTransfer`/`/api/build/list`/`/api/build/unlist` flows.

**Tech Stack:** Bun, TypeScript, vanilla DOM (no framework). Test runner: `bun test`. Pages stitched at server start from `public/pages/<id>.html` (see `src/server.ts:25-41`).

**Repo conventions to follow:**
- `src/app.ts` uses 2-space indentation — match it for edits to that file.
- New standalone files (HTML/CSS/test files) follow each adjacent file's style. `src/server.ts` and CSS use tabs.
- Reuse existing helpers: `$`, `escapeHtml`, `log`, `PLACEHOLDER_SM`, `navigateTo`, `navigationStack`, `getNFTsByOwner`, `validateTransfer`, `buildTransfer`, `loadNftDetail`.
- Existing list/unlist endpoints: `POST /api/build/list` and `POST /api/build/unlist` returning `{ success, operation, errors? }`. Broadcast via `window.hive_keychain.requestBroadcast(user, [op], "Posting", cb)`.

---

## Task 1: Add pure function `groupInstancesBySeed` with tests

**Files:**
- Create: `packages/playground/src/inventory-grouping.ts`
- Create: `packages/playground/src/inventory-grouping.test.ts`

- [ ] **Step 1: Create the test file**

Create `packages/playground/src/inventory-grouping.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
	groupInstancesBySeed,
	type GroupableNft,
} from "./inventory-grouping";

const make = (overrides: Partial<GroupableNft>): GroupableNft => ({
	id: overrides.id ?? "id",
	collectionId: overrides.collectionId ?? "col",
	edition: overrides.edition ?? 1,
	name: overrides.name ?? "Card",
	imageUrl: overrides.imageUrl ?? "img",
	seedId: overrides.seedId ?? null,
	instanceNumber: overrides.instanceNumber ?? null,
	listingPrice: overrides.listingPrice ?? null,
	listingCurrency: overrides.listingCurrency ?? null,
	status: overrides.status ?? null,
	isSeed: overrides.isSeed ?? false,
});

describe("groupInstancesBySeed", () => {
	it("collapses N instances of the same seed into one group", () => {
		const a1 = make({ id: "a-1", seedId: "seed-A", name: "A" });
		const a2 = make({ id: "a-2", seedId: "seed-A", name: "A" });
		const a3 = make({ id: "a-3", seedId: "seed-A", name: "A" });

		const groups = groupInstancesBySeed([a1, a2, a3]);

		expect(groups).toHaveLength(1);
		expect(groups[0].seedId).toBe("seed-A");
		expect(groups[0].count).toBe(3);
		expect(groups[0].instances.map((n) => n.id)).toEqual(["a-1", "a-2", "a-3"]);
	});

	it("produces one group per distinct seedId", () => {
		const a = make({ id: "a-1", seedId: "seed-A", name: "Alpha" });
		const b1 = make({ id: "b-1", seedId: "seed-B", name: "Beta" });
		const b2 = make({ id: "b-2", seedId: "seed-B", name: "Beta" });

		const groups = groupInstancesBySeed([a, b1, b2]);

		expect(groups).toHaveLength(2);
		const beta = groups.find((g) => g.seedId === "seed-B");
		expect(beta?.count).toBe(2);
	});

	it("falls back to `${collectionId}::${edition}` when seedId missing", () => {
		const x1 = make({
			id: "x-1",
			seedId: null,
			collectionId: "col-X",
			edition: 5,
		});
		const x2 = make({
			id: "x-2",
			seedId: null,
			collectionId: "col-X",
			edition: 5,
		});

		const groups = groupInstancesBySeed([x1, x2]);

		expect(groups).toHaveLength(1);
		expect(groups[0].seedId).toBe("col-X::5");
		expect(groups[0].count).toBe(2);
	});

	it("orders groups by count desc, then name asc", () => {
		const single = make({ id: "z-1", seedId: "seed-Z", name: "Zulu" });
		const a1 = make({ id: "a-1", seedId: "seed-A", name: "Alpha" });
		const a2 = make({ id: "a-2", seedId: "seed-A", name: "Alpha" });
		const m1 = make({ id: "m-1", seedId: "seed-M", name: "Mike" });
		const m2 = make({ id: "m-2", seedId: "seed-M", name: "Mike" });

		const groups = groupInstancesBySeed([single, a1, a2, m1, m2]);

		expect(groups.map((g) => g.seedId)).toEqual([
			"seed-A",
			"seed-M",
			"seed-Z",
		]);
	});

	it("returns empty array for empty input", () => {
		expect(groupInstancesBySeed([])).toEqual([]);
	});

	it("returns count=1 group for a single instance", () => {
		const only = make({ id: "x", seedId: "seed-X", name: "Solo" });
		const groups = groupInstancesBySeed([only]);
		expect(groups).toHaveLength(1);
		expect(groups[0].count).toBe(1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/playground && bun test src/inventory-grouping.test.ts`
Expected: FAIL — module `./inventory-grouping` does not exist.

- [ ] **Step 3: Implement the module**

Create `packages/playground/src/inventory-grouping.ts`:

```ts
export type GroupableNft = {
	id: string;
	collectionId?: string | null;
	edition?: string | number | null;
	name?: string | null;
	imageUrl?: string | null;
	seedId?: string | null;
	instanceNumber?: number | null;
	listingPrice?: string | null;
	listingCurrency?: string | null;
	status?: string | null;
	isSeed?: boolean;
};

export type InstanceGroup = {
	seedId: string;
	collectionId: string;
	edition: number | string;
	name: string;
	imageUrl: string;
	count: number;
	listedCount: number;
	instances: GroupableNft[];
};

function groupKey(nft: GroupableNft): string | null {
	if (nft.seedId) return nft.seedId;
	if (nft.collectionId != null && nft.edition != null) {
		return `${nft.collectionId}::${nft.edition}`;
	}
	return null;
}

export function groupInstancesBySeed(nfts: GroupableNft[]): InstanceGroup[] {
	const buckets = new Map<string, InstanceGroup>();

	for (const nft of nfts) {
		const key = groupKey(nft);
		if (!key) continue;

		const existing = buckets.get(key);
		if (existing) {
			existing.instances.push(nft);
			existing.count += 1;
			if (nft.listingPrice) existing.listedCount += 1;
			continue;
		}

		buckets.set(key, {
			seedId: key,
			collectionId: nft.collectionId ?? "",
			edition: nft.edition ?? "",
			name: nft.name ?? "Untitled NFT",
			imageUrl: nft.imageUrl ?? "",
			count: 1,
			listedCount: nft.listingPrice ? 1 : 0,
			instances: [nft],
		});
	}

	return Array.from(buckets.values()).sort((a, b) => {
		if (b.count !== a.count) return b.count - a.count;
		return a.name.localeCompare(b.name);
	});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/playground && bun test src/inventory-grouping.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/playground/src/inventory-grouping.ts packages/playground/src/inventory-grouping.test.ts
git commit -m "feat(playground): add pure groupInstancesBySeed helper"
```

---

## Task 2: Wire grouping into `loadInventory` and add group card render

**Files:**
- Modify: `packages/playground/src/app.ts` (import the new module; add `renderInstanceGroups`; replace the instances render in `loadInventory`)
- Modify: `packages/playground/public/styles.css` (add `.nft-card-group-badge` and `.seed-group-status-chip`)

- [ ] **Step 1: Add the import at the top of `src/app.ts`**

Edit `packages/playground/src/app.ts` — after the existing import block (around line 25, before `let connectedUser`), add:

```ts
import {
  groupInstancesBySeed,
  type InstanceGroup,
} from "./inventory-grouping";
```

- [ ] **Step 2: Add module-level state for the seed group page**

In `packages/playground/src/app.ts`, find:

```ts
let currentNftId: string | null = null;
```

Replace with:

```ts
let currentNftId: string | null = null;
let currentSeedGroupId: string | null = null;
```

- [ ] **Step 3: Add `renderInstanceGroups` function**

In `packages/playground/src/app.ts`, immediately after the existing `renderNfts` function (look for `function renderNfts(` around line 1189; insert *after* its closing brace), add:

```ts
function renderInstanceGroups(
  groups: InstanceGroup[],
  containerId: string,
) {
  const container = $(containerId);
  if (!container) return;

  if (groups.length === 0) {
    container.innerHTML = `
				<div class="empty-state">
					<p class="empty-state-text">No NFTs found</p>
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
				<div class="nft-card" data-seed="${escapeHtml(g.seedId)}">
					${showCount ? `<span class="nft-card-group-badge">x${g.count}</span>` : ""}
					<img class="nft-image" src="${escapeHtml(g.imageUrl)}" onerror="this.src='${PLACEHOLDER_SM}'">
					<div class="nft-card-body">
						<div class="nft-name">${escapeHtml(g.name)}</div>
						<div class="nft-owner">@${escapeHtml(connectedUser ?? "")}</div>
						<div class="nft-meta">
							<span class="nft-meta-supply">${g.count} owned</span>
							<span class="nft-type-badge instance">INSTANCE</span>
						</div>
						${listedChip ? `<div class="nft-meta">${listedChip}</div>` : ""}
					</div>
				</div>
			`;
    })
    .join("");

  container.querySelectorAll(".nft-card").forEach((card) => {
    (card as HTMLElement).onclick = () => {
      const seedId = (card as HTMLElement).dataset.seed;
      if (seedId) loadSeedGroup(seedId);
    };
  });
}
```

> Note: `loadSeedGroup` is added in Task 3. TypeScript will complain about the forward reference until then — that's expected; we resolve it by Task 3 / Step 4.

- [ ] **Step 4: Replace the instances render in `loadInventory`**

In `packages/playground/src/app.ts`, find the block in `loadInventory` (currently around line 1118-1120):

```ts
      if (seeds.length > 0) renderNfts(seeds, "inventory-seeds", true);
      if (instances.length > 0)
        renderNfts(instances, "inventory-instances", true);
```

Replace with:

```ts
      if (seeds.length > 0) renderNfts(seeds, "inventory-seeds", true);
      if (instances.length > 0) {
        const groups = groupInstancesBySeed(instances);
        renderInstanceGroups(groups, "inventory-instances");
      }
```

- [ ] **Step 5: Add CSS for the group badge and status chip**

Edit `packages/playground/public/styles.css`. Find the `.nft-card.selected` block (around line 701-706) and immediately after it add:

```css
      .nft-card-group-badge {
        position: absolute;
        top: 8px;
        right: 8px;
        background: rgba(15, 23, 42, 0.85);
        color: #fff;
        font-family: var(--mono);
        font-size: 11px;
        font-weight: 700;
        padding: 3px 7px;
        border-radius: 12px;
        z-index: 2;
        pointer-events: none;
      }

      .seed-group-status-chip {
        display: inline-block;
        font-family: var(--mono);
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 3px;
        background: rgba(245, 158, 11, 0.15);
        color: #f59e0b;
      }
```

- [ ] **Step 6: Typecheck**

Run: `cd packages/playground && bun run typecheck`
Expected: a single error about `loadSeedGroup` not defined (forward reference). All other code typechecks. We will resolve the forward reference in Task 3.

If any other errors appear, fix them before proceeding.

- [ ] **Step 7: Commit**

```bash
git add packages/playground/src/app.ts packages/playground/public/styles.css
git commit -m "feat(playground): group inventory instances by seed"
```

---

## Task 3: Add `seed-group` page (HTML + server registration + load/render)

**Files:**
- Create: `packages/playground/public/pages/seed-group.html`
- Modify: `packages/playground/src/server.ts` (add `seed-group` to `PAGE_IDS`)
- Modify: `packages/playground/src/app.ts` (add `loadSeedGroup`, `renderSeedGroupTable`, helpers)
- Modify: `packages/playground/public/styles.css` (table styles)

- [ ] **Step 1: Create the page HTML**

Create `packages/playground/public/pages/seed-group.html`:

```html
        <div class="page" id="page-seed-group">
          <div class="breadcrumb">
            <a href="javascript:void(0)" onclick="loadInventory(); navigateTo('inventory')">← Back to inventory</a>
          </div>
          <div class="page-header">
            <h1 class="page-title" id="seed-group-title">Seed group</h1>
            <p class="page-desc" id="seed-group-subtitle"></p>
          </div>

          <div class="seed-group-summary" id="seed-group-summary" style="display: none;">
            <img id="seed-group-image" class="seed-group-image" src="" alt="">
            <div class="seed-group-meta">
              <div><span class="stat-label">Collection:</span> <span id="seed-group-collection">-</span></div>
              <div><span class="stat-label">Edition:</span> <span id="seed-group-edition">-</span></div>
              <div><span class="stat-label">You own:</span> <span id="seed-group-owned">-</span> / <span id="seed-group-total">-</span></div>
            </div>
          </div>

          <div id="seed-group-table-container">
            <div class="empty-state">
              <p class="empty-state-text">Loading…</p>
            </div>
          </div>
        </div>
```

- [ ] **Step 2: Register the page in the server**

Edit `packages/playground/src/server.ts`. Find:

```ts
const PAGE_IDS = [
	"collections",
	"create",
	"inventory",
	"collection-detail",
	"nft-detail",
	"advanced",
	"marketplace",
] as const;
```

Replace with:

```ts
const PAGE_IDS = [
	"collections",
	"create",
	"inventory",
	"collection-detail",
	"nft-detail",
	"seed-group",
	"advanced",
	"marketplace",
] as const;
```

- [ ] **Step 3: Add CSS for the seed-group page**

Edit `packages/playground/public/styles.css`. Append at the end of the file:

```css
      .seed-group-summary {
        display: grid;
        grid-template-columns: 120px 1fr;
        gap: 20px;
        align-items: center;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 16px;
        margin-bottom: 24px;
      }

      .seed-group-image {
        width: 120px;
        height: 120px;
        object-fit: cover;
        border-radius: 6px;
        background: var(--surface-2);
      }

      .seed-group-meta {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 13px;
      }

      .seed-group-table {
        width: 100%;
        border-collapse: collapse;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        overflow: hidden;
      }

      .seed-group-table th,
      .seed-group-table td {
        padding: 10px 12px;
        text-align: left;
        font-size: 12px;
        border-bottom: 1px solid var(--border);
      }

      .seed-group-table th {
        background: var(--surface-2);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-muted);
      }

      .seed-group-table tr:last-child td {
        border-bottom: none;
      }

      .seed-group-actions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }

      .seed-group-actions button {
        font-size: 11px;
        padding: 4px 10px;
      }

      .seed-group-actions button[disabled] {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .seed-group-id {
        font-family: var(--mono);
        font-size: 11px;
        color: var(--text-muted);
      }
```

- [ ] **Step 4: Add `loadSeedGroup` and `renderSeedGroupTable` in `src/app.ts`**

Edit `packages/playground/src/app.ts`. Find the line:

```ts
(window as any).loadInventory = loadInventory;
```

Immediately after it, insert:

```ts
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
      fetchJsonOrThrow<NftDetailResponse>(
        `/api/nft/${encodeURIComponent(seedId)}/details`,
      ),
      getNFTsByOwner(connectedUser, 200),
    ]);

    if (seedData.error || !seedData.nft) {
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

    const seed = seedData.nft;
    const owned = ownerData.nfts.filter(
      (n) =>
        n.isSeed !== true &&
        ((n as any).seedId === seedId ||
          `${n.collectionId}::${n.edition}` === seedId),
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

function renderSeedGroupTable(owned: NftCardData[]) {
  const tableContainer = $("seed-group-table-container");
  if (!tableContainer) return;

  const sorted = [...owned].sort(
    (a, b) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0),
  );

  const rows = sorted
    .map((nft) => {
      const isLent = (nft.status ?? "").toLowerCase() === "lent";
      const isListed = Boolean(nft.listingPrice);
      const statusText = isLent
        ? "Lent"
        : isListed
          ? `Listed @ ${escapeHtml(nft.listingPrice ?? "")} ${escapeHtml(nft.listingCurrency ?? "")}`
          : "Owned";
      const idAttr = escapeHtml(nft.id);
      const disabled = isLent ? "disabled" : "";
      const lentTip = isLent ? 'title="Lent — cannot modify"' : "";
      const listAction = isListed
        ? `<button class="btn btn-secondary" ${disabled} ${lentTip} onclick="seedGroupUnlist('${idAttr}')">Unlist</button>`
        : `<button class="btn btn-secondary" ${disabled} ${lentTip} onclick="seedGroupListPrompt('${idAttr}')">List</button>`;
      return `
				<tr>
					<td>#${nft.instanceNumber ?? "?"}</td>
					<td><span class="seed-group-id">${idAttr}</span></td>
					<td>${statusText}</td>
					<td class="seed-group-actions">
						<button class="btn btn-secondary" onclick="seedGroupOpen('${idAttr}')">Open</button>
						<button class="btn btn-secondary" ${disabled} ${lentTip} onclick="seedGroupTransferPrompt('${idAttr}')">Transfer</button>
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
}

(window as any).loadSeedGroup = loadSeedGroup;
```

- [ ] **Step 5: Typecheck**

Run: `cd packages/playground && bun run typecheck`
Expected: PASS — no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/playground/public/pages/seed-group.html packages/playground/src/server.ts packages/playground/src/app.ts packages/playground/public/styles.css
git commit -m "feat(playground): add seed-group page with owned instances table"
```

---

## Task 4: Per-row actions (Open / Transfer / List / Unlist)

**Files:**
- Modify: `packages/playground/src/app.ts`

- [ ] **Step 1: Add the four row-action handlers**

Edit `packages/playground/src/app.ts`. Find the line `(window as any).loadSeedGroup = loadSeedGroup;` from Task 3 and immediately after it insert:

```ts
function seedGroupOpen(nftId: string) {
  loadNftDetail(nftId);
}

async function seedGroupTransferPrompt(nftId: string) {
  if (!connectedUser) {
    log("Connect wallet first", "error");
    return;
  }
  const to = window
    .prompt(`Transfer ${nftId} to which Hive account?`)
    ?.trim()
    .toLowerCase();
  if (!to) return;

  log(`Validating transfer of ${nftId}…`);
  const validation = await validateTransfer(nftId, connectedUser);
  if (!validation.valid) {
    log(`Cannot transfer: ${validation.error}`, "error");
    return;
  }
  const nft = validation.nft!;
  const buildResult = await buildTransfer({
    nftId: nft.id,
    from: connectedUser,
    to,
    imageUrl: nft.imageUrl ?? undefined,
    imageHash: nft.imageHash ?? undefined,
  });
  if (!buildResult.success) {
    log(`Build transfer failed: ${buildResult.errors.join(", ")}`, "error");
    return;
  }

  log(`Transferring ${nftId} to @${to}…`);
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

async function seedGroupListPrompt(nftId: string) {
  if (!connectedUser) {
    log("Connect wallet first", "error");
    return;
  }
  const rawPrice = window.prompt(`List ${nftId} for what price?`)?.trim();
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
  const price = parsed.toFixed(3);

  try {
    const response = await fetch("/api/build/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nftId,
        owner: connectedUser,
        price: { amount: price, currency },
      }),
    });
    const result = await response.json();
    if (!result.success) {
      log(`Error: ${result.errors?.[0]?.message || result.error}`, "error");
      return;
    }

    log(`Listing ${nftId} for ${price} ${currency}…`);
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

async function seedGroupUnlist(nftId: string) {
  if (!connectedUser) {
    log("Connect wallet first", "error");
    return;
  }
  if (!window.confirm(`Unlist ${nftId}?`)) return;

  try {
    const response = await fetch("/api/build/unlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nftId, owner: connectedUser }),
    });
    const result = await response.json();
    if (!result.success) {
      log(`Error: ${result.errors?.[0]?.message || result.error}`, "error");
      return;
    }

    log(`Unlisting ${nftId}…`);
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

function scheduleSeedGroupReload() {
  setTimeout(() => {
    if (currentSeedGroupId) loadSeedGroup(currentSeedGroupId);
    loadInventory();
  }, 5000);
}

(window as any).seedGroupOpen = seedGroupOpen;
(window as any).seedGroupTransferPrompt = seedGroupTransferPrompt;
(window as any).seedGroupListPrompt = seedGroupListPrompt;
(window as any).seedGroupUnlist = seedGroupUnlist;
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/playground && bun run typecheck`
Expected: PASS — no errors.

- [ ] **Step 3: Run pure-function tests again to confirm no regression**

Run: `cd packages/playground && bun test src/inventory-grouping.test.ts`
Expected: PASS — 6 tests green.

- [ ] **Step 4: Commit**

```bash
git add packages/playground/src/app.ts
git commit -m "feat(playground): per-row actions on seed group page"
```

---

## Task 5: Manual validation in dev server

**Files:** none (manual validation only)

- [ ] **Step 1: Start the dev server**

Run from repo root: `cd packages/playground && bun run dev`
Expected: server logs startup, no build errors. Open `http://localhost:3000` (or whatever port `playgroundConfig.port` resolves to — check the startup log).

- [ ] **Step 2: Walk the golden path**

With a Hive Keychain wallet that owns multiple instances of the same seed on testnet (`api-nftlox.hivecreators.co`):

1. Connect wallet.
2. Navigate to **Inventory** → confirm: seeds render as individual cards; instances render as grouped cards with `xN` badge for groups of ≥2; groups of 1 render without the badge.
3. Click a group card → confirm: navigates to the seed-group page; header shows seed image, name, collection, edition, owned/total counts; table lists every owned instance with `#`, ID, status, and action buttons.
4. Click `Open` on a row → confirm: navigates to `nft-detail` for that exact id.
5. Use the back link → returns to inventory and reloads it.
6. Click `Transfer` on a row → enter a recipient → approve in Keychain → confirm: success log; after ~5s, table re-renders with one fewer row (or empty state if last).
7. Click `List` on an unlisted row → enter price/currency → approve → confirm: row status changes to "Listed @ price"; button switches to `Unlist`.
8. Click `Unlist` on a listed row → confirm in dialog → approve → confirm: row status returns to "Owned".

- [ ] **Step 3: Walk the edge cases**

1. Find or create an account with **exactly one** instance of a seed → confirm card has no badge but click still opens the seed-group page (table with one row).
2. Manually navigate to `seed-group.html` for a seed you don't own (use the page id by typing in the URL or via console: `loadSeedGroup('<some-other-seed-id>')`) → confirm: empty state "You don't own any instance of this seed."
3. Same with an invalid seedId → confirm: error empty state, no crash, log message.
4. If any instance is `lent` (status from the indexer), confirm Transfer/List/Unlist buttons are disabled and `Open` still works.

- [ ] **Step 4: Document results**

If all checks pass, the feature is ready. If anything fails, capture the failure (log line, screenshot, or HTML snippet) and either fix in place (re-run from the failing task) or open a follow-up task.

> Note: this task does not produce a commit; manual validation has no artifact other than the recorded outcome.

---

## Self-review

**Spec coverage:**
- Decision 1 (group by `seedId`): Task 1 — `groupKey` uses `seedId` first.
- Decision 2 (always group; badge hidden when count=1): Task 2 — `showCount = g.count >= 2` controls badge visibility.
- Decision 3 (new `seed-group.html` page): Task 3.
- Decision 4 (per-row Open/Transfer/List/Unlist): Task 4.
- Decision 5 (client-side grouping): all logic in `src/app.ts` and pure helper.
- Edge case "fallback to `${collectionId}::${edition}`": Task 1 + Task 3 filter uses the same fallback in the owner-filter step.
- Edge case "lent instance disabled": Task 3 row template + Task 4 buttons honor it.
- Edge case "user owns zero / invalid seed": Task 3 Step 4 handles both.
- Edge case "refresh after action": `scheduleSeedGroupReload` in Task 4.
- Tests: Task 1 covers all six tests listed in the spec.

**Placeholder scan:** none.

**Type consistency:** `InstanceGroup` type is defined once in `inventory-grouping.ts` and imported. `NftCardData` and `NftDetailNft` are reused as-is from existing definitions in `app.ts`. `currentSeedGroupId`, `loadSeedGroup`, `renderSeedGroupTable`, and the four `seedGroup*` handlers are referenced consistently.

**Out-of-scope confirmed:** no bulk actions, no backend changes, no seed-card changes.
