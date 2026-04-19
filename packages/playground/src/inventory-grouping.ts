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
