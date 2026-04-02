import type { Queryable } from "@/db/client.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import {
	COLLECTION_STATUS_ARCHIVED,
	getCollectionRules,
} from "@/db/queries/collections.ts";
import { getNftForProcessing } from "@/db/queries/nfts.ts";
import { insertPack, packExists } from "@/db/queries/packs.ts";
import {
	requireBoundedString,
	requireHiveAmount,
	optionalString,
	optionalBoundedString,
	optionalNumber,
} from "@/utils/validation.ts";
import { MAX_ID_LENGTH, MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_IMAGE_URL_LENGTH } from "nftlox-sdk";
import { validateSeedDemand } from "@/utils/nft-rules.ts";

type DropEntry = { seedId: string; weight: number };

function parseDropTable(raw: unknown): DropEntry[] {
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new Error("Drop table must be a non-empty array");
	}

	return raw.map((entry, i) => {
		if (!entry || typeof entry !== "object") {
			throw new Error(`Drop table entry ${i}: must be an object`);
		}
		const e = entry as Record<string, unknown>;
		if (typeof e.seedId !== "string" || e.seedId === "") {
			throw new Error(`Drop table entry ${i}: seedId is required`);
		}
		if (typeof e.weight !== "number" || !Number.isFinite(e.weight) || e.weight < 1 || e.weight > 1_000_000) {
			throw new Error(`Drop table entry ${i}: weight must be between 1 and 1,000,000`);
		}
		return { seedId: e.seedId, weight: e.weight };
	});
}

function extractOptionalPrice(raw: unknown): { amount: number | null; currency: string | null } {
	if (!raw || typeof raw !== "object") return { amount: null, currency: null };
	const p = raw as Record<string, unknown>;
	if (p.amount === undefined || p.amount === null) return { amount: null, currency: null };
	const validated = requireHiveAmount(raw, "price");
	const amount = parseFloat(validated.amount);
	if (amount <= 0) throw new Error(`Price amount must be positive, got ${validated.amount}`);
	return { amount, currency: validated.currency };
}

async function validateSeedSupply(
	entry: DropEntry,
	collectionId: string,
	maxSupply: number,
	itemsPerPack: number,
	totalWeight: number,
	txn: Queryable,
): Promise<void> {
	const seed = await getNftForProcessing(entry.seedId, txn);
	if (!seed) throw new Error(`Seed not found: ${entry.seedId}`);
	if (seed.nft_type !== "seed") throw new Error(`${entry.seedId} is not a seed`);
	if (seed.collection_id !== collectionId) {
		throw new Error(`Seed ${entry.seedId} does not belong to collection ${collectionId}`);
	}

	const demand = validateSeedDemand({
		seedId: entry.seedId,
		weight: entry.weight,
		totalWeight,
		maxReplicas: seed.max_replicas,
		distributed: seed.distributed,
		maxSupply,
		itemsPerPack,
	});
	if (!demand.ok) throw new Error(demand.error);
}

export async function handlePackCreate(op: ParsedOperation, txn: Queryable): Promise<void> {
	const d = op.data;
	const id = requireBoundedString(d.id, "id", MAX_ID_LENGTH);
	const collectionId = requireBoundedString(d.collectionId, "collectionId", MAX_ID_LENGTH);
	const name = requireBoundedString(d.name, "name", MAX_NAME_LENGTH);

	if (await packExists(id, txn)) return;

	const collection = await getCollectionRules(collectionId, txn);
	if (!collection) throw new Error(`Collection not found: ${collectionId}`);
	if (collection.creator !== op.signer) {
		throw new Error(`Signer ${op.signer} is not creator of collection ${collectionId}`);
	}
	if (collection.status === COLLECTION_STATUS_ARCHIVED) throw new Error(`Collection ${collectionId} is archived`);

	const dropTable = parseDropTable(d.dropTable);
	const maxSupply = optionalNumber(d.maxSupply) ?? 0;
	const itemsPerPack = optionalNumber(d.itemsPerPack) ?? 1;

	const totalWeight = dropTable.reduce((sum, entry) => sum + entry.weight, 0);
	if (totalWeight <= 0) throw new Error(`Total weight must be positive, got ${totalWeight}`);

	for (const entry of dropTable) {
		await validateSeedSupply(entry, collectionId, maxSupply, itemsPerPack, totalWeight, txn);
	}

	const { amount: priceAmount, currency: priceCurrency } = extractOptionalPrice(d.price);

	await insertPack({
		id,
		collectionId,
		creator: op.signer,
		name,
		description: optionalBoundedString(d.description, "description", MAX_DESCRIPTION_LENGTH),
		imageUrl: optionalBoundedString(d.imageUrl, "imageUrl", MAX_IMAGE_URL_LENGTH),
		dropTable,
		itemsPerPack,
		priceAmount,
		priceCurrency,
		maxSupply,
		blockNum: op.blockNum,
		txId: op.txId,
		createdAt: op.timestamp,
	}, txn);
}
