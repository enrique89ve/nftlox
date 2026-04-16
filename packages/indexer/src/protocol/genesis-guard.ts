import { PROTOCOL_GENESIS_BLOCK, PROTOCOL_ID } from "./constants.ts";

export type GenesisBlockValidationInput = {
	readonly genesisBlock: number;
};

export function validateGenesisBlockSelection(input: GenesisBlockValidationInput): void {
	const { genesisBlock } = input;

	if (!Number.isInteger(genesisBlock) || genesisBlock <= 0) {
		throw new Error("genesisBlock must be a positive integer");
	}

	if (genesisBlock !== PROTOCOL_GENESIS_BLOCK) {
		throw new Error(
			`genesisBlock ${genesisBlock} does not match protocol canonical genesis ${PROTOCOL_GENESIS_BLOCK} for ${PROTOCOL_ID}. ` +
			`Edit PROTOCOL_GENESIS_BLOCK in src/protocol/constants.ts if you need a different value; the SDK drift test will keep both sides aligned.`,
		);
	}
}
