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
	PROTOCOL_COLLECTION_FEE_HBD,
	PROTOCOL_FEE_BPS,
	isProtocolAction,
	type ProtocolAction,
} from "./constants";

/** Which on-chain field identifies the payer (canonical identity source). */
export type PayerSource = "signer" | "transfer:from" | "payload:buyer";

/** Which natural key from the payload forms the memo suffix. */
export type MemoKey = "collectionId" | "nftId" | "seedId" | "opDigest";

export type PaymentRequirement =
	| { readonly kind: "none" }
	| {
		readonly kind: "fixed";
		readonly amountHbd: string;
		readonly payer: PayerSource;
		readonly recipient: "treasury";
		readonly memoKey: MemoKey;
		readonly memoTag: string;
	}
	| {
		readonly kind: "split";
		readonly priceSource: "nft.listing";
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
		readonly recipient: "treasury";
		readonly memoKey: MemoKey;
		readonly memoTag: string;
	};

const ACTION_PAYMENT_MAP = {
	[ACTION_CREATE_COLLECTION]: {
		kind: "fixed",
		amountHbd: PROTOCOL_COLLECTION_FEE_HBD,
		payer: "transfer:from",
		recipient: "treasury",
		memoKey: "collectionId",
		memoTag: "FEE-COL",
	},
	[ACTION_BUY]: {
		kind: "split",
		priceSource: "nft.listing",
		protocolFeeBps: PROTOCOL_FEE_BPS,
		payer: "payload:buyer",
		memoKey: "nftId",
		memoTags: { seller: "BUY", royalty: "ROY", fee: "FEE" },
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

export function getPaymentRequirement(
	action: ProtocolAction,
): PaymentRequirement {
	if (!isProtocolAction(action)) {
		throw new Error(`Unsupported protocol action: ${String(action)}`);
	}
	return ACTION_PAYMENT[action];
}
