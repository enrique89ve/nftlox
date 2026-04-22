/**
 * A.1 Structural smoke for POST /api/multisig/buy.
 *
 * Fires requests with intentionally malformed or impossible payloads and
 * asserts the node returns the right HTTP status + error code from the
 * BUY_MULTISIG_STATUS dispatcher. Zero broadcasts, zero chain cost.
 */
import { solveMultisigPow, NFTLOX_POW_HEADER } from "nftlox-sdk";

const INDEXER = process.env.INDEXER_URL ?? "http://localhost:3050";

type Expected = Readonly<{
	readonly name: string;
	readonly body: unknown;
	readonly expectedStatus: number;
	readonly expectedCode: string;
}>;

async function post(body: unknown): Promise<{ status: number; json: unknown }> {
	const pow = await solveMultisigPow(body);
	const res = await fetch(`${INDEXER}/api/multisig/buy`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			[NFTLOX_POW_HEADER]: pow,
		},
		body: JSON.stringify(body),
	});
	const json = await res.json().catch(() => null);
	return { status: res.status, json };
}

function makeUnsignedBuyTxBody(params: {
	readonly buyer?: string;
	readonly seller?: string;
	readonly nodeAccount?: string;
	readonly nftId?: string;
	readonly listingId?: string;
	readonly listTxId?: string;
	readonly signatures?: string[];
}): unknown {
	const buyer = params.buyer ?? "p5testkey456";
	const seller = params.seller ?? "alice";
	const nodeAccount = params.nodeAccount ?? "gametest.ing";
	const nftId = params.nftId ?? "nft_smoke_doesnotexist";
	const listingId = params.listingId ?? "list_fake";
	const listTxId = params.listTxId ?? "tx_fake";
	return {
		transaction: {
			ref_block_num: 1,
			ref_block_prefix: 1,
			expiration: new Date(Date.now() + 60_000).toISOString().split(".")[0],
			operations: [
				["transfer", { from: buyer, to: seller, amount: "10.000 HIVE", memo: `NFTLox BUY:${nftId}` }],
				["custom_json", {
					required_auths: [nodeAccount],
					required_posting_auths: [],
					id: "nftlox_testnet",
					json: JSON.stringify({
						protocol: "nftlox_testnet",
						version: "0.7.0",
						action: "buy",
						data: { nftId, listingId, listTxId },
					}),
				}],
			],
			extensions: [],
			signatures: params.signatures ?? ["a".repeat(130)],
		},
	};
}

const cases: ReadonlyArray<Expected> = [
	{
		name: "non-object body",
		body: "not an object",
		expectedStatus: 400,
		expectedCode: "INVALID_TX_STRUCTURE",
	},
	{
		name: "empty object",
		body: {},
		expectedStatus: 400,
		expectedCode: "INVALID_TX_STRUCTURE",
	},
	{
		name: "missing signatures (node-last expects [buyerSig])",
		body: makeUnsignedBuyTxBody({ signatures: [] }),
		expectedStatus: 400,
		expectedCode: "BUYER_SIGNATURE_MISSING",
	},
	{
		name: "malformed buyer signature (wrong length)",
		body: makeUnsignedBuyTxBody({ signatures: ["deadbeef"] }),
		expectedStatus: 400,
		expectedCode: "BUYER_SIGNATURE_MISSING",
	},
	{
		name: "structurally valid but NFT does not exist",
		body: makeUnsignedBuyTxBody({}),
		expectedStatus: 404,
		expectedCode: "NFT_NOT_FOUND",
	},
];

async function runCase(tc: Expected): Promise<boolean> {
	const { status, json } = await post(tc.body);
	const actualCode = typeof json === "object" && json !== null && "code" in json
		? (json as { code: unknown }).code
		: undefined;
	const ok = status === tc.expectedStatus && actualCode === tc.expectedCode;
	const tag = ok ? "✓ PASS" : "✗ FAIL";
	console.log(`${tag}  ${tc.name}`);
	console.log(`        expected: HTTP ${tc.expectedStatus} / code ${tc.expectedCode}`);
	console.log(`        actual  : HTTP ${status} / code ${String(actualCode)}`);
	if (!ok && json && typeof json === "object" && "message" in json) {
		console.log(`        message : ${String((json as { message: unknown }).message)}`);
	}
	console.log();
	return ok;
}

async function main(): Promise<void> {
	let passed = 0;
	let failed = 0;
	for (const tc of cases) {
		if (await runCase(tc)) passed++;
		else failed++;
	}
	console.log(`---\n${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}

void main();
