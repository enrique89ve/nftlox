// Hive NFT Tracker (BlockTrades Standard) routes
import {
	buildRegisterOp,
	buildIssueOp,
	buildTransferOp,
	buildSetDataOp,
	buildSoulbindOp,
	buildModifyOp,
} from "../hive-nft-tracker";

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json" },
	});

type RouteHandler = (req: Request) => Promise<Response>;

export const nftTrackerRoutes: Record<string, { POST: RouteHandler }> = {
	"/api/nft-tracker/register": {
		POST: async (req: Request) => {
			try {
				const body = await req.json() as {
					creator: string;
					symbol: string;
					name: string;
					maxCount?: number | null;
					issuers?: string[];
				};
				if (!body.creator || !body.symbol || !body.name) {
					return json({ error: "Missing required fields: creator, symbol, name" }, 400);
				}
				const result = buildRegisterOp(body);
				return json({ success: true, ...result });
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},
	},

	"/api/nft-tracker/issue": {
		POST: async (req: Request) => {
			try {
				const body = await req.json() as {
					issuer: string;
					symbol: string;
					holder: string;
					data?: Record<string, unknown>;
					tags?: string[];
					soulbound?: boolean;
				};
				if (!body.issuer || !body.symbol || !body.holder) {
					return json({ error: "Missing required fields: issuer, symbol, holder" }, 400);
				}
				const result = buildIssueOp(body);
				return json({ success: true, ...result });
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},
	},

	"/api/nft-tracker/transfer": {
		POST: async (req: Request) => {
			try {
				const body = await req.json() as {
					from: string;
					symbol: string;
					ids: number[];
					to: string;
				};
				if (!body.from || !body.symbol || !body.ids || !body.to) {
					return json({ error: "Missing required fields: from, symbol, ids, to" }, 400);
				}
				const result = buildTransferOp(body);
				return json({ success: true, ...result });
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},
	},

	"/api/nft-tracker/set-data": {
		POST: async (req: Request) => {
			try {
				const body = await req.json() as {
					issuer: string;
					symbol: string;
					ids: number[];
					data: Record<string, unknown>;
				};
				if (!body.issuer || !body.symbol || !body.ids || !body.data) {
					return json({ error: "Missing required fields: issuer, symbol, ids, data" }, 400);
				}
				const result = buildSetDataOp(body);
				return json({ success: true, ...result });
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},
	},

	"/api/nft-tracker/soulbind": {
		POST: async (req: Request) => {
			try {
				const body = await req.json() as {
					issuer: string;
					symbol: string;
					ids: number[];
				};
				if (!body.issuer || !body.symbol || !body.ids) {
					return json({ error: "Missing required fields: issuer, symbol, ids" }, 400);
				}
				const result = buildSoulbindOp(body);
				return json({ success: true, ...result });
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},
	},

	"/api/nft-tracker/modify": {
		POST: async (req: Request) => {
			try {
				const body = await req.json() as {
					owner: string;
					symbol: string;
					name?: string;
					newOwner?: string;
					maxCount?: number | null;
					issuers?: string[];
				};
				if (!body.owner || !body.symbol) {
					return json({ error: "Missing required fields: owner, symbol" }, 400);
				}
				const result = buildModifyOp(body);
				return json({ success: true, ...result });
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		},
	},
};
