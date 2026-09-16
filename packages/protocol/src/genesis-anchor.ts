import { PROTOCOL_ID } from "./constants";

export const PROTOCOL_GENESIS_BLOCK = 109_974_058;
// Anchor hash for PROTOCOL_GENESIS_BLOCK. Verified against ≥2 Hive endpoints at
// startup so a hostile HafAH cannot hand us a fabricated chain from scratch.
export const PROTOCOL_GENESIS_BLOCK_ID =
  "068e122af76dc3673550c386fbe167afd2ef2484";

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
        `Edit PROTOCOL_GENESIS_BLOCK in @nftlox/protocol if you need a different value.`,
    );
  }
}
