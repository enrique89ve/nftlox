// SPV verification routes — server-side proxy to avoid CORS
import {
	verifyNftOwnership,
	verifyOperationOnChain,
	createDefaultL1Config,
} from "nftlox-sdk";
import { INDEXER_URL } from "../shared/indexer";

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json" },
	});

type RouteHandler = (req: Request) => Promise<Response>;

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const asNonEmptyString = (value: unknown): string | null => {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
};

export const spvRoutes: Record<string, { POST: RouteHandler }> = {
	"/api/spv/verify-ownership": {
		POST: async (req: Request) => {
			try {
				const body = await req.json() as unknown;
				if (!isRecord(body)) {
					return json({ error: "Invalid JSON body" }, 400);
				}

				const nftId = asNonEmptyString(body.nftId);
				const expectedOwner = asNonEmptyString(body.expectedOwner)?.toLowerCase();

				if (!nftId || !expectedOwner) {
					return json({ error: "Missing required fields: nftId, expectedOwner" }, 400);
				}

				const result = await verifyNftOwnership({
					nftId,
					expectedOwner,
					indexerBaseUrl: INDEXER_URL,
					l1Config: createDefaultL1Config(),
				});

				return json(result);
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},
	},

	"/api/spv/verify-on-chain": {
		POST: async (req: Request) => {
			try {
				const body = await req.json() as unknown;
				if (!isRecord(body)) {
					return json({ error: "Invalid JSON body" }, 400);
				}

				const txId = asNonEmptyString(body.txId);
				if (!txId) {
					return json({ error: "Missing required field: txId" }, 400);
				}

				const result = await verifyOperationOnChain({
					txId,
					blockNum: typeof body.blockNum === "number" ? body.blockNum : 0,
					expectedAction: asNonEmptyString(body.expectedAction) ?? "",
					expectedSigner: asNonEmptyString(body.expectedSigner)?.toLowerCase() ?? "",
					l1Config: createDefaultL1Config(),
				});

				return json(result);
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},
	},

};
