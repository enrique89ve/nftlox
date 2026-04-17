import type { HiveOperation, HiveTransferOperation, ProtocolPayload, KeyType } from "@nftlox/protocol";

export type ValidationError = {
	readonly field: string;
	readonly message: string;
	readonly code: string;
};

/**
 * Describes an additional signer whose signature the caller cannot produce
 * directly. Today the only producer is the node operator over the multisig
 * endpoint; modeling it explicitly keeps 2-op flows (like `create_collection`)
 * honest about the dual-signer reality instead of hiding it behind a single
 * `signer` field.
 */
export type CoSigner = Readonly<{
	/** Index into `operations` that this co-signer authorizes. */
	readonly op: number;
	/** Hive account whose signature is required for that op. */
	readonly account: string;
	/** Key authority used (`Active` for custom_json co-signs, `Posting` otherwise). */
	readonly keyType: KeyType;
	/** Discriminator for how the signature is obtained. */
	readonly via: "multisig";
}>;

export type KeychainResult<T> =
	| {
		readonly success: true;
		readonly operations: ReadonlyArray<HiveOperation | HiveTransferOperation>;
		/** Key type the primary caller must use to sign their operations. */
		readonly keyType: KeyType;
		/** The primary caller (the account driving the transaction). */
		readonly signer: string;
		/**
		 * Additional signers the caller must obtain out-of-band (e.g., node
		 * multisig). Present only for multi-signer flows; single-signer builders
		 * omit it so existing consumers keep the simpler shape.
		 */
		readonly coSigners?: readonly CoSigner[] | undefined;
		readonly payload: ProtocolPayload<T>;
		readonly generatedIds?: Readonly<Record<string, string>> | undefined;
		readonly warnings?: readonly string[] | undefined;
	}
	| {
		readonly success: false;
		readonly errors: readonly ValidationError[];
	};
