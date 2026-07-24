import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { sql } from "@/db/client.ts";
import { setDivergentAtBlock } from "@/db/queries/state-root.ts";
import { seedActiveSettlementNode } from "./helpers/settlement-node.ts";
import {
	cleanCommonTables,
	insertListedInstance,
	seedCollection,
	fixtureHiveTxId,
	fixtureListingId,
	fixtureNftId,
} from "./helpers/nft-fixtures.ts";
import { useSingletonLock } from "./helpers/singleton-lock.ts";
import type { BuyLockHandle, MultisigBuyContext } from "@/api/services/multisig/types.ts";
import {
	ACTION_BUY,
	BUY_TX_TTL_MS,
	MEMO_PREFIX_BUY,
	MEMO_PREFIX_FEE,
	MIN_PROTOCOL_VERSION,
	MULTISIG_TX_MAX_EXPIRATION_MS,
} from "@/protocol/index.ts";
import { config } from "@/config.ts";

const testState = {
	broadcastCalls: 0,
	signerCalls: 0,
};

const BUY_TX_HASH = "a".repeat(40);
const NODE_ACCOUNT = config.hiveAccount;
const PROTOCOL_ID = config.protocolId;
const SELLER = "seller.one";
const BUYER = "buyer.one";
const COLLECTION_ID = "col_multisig_buy_orchestration";
const NFT_ID = fixtureNftId("orchestration");
const LISTING_ID = fixtureListingId("orchestration");
const LIST_TX_ID = fixtureHiveTxId("orchestration");
const DIVERGENT_BLOCK = 123_456;

type FakeTransactionState = {
	operations: Array<readonly [string, unknown]>;
	extensions: unknown[];
	signatures: string[];
	ref_block_num?: number;
	ref_block_prefix?: number;
	expiration?: string;
};

type FakeTransactionInstance = {
	transaction?: FakeTransactionState;
	addOperation: (name: string, body: unknown) => Promise<void>;
	digest: () => { readonly digest: Uint8Array; readonly txId: string };
	addSignature: (signature: string) => FakeTransactionInstance;
	broadcast: () => Promise<void>;
};

function FakeTransaction(): FakeTransactionInstance {
	const instance: FakeTransactionInstance = {
		transaction: undefined,
		addOperation: async (name, body) => {
			instance.transaction ??= {
				operations: [],
				extensions: [],
				signatures: [],
			};
			instance.transaction.operations.push([name, body]);
		},
		digest: () => ({ digest: new Uint8Array(32), txId: BUY_TX_HASH }),
		addSignature: (signature) => {
			instance.transaction?.signatures.push(signature);
			return instance;
		},
		broadcast: async () => {
			testState.broadcastCalls += 1;
		},
	};
	return instance;
}

mock.module("hive-tx", () => ({ Transaction: FakeTransaction }));
mock.module("@/api/services/beekeeper-signer.ts", () => ({
	signWithBeekeeper: () => {
		testState.signerCalls += 1;
		return "b".repeat(130);
	},
}));
mock.module("@/api/services/multisig/signature-verification.ts", () => ({
	verifyBuyerSignatureOrThrow: async () => {},
}));
mock.module("@/scanner/hive-client.ts", () => ({
	getAccountLiquidBalance: async () => ({ hive: 100, hbd: 100 }),
}));

const { processBuyRequest } = await import("@/api/services/multisig/buy.ts");

function expirationFromNow(offsetMs: number): string {
	return new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, "");
}

function buildBuyBody(): Readonly<Record<string, unknown>> {
	const sellerMemo = `${MEMO_PREFIX_BUY}${NFT_ID}`;
	const feeMemo = `${MEMO_PREFIX_FEE}${NFT_ID}`;
	return {
		transaction: {
			ref_block_num: 1,
			ref_block_prefix: 1,
			expiration: expirationFromNow(MULTISIG_TX_MAX_EXPIRATION_MS - 5_000),
			extensions: [],
			signatures: ["c".repeat(130)],
			operations: [
				[
					"transfer",
					{
						from: BUYER,
						to: SELLER,
						amount: "9.900 HIVE",
						memo: sellerMemo,
					},
				],
				[
					"transfer",
					{
						from: BUYER,
						to: NODE_ACCOUNT,
						amount: "0.100 HIVE",
						memo: feeMemo,
					},
				],
				[
					"custom_json",
					{
						id: PROTOCOL_ID,
						required_auths: [NODE_ACCOUNT],
						required_posting_auths: [],
						json: JSON.stringify({
							protocol: PROTOCOL_ID,
							version: MIN_PROTOCOL_VERSION,
							action: ACTION_BUY,
							data: {
								nftId: NFT_ID,
								listingId: LISTING_ID,
								listTxId: LIST_TX_ID,
							},
						}),
					},
				],
			],
		},
	};
}

async function setSyncState(): Promise<void> {
	await sql`
		UPDATE sync_state
		SET last_block = 100,
		    hive_head_block = 115,
		    hive_irreversible_block = 100,
		    hive_head_time = NOW()
		WHERE id = 1
	`;
}

async function clearState(): Promise<void> {
	await sql`UPDATE state_meta SET divergent_at_block = NULL WHERE id = 1`;
	await sql`DELETE FROM l2_nodes WHERE account = ${NODE_ACCOUNT}`;
	await sql`DELETE FROM collections WHERE id = ${COLLECTION_ID}`;
}

function buildPostVictoryDb(): MultisigBuyContext["db"] {
	const state = { divergenceInjected: false };
	return new Proxy(sql, {
		apply(target, thisArg, argumentsList) {
			const result = Reflect.apply(target, thisArg, argumentsList);
			return Promise.resolve(result).then(async (rows: unknown) => {
				if (state.divergenceInjected || !isPendingSaleRows(rows)) return rows;
				state.divergenceInjected = true;
				await setDivergentAtBlock(DIVERGENT_BLOCK);
				return rows;
			});
		},
	});
}

function isPendingSaleRows(value: unknown): boolean {
	if (!Array.isArray(value)) return false;
	const [first] = value;
	return typeof first === "object"
		&& first !== null
		&& !Array.isArray(first)
		&& "status" in first
		&& first.status === "pending_sale";
}

function buildCtx(): MultisigBuyContext {
	const buyLock: BuyLockHandle = {
		acquire: async (_nftId, _listingId, _listTxId, holder) => {
			await sql`
				UPDATE nfts
				SET status = 'pending_sale',
				    sale_buyer = ${BUYER},
				    sale_settlement_node = ${NODE_ACCOUNT},
				    sale_commitment_buy_tx_hash = ${holder},
				    sale_commitment_op_tx_id = 'commitment-op',
				    sale_expires_block = 200
				WHERE id = ${NFT_ID}
			`;
			return { acquired: true };
		},
		release: async () => {},
	};

	return {
		db: buildPostVictoryDb(),
		nodeAccount: NODE_ACCOUNT,
		protocolId: PROTOCOL_ID,
		buyLock,
		buyTxTtlMs: BUY_TX_TTL_MS,
	};
}

describe("buy multisig post-victory orchestration gate", () => {
	useSingletonLock();

	beforeEach(async () => {
		testState.broadcastCalls = 0;
		testState.signerCalls = 0;
		await cleanCommonTables();
		await clearState();
		await setSyncState();
		await seedCollection(COLLECTION_ID, SELLER);
		await insertListedInstance({
			nftId: NFT_ID,
			collectionId: COLLECTION_ID,
			seller: SELLER,
			listingId: LISTING_ID,
			listTxId: LIST_TX_ID,
		});
		await seedActiveSettlementNode(NODE_ACCOUNT, { registeredBlock: 100 });
	});

	afterAll(async () => {
		await cleanCommonTables();
		await clearState();
	});

	test("blocks final signing and broadcast when divergence appears after commitment victory", async () => {
		const result = await processBuyRequest(buildBuyBody(), buildCtx());

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("NODE_DIVERGENT");
			expect(result.commitmentOpTxId).toBe(BUY_TX_HASH);
		}
		expect(testState.signerCalls).toBe(1);
		expect(testState.broadcastCalls).toBe(1);
	});
});
