import { z } from "zod";
import { seedProvenanceSchema, usernameSchema } from "../schemas";
import { formatZodError, withProvenance } from "./helpers";
import type { KeychainResult } from "./types";
import {
	createPayload,
	createHiveOperation,
	getKeyType,
	type TransferData,
} from "@nftlox/protocol";

/**
 * Transfer builder input.
 *
 * `from` is the signer of the Hive operation (carried by the auth array
 * selected via ACTION_AUTH_LEVEL — posting for transfer). It is intentionally
 * NOT emitted in the protocol payload: the indexer derives the owner from
 * `op.signer` (Hive is the source of truth for who signed the op). Any payload
 * that ships a `from` field is rejected by the transfer handler.
 *
 * Kept as `from` (rather than `signer`) for SDK caller ergonomics.
 */
export const transferBuilderSchema = seedProvenanceSchema.extend({
	nftId: z.string().min(1, "Invalid NFT ID format"),
	from: usernameSchema,
	to: usernameSchema,
}).refine((data) => data.from !== data.to, {
	message: "Cannot transfer to yourself",
	path: ["to"],
});
export type TransferBuilderInput = z.infer<typeof transferBuilderSchema>;

export function buildTransfer(
	input: TransferBuilderInput,
): KeychainResult<TransferData> {
	const parsed = transferBuilderSchema.safeParse(input);
	if (!parsed.success) {
		return { success: false, errors: formatZodError(parsed.error) };
	}

	const data = parsed.data;

	const transferData: TransferData = {
		nftId: data.nftId,
		to: data.to,
		...withProvenance(data),
	};

	const payload = createPayload("transfer", transferData);
	const operation = createHiveOperation(payload, data.from);

	return {
		success: true,
		operations: [operation],
		keyType: getKeyType("transfer"),
		signer: data.from,
		payload,
	};
}
