import { sql } from "@/db/client.ts";
import { NFT_KIND_INSTANCE, NFT_STATUS_LISTED } from "./nft-types.ts";

export async function getProtocolStats() {
	const [nftStats] = await sql`
		SELECT
			(SELECT COUNT(*)::int FROM collections WHERE status = 'active') AS total_collections,
			COALESCE((SELECT SUM(total) FROM collection_stats), 0)::int AS total_nfts,
			COALESCE((SELECT SUM(seeds) FROM collection_stats), 0)::int AS total_seeds,
			COALESCE((SELECT SUM(instances) FROM collection_stats), 0)::int AS total_instances,
			COALESCE((SELECT SUM(replicas) FROM collection_stats), 0)::int AS total_replicas,
			COALESCE((
				SELECT COUNT(*) FROM nfts
				WHERE nft_type = ${NFT_KIND_INSTANCE}
					AND status = ${NFT_STATUS_LISTED}
					AND (listing_expires_at IS NULL OR listing_expires_at > NOW())
			), 0)::int AS total_listed,
			COALESCE((SELECT SUM(burned) FROM collection_stats), 0)::int AS total_burned,
			(SELECT COUNT(DISTINCT owner)::int FROM nfts) AS unique_owners,
			(SELECT COUNT(*)::int FROM invalid_operations) AS invalid_ops,
			(SELECT COUNT(*)::int FROM schema_versions) AS total_schema_versions
	`;

	const salesStats = await sql`
		SELECT currency,
			COUNT(*)::int AS total_sales,
			COALESCE(SUM(gross_amount), 0)::numeric AS volume,
			COALESCE(SUM(royalty_amount), 0)::numeric AS total_royalties,
			COALESCE(SUM(protocol_fee), 0)::numeric AS total_fees
		FROM sales
		GROUP BY currency
	`;

	return {
		...nftStats,
		sales: salesStats,
	};
}
