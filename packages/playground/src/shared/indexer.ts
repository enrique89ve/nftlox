// Server-only — uses process.env. Do not import in browser code.
import { createIndexerClient } from "nftlox-sdk";

export const INDEXER_URL = typeof process !== "undefined"
	? (process.env?.["INDEXER_URL"] ?? "http://localhost:3050")
	: "http://localhost:3050";

export const indexer = createIndexerClient(INDEXER_URL);
