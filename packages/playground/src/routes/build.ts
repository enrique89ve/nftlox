// Build routes — construct Hive operations via SDK builders
import {
	PROTOCOL_VERSION,
	HASH_VERSION,
	// Direct operation creators for replicate (no builder exists)
	createReplicateOperation,
	createReplicatePayload,
	// Builders
	buildCollection,
	buildSeedBatch,
	buildSeed,
	buildBulkDistribute,
	buildTransfer,
	buildList,
	buildUnlist,
	buildBurn,
	buildBuy,
	buildSetData,
	buildPackCreate,
	buildPackBuy,
	buildPackOpen,
	buildPackTransfer,
	buildNftApprove,
	buildNftApproveAll,
	buildNftTransferFrom,
	buildPackApprove,
	buildPackTransferFrom,
	buildDataOperatorApprove,
	buildSetDataFrom,
	buildNftLend,
	buildNftReturn,
	// For preview-ids (inline replacement)
	generateDeterministicCollectionId,
	generateOriginDnaSync,
	generateDeterministicSeedId,
} from "nftlox-sdk";
import { splitOperationsIntoBatches } from "../protocol";

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json" },
	});

type RouteHandler = (req: Request) => Promise<Response>;

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

	"/api/build/collection": buildRoute((body) => {
		const result = buildCollection(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			hashVersion: HASH_VERSION,
			collectionId: result.generatedId,
			generatedIds: result.generatedIds,
			operation: result.operation,
			payload: result.payload,
			warnings: result.warnings,
		});
	}),

	"/api/build/seeds": buildRoute((body) => {
		const result = buildSeedBatch(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);

		const operations = body.seeds.map((seed: any) => {
			const seedResult = buildSeed({
				artId: seed.artId,
				collectionId: body.collectionId,
				name: seed.name,
				imageUrl: seed.imageUrl,
				maxSupply: seed.maxSupply,
				owner: body.owner,
				edition: 1,
				brief: seed.brief,
			});
			return {
				artId: seed.artId,
				seedId: seedResult.generatedId,
				operation: seedResult.operation,
			};
		});

		const batches = splitOperationsIntoBatches(operations.map((o: any) => o.operation!));

		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			hashVersion: HASH_VERSION,
			collectionId: body.collectionId,
			generatedIds: result.generatedIds,
			seeds: operations,
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
			operation: result.operation,
			payload: result.payload,
			keyType: "Posting",
			warnings: result.warnings,
		});
	}),

	"/api/build/transfer": buildRoute((body) => {
		const result = buildTransfer(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			payload: result.payload,
		});
	}),

	"/api/build/list": buildRoute((body) => {
		const result = buildList(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			payload: result.payload,
		});
	}),

	"/api/build/unlist": buildRoute((body) => {
		const result = buildUnlist(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			payload: result.payload,
		});
	}),

	"/api/build/burn": buildRoute((body) => {
		const result = buildBurn(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			payload: result.payload,
		});
	}),

	"/api/build/buy": buildRoute((body) => {
		const result = buildBuy(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			hiveOperations: (result as any).hiveOperations,
			payload: result.payload,
		});
	}),

	"/api/build/preview-ids": buildRoute((body) => {
		const collectionId = generateDeterministicCollectionId(
			body.creator,
			body.name,
			body.symbol,
		);
		const originDna = generateOriginDnaSync(collectionId);

		const seedIds: Record<string, string> = {};
		if (body.artIds && Array.isArray(body.artIds)) {
			for (const artId of body.artIds) {
				seedIds[artId] = generateDeterministicSeedId(collectionId, artId);
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

	// --- Packs (4) ---

	"/api/build/pack-create": buildRoute((body) => {
		const result = buildPackCreate(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			packId: result.generatedId,
			operation: result.operation,
			payload: result.payload,
			keyType: "Posting",
		});
	}),

	"/api/build/pack-buy": buildRoute((body) => {
		const result = buildPackBuy(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			payload: result.payload,
			keyType: "Posting",
		});
	}),

	"/api/build/pack-open": buildRoute((body) => {
		const result = buildPackOpen(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			payload: result.payload,
			keyType: "Posting",
		});
	}),

	"/api/build/pack-transfer": buildRoute((body) => {
		const result = buildPackTransfer(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			payload: result.payload,
			keyType: "Posting",
		});
	}),

	// --- Core faltante (2) ---

	"/api/build/replicate": buildRoute((body) => {
		const input = {
			originalId: body.originalId,
			originDna: body.originDna,
			originalInstanceDna: body.originalInstanceDna,
			newOwner: body.newOwner,
			currentOwner: body.currentOwner,
		};
		const operation = createReplicateOperation(input);
		const payload = createReplicatePayload(input);

		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation,
			payload,
			keyType: "Posting",
		});
	}),

	"/api/build/set-data": buildRoute((body) => {
		const result = buildSetData({ ...body, owner: body.issuer });
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			payload: result.payload,
			keyType: "Active",
		});
	}),

	// --- Allowances (5) ---

	"/api/build/nft-approve": buildRoute((body) => {
		const result = buildNftApprove(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			keyType: "Active",
		});
	}),

	"/api/build/nft-approve-all": buildRoute((body) => {
		const result = buildNftApproveAll(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			keyType: "Active",
		});
	}),

	"/api/build/nft-transfer-from": buildRoute((body) => {
		const result = buildNftTransferFrom({ ...body, operator: body.spender });
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			keyType: "Active",
		});
	}),

	"/api/build/pack-approve": buildRoute((body) => {
		const result = buildPackApprove(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			keyType: "Active",
		});
	}),

	"/api/build/pack-transfer-from": buildRoute((body) => {
		const result = buildPackTransferFrom({ ...body, operator: body.spender });
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			keyType: "Active",
		});
	}),

	// --- Lending (2) ---

	"/api/build/nft-lend": buildRoute((body) => {
		const result = buildNftLend(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			keyType: "Active",
		});
	}),

	"/api/build/nft-return": buildRoute((body) => {
		const result = buildNftReturn({ ...body, owner: body.signer });
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			keyType: "Active",
		});
	}),

	// --- Data Operators (2) ---

	"/api/build/data-operator-approve": buildRoute((body) => {
		const result = buildDataOperatorApprove({ ...body, owner: body.creator });
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			keyType: "Active",
		});
	}),

	"/api/build/set-data-from": buildRoute((body) => {
		const result = buildSetDataFrom(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			keyType: "Active",
		});
	}),
};
