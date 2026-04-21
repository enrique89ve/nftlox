// NFTLox Protocol — per-action payment requirement registry.
// Mirrors the ACTION_AUTH_LEVEL pattern (auth.ts). Adding a new action to
// ALL_ACTIONS without a corresponding ACTION_PAYMENT entry is a TS compile
// error via `satisfies Record<ProtocolAction, PaymentRequirement>`.

import {
	ACTION_ARCHIVE_COLLECTION,
	ACTION_BULK_DISTRIBUTE,
	ACTION_BUY,
	ACTION_CREATE_COLLECTION,
	ACTION_DATA_OPERATOR_APPROVE,
	ACTION_EXTEND_SCHEMA,
	ACTION_LIST,
	ACTION_MINT,
	ACTION_NFT_APPROVE,
	ACTION_NFT_APPROVE_ALL,
	ACTION_NFT_LEND,
	ACTION_NFT_RETURN,
	ACTION_NFT_TRANSFER_FROM,
	ACTION_NODE_HEARTBEAT,
	ACTION_NODE_REGISTER,
	ACTION_SET_DATA,
	ACTION_SET_DATA_FROM,
	ACTION_TRANSFER,
	ACTION_UNLIST,
	INSTANCE_FEE_ENABLED,
	INSTANCE_FEE_PER_N,
	INSTANCE_FEE_UNIT_HBD,
	MEMO_TAG_BUY,
	MEMO_TAG_FEE,
	MEMO_TAG_FEE_COL,
	MEMO_TAG_ROYALTY,
	PROTOCOL_COLLECTION_FEE_HBD,
	PROTOCOL_FEE_BPS,
	type ProtocolAction,
} from "./constants";

/** Which on-chain field identifies the payer (canonical identity source). */
export type PayerSource = "signer" | "transfer:from" | "payload:buyer";

/** Which natural key from the payload forms the memo suffix. */
export type MemoKey = "collectionId" | "nftId" | "seedId" | "opDigest";

/**
 * Where the protocol fee is sent. `action:signer` means the recipient is read
 * from the L1 custom_json signer, not local node config, so replay validation
 * is identical across indexers.
 */
export type PaymentRecipient = "action:signer";

/** How the amount is computed at validation time. */
export type PriceSource = "nft.listing";

export type PaymentRequirement =
	| { readonly kind: "none" }
	| {
		readonly kind: "fixed";
		readonly amountHbd: string;
		readonly payer: PayerSource;
		readonly recipient: PaymentRecipient;
		readonly memoKey: MemoKey;
		readonly memoTag: string;
	}
	| {
		readonly kind: "split";
		readonly priceSource: PriceSource;
		readonly protocolFeeBps: number;
		readonly payer: "payload:buyer";
		readonly memoKey: "nftId";
		readonly memoTags: {
			readonly seller: string;
			readonly royalty: string;
			readonly fee: string;
		};
	}
	| {
		// Declared up-front; no caller today. Spec 2 (collection sizing +
		// prepaid fee) will wire the first scaled caller via create_collection.
		readonly kind: "scaled";
		readonly baseHbd: string;
		readonly unitHbd: string;
		readonly unitDenominator: number;
		readonly countFrom: "payload:maxInstances";
		readonly payer: PayerSource;
		readonly recipient: PaymentRecipient;
		readonly memoKey: MemoKey;
		readonly memoTag: string;
	};

/**
 * Exhaustive-pattern-matching sentinel. Use in the `default:` branch of a
 * switch over `PaymentRequirement["kind"]` to get a compile error the moment
 * a new variant is added upstream.
 */
export function assertNeverPaymentKind(x: never): never {
	throw new Error(`Unhandled PaymentRequirement.kind: ${JSON.stringify(x)}`);
}

/**
 * Translates the declarative `PaymentRecipient` token into a concrete Hive
 * account for a given operation. Pure function (no I/O) so it can be used
 * identically by consensus validators, SDK builders, and tests. Exhaustive
 * switch: adding a new recipient literal without updating this function is a
 * compile error.
 *
 * Determinism note: `action:signer` returns `op.signer` — the account that
 * signed the L1 `custom_json`. Every indexer observing the same block sees the
 * same signer, so every indexer resolves the fee target identically, with no
 * dependency on local node configuration.
 */
export function resolvePaymentRecipient(
	recipient: PaymentRecipient,
	op: { readonly signer: string },
): string {
	switch (recipient) {
		case "action:signer":
			return op.signer;
		default: {
			const _exhaustive: never = recipient;
			throw new Error(`Unhandled PaymentRecipient: ${String(_exhaustive)}`);
		}
	}
}

// create_collection payment shape toggles with INSTANCE_FEE_ENABLED.
// - false (default): `fixed` 0.100 HBD, unchanged from pre-scaling era.
// - true: `scaled` — 0.100 HBD base + 0.001 HBD per INSTANCE_FEE_PER_N (1000)
//   slots declared in `payload.maxInstances`. The router + validator dispatch
//   chain already supports both branches; flipping the flag is all it takes.
const COLLECTION_PAYMENT_REQUIREMENT = (INSTANCE_FEE_ENABLED
	? {
		kind: "scaled" as const,
		baseHbd: PROTOCOL_COLLECTION_FEE_HBD,
		unitHbd: INSTANCE_FEE_UNIT_HBD,
		unitDenominator: INSTANCE_FEE_PER_N,
		countFrom: "payload:maxInstances" as const,
		payer: "transfer:from" as const,
		recipient: "action:signer" as const,
		memoKey: "collectionId" as const,
		memoTag: MEMO_TAG_FEE_COL,
	}
	: {
		kind: "fixed" as const,
		amountHbd: PROTOCOL_COLLECTION_FEE_HBD,
		payer: "transfer:from" as const,
		recipient: "action:signer" as const,
		memoKey: "collectionId" as const,
		memoTag: MEMO_TAG_FEE_COL,
	}) satisfies PaymentRequirement;

const ACTION_PAYMENT_MAP = {
	[ACTION_CREATE_COLLECTION]: COLLECTION_PAYMENT_REQUIREMENT,
	[ACTION_BUY]: {
		kind: "split",
		priceSource: "nft.listing",
		protocolFeeBps: PROTOCOL_FEE_BPS,
		payer: "payload:buyer",
		memoKey: "nftId",
		memoTags: { seller: MEMO_TAG_BUY, royalty: MEMO_TAG_ROYALTY, fee: MEMO_TAG_FEE },
	},
	[ACTION_MINT]: { kind: "none" },
	[ACTION_TRANSFER]: { kind: "none" },
	[ACTION_BULK_DISTRIBUTE]: { kind: "none" },
	[ACTION_SET_DATA]: { kind: "none" },
	[ACTION_EXTEND_SCHEMA]: { kind: "none" },
	[ACTION_ARCHIVE_COLLECTION]: { kind: "none" },
	[ACTION_NODE_REGISTER]: { kind: "none" },
	[ACTION_NODE_HEARTBEAT]: { kind: "none" },
	[ACTION_LIST]: { kind: "none" },
	[ACTION_UNLIST]: { kind: "none" },
	[ACTION_NFT_APPROVE]: { kind: "none" },
	[ACTION_NFT_APPROVE_ALL]: { kind: "none" },
	[ACTION_NFT_TRANSFER_FROM]: { kind: "none" },
	[ACTION_DATA_OPERATOR_APPROVE]: { kind: "none" },
	[ACTION_SET_DATA_FROM]: { kind: "none" },
	[ACTION_NFT_LEND]: { kind: "none" },
	[ACTION_NFT_RETURN]: { kind: "none" },
} as const satisfies Record<ProtocolAction, PaymentRequirement>;

export const ACTION_PAYMENT = Object.freeze(ACTION_PAYMENT_MAP);

/**
 * Total lookup over a compile-time-validated key. Callers holding a
 * `ProtocolAction` are guaranteed a result — no runtime guard needed.
 * Boundary validation (raw JSON → `ProtocolAction`) lives in the parser.
 */
export function getPaymentRequirement(
	action: ProtocolAction,
): PaymentRequirement {
	return ACTION_PAYMENT[action];
}
