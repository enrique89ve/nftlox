/**
 * hive-nft-tracker.ts — Payload builders for the official Hive NFT Tracker
 *
 * Generates custom_json operations compatible with BlockTrades' NFT standard:
 *   https://gitlab.syncad.com/hive/nft_tracker
 *
 * All operations use `id: "NFT"` and `required_auths` (Active key).
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface HiveNftRegisterInput {
	creator: string;
	symbol: string;       // format: "creator/SYMBOL"
	name: string;
	maxCount?: number | null;
	issuers?: string[];
}

export interface HiveNftIssueInput {
	issuer: string;
	symbol: string;
	holder: string;
	data?: Record<string, unknown>;
	soulbound?: boolean;
}

export interface HiveNftTransferInput {
	from: string;
	symbol: string;
	ids: number[];
	to: string;
}

export interface HiveNftSetDataInput {
	issuer: string;
	symbol: string;
	ids: number[];
	data: Record<string, unknown>;
}

export interface HiveNftSoulbindInput {
	issuer: string;
	symbol: string;
	ids: number[];
}

export interface HiveNftModifyInput {
	owner: string;
	symbol: string;
	name?: string;
	newOwner?: string;
	maxCount?: number | null;
	issuers?: string[];
}

// ── Hive Operation Format ──────────────────────────────────────────────

export type HiveNftOperation = [
	"custom_json",
	{
		required_auths: string[];
		required_posting_auths: string[];
		id: "NFT";
		json: string;
	},
];

// ── Builders ───────────────────────────────────────────────────────────

/**
 * Build a `register` operation to create a new NFT type/collection.
 */
export function buildRegisterOp(input: HiveNftRegisterInput): {
	operation: HiveNftOperation;
	payload: Record<string, unknown>;
} {
	const payload: Record<string, unknown> = {
		action: "register",
		symbol: input.symbol.includes("/")
			? input.symbol
			: `${input.creator}/${input.symbol}`,
		name: input.name,
		owner: input.creator,
		max_count: input.maxCount ?? null,
		issuers: input.issuers ?? [input.creator],
	};

	return {
		payload,
		operation: [
			"custom_json",
			{
				required_auths: [input.creator],
				required_posting_auths: [],
				id: "NFT",
				json: JSON.stringify(payload),
			},
		],
	};
}

/**
 * Build an `issue` operation to mint a new NFT instance.
 */
export function buildIssueOp(input: HiveNftIssueInput): {
	operation: HiveNftOperation;
	payload: Record<string, unknown>;
} {
	const payload: Record<string, unknown> = {
		action: "issue",
		symbol: input.symbol,
		holder: input.holder,
		data: input.data ?? {},
		soulbound: input.soulbound ?? false,
	};

	return {
		payload,
		operation: [
			"custom_json",
			{
				required_auths: [input.issuer],
				required_posting_auths: [],
				id: "NFT",
				json: JSON.stringify(payload),
			},
		],
	};
}

/**
 * Build a `transfer` operation to send NFT instances to another account.
 */
export function buildTransferOp(input: HiveNftTransferInput): {
	operation: HiveNftOperation;
	payload: Record<string, unknown>;
} {
	const payload: Record<string, unknown> = {
		action: "transfer",
		symbol: input.symbol,
		ids: input.ids,
		to: input.to,
	};

	return {
		payload,
		operation: [
			"custom_json",
			{
				required_auths: [input.from],
				required_posting_auths: [],
				id: "NFT",
				json: JSON.stringify(payload),
			},
		],
	};
}

/**
 * Build a `set_data` operation to update NFT instance metadata.
 */
export function buildSetDataOp(input: HiveNftSetDataInput): {
	operation: HiveNftOperation;
	payload: Record<string, unknown>;
} {
	const payload: Record<string, unknown> = {
		action: "set_data",
		symbol: input.symbol,
		ids: input.ids,
		data: input.data,
	};

	return {
		payload,
		operation: [
			"custom_json",
			{
				required_auths: [input.issuer],
				required_posting_auths: [],
				id: "NFT",
				json: JSON.stringify(payload),
			},
		],
	};
}

/**
 * Build a `soulbind` operation to make NFTs non-transferable.
 */
export function buildSoulbindOp(input: HiveNftSoulbindInput): {
	operation: HiveNftOperation;
	payload: Record<string, unknown>;
} {
	const payload: Record<string, unknown> = {
		action: "soulbind",
		symbol: input.symbol,
		ids: input.ids,
		soulbound: true,
	};

	return {
		payload,
		operation: [
			"custom_json",
			{
				required_auths: [input.issuer],
				required_posting_auths: [],
				id: "NFT",
				json: JSON.stringify(payload),
			},
		],
	};
}

/**
 * Build a `modify` operation to update an NFT type's properties.
 */
export function buildModifyOp(input: HiveNftModifyInput): {
	operation: HiveNftOperation;
	payload: Record<string, unknown>;
} {
	const payload: Record<string, unknown> = {
		action: "modify",
		symbol: input.symbol,
	};
	if (input.name !== undefined) payload.name = input.name;
	if (input.newOwner !== undefined) payload.owner = input.newOwner;
	if (input.maxCount !== undefined) payload.max_count = input.maxCount;
	if (input.issuers !== undefined) payload.issuers = input.issuers;

	return {
		payload,
		operation: [
			"custom_json",
			{
				required_auths: [input.owner],
				required_posting_auths: [],
				id: "NFT",
				json: JSON.stringify(payload),
			},
		],
	};
}
