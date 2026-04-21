// NFTLox Protocol — auth map.
// Authoritative source of truth for action authority levels.

import {
	ALL_ACTIONS,
	ACTION_CREATE_COLLECTION,
	ACTION_MINT,
	ACTION_TRANSFER,
	ACTION_BULK_DISTRIBUTE,
	ACTION_SET_DATA,
	ACTION_EXTEND_SCHEMA,
	ACTION_ARCHIVE_COLLECTION,
	ACTION_NODE_REGISTER,
	ACTION_NODE_HEARTBEAT,
	ACTION_LIST,
	ACTION_UNLIST,
	ACTION_SALE_LOCK,
	ACTION_BUY,
	ACTION_NFT_APPROVE,
	ACTION_NFT_APPROVE_ALL,
	ACTION_NFT_TRANSFER_FROM,
	ACTION_DATA_OPERATOR_APPROVE,
	ACTION_SET_DATA_FROM,
	ACTION_NFT_LEND,
	ACTION_NFT_RETURN,
	isProtocolAction,
	type ProtocolAction,
} from "./constants";

export type AuthLevel = "active" | "posting";

/** Keychain-compatible key type string ("Active" | "Posting"). */
export type KeyType = "Active" | "Posting";

const ACTION_AUTH_LEVEL_MAP = {
	[ACTION_CREATE_COLLECTION]: "active",
	[ACTION_MINT]: "posting",
	[ACTION_TRANSFER]: "posting",
	[ACTION_BULK_DISTRIBUTE]: "posting",
	[ACTION_SET_DATA]: "posting",
	[ACTION_EXTEND_SCHEMA]: "posting",
	[ACTION_ARCHIVE_COLLECTION]: "posting",
	[ACTION_NODE_REGISTER]: "posting",
	[ACTION_NODE_HEARTBEAT]: "posting",
	[ACTION_LIST]: "posting",
	[ACTION_UNLIST]: "posting",
	// sale_lock: broadcast server-side by the settlement node using its posting
	// key. No funds move in this op — posting is the correct (and safer) level.
	[ACTION_SALE_LOCK]: "posting",
	// buy: tx2 still uses node active multisig for the custom_json while the
	// buyer's active key authorizes the paired transfers in the same tx.
	[ACTION_BUY]: "active",
	[ACTION_NFT_APPROVE]: "posting",
	[ACTION_NFT_APPROVE_ALL]: "posting",
	[ACTION_NFT_TRANSFER_FROM]: "posting",
	[ACTION_DATA_OPERATOR_APPROVE]: "posting",
	[ACTION_SET_DATA_FROM]: "posting",
	[ACTION_NFT_LEND]: "posting",
	[ACTION_NFT_RETURN]: "posting",
} as const satisfies Record<ProtocolAction, AuthLevel>;

export const ACTION_AUTH_LEVEL = Object.freeze(ACTION_AUTH_LEVEL_MAP);

/** Get the auth level for any protocol action. */
export function getAuthLevel(action: ProtocolAction): AuthLevel {
	if (!isProtocolAction(action)) {
		throw new Error(`Unsupported protocol action: ${String(action)}`);
	}
	return ACTION_AUTH_LEVEL[action];
}

/** Get the Keychain-compatible key type string for an action. */
export function getKeyType(action: ProtocolAction): KeyType {
	if (!isProtocolAction(action)) {
		throw new Error(`Unsupported protocol action: ${String(action)}`);
	}
	return ACTION_AUTH_LEVEL[action] === "active" ? "Active" : "Posting";
}

/** Returns null if auth matches; otherwise a human-readable mismatch reason. */
export function getAuthMismatchReason(
	action: ProtocolAction,
	actualAuthLevel: AuthLevel,
): string | null {
	const expectedAuthLevel = getAuthLevel(action);
	if (actualAuthLevel === expectedAuthLevel) return null;
	return `Action '${action}' requires ${expectedAuthLevel} key authority, got ${actualAuthLevel}`;
}

type ActionForAuthLevel<Level extends AuthLevel> = {
	[Action in ProtocolAction]: (typeof ACTION_AUTH_LEVEL)[Action] extends Level
		? Action
		: never;
}[ProtocolAction];

export type ActiveAuthAction = ActionForAuthLevel<"active">;
export type PostingAuthAction = ActionForAuthLevel<"posting">;

function isAuthLevelAction<Level extends AuthLevel>(
	action: ProtocolAction,
	level: Level,
): action is ActionForAuthLevel<Level> {
	return ACTION_AUTH_LEVEL[action] === level;
}

// Derived arrays (computed from the map, not manually maintained)
export const ACTIVE_AUTH_ACTIONS: readonly ActiveAuthAction[] = Object.freeze(
	ALL_ACTIONS.filter((action): action is ActiveAuthAction =>
		isAuthLevelAction(action, "active"),
	),
);

export const POSTING_AUTH_ACTIONS: readonly PostingAuthAction[] = Object.freeze(
	ALL_ACTIONS.filter((action): action is PostingAuthAction =>
		isAuthLevelAction(action, "posting"),
	),
);

// Re-export isProtocolAction for convenience (auth consumers often need both)
export { isProtocolAction };
