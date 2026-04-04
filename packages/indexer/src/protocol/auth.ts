// NFTLox Protocol Auth Level Map (self-contained copy for indexer)
// Source of truth: packages/sdk/src/constants.ts

import {
	ALL_ACTIONS,
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_TRANSFER,
	ACTION_REPLICATE,
	ACTION_BULK_DISTRIBUTE,
	ACTION_SET_DATA,
	ACTION_SET_OWNER_DATA,
	ACTION_EXTEND_SCHEMA,
	ACTION_ARCHIVE_COLLECTION,
	ACTION_LIST,
	ACTION_UNLIST,
	ACTION_BUY,
	ACTION_PACK_CREATE,
	ACTION_PACK_BUY,
	ACTION_PACK_TRANSFER,
	ACTION_PACK_OPEN,
	ACTION_PACK_DESTROY,
	ACTION_PACK_APPROVE,
	ACTION_PACK_TRANSFER_FROM,
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
	[ACTION_REPLICATE]: "posting",
	[ACTION_BULK_DISTRIBUTE]: "posting",
	[ACTION_SET_DATA]: "posting",
	[ACTION_SET_OWNER_DATA]: "posting",
	[ACTION_EXTEND_SCHEMA]: "posting",
	[ACTION_ARCHIVE_COLLECTION]: "posting",
	[ACTION_LIST]: "posting",
	[ACTION_UNLIST]: "posting",
	[ACTION_BUY]: "active",
	[ACTION_PACK_CREATE]: "posting",
	[ACTION_PACK_BUY]: "active",
	[ACTION_PACK_TRANSFER]: "posting",
	[ACTION_PACK_OPEN]: "posting",
	[ACTION_PACK_DESTROY]: "posting",
	[ACTION_PACK_APPROVE]: "posting",
	[ACTION_PACK_TRANSFER_FROM]: "posting",
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
