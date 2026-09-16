import { sql } from "@/db/client.ts";
import { ASSET_KIND_INSTANCE, ASSET_STATUS_LISTED } from "./asset-types.ts";

export async function getProtocolStats() {
	const [assetStats] = await sql`
		SELECT
			(SELECT COUNT(*)::int FROM collections) AS total_collections,
			COALESCE((SELECT SUM(total) FROM collection_stats), 0)::int AS total_assets,
			COALESCE((SELECT SUM(seeds) FROM collection_stats), 0)::int AS total_seeds,
			COALESCE((SELECT SUM(instances) FROM collection_stats), 0)::int AS total_instances,
			COALESCE((
				SELECT COUNT(*) FROM assets
				WHERE asset_type = ${ASSET_KIND_INSTANCE}
					AND status = ${ASSET_STATUS_LISTED}
					AND (listing_expires_at IS NULL OR listing_expires_at > NOW())
			), 0)::int AS total_listed,
			COALESCE((SELECT SUM(burned) FROM collection_stats), 0)::int AS total_burned,
			-- Read from the maintained counter table instead of COUNT(DISTINCT owner) on
			-- assets (which is O(N) and DoS-able at scale). Rows with total=0 are kept for
			-- ex-owners after they transfer/burn everything; exclude them.
			(SELECT COUNT(*)::int FROM owner_asset_counts WHERE total > 0) AS unique_owners,
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
		...assetStats,
		sales: salesStats,
	};
}
