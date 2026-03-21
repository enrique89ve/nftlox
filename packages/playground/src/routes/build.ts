// Build routes — construct Hive operations via PayloadBuilder and SDK payloads
import {
	PROTOCOL_VERSION,
	HASH_VERSION,
	PayloadBuilder,
	// Direct operation creators for endpoints not covered by PayloadBuilder
	createOfferOperation,
	createOfferPayload,
	createAcceptOfferOperation,
	createAcceptOfferPayload,
	createRejectOfferOperation,
	createRejectOfferPayload,
	createReplicateOperation,
	createReplicatePayload,
	createSetDataOperation,
	createSetDataPayload,
	createNftApproveOperation,
	createNftApproveAllOperation,
	createNftTransferFromOperation,
	createPackApproveOperation,
	createPackTransferFromOperation,
	createNftLendOperation,
	createNftReturnOperation,
	createDataOperatorApproveOperation,
	createSetDataFromOperation,
	// Validation
	validateOfferInput,
	validateNftApproveInput,
	validateNftApproveAllInput,
	validateNftTransferFromInput,
	validatePackApproveInput,
	validatePackTransferFromInput,
	validateNftLendInput,
	validateNftReturnInput,
	validateDataOperatorApproveInput,
	validateSetDataFromInput,
} from "nftlox-sdk";
import { splitOperationsIntoBatches } from "../protocol";

const builder = new PayloadBuilder();

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
		const result = builder.buildCollection(body);
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
		const result = builder.buildSeedBatch(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);

		const operations = body.seeds.map((seed: any) => {
			const seedResult = builder.buildSeed({
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
		const result = builder.buildBulkDistribute(body);
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
		const result = builder.buildTransfer(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			payload: result.payload,
		});
	}),

	"/api/build/list": buildRoute((body) => {
		const result = builder.buildList(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			payload: result.payload,
		});
	}),

	"/api/build/unlist": buildRoute((body) => {
		const result = builder.buildUnlist(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			payload: result.payload,
		});
	}),

	"/api/build/burn": buildRoute((body) => {
		const result = builder.buildBurn(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			payload: result.payload,
		});
	}),

	"/api/build/buy": buildRoute((body) => {
		const result = builder.buildBuy(body);
		if (!result.success) return json({ success: false, errors: result.errors }, 400);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation: result.operation,
			payload: result.payload,
		});
	}),

	"/api/build/preview-ids": buildRoute((body) => {
		const preview = builder.previewIds(body);
		const seedIds: Record<string, string> = {};
		preview.seedIds.forEach((v, k) => seedIds[k] = v);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			hashVersion: HASH_VERSION,
			collectionId: preview.collectionId,
			originDna: preview.originDna,
			seedIds,
		});
	}),

	// ============ NEW BUILD ENDPOINTS ============

	// --- Offers (3) ---

	"/api/build/offer": buildRoute((body) => {
		const validation = validateOfferInput({
			nftId: body.nftId,
			price: body.price,
			expiresAt: body.expiresAt,
		});
		if (!validation.valid) return json({ success: false, error: validation.error }, 400);

		const operation = createOfferOperation(
			{ nftId: body.nftId, price: body.price, expiresAt: body.expiresAt },
			body.offerer,
		);
		const payload = createOfferPayload({
			nftId: body.nftId,
			price: body.price,
			expiresAt: body.expiresAt,
		});

		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation,
			payload,
			keyType: "Posting",
		});
	}),

	"/api/build/accept-offer": buildRoute((body) => {
		const operation = createAcceptOfferOperation(
			{ nftId: body.nftId, offerId: body.offerId, paymentTxId: body.paymentTxId },
			body.owner,
		);
		const payload = createAcceptOfferPayload({
			nftId: body.nftId,
			offerId: body.offerId,
			paymentTxId: body.paymentTxId,
		});

		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation,
			payload,
			keyType: "Posting",
		});
	}),

	"/api/build/reject-offer": buildRoute((body) => {
		const operation = createRejectOfferOperation(
			{ nftId: body.nftId, offerId: body.offerId },
			body.owner,
		);
		const payload = createRejectOfferPayload({
			nftId: body.nftId,
			offerId: body.offerId,
		});

		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation,
			payload,
			keyType: "Posting",
		});
	}),

	// --- Packs (4) ---

	"/api/build/pack-create": buildRoute((body) => {
		const result = builder.buildPackCreate(body);
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
		const result = builder.buildPackBuy(body);
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
		const result = builder.buildPackOpen(body);
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
		const result = builder.buildPackTransfer(body);
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
		const operation = createSetDataOperation(
			{ nftId: body.nftId, instanceDna: body.instanceDna, data: body.data, tags: body.tags },
			body.issuer,
		);
		const payload = createSetDataPayload({
			nftId: body.nftId,
			instanceDna: body.instanceDna,
			data: body.data,
			tags: body.tags,
		});

		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation,
			payload,
			keyType: "Active",
		});
	}),

	// --- Allowances (5) ---

	"/api/build/nft-approve": buildRoute((body) => {
		const validation = validateNftApproveInput(body);
		if (!validation.valid) return json({ success: false, error: validation.error }, 400);
		const operation = createNftApproveOperation(body, body.owner);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation,
			keyType: "Active",
		});
	}),

	"/api/build/nft-approve-all": buildRoute((body) => {
		const validation = validateNftApproveAllInput(body);
		if (!validation.valid) return json({ success: false, error: validation.error }, 400);
		const operation = createNftApproveAllOperation(body, body.owner);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation,
			keyType: "Active",
		});
	}),

	"/api/build/nft-transfer-from": buildRoute((body) => {
		const validation = validateNftTransferFromInput(body);
		if (!validation.valid) return json({ success: false, error: validation.error }, 400);
		const operation = createNftTransferFromOperation(body, body.spender);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation,
			keyType: "Active",
		});
	}),

	"/api/build/pack-approve": buildRoute((body) => {
		const validation = validatePackApproveInput(body);
		if (!validation.valid) return json({ success: false, error: validation.error }, 400);
		const operation = createPackApproveOperation(body, body.owner);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation,
			keyType: "Active",
		});
	}),

	"/api/build/pack-transfer-from": buildRoute((body) => {
		const validation = validatePackTransferFromInput(body);
		if (!validation.valid) return json({ success: false, error: validation.error }, 400);
		const operation = createPackTransferFromOperation(body, body.spender);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation,
			keyType: "Active",
		});
	}),

	// --- Lending (2) ---

	"/api/build/nft-lend": buildRoute((body) => {
		const validation = validateNftLendInput(body);
		if (!validation.valid) return json({ success: false, error: validation.error }, 400);
		const operation = createNftLendOperation(body, body.owner);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation,
			keyType: "Active",
		});
	}),

	"/api/build/nft-return": buildRoute((body) => {
		const validation = validateNftReturnInput(body);
		if (!validation.valid) return json({ success: false, error: validation.error }, 400);
		const operation = createNftReturnOperation(body, body.signer);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation,
			keyType: "Active",
		});
	}),

	// --- Data Operators (2) ---

	"/api/build/data-operator-approve": buildRoute((body) => {
		const validation = validateDataOperatorApproveInput(body);
		if (!validation.valid) return json({ success: false, error: validation.error }, 400);
		const operation = createDataOperatorApproveOperation(body, body.creator);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation,
			keyType: "Active",
		});
	}),

	"/api/build/set-data-from": buildRoute((body) => {
		const validation = validateSetDataFromInput(body);
		if (!validation.valid) return json({ success: false, error: validation.error }, 400);
		const operation = createSetDataFromOperation(body, body.operator);
		return json({
			success: true,
			protocolVersion: PROTOCOL_VERSION,
			operation,
			keyType: "Active",
		});
	}),
};
