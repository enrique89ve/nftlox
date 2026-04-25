/**
 * Quick game example — the SDK end-to-end in one file.
 *
 * Two parts you can copy independently:
 *
 *   PART A — Read-only walkthrough (no signing, no wallet)
 *     Useful as a smoke test the moment you `npm install nftlox-sdk`.
 *     Connects, queries the live indexer, runs an SPV check.
 *
 *   PART B — Posting-auth write flow (distribute → list)
 *     Demonstrates the hot-path operations a game server runs every day.
 *     Both `bulk_distribute` and `list` need only the user's POSTING key —
 *     no multisig, no active key, no fee transfer. Calls a stubbed
 *     `signAndBroadcast`; replace with Hive Keychain (browser) or
 *     @hiveio/wax / hive-tx (server) when you wire it up.
 *
 *     The active-auth flows (`create_collection`, `buy`) are NOT shown here
 *     because they require a Hive transaction-building library the SDK does
 *     not bundle. See packages/playground/docs/broadcasting.md for a runnable
 *     guide that covers them.
 *
 * Run Part A:    bun packages/sdk/examples/quick-game.ts
 * Run Part B:    QUICK_GAME_WRITE=1 bun packages/sdk/examples/quick-game.ts
 *
 * The SDK never touches private keys — builders return unsigned operations
 * and the `keyType` ("Posting" or "Active") the consumer must use. Key
 * custody stays entirely in the integrator's hands.
 */

import {
	createNftloxClient,
	expireIn,
	type HiveOperation,
	type HiveTransferOperation,
	type KeychainResult,
} from "../src";

// ─── Config ──────────────────────────────────────────────────────────────────

const INDEXER_URL = process.env.NFTLOX_INDEXER_URL
	?? "https://api-nftlox.hivecreators.co";

const CREATOR = process.env.HIVE_USERNAME ?? "alice";
const PLAYER = process.env.HIVE_PLAYER ?? "bob";

/** Set to a real seed id from your collection to run Part B end-to-end. */
const DEMO_SEED_ID = process.env.QUICK_GAME_SEED_ID ?? "seed_replace_with_a_real_one";
const DEMO_SEED_TX_ID = process.env.QUICK_GAME_SEED_TX_ID
	?? "0000000000000000000000000000000000000000";

// ─── Stub signer ─────────────────────────────────────────────────────────────
//
// In a browser, replace with Keychain:
//   window.hive_keychain.requestBroadcast(signer, operations, keyType, callback)
// On a server, replace with @hiveio/wax or hive-tx using a key from env vars.

type Op = HiveOperation | HiveTransferOperation;
type BroadcastResult = { txId: string };

async function signAndBroadcast(
	operations: ReadonlyArray<Op>,
	keyType: "Posting" | "Active",
	signer: string,
): Promise<BroadcastResult> {
	console.log(`[stub] would broadcast ${operations.length} op(s) signed by ${signer} (${keyType})`);
	return { txId: `stub_${Date.now().toString(16)}` };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type Success<T> = Extract<KeychainResult<T>, { success: true }>;

function unwrap<T>(label: string, result: KeychainResult<T>): Success<T> {
	if (!result.success) {
		const summary = result.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
		throw new Error(`${label} failed validation: ${summary}`);
	}
	return result;
}

// ─── PART A — Read-only walkthrough ──────────────────────────────────────────

export async function readOnlyDemo(): Promise<void> {
	const client = createNftloxClient({ indexerUrl: INDEXER_URL });
	await client.connect();
	console.log(`Connected to ${client.protocol.id} @ ${client.protocol.version}`);

	// 1. Indexer status — confirms the node is in sync with Hive L1.
	const status = await client.indexer.getStatus();
	console.log(`Indexer head block: ${status.lastBlock}`);

	// 2. List a few collections.
	const collections = await client.indexer.getCollections({ limit: 3 });
	console.log(`Top collections: ${collections.map((c) => c.id).join(", ") || "(none yet)"}`);

	// 3. Sample listing + SPV check (skip if no listings exist yet).
	const sample = await client.indexer.getListings({ limit: 1 });
	const ref = sample[0];
	if (ref?.listing_tx_id && ref.listing_price && ref.listing_currency) {
		const check = await client.spv.verifyListingPrice({
			listTxId: ref.listing_tx_id,
			expectedNftId: ref.id,
			expectedSeller: ref.owner,
			expectedPrice: {
				amount: Number(ref.listing_price),
				currency: ref.listing_currency as "HIVE" | "HBD",
			},
		});
		console.log(`SPV listing-price check on ${ref.id}: ${check.status}`);
	} else {
		console.log("No active listings to SPV-check yet.");
	}
}

// ─── PART B — Posting-auth write flow ────────────────────────────────────────

export async function writeDemo(): Promise<void> {
	const client = createNftloxClient({ indexerUrl: INDEXER_URL });
	await client.connect();

	// 1. Distribute one instance from an existing seed to the player.
	//    (Posting auth — no multisig, no fee.)
	const distribution = unwrap(
		"bulk_distribute",
		await client.builders.bulkDistribute({
			signer: CREATOR,
			to: PLAYER,
			items: [{
				seedId: DEMO_SEED_ID,
				seedTxId: DEMO_SEED_TX_ID,
				quantity: 1,
			}],
		}),
	);
	const distTx = await signAndBroadcast(
		distribution.operations,
		distribution.keyType,
		distribution.signer,
	);
	console.log(`Distributed 1 instance in tx ${distTx.txId}`);

	// 2. Find the player's freshly-distributed instance.
	const inventory = await client.indexer.getUserNfts(PLAYER);
	const card = inventory.nfts.find((n) => n.seed_id === DEMO_SEED_ID);
	if (!card) {
		console.log("(player inventory not yet indexed — wait one block and rerun)");
		return;
	}

	// 3. Player lists their card. Always provide an explicit `expiresAt`
	//    inside the protocol's [7, 60]-day window — listings outside that
	//    range are rejected by both the SDK and the indexer.
	const listing = unwrap(
		"list",
		await client.builders.list({
			nftId: card.id,
			owner: PLAYER,
			price: { amount: "10.000", currency: "HIVE" },
			expiresAt: expireIn({ days: 14 }),
		}),
	);
	const listTx = await signAndBroadcast(listing.operations, listing.keyType, listing.signer);
	console.log(`${card.id} listed in tx ${listTx.txId}`);

	// 4. Trustless verification of the listing against Hive L1 — useful for
	//    apps that want to display the price without trusting the indexer.
	const spvCheck = await client.spv.verifyListingPrice({
		listTxId: listTx.txId,
		expectedNftId: card.id,
		expectedSeller: PLAYER,
		expectedPrice: { amount: 10, currency: "HIVE" },
	});
	console.log(`SPV listing-price check: ${spvCheck.status}`);
}

// ─── CLI entry ───────────────────────────────────────────────────────────────

if (typeof process !== "undefined" && process.argv[1]?.endsWith("quick-game.ts")) {
	const runWrite = process.env.QUICK_GAME_WRITE === "1";
	(runWrite ? writeDemo() : readOnlyDemo()).catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
