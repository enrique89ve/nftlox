// Query routes — proxy indexer API for the playground frontend
import { indexer } from "../shared/indexer";
import { IndexerError } from "nftlox-sdk";

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json" },
	});

const packExtensionUnavailable = (): Response =>
	json({
		error: "Pack queries were removed from the core indexer. Use the external packs module/service instead.",
	}, 410);

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
			return json({ error: e.body }, e.status);
		}
		return json({ error: String(e) }, 500);
	}
}

export const queryRoutes: Record<string, ((req: Request) => Promise<Response>) | { [method: string]: (req: Request) => Promise<Response> }> = {
	"/api/user/:username": (req: Request) =>
		safeHandler(async () => {
			const url = new URL(req.url);
			const username = url.pathname.split("/api/user/")[1]!.split("/")[0]!.toLowerCase();
			const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10), 200);
			const offset = parseInt(url.searchParams.get("offset") || "0", 10);
			const result = await indexer.getUserNfts(username, { limit, offset });
			const nfts = result.nfts || [];
			const hasMore = nfts.length >= limit;
			return json({
				user: username,
				count: nfts.length,
				hasMore,
				offset,
				counts: result.counts,
				nfts: nfts.map((nft) => ({
					id: nft.id,
					collectionId: nft.collection_id,
					nftType: nft.nft_type,
					status: nft.status,
					edition: nft.edition,
					owner: nft.owner,
					name: nft.name,
					imageUrl: nft.image_url,
					originDna: nft.origin_dna,
					instanceDna: nft.instance_dna,
					seedId: nft.seed_id,
					seedTxId: nft.seed_tx_id ?? null,
					instanceNumber: nft.instance_number,
					maxSupply: nft.max_supply,
					distributed: nft.distributed,
					listingPrice: nft.listing_price,
					listingCurrency: nft.listing_currency,
					isSeed: nft.nft_type === "seed",
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
					status: c.status,
				})),
			});
		}),

	"/api/user/:username/packs": async () => packExtensionUnavailable(),

	"/api/nft/:nftId": (req: Request) =>
		safeHandler(async () => {
			const nftId = new URL(req.url).pathname.split("/api/nft/")[1]!.split("/")[0]!;
			const nft = await indexer.getNft(nftId);
			return json(nft);
		}),

	"/api/nft/:nftId/details": (req: Request) =>
		safeHandler(async () => {
			const nftId = new URL(req.url).pathname.split("/api/nft/")[1]!.split("/")[0]!;
			const nft = await indexer.getNft(nftId);

			// Fetch related data in parallel
			const [instances] = await Promise.all([
				nft.nft_type === "seed"
					? indexer.getNftInstances(nftId, { limit: 50 })
					: Promise.resolve([]),
			]);

			// Fetch parent if this is an instance.
			let original = null;
			const parentId = nft.seed_id;
			if (parentId) {
				try {
					original = await indexer.getNft(parentId);
				} catch { /* parent may not exist */ }
			}

			return json({
				id: nft.id,
				origin_dna: nft.origin_dna,
				instance_dna: nft.instance_dna,
				tx_id: nft.tx_id,
				nft: {
					id: nft.id,
					name: nft.name,
					imageUrl: nft.image_url,
					owner: nft.owner,
					collectionId: nft.collection_id,
					edition: nft.edition,
					originDna: nft.origin_dna,
					instanceDna: nft.instance_dna,
					mintedAt: nft.created_at,
					burned: nft.status === "burned",
					listed: nft.status === "listed",
					listingPrice: nft.listing_price ? { amount: nft.listing_price, currency: nft.listing_currency } : undefined,
					isSeed: nft.nft_type === "seed",
					maxSupply: nft.max_supply,
					distributed: nft.distributed,
					seedId: nft.seed_id,
					seedTxId: nft.seed_tx_id ?? null,
					instanceNumber: nft.instance_number,
					dataHash: nft.data_hash,
					txId: nft.tx_id,
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
					status: c.status,
				})),
			});
		}),

	"/api/collection/:id": (req: Request) =>
		safeHandler(async () => {
			const id = new URL(req.url).pathname.split("/api/collection/")[1]!.split("/")[0]!;
			const col = await indexer.getCollection(id);
			return json(col);
		}),

	"/api/collection/:id/nfts": (req: Request) =>
		safeHandler(async () => {
			const url = new URL(req.url);
			const id = url.pathname.split("/api/collection/")[1]!.split("/")[0]!;
			const [seeds, instances] = await Promise.all([
				indexer.getCollectionNfts(id, { type: "seed", limit: 200 }),
				indexer.getCollectionNfts(id, { type: "instance", limit: 200 }),
			]);
			return json({
				collectionId: id,
				totalCount: seeds.length + instances.length,
				seeds: {
					count: seeds.length,
					items: seeds.map(nft => ({
						id: nft.id,
						name: nft.name,
						imageUrl: nft.image_url,
						owner: nft.owner,
						maxSupply: nft.max_supply,
						distributed: nft.distributed || 0,
						originDna: nft.origin_dna,
						instanceDna: nft.instance_dna,
					})),
				},
				instances: {
					count: instances.length,
					items: instances.map(nft => ({
						id: nft.id,
						name: nft.name,
						imageUrl: nft.image_url,
						owner: nft.owner,
						seedId: nft.seed_id,
						instanceNumber: nft.instance_number,
					})),
				},
			});
		}),

	"/api/collection/:id/stats": (req: Request) =>
		safeHandler(async () => {
			const id = new URL(req.url).pathname.split("/api/collection/")[1]!.split("/")[0]!;
			const stats = await indexer.getCollectionStats(id);
			return json(stats);
		}),

	"/api/collection/:id/exists": (req: Request) =>
		safeHandler(async () => {
			const id = new URL(req.url).pathname.split("/api/collection/")[1]!.split("/")[0]!;
			try {
				await indexer.getCollection(id);
				return json({ collectionId: id, exists: true });
			} catch (e) {
				if (e instanceof IndexerError && e.status === 404) {
					return json({ collectionId: id, exists: false });
				}
				throw e;
			}
		}),

	"/api/seed/:seedId/instances": (req: Request) =>
		safeHandler(async () => {
			const seedId = new URL(req.url).pathname.split("/api/seed/")[1]!.split("/")[0]!;
			const instances = await indexer.getNftInstances(seedId, { compact: true });
			return json({ seedId, count: instances.length, instances });
		}),

	"/api/seed/:id/exists": (req: Request) =>
		safeHandler(async () => {
			const id = new URL(req.url).pathname.split("/api/seed/")[1]!.split("/")[0]!;
			try {
				const nft = await indexer.getNft(id);
				return json({ seedId: id, exists: nft.nft_type === "seed" });
			} catch (e) {
				if (e instanceof IndexerError && e.status === 404) {
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

	// Packs moved to an external module
	"/api/packs": async () => packExtensionUnavailable(),
	"/api/pack/:id": async () => packExtensionUnavailable(),

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
