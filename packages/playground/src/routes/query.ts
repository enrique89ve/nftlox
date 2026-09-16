// Query routes — proxy indexer API for the playground frontend
import { indexer } from "../shared/indexer";
import { IndexerError } from "nftlox-sdk";

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json" },
	});

type ListingSort = "price_asc" | "price_desc" | "recent";

const LISTING_SORTS = new Set<ListingSort>(["price_asc", "price_desc", "recent"]);

function parseListingSort(value: string | null): ListingSort | undefined {
	if (!value) return undefined;
	return LISTING_SORTS.has(value as ListingSort) ? value as ListingSort : undefined;
}

async function safeHandler(fn: () => Promise<Response>): Promise<Response> {
	try {
		return await fn();
	} catch (e) {
		if (e instanceof IndexerError) {
			return json({ error: e.responseBody ?? e.message }, e.statusCode ?? 500);
		}
		return json({ error: String(e) }, 500);
	}
}

async function getCollectionCreator(collectionId: string): Promise<string | null> {
	try {
		const collection = await indexer.getCollection(collectionId);
		return collection.creator;
	} catch {
		return null;
	}
}

export const queryRoutes: Record<string, ((req: Request) => Promise<Response>) | { [method: string]: (req: Request) => Promise<Response> }> = {
	"/api/user/:username": (req: Request) =>
		safeHandler(async () => {
			const url = new URL(req.url);
			const username = url.pathname.split("/api/user/")[1]!.split("/")[0]!.toLowerCase();
			const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10), 200);
			const offset = parseInt(url.searchParams.get("offset") || "0", 10);
			const result = await indexer.getUserAssets(username, { limit, offset });
			const assets = result.assets || [];
			const hasMore = assets.length >= limit;
			return json({
				user: username,
				count: assets.length,
				hasMore,
				offset,
				counts: result.counts,
				assets: assets.map((asset) => ({
					id: asset.id,
					collectionId: asset.collection_id,
					assetType: asset.asset_type,
					status: asset.status,
					edition: asset.edition,
					owner: asset.owner,
					name: asset.name,
					imageUrl: asset.image_url,
					originDna: asset.origin_dna,
					assetDna: asset.asset_dna,
					seedId: asset.seed_id,
					seedTxId: asset.seed_tx_id ?? null,
					instanceNumber: asset.instance_number,
					maxSupply: asset.max_supply,
					distributed: asset.distributed,
					listingPrice: asset.listing_price,
					listingCurrency: asset.listing_currency,
					isSeed: asset.asset_type === "seed",
				})),
			});
		}),

	"/api/user/:username/collections": (req: Request) =>
		safeHandler(async () => {
			const username = new URL(req.url).pathname.split("/api/user/")[1]!.split("/")[0]!.toLowerCase();
			const collections = await indexer.getUserCollections(username);
			return json({
				user: username,
				count: collections.length,
				collections: collections.map(c => ({
					id: c.id,
					name: c.name,
					symbol: c.symbol,
					creator: c.creator,
					totalPotential: c.total_potential,
				})),
			});
		}),

	"/api/assets/:assetId": (req: Request) =>
		safeHandler(async () => {
			const assetId = new URL(req.url).pathname.split("/api/assets/")[1]!.split("/")[0]!;
			const asset = await indexer.getAsset(assetId);
			return json(asset);
		}),

	"/api/assets/:assetId/details": (req: Request) =>
		safeHandler(async () => {
			const assetId = new URL(req.url).pathname.split("/api/assets/")[1]!.split("/")[0]!;
			const asset = await indexer.getAsset(assetId);

			const [collectionCreator, instances] = await Promise.all([
				getCollectionCreator(asset.collection_id),
				asset.asset_type === "seed"
					? indexer.getAssetInstances(assetId, { limit: 50 })
					: Promise.resolve([]),
			]);
			const mintedBy = asset.minted_by ?? collectionCreator;

			// Fetch parent if this is an instance.
			let original = null;
			const parentId = asset.seed_id;
			if (parentId) {
				try {
					original = await indexer.getAsset(parentId);
				} catch { /* parent may not exist */ }
			}

			return json({
				id: asset.id,
				origin_dna: asset.origin_dna,
				asset_dna: asset.asset_dna,
				tx_id: asset.tx_id,
				asset: {
					id: asset.id,
					name: asset.name,
					imageUrl: asset.image_url,
					owner: asset.owner,
					collectionId: asset.collection_id,
					edition: asset.edition,
					originDna: asset.origin_dna,
					assetDna: asset.asset_dna,
					mintedBy,
					mintedAt: asset.created_at,
					burned: asset.status === "burned",
					listed: asset.status === "listed",
					lent: asset.status === "lent",
					listingPrice: asset.listing_price ? { amount: asset.listing_price, currency: asset.listing_currency } : undefined,
					isSeed: asset.asset_type === "seed",
					maxSupply: asset.max_supply,
					distributed: asset.distributed,
					seedId: asset.seed_id,
					seedTxId: asset.seed_tx_id ?? null,
					instanceNumber: asset.instance_number,
					dataHash: asset.data_hash,
					txId: asset.tx_id,
				},
				original: original ? {
					id: original.id,
					name: original.name,
					imageUrl: original.image_url,
					owner: original.owner,
				} : null,
				instances: {
					count: instances.length,
					items: instances.slice(0, 50).map(r => ({
						id: r.id,
						name: r.name,
						owner: r.owner,
						instanceNumber: r.instance_number,
					})),
				},
			});
		}),

	"/api/collections": () =>
		safeHandler(async () => {
			const cols = await indexer.getCollections({ limit: 200 });
			return json({
				count: cols.length,
				collections: cols.map(c => ({
					id: c.id,
					name: c.name,
					symbol: c.symbol,
					creator: c.creator,
					totalPotential: c.total_potential,
					seedCount: c.seed_count,
					instanceCount: c.instance_count,
				})),
			});
		}),

	"/api/collections/:id": (req: Request) =>
		safeHandler(async () => {
			const id = new URL(req.url).pathname.split("/api/collections/")[1]!.split("/")[0]!;
			const col = await indexer.getCollection(id);
			return json(col);
		}),

	"/api/collections/:id/assets": (req: Request) =>
		safeHandler(async () => {
			const url = new URL(req.url);
			const id = url.pathname.split("/api/collections/")[1]!.split("/")[0]!;
			const [seeds, instances] = await Promise.all([
				indexer.getCollectionAssets(id, { type: "seed", limit: 200 }),
				indexer.getCollectionAssets(id, { type: "instance", limit: 200 }),
			]);
			return json({
				collectionId: id,
				totalCount: seeds.length + instances.length,
				seeds: {
					count: seeds.length,
					items: seeds.map(asset => ({
						id: asset.id,
						name: asset.name,
						imageUrl: asset.image_url,
						owner: asset.owner,
						maxSupply: asset.max_supply,
						distributed: asset.distributed || 0,
						originDna: asset.origin_dna,
						assetDna: asset.asset_dna,
					})),
				},
				instances: {
					count: instances.length,
					items: instances.map(asset => ({
						id: asset.id,
						name: asset.name,
						imageUrl: asset.image_url,
						owner: asset.owner,
						seedId: asset.seed_id,
						instanceNumber: asset.instance_number,
					})),
				},
			});
		}),

	"/api/collections/:id/stats": (req: Request) =>
		safeHandler(async () => {
			const id = new URL(req.url).pathname.split("/api/collections/")[1]!.split("/")[0]!;
			const stats = await indexer.getCollectionStats(id);
			return json(stats);
		}),

	"/api/collections/:id/exists": (req: Request) =>
		safeHandler(async () => {
			const id = new URL(req.url).pathname.split("/api/collections/")[1]!.split("/")[0]!;
			try {
				await indexer.getCollection(id);
				return json({ collectionId: id, exists: true });
			} catch (e) {
				if (e instanceof IndexerError && e.statusCode === 404) {
					return json({ collectionId: id, exists: false });
				}
				throw e;
			}
		}),

	"/api/seed/:seedId/instances": (req: Request) =>
		safeHandler(async () => {
			const seedId = new URL(req.url).pathname.split("/api/seed/")[1]!.split("/")[0]!;
			const instances = await indexer.getAssetInstances(seedId, { compact: true });
			return json({ seedId, count: instances.length, instances });
		}),

	"/api/seed/:id/exists": (req: Request) =>
		safeHandler(async () => {
			const id = new URL(req.url).pathname.split("/api/seed/")[1]!.split("/")[0]!;
			try {
				const asset = await indexer.getAsset(id);
				return json({ seedId: id, exists: asset.asset_type === "seed" });
			} catch (e) {
				if (e instanceof IndexerError && e.statusCode === 404) {
					return json({ seedId: id, exists: false });
				}
				throw e;
			}
		}),

	// Marketplace
	"/api/marketplace/listings": (req: Request) =>
		safeHandler(async () => {
			const url = new URL(req.url);
			const sort = parseListingSort(url.searchParams.get("sort"));
			const currency = url.searchParams.get("currency") || undefined;
			const limit = Number(url.searchParams.get("limit")) || 50;
			const listings = await indexer.getListings({ sort, currency, limit });
			return json({ count: listings.length, listings });
		}),

	"/api/node": () =>
		safeHandler(async () => {
			const status = await indexer.getStatus();
			const profile = status.nodeAccount
				? await indexer.getNodeProfile(status.nodeAccount).catch(() => null)
				: null;
			return json({
				account: status.nodeAccount,
				status,
				profile,
			});
		}),

	"/api/node/operations": (req: Request) =>
		safeHandler(async () => {
			const url = new URL(req.url);
			const status = await indexer.getStatus();
			const account = (url.searchParams.get("account") || status.nodeAccount || "").trim().toLowerCase();
			if (!account) {
				return json({ error: "Indexer node account unavailable" }, 502);
			}
			const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
			const offset = parseInt(url.searchParams.get("offset") || "0", 10);
			return json(await indexer.getNodeOperations(account, { limit, offset }));
		}),

	// Status/Stats
	"/api/stats": () =>
		safeHandler(async () => {
			const stats = await indexer.getStats();
			return json(stats);
		}),

	"/api/status": () =>
		safeHandler(async () => {
			const status = await indexer.getStatus();
			return json(status);
		}),

	"/api/health": () =>
		safeHandler(async () => {
			const health = await indexer.getHealth();
			return json(health);
		}),
};
