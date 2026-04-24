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
	ACTION_BUY_COMMITMENT,
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
	// buy_commitment: the node broadcasts this on-chain with its own active key
	// before co-signing a `buy` tx, reserving the NFT for the committed buyer.
	// Ordering of commitments in a Hive block is the network-wide consensus on
	// who gets to settle, closing the cross-node race without off-chain coord.
	[ACTION_BUY_COMMITMENT]: "active",
	// buy: the node co-signs the trailing custom_json with active while the
	// buyer authorizes the paired transfers in the same transaction.
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

// Boundary helpers for SDK/indexer consumers that receive action strings from
// untyped sources (on-chain custom_json.id, API responses, log lines). They
// validate once at the boundary and either return a narrowed result or throw
// loudly with the rejected value. Callers that already hold a ProtocolAction
// pass through without friction since string is wider.

/** Get the auth level for an action string. Throws if the string is not a known ProtocolAction. */
export function getAuthLevel(action: string): AuthLevel {
	if (!isProtocolAction(action)) {
		throw new Error(`Unsupported protocol action: ${action}`);
	}
	return ACTION_AUTH_LEVEL[action];
}

/** Get the Keychain-compatible key type string for an action. Throws if the string is not a known ProtocolAction. */
export function getKeyType(action: string): KeyType {
	if (!isProtocolAction(action)) {
		throw new Error(`Unsupported protocol action: ${action}`);
	}
	return ACTION_AUTH_LEVEL[action] === "active" ? "Active" : "Posting";
}

/** Returns null if auth matches; otherwise a human-readable mismatch reason. Throws if the action string is not a known ProtocolAction. */
export function getAuthMismatchReason(
	action: string,
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

// Subconjunto de ACTIVE_AUTH_ACTIONS cuyo op.signer DEBE ser un nodo de
// settlement registrado y activo en l2_nodes al bloque de procesamiento.
// Regla de rol de firmante, ortogonal a PaymentRequirement: buy_commitment
// no tiene fees y buy tiene split que no cae en recipient:action:signer, así
// que ninguna de las dos está cubierta por la gate basada en fees del router.
// Consumido por el action-router (packages/indexer) junto a
// requirementNeedsActiveNodeSigner para invocar assertActiveSettlementNode.
const NODE_SIGNED_ACTIONS_SET: ReadonlySet<ProtocolAction> = new Set<ProtocolAction>([
	ACTION_BUY_COMMITMENT,
	ACTION_BUY,
]);

export function requiresActiveNodeSigner(action: ProtocolAction): boolean {
	return NODE_SIGNED_ACTIONS_SET.has(action);
}

export const NODE_SIGNED_ACTIONS: readonly ActiveAuthAction[] = Object.freeze(
	ACTIVE_AUTH_ACTIONS.filter((action) => NODE_SIGNED_ACTIONS_SET.has(action)),
);

// Re-export isProtocolAction for convenience (auth consumers often need both)
export { isProtocolAction };
