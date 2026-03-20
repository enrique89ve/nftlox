// Shared indexer client instance for both server and client-side use
import { createIndexerClient } from "nftlox-sdk";

const INDEXER_URL = typeof process !== "undefined"
	? (process.env?.["INDEXER_URL"] ?? "http://localhost:3050")
	: "http://localhost:3050";

export const indexer = createIndexerClient(INDEXER_URL);
