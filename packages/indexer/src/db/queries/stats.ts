import { sql } from "@/db/client.ts";

export async function getProtocolStats() {
	const [stats] = await sql`
		SELECT
			(SELECT COUNT(*) FROM collections WHERE status = 'active') AS total_collections,
			COUNT(*) AS total_nfts,
			COUNT(*) FILTER (WHERE nft_type = 'seed') AS total_seeds,
			COUNT(*) FILTER (WHERE nft_type = 'instance') AS total_instances,
			COUNT(*) FILTER (WHERE nft_type = 'replica') AS total_replicas,
			COUNT(*) FILTER (WHERE status = 'listed') AS total_listed,
			COUNT(*) FILTER (WHERE status = 'burned') AS total_burned,
			COUNT(DISTINCT owner) FILTER (WHERE status != 'burned') AS unique_owners,
			(SELECT COUNT(*) FROM invalid_operations) AS invalid_ops
		FROM nfts
	`;
	return stats;
}
