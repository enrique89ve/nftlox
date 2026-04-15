import { PROTOCOL_GENESIS_BLOCK, PROTOCOL_ID } from "./constants.ts";

export type GenesisBlockValidationInput = {
	readonly genesisBlock: number;
	readonly allowUnsafeGenesisBlock: boolean;
};

export function validateGenesisBlockSelection(input: GenesisBlockValidationInput): void {
	const { genesisBlock, allowUnsafeGenesisBlock } = input;

	if (genesisBlock <= 0) {
		throw new Error("GENESIS_BLOCK must be a positive integer");
	}

	if (allowUnsafeGenesisBlock) return;
	if (genesisBlock <= PROTOCOL_GENESIS_BLOCK) return;

	throw new Error(
		`Unsafe GENESIS_BLOCK ${genesisBlock} for protocol ${PROTOCOL_ID}. ` +
		`Canonical protocol genesis is block ${PROTOCOL_GENESIS_BLOCK}. ` +
		`Starting later can leave orphaned operations and incomplete state. ` +
		`Use GENESIS_BLOCK <= ${PROTOCOL_GENESIS_BLOCK} or set ALLOW_UNSAFE_GENESIS_BLOCK=true only if you intentionally want a partial index.`,
	);
}
