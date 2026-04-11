// NFTLox indexer auth map for the supported protocol subset.

import {
	ALL_ACTIONS,
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_TRANSFER,
	ACTION_BULK_DISTRIBUTE,
	ACTION_SET_DATA,
	ACTION_EXTEND_SCHEMA,
	ACTION_ARCHIVE_COLLECTION,
	ACTION_LIST,
	ACTION_UNLIST,
	ACTION_BUY,
	ACTION_NFT_APPROVE,
	ACTION_NFT_APPROVE_ALL,
	ACTION_NFT_TRANSFER_FROM,
	ACTION_DATA_OPERATOR_APPROVE,
	ACTION_SET_DATA_FROM,
	ACTION_NFT_LEND,
	ACTION_NFT_RETURN,
	type ProtocolAction,
} from "./constants.ts";

export type AuthLevel = "active" | "posting";

export const ACTION_AUTH_LEVEL: Record<ProtocolAction, AuthLevel> = {
	[ACTION_CREATE_COLLECTION]: "posting",
	[ACTION_MINT]: "posting",
	[ACTION_TRANSFER]: "posting",
	[ACTION_BULK_DISTRIBUTE]: "posting",
	[ACTION_SET_DATA]: "posting",
	[ACTION_EXTEND_SCHEMA]: "posting",
	[ACTION_ARCHIVE_COLLECTION]: "posting",
	[ACTION_LIST]: "posting",
	[ACTION_UNLIST]: "posting",
	[ACTION_BUY]: "active",
	[ACTION_NFT_APPROVE]: "posting",
	[ACTION_NFT_APPROVE_ALL]: "posting",
	[ACTION_NFT_TRANSFER_FROM]: "posting",
	[ACTION_DATA_OPERATOR_APPROVE]: "posting",
	[ACTION_SET_DATA_FROM]: "posting",
	[ACTION_NFT_LEND]: "posting",
	[ACTION_NFT_RETURN]: "posting",
} as const;

// Derived arrays (computed from the map)
export const ACTIVE_AUTH_ACTIONS = ALL_ACTIONS.filter(a => ACTION_AUTH_LEVEL[a] === "active");
export const POSTING_AUTH_ACTIONS = ALL_ACTIONS.filter(a => ACTION_AUTH_LEVEL[a] === "posting");
