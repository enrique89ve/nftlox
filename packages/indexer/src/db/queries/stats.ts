import { sql } from "../client.ts";

export async function getProtocolStats() {
	const [stats] = await sql`
		SELECT
			(SELECT COUNT(*) FROM collections) AS total_collections,
			(SELECT COUNT(*) FROM nfts) AS total_nfts,
			(SELECT COUNT(*) FROM nfts WHERE nft_type = 'seed') AS total_seeds,
			(SELECT COUNT(*) FROM nfts WHERE nft_type = 'instance') AS total_instances,
			(SELECT COUNT(*) FROM nfts WHERE nft_type = 'replica') AS total_replicas,
			(SELECT COUNT(*) FROM nfts WHERE status = 'listed') AS total_listed,
			(SELECT COUNT(*) FROM nfts WHERE status = 'burned') AS total_burned,
			(SELECT COUNT(DISTINCT owner) FROM nfts WHERE status != 'burned') AS unique_owners,
			(SELECT COUNT(*) FROM history_events) AS total_events,
			(SELECT COUNT(*) FROM history_events WHERE event_type = 'buy') AS total_sales,
			(SELECT COUNT(*) FROM offers WHERE status = 'active') AS active_offers,
			(SELECT COUNT(*) FROM invalid_operations) AS invalid_ops
	`;
	return stats;
}
