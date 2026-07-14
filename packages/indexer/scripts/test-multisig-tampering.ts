/**
 * Empirical validation that a node co-signer CANNOT modify the contents of a
 * buyer-signed transaction without invalidating the buyer's signature.
 *
 * Runs against real Hive mainnet using `condenser_api.verify_authority`, so no
 * broadcast happens and no funds move. We only check whether the network would
 * accept the (signed) transaction as authority-valid.
 *
 * Reads keys from packages/indexer/.env:
 *   HIVE_ACCOUNT, ACTIVE_KEY           (the node)
 *   TEST_BUYER_ACCOUNT, TEST_BUYER_ACTIVE_KEY
 */
import { Transaction, PrivateKey, callRPC, config } from "hive-tx";
import { PROTOCOL_ID, PROTOCOL_VERSION, RECOMMENDED_BUY_TX_EXPIRATION_MS } from "@nftlox/protocol";

type HiveTransferBody = {
	from: string;
	to: string;
	amount: string;
	memo: string;
};

type HiveCustomJsonBody = {
	required_auths: string[];
	required_posting_auths: string[];
	id: string;
	json: string;
};

type SignedTx = ReturnType<Transaction["sign"]>;


const NODE_ACCOUNT = requireEnv("HIVE_ACCOUNT");
const NODE_ACTIVE_KEY = requireEnv("ACTIVE_KEY");
const BUYER_ACCOUNT = requireEnv("TEST_BUYER_ACCOUNT");
const BUYER_ACTIVE_KEY = requireEnv("TEST_BUYER_ACTIVE_KEY");

config.nodes = [
	"https://api.syncad.com",
	"https://rpc.mahdiyari.info",
	"https://api.hive.blog",
];

const nodeKey = PrivateKey.from(NODE_ACTIVE_KEY);
const buyerKey = PrivateKey.from(BUYER_ACTIVE_KEY);

async function buildBuyTx(): Promise<Transaction> {
	const tx = new Transaction({ expiration: RECOMMENDED_BUY_TX_EXPIRATION_MS });
	await tx.addOperation("transfer", {
		from: BUYER_ACCOUNT,
		to: NODE_ACCOUNT,
		amount: "1.000 HIVE",
		memo: "nftlox:tampering-test",
	});
	await tx.addOperation("custom_json", {
		required_auths: [NODE_ACCOUNT],
		required_posting_auths: [],
		id: PROTOCOL_ID,
		json: JSON.stringify({
			protocol: PROTOCOL_ID,
			version: PROTOCOL_VERSION,
			action: "buy",
			data: {
				nftId: "test-nft-id",
				listingId: "L1",
				listTxId: "abc123deadbeef",
			},
		}),
	});
	return tx;
}

async function verifyAuthority(signedTx: SignedTx): Promise<
	{ accepted: true } | { accepted: false; error: string }
> {
	try {
		const result = await callRPC("condenser_api.verify_authority", [signedTx]);
		return result === true
			? { accepted: true }
			: { accepted: false, error: `verify_authority returned ${JSON.stringify(result)}` };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { accepted: false, error: message };
	}
}

function cloneTx(tx: Transaction): SignedTx {
	return JSON.parse(JSON.stringify(tx.transaction));
}

function withBuyerSig(tx: Transaction): SignedTx {
	// Fresh sign (buyer only). We work on a clone so each test is independent.
	const fresh = new Transaction({ transaction: tx.transaction });
	fresh.sign(buyerKey);
	return cloneTx(fresh);
}

function addNodeSigToModifiedTx(signedByBuyer: SignedTx): SignedTx {
	// The node receives the partially-signed tx and adds its own signature.
	// We simulate this with hive-tx by wrapping the (possibly tampered) tx and
	// calling sign(nodeKey), which appends the node's signature to the array.
	const wrapper = new Transaction({ transaction: signedByBuyer });
	wrapper.sign(nodeKey);
	return cloneTx(wrapper);
}

type TestCase = Readonly<{
	name: string;
	expect: "accept" | "reject";
	build: () => Promise<SignedTx>;
}>;

async function runCases(): Promise<void> {
	const cases: ReadonlyArray<TestCase> = [
		{
			name: "A · control · buyer signs, node signs unchanged tx",
			expect: "accept",
			build: async () => {
				const tx = await buildBuyTx();
				const withBuyer = withBuyerSig(tx);
				return addNodeSigToModifiedTx(withBuyer);
			},
		},
		{
			name: "B · node changes transfer amount before signing",
			expect: "reject",
			build: async () => {
				const tx = await buildBuyTx();
				const withBuyer = withBuyerSig(tx);
				const transfer = withBuyer.operations[0]![1] as HiveTransferBody;
				transfer.amount = "0.001 HIVE";
				return addNodeSigToModifiedTx(withBuyer);
			},
		},
		{
			name: "C · node redirects transfer to attacker account",
			expect: "reject",
			build: async () => {
				const tx = await buildBuyTx();
				const withBuyer = withBuyerSig(tx);
				const transfer = withBuyer.operations[0]![1] as HiveTransferBody;
				transfer.to = "hive.fund";
				return addNodeSigToModifiedTx(withBuyer);
			},
		},
		{
			name: "D · node rewrites nftId inside custom_json payload",
			expect: "reject",
			build: async () => {
				const tx = await buildBuyTx();
				const withBuyer = withBuyerSig(tx);
				const customJson = withBuyer.operations[1]![1] as HiveCustomJsonBody;
				const payload = JSON.parse(customJson.json) as {
					protocol: string;
					version: string;
					action: string;
					data: Record<string, string>;
				};
				payload.data.nftId = "different-nft";
				customJson.json = JSON.stringify(payload);
				return addNodeSigToModifiedTx(withBuyer);
			},
		},
		{
			name: "E · node changes expiration after buyer signed",
			expect: "reject",
			build: async () => {
				const tx = await buildBuyTx();
				const withBuyer = withBuyerSig(tx);
				const original = new Date(`${withBuyer.expiration}Z`).getTime();
				const shifted = new Date(original + 30_000).toISOString().split(".")[0]!;
				withBuyer.expiration = shifted;
				return addNodeSigToModifiedTx(withBuyer);
			},
		},
		{
			name: "F · node broadcasts only its own signature (no buyer sig)",
			expect: "reject",
			build: async () => {
				const tx = await buildBuyTx();
				const unsigned = cloneTx(tx);
				const wrapper = new Transaction({ transaction: unsigned });
				wrapper.sign(nodeKey);
				return cloneTx(wrapper);
			},
		},
	];

	let passed = 0;
	let failed = 0;

	for (const testCase of cases) {
		const signedTx = await testCase.build();
		const result = await verifyAuthority(signedTx);
		const expectedOutcome = testCase.expect === "accept";
		const actualOutcome = result.accepted;
		const ok = expectedOutcome === actualOutcome;
		if (ok) passed++;
		else failed++;

		const status = ok ? "✓ PASS" : "✗ FAIL";
		const expected = testCase.expect === "accept" ? "accepted" : "rejected";
		const actual = result.accepted ? "accepted" : "rejected";
		console.log(`${status}  ${testCase.name}`);
		console.log(`        expected=${expected}  actual=${actual}`);
		if (!result.accepted) {
			console.log(`        reason: ${result.error}`);
		}
		console.log();
	}

	console.log(`---\n${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing env var: ${name}`);
	return value;
}

void runCases();
