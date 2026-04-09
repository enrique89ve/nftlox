// SPV verification routes — server-side proxy to avoid CORS
import {
	verifyNftOwnership,
	verifyOperationOnChain,
	verifyPackOpen,
	createDefaultL1Config,
} from "nftlox-sdk";
import { INDEXER_URL } from "../shared/indexer";

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json" },
	});

type RouteHandler = (req: Request) => Promise<Response>;

export const spvRoutes: Record<string, { POST: RouteHandler }> = {
	"/api/spv/verify-ownership": {
		POST: async (req: Request) => {
			try {
				const body = await req.json() as {
					nftId: string;
					expectedOwner: string;
				};

				if (!body.nftId || !body.expectedOwner) {
					return json({ error: "Missing required fields: nftId, expectedOwner" }, 400);
				}

				const result = await verifyNftOwnership({
					nftId: body.nftId,
					expectedOwner: body.expectedOwner,
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
				const body = await req.json() as {
					txId: string;
					blockNum?: number;
					expectedAction?: string;
					expectedSigner?: string;
				};

				if (!body.txId) {
					return json({ error: "Missing required field: txId" }, 400);
				}

				const result = await verifyOperationOnChain({
					txId: body.txId,
					blockNum: body.blockNum ?? 0,
					expectedAction: body.expectedAction ?? "",
					expectedSigner: body.expectedSigner ?? "",
					l1Config: createDefaultL1Config(),
				});

				return json(result);
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},
	},

	"/api/spv/verify-pack-open": {
		POST: async (req: Request) => {
			try {
				const body = await req.json() as {
					txId: string;
					blockNum: number;
				};

				if (!body.txId || !body.blockNum) {
					return json({ error: "Missing required fields: txId, blockNum" }, 400);
				}

				const result = await verifyPackOpen({
					txId: body.txId,
					blockNum: body.blockNum,
					indexerBaseUrl: INDEXER_URL,
					l1Config: createDefaultL1Config(),
				});

				return json(result);
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},
	},
};
