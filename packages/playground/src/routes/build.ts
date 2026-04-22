// Build routes — construct Hive operations via SDK builders
import { Transaction } from "hive-tx";
import {
	ACTION_EXTEND_SCHEMA,
	PROTOCOL_VERSION,
	HASH_VERSION,
	PROTOCOL_COLLECTION_FEE_HBD,
	requestCreateCollectionMultisig,
	extendSchemaInputSchema,
	usernameSchema,
	createPayload,
	createHiveOperation,
	getKeyType,
	type HiveOperation,
	type HiveTransactionObject,
	// Builders
	buildCollection,
	buildArchiveCollection,
	buildSeedBatch,
	buildSeed,
	buildBulkDistribute,
	buildTransfer,
	buildList,
	buildUnlist,
	buildBurn,
	buildBuy,
	buildNodeRegister,
	buildSetData,
	buildNftApprove,
	buildNftApproveAll,
	buildNftTransferFrom,
	buildDataOperatorApprove,
	buildSetDataFrom,
	buildNftLend,
	buildNftReturn,
	// For preview-ids (inline replacement)
	generateDeterministicCollectionId,
	generateOriginDna,
	generateDeterministicSeedId,
} from "nftlox-sdk";
import { splitOperationsIntoBatches } from "../protocol";
import { INDEXER_URL } from "../shared/indexer";

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json" },
	});

type RouteHandler = (req: Request) => Promise<Response>;
const TX_EXPIRATION_MS = 60_000;

type IndexerStatusResponse = {
	nodeAccount?: string | null;
}

type CollectionMultisigResponse = {
	ok: boolean;
	signature?: string;
	digest?: string;
	code?: string;
	message?: string;
}

type BuildSeedsRequestSeed = Readonly<{
	artId: string;
	name: string;
	imageUrl: string;
	maxSupply: number;
	brief?: string | undefined;
	immutableData?: Record<string, unknown> | undefined;
}>;

type BuildSeedsRequest = Readonly<{
	collectionId: string;
	signer?: string | undefined;
	owner?: string | undefined;
	seeds: readonly BuildSeedsRequestSeed[];
}>;

type BuiltSeedOperation = Readonly<{
	artId: string;
	seedId?: string | undefined;
	immutableData?: Record<string, unknown> | undefined;
	operation: HiveOperation;
}>;

function isIndexerStatusResponse(v: unknown): v is IndexerStatusResponse {
	return typeof v === "object" && v !== null;
}

function isCollectionMultisigResponse(v: unknown): v is CollectionMultisigResponse {
	return typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).ok === "boolean";
}

/** Derive keyType from the SDK operation — single source of truth */
function keyTypeFromOp(operation: unknown): "Active" | "Posting" {
	const op = operation as [string, { required_auths?: string[] }];
	return op[1]?.required_auths?.length ? "Active" : "Posting";
}

/** hive-tx's Transaction uses concrete Hive operation unions; the SDK accepts a
 * structurally narrower shape. They are wire-compatible, so widen the type at
 * the boundary without losing runtime shape. */
function asProtocolTransaction(tx: unknown): HiveTransactionObject {
	return tx as HiveTransactionObject;
}

function isBuiltSeedOperation(value: BuiltSeedOperation | null): value is BuiltSeedOperation {
	return value !== null;
}

function buildRoute(handler: (body: any) => Response | Promise<Response>): { POST: RouteHandler } {
	return {
		POST: async (req: Request) => {
			try {
				const body = await req.json();
				return await handler(body);
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},
	};
}

export const buildRoutes: Record<string, { POST: RouteHandler }> = {
	// ============ EXISTING BUILD ENDPOINTS ============

	"/api/build/collection": buildRoute(async (body) => {
		const statusRes = await fetch(`${INDEXER_URL}/api/status`);
		if (!statusRes.ok) return json({ success: false, error: "Indexer status unavailable" }, 502);
		const statusRaw: unknown = await statusRes.json();
		if (!isIndexerStatusResponse(statusRaw) || !statusRaw.nodeAccount) {
			return json({ success: false, error: "Indexer node account unavailable" }, 502);
		}

		const result = await buildCollection(body, { nodeAccount: statusRaw.nodeAccount });
		if (!result.success) return json({ success: false, errors: result.errors }, 400);

		const customJsonOp = result.operations.find((op) => op[0] === "custom_json");
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			hashVersion: HASH_VERSION,
			collectionId: result.generatedIds?.collectionId,
			generatedIds: result.generatedIds,
			operations: result.operations,
			operation: customJsonOp,
			payload: result.payload,
			keyType: result.keyType,
			warnings: result.warnings,
		});
	}),

	"/api/build/collection-multisig": buildRoute(async (body) => {
		const statusRes = await fetch(`${INDEXER_URL}/api/status`);
		if (!statusRes.ok) {
			return json({ success: false, error: "Indexer status unavailable" }, 502);
		}
		const statusRaw: unknown = await statusRes.json();
		if (!isIndexerStatusResponse(statusRaw)) {
			return json({ success: false, error: "Indexer status malformed" }, 502);
		}
		const status = statusRaw;
		if (!status.nodeAccount) {
			return json({ success: false, error: "Indexer node account unavailable" }, 502);
		}

		const result = await buildCollection(body, { nodeAccount: status.nodeAccount });
		if (!result.success) return json({ success: false, errors: result.errors }, 400);

		const tx = new Transaction({ expiration: TX_EXPIRATION_MS });
		for (const [opName, opBody] of result.operations) {
			// hive-tx's Operation union types auth arrays as mutable `string[]`,
			// while our protocol contract exposes them as `readonly string[]` to
			// prevent in-place mutation of built operations. The wire shape is
			// identical — widen through `unknown` at this library boundary.
			await tx.addOperation(
				opName as Parameters<Transaction["addOperation"]>[0],
				opBody as unknown as Parameters<Transaction["addOperation"]>[1],
			);
		}

		if (!tx.transaction) {
			return json({ success: false, error: "Transaction building failed" }, 500);
		}

		const multisigRequest = {
			transaction: asProtocolTransaction(tx.transaction),
		};
		const multisigResult = await requestCreateCollectionMultisig(INDEXER_URL, multisigRequest);

		if (!multisigResult.ok) {
			return json({
				success: false,
				error: multisigResult.message,
				code: multisigResult.code,
			}, 400);
		}

		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			hashVersion: HASH_VERSION,
			collectionId: result.generatedIds?.collectionId,
			generatedIds: result.generatedIds,
			transaction: tx.transaction,
			nodeSignature: multisigResult.signature,
			digest: multisigResult.digest,
			payload: result.payload,
			keyType: result.keyType,
			fee: {
				amount: PROTOCOL_COLLECTION_FEE_HBD,
				currency: "HBD",
				account: status.nodeAccount,
			},
			warnings: result.warnings,
		});
	}),

	"/api/build/seeds": buildRoute(async (body) => {
		const requestBody = body as BuildSeedsRequest;
		const signer = requestBody.signer ?? requestBody.owner ?? "";
		const result = await buildSeedBatch({ ...requestBody, signer, seeds: [...requestBody.seeds] });
		if (!result.success) return json({ success: false, errors: result.errors }, 400);

		const operations: Array<BuiltSeedOperation | null> = await Promise.all(requestBody.seeds.map(async (seed) => {
			const seedResult = await buildSeed({
				artId: seed.artId,
				collectionId: requestBody.collectionId,
				name: seed.name,
				imageUrl: seed.imageUrl,
				maxSupply: seed.maxSupply,
				signer: result.signer,
				owner: requestBody.owner,
				edition: 1,
				brief: seed.brief,
				...(seed.immutableData !== undefined && { immutableData: seed.immutableData }),
			});
			if (!seedResult.success) return null;
			const operation = seedResult.operations[0];
			if (operation?.[0] !== "custom_json") return null;
			return {
				artId: seed.artId,
				seedId: seedResult.generatedIds?.seedId,
				...(seed.immutableData !== undefined && { immutableData: seed.immutableData }),
				operation,
			} satisfies BuiltSeedOperation;
		}));
		const validOps = operations.filter(isBuiltSeedOperation);

		const batches = splitOperationsIntoBatches(validOps.map((operationItem) => operationItem.operation));

		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			hashVersion: HASH_VERSION,
			collectionId: requestBody.collectionId,
			generatedIds: result.generatedIds,
			seeds: validOps,
			batches: batches.map((batch, i) => ({
				batchNumber: i + 1,
				operationCount: batch.length,
				operations: batch,
			})),
			warnings: result.warnings,
		});
	}),

	"/api/build/bulk-distribute": buildRoute((body) => {
		const result = buildBulkDistribute(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operations[0],
			payload: result.payload,
			keyType: keyTypeFromOp(result.operations[0]),
			warnings: result.warnings,
		});
	}),

	"/api/build/transfer": buildRoute(async (body) => {
		const result = await buildTransfer(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operations[0],
			payload: result.payload,
			keyType: keyTypeFromOp(result.operations[0]),
		});
	}),

	"/api/build/list": buildRoute(async (body) => {
		const result = await buildList(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operations[0],
			payload: result.payload,
			keyType: keyTypeFromOp(result.operations[0]),
		});
	}),

	"/api/build/unlist": buildRoute(async (body) => {
		const result = await buildUnlist(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operations[0],
			payload: result.payload,
			keyType: keyTypeFromOp(result.operations[0]),
		});
	}),

	"/api/build/burn": buildRoute(async (body) => {
		const result = await buildBurn(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operations[0],
			payload: result.payload,
			keyType: keyTypeFromOp(result.operations[0]),
		});
	}),

	"/api/build/buy": buildRoute((body) => {
		const result = buildBuy(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			hiveOperations: result.operations,
			payload: result.payload,
			keyType: result.keyType,
			coSigners: result.coSigners,
		});
	}),

	"/api/build/node-register": buildRoute((body) => {
		const result = buildNodeRegister(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operations[0],
			payload: result.payload,
			keyType: result.keyType,
		});
	}),

	"/api/build/preview-ids": buildRoute(async (body) => {
		const collectionId = await generateDeterministicCollectionId(
			body.creator,
			body.name,
			body.symbol,
		);
		const originDna = await generateOriginDna(collectionId);

		const seedIds: Record<string, string> = {};
		if (body.artIds && Array.isArray(body.artIds)) {
			for (const artId of body.artIds) {
				seedIds[artId] = await generateDeterministicSeedId(collectionId, artId);
			}
		}

		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			hashVersion: HASH_VERSION,
			collectionId,
			originDna,
			seedIds,
		});
	}),

	// ============ NEW BUILD ENDPOINTS ============

	"/api/build/set-data": buildRoute((body) => {
		const result = buildSetData({ ...body, owner: body.issuer });
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operations[0],
			payload: result.payload,
			keyType: keyTypeFromOp(result.operations[0]),
		});
	}),

	"/api/build/archive-collection": buildRoute((body) => {
		const result = buildArchiveCollection(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operations[0],
			payload: result.payload,
			keyType: keyTypeFromOp(result.operations[0]),
		});
	}),

	"/api/build/extend-schema": buildRoute((body) => {
		const parsedInput = extendSchemaInputSchema.safeParse(body);
		if (!parsedInput.success) return json({ success: false, errors: parsedInput.error.issues }, 400);
		const parsedCreator = usernameSchema.safeParse(body.creator);
		if (!parsedCreator.success) return json({ success: false, errors: parsedCreator.error.issues }, 400);

		const payload = createPayload("extend_schema", parsedInput.data);
		const operation = createHiveOperation(payload, parsedCreator.data);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation,
			payload,
			keyType: getKeyType(ACTION_EXTEND_SCHEMA),
		});
	}),

	// --- Allowances (3) ---

	"/api/build/nft-approve": buildRoute((body) => {
		const result = buildNftApprove(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operations[0],
			keyType: keyTypeFromOp(result.operations[0]),
		});
	}),

	"/api/build/nft-approve-all": buildRoute((body) => {
		const result = buildNftApproveAll(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operations[0],
			keyType: keyTypeFromOp(result.operations[0]),
		});
	}),

	"/api/build/nft-transfer-from": buildRoute((body) => {
		const result = buildNftTransferFrom({ ...body, operator: body.spender });
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operations[0],
			keyType: keyTypeFromOp(result.operations[0]),
		});
	}),

	// --- Lending (2) ---

	"/api/build/nft-lend": buildRoute((body) => {
		const result = buildNftLend(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operations[0],
			keyType: keyTypeFromOp(result.operations[0]),
		});
	}),

	"/api/build/nft-return": buildRoute((body) => {
		const result = buildNftReturn({ ...body, owner: body.signer });
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operations[0],
			keyType: keyTypeFromOp(result.operations[0]),
		});
	}),

	// --- Data Operators (2) ---

	"/api/build/data-operator-approve": buildRoute((body) => {
		const result = buildDataOperatorApprove(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operations[0],
			keyType: keyTypeFromOp(result.operations[0]),
		});
	}),

	"/api/build/set-data-from": buildRoute((body) => {
		const result = buildSetDataFrom(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operations[0],
			keyType: keyTypeFromOp(result.operations[0]),
		});
	}),
};
