import { PROTOCOL_ID } from "@nftlox/protocol";

export const PROTOCOL_GENESIS_BLOCK = 105_729_623;
// Anchor hash for PROTOCOL_GENESIS_BLOCK. Verified against ≥2 Hive endpoints at
// startup so a hostile HafAH cannot hand us a fabricated chain from scratch.
export const PROTOCOL_GENESIS_BLOCK_ID =
  "064d4e57e7ca248e4ee9a3c290c1420b7bd8265e";

export type GenesisBlockValidationInput = {
  readonly genesisBlock: number;
};

export function validateGenesisBlockSelection(
  input: GenesisBlockValidationInput,
): void {
  const { genesisBlock } = input;

  if (!Number.isInteger(genesisBlock) || genesisBlock <= 0) {
    throw new Error("genesisBlock must be a positive integer");
  }

  if (genesisBlock !== PROTOCOL_GENESIS_BLOCK) {
    throw new Error(
      `genesisBlock ${genesisBlock} does not match protocol canonical genesis ${PROTOCOL_GENESIS_BLOCK} for ${PROTOCOL_ID}. ` +
        `Edit PROTOCOL_GENESIS_BLOCK in src/protocol/genesis-guard.ts if you need a different value.`,
    );
  }
}
