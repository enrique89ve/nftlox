import { PROTOCOL_ID } from "@nftlox/protocol";

export const PROTOCOL_GENESIS_BLOCK = 105_633_752;
// Anchor hash for PROTOCOL_GENESIS_BLOCK. Verified against ≥2 Hive endpoints at
// startup so a hostile HafAH cannot hand us a fabricated chain from scratch.
export const PROTOCOL_GENESIS_BLOCK_ID =
  "064bd7d8622d4ac247d76e598d12beb470e3344b";

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
