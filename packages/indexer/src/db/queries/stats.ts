import { sql } from "@/db/client.ts";

export async function getProtocolStats() {
	const [nftStats] = await sql`
		SELECT
			(SELECT COUNT(*) FROM collections WHERE status = 'active') AS total_collections,
			COUNT(*) AS total_nfts,
			COUNT(*) FILTER (WHERE nft_type = 'seed') AS total_seeds,
			COUNT(*) FILTER (WHERE nft_type = 'instance') AS total_instances,
			COUNT(*) FILTER (WHERE nft_type = 'replica') AS total_replicas,
			COUNT(*) FILTER (WHERE status = 'listed') AS total_listed,
			COUNT(*) FILTER (WHERE status = 'burned') AS total_burned,
			COUNT(DISTINCT owner) FILTER (WHERE status != 'burned') AS unique_owners,
			(SELECT COUNT(*) FROM invalid_operations) AS invalid_ops,
			(SELECT COUNT(*) FROM packs) AS total_packs,
			(SELECT COUNT(*) FROM schema_versions) AS total_schema_versions
		FROM nfts
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
