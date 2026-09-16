export type GroupableAsset = {
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
	instances: GroupableAsset[];
};

export function instanceGroupKey(asset: GroupableAsset): string | null {
	if (asset.seedId) return asset.seedId;
	if (asset.collectionId != null && asset.edition != null) {
		return `${asset.collectionId}::${asset.edition}`;
	}
	return null;
}

export function groupInstancesBySeed(assets: GroupableAsset[]): InstanceGroup[] {
	const buckets = new Map<string, InstanceGroup>();

	for (const asset of assets) {
		const key = instanceGroupKey(asset);
		if (!key) continue;

		const existing = buckets.get(key);
		if (existing) {
			existing.instances.push(asset);
			existing.count += 1;
			if (asset.listingPrice) existing.listedCount += 1;
			continue;
		}

		buckets.set(key, {
			seedId: key,
			collectionId: asset.collectionId ?? "",
			edition: asset.edition ?? "",
			name: asset.name ?? "Untitled Asset",
			imageUrl: asset.imageUrl ?? "",
			count: 1,
			listedCount: asset.listingPrice ? 1 : 0,
			instances: [asset],
		});
	}

	return Array.from(buckets.values()).sort((a, b) => {
		if (b.count !== a.count) return b.count - a.count;
		return a.name.localeCompare(b.name);
	});
}
