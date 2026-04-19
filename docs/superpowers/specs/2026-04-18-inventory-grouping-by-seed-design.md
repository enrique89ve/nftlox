# Inventory grouping by seed (playground)

**Date:** 2026-04-18
**Scope:** `packages/playground` only. No backend, SDK, indexer, protocol, or packs-engine changes.

## Goal

In the playground inventory, stop rendering each owned instance as a separate card. Instead, group instances that share the same `seedId` into a single "group card". Clicking a group card opens a dedicated page that lists every instance ID the connected user owns of that seed, with per-row actions (`Open`, `Transfer`, `List`/`Unlist`).

Seeds remain rendered individually (a seed is unique by definition).

## Decisions (recorded from brainstorming)

1. **Grouping key:** `seedId`. Fallback to `${collectionId}::${edition}` only if `seedId` is missing on the instance.
2. **Threshold:** always group instances by seed. The `xN` count badge is hidden when `count === 1`; the underlying render path is uniform.
3. **Group page:** new page `seed-group.html` (not a reuse of `nft-detail.html`). Keeps "individual NFT detail" and "my copies of this seed" as separate concerns.
4. **Per-row actions:** `Open`, `Transfer`, `List`/`Unlist` (with price modal). No bulk actions in this iteration.
5. **Where grouping happens:** client-side in `app.ts`. The existing `/api/user/:owner/inventory` endpoint already returns every field needed.

## Architecture

All new logic lives in `packages/playground/src/app.ts` and two HTML files. No new endpoints, no new protocol operations, no changes to the query layer.

Flow:

1. `loadInventory()` calls `getNFTsByOwner(connectedUser, 200)` exactly as today.
2. Seeds (`isSeed === true`) render individually via the existing `renderNfts`.
3. Instances (`isSeed !== true`) are passed through `groupInstancesBySeed` and rendered via a new `renderInstanceGroups` into the existing `#inventory-instances` container.
4. Click on a group card → `loadSeedGroup(seedId)` shows `seed-group.html`.
5. `loadSeedGroup` fetches seed metadata via `GET /api/nft/:seedId/details` (existing endpoint) and reuses the already-loaded inventory NFTs filtered by that seed.
6. Per-row actions reuse existing handlers in `app.ts`: `transferNft`, `listNft`, `unlistNft`. No duplicated broadcast or signing logic.

## Files

**New:**

- `packages/playground/public/pages/seed-group.html` — header (seed image, name, collection, edition, "Posees N de M") + table of owned instance rows + reuse of the existing list/transfer modals where possible.

**Modified:**

- `packages/playground/public/index.html` — include the new page partial alongside `inventory.html` and `nft-detail.html`.
- `packages/playground/public/styles.css` — add classes: `.nft-card-group-badge` (top-right `xN`), `.seed-group-table`, `.seed-group-row`, `.seed-group-actions`, `.seed-group-status-chip`.
- `packages/playground/src/app.ts` — add the functions and types listed below; adapt `loadInventory()` to call `renderInstanceGroups` for the instances section.

## New types and functions in `app.ts`

```ts
type InstanceGroup = {
  seedId: string;             // canonical key
  collectionId: string;
  edition: number | string;
  name: string;
  imageUrl: string;
  count: number;              // owned by current user
  instances: NftCardData[];   // raw cards, preserved for the group page
}

function groupInstancesBySeed(nfts: NftCardData[]): InstanceGroup[];
function renderInstanceGroups(groups: InstanceGroup[], containerId: string, selectable: boolean): void;
function loadSeedGroup(seedId: string): Promise<void>;
function renderSeedGroupTable(seedMeta: NftDetailNft, ownedInstances: NftCardData[]): void;
```

`groupInstancesBySeed` is a pure function and is the unit-testable seam.

## Routing / page navigation

The playground does not have a real router; pages are switched by show/hide of root divs (same pattern used by `loadNftDetail`). `loadSeedGroup` follows that pattern and stores the active id in a module-level `currentSeedGroupId` so refresh-after-action can reload the same view.

## Edge cases

- **Single instance:** `count === 1` → group card renders without the `xN` badge (hidden via CSS). Click still goes to the group page so behavior stays uniform.
- **Listed instance in group:** show a small chip "N listadas" in the group card meta. Does not block opening the group.
- **Lent instance row:** `Transfer`/`List`/`Unlist` disabled with tooltip "Lent — cannot modify". `Open` always enabled.
- **User owns zero instances of the requested seed** (URL typed manually): empty state "You don't own any instance of this seed" + "Back to inventory" button.
- **Invalid / burned seedId:** if `/api/nft/:seedId/details` fails, show an error message and a back button. No crash.
- **Refresh after action:** mirror the existing pattern (`setTimeout(loadInventory, 4000)` after broadcast). On the group page, also call `loadSeedGroup(currentSeedGroupId)` after the delay.
- **Last instance transferred:** if the post-action reload finds zero owned instances of the seed, navigate back to inventory and log "No more instances of this seed".
- **Missing `seedId` on instance:** fallback group key `${collectionId}::${edition}` keeps the UI working. If both are also missing, the instance falls through to a single-card render so nothing crashes.

## Testing

**Automated** — `packages/playground/src/app.test.ts` (create if absent), pure-function tests for `groupInstancesBySeed`:

- Multiple instances of the same `seedId` collapse into one group with correct `count`.
- Multiple seeds → multiple groups.
- Fallback grouping by `${collectionId}::${edition}` when `seedId` is missing.
- Output sorted by `count` desc, then `name` asc.
- Empty input → empty array.
- Single instance → group of `count === 1`.

No DOM/E2E tests are added; the playground does not have that scaffolding today and the user's standards discourage introducing it for one feature.

**Manual validation** — dev server, wallet connected to testnet (`api-nftlox.hivecreators.co`):

1. Inventory loads: seeds individual, instances grouped with correct `xN`.
2. Account with exactly 1 instance of a seed → card without badge, click goes to group page.
3. Group page header shows correct metadata + table lists every owned id.
4. `Open` → `nft-detail.html` of that exact id.
5. `Transfer` → broadcast, log success, post-refresh row count drops by one (or returns to inventory if it was the last one).
6. `List` → broadcast, row state becomes "Listed @ price", `Unlist` button appears.
7. `Unlist` → row returns to "Owned", `List` reappears.
8. `lent` instance → action buttons disabled with tooltip.
9. `seed-group.html?seed=<seedNoneOwned>` → empty state.
10. `seed-group.html?seed=<invalid>` → error visible, no crash.

**Pre-PR checks:** `bun test` (for the new pure-function tests) and the playground's typecheck script.

## Out of scope

- Bulk select / bulk list / bulk transfer.
- New backend endpoints or aggregations.
- Changes to seed cards (still rendered individually).
- Visual redesign of the inventory beyond the `xN` badge and the new group page.
