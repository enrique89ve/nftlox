import type { HiveOperation, HiveTransferOperation, ProtocolPayload, KeyType } from "@nftlox/protocol";

export type ValidationError = {
	readonly field: string;
	readonly message: string;
	readonly code: string;
};

export type KeychainResult<T> =
	| {
		readonly success: true;
		readonly operations: ReadonlyArray<HiveOperation | HiveTransferOperation>;
		readonly keyType: KeyType;
		readonly signer: string;
		readonly payload: ProtocolPayload<T>;
		readonly generatedIds?: Readonly<Record<string, string>> | undefined;
		readonly warnings?: readonly string[] | undefined;
	}
	| {
		readonly success: false;
		readonly errors: readonly ValidationError[];
	};
