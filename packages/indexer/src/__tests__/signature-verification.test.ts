import { describe, expect, test } from "bun:test";
import { PrivateKey, Transaction } from "hive-tx";
import {
	verifyBuyerSignatureOrThrow,
	type HiveActiveAuthority,
} from "@/api/services/multisig/signature-verification.ts";

const BUYER = "test.buyer";

function buildUnsignedTx(): Transaction {
	const tx = new Transaction();
	tx.transaction = {
		ref_block_num: 1,
		ref_block_prefix: 1,
		expiration: new Date(Date.now() + 60_000).toISOString().split(".")[0]!,
		operations: [
			["transfer", { from: BUYER, to: "seller.one", amount: "1.000 HIVE", memo: "x" }],
		],
		extensions: [],
		signatures: [],
	};
	return tx;
}

function signTx(tx: Transaction, key: PrivateKey): { signature: string; digestBytes: Uint8Array } {
	const { digest } = tx.digest();
	const sig = key.sign(digest);
	return { signature: sig.customToString(), digestBytes: digest };
}

describe("verifyBuyerSignatureOrThrow", () => {
	test("accepts a signature from a key that meets the threshold alone", async () => {
		const key = PrivateKey.fromSeed("buyer-seed-ok");
		const pubKeyStr = key.createPublic().toString();
		const tx = buildUnsignedTx();
		const { signature, digestBytes } = signTx(tx, key);

		const active: HiveActiveAuthority = {
			weight_threshold: 1,
			account_auths: [],
			key_auths: [[pubKeyStr, 1]],
		};

		await verifyBuyerSignatureOrThrow({
			buyer: BUYER,
			buyerSignature: signature,
			digestBytes,
			fetchActive: async () => active,
		});
	});

	test("rejects a structurally-valid signature that recovers to an unrelated key (VUL-001)", async () => {
		const tx = buildUnsignedTx();
		const randomHex = "a".repeat(130);

		const authorizedKey = PrivateKey.fromSeed("authorized");
		const active: HiveActiveAuthority = {
			weight_threshold: 1,
			account_auths: [],
			key_auths: [[authorizedKey.createPublic().toString(), 1]],
		};

		await expect(
			verifyBuyerSignatureOrThrow({
				buyer: BUYER,
				buyerSignature: randomHex,
				digestBytes: tx.digest().digest,
				fetchActive: async () => active,
			}),
		).rejects.toMatchObject({ code: "INVALID_BUYER_SIGNATURE" });
	});

	test("rejects a valid signature when the signing key weight is below the threshold", async () => {
		const key = PrivateKey.fromSeed("weak-key");
		const pubKeyStr = key.createPublic().toString();
		const tx = buildUnsignedTx();
		const { signature, digestBytes } = signTx(tx, key);

		const active: HiveActiveAuthority = {
			weight_threshold: 2,
			account_auths: [],
			key_auths: [[pubKeyStr, 1]],
		};

		await expect(
			verifyBuyerSignatureOrThrow({
				buyer: BUYER,
				buyerSignature: signature,
				digestBytes,
				fetchActive: async () => active,
			}),
		).rejects.toMatchObject({ code: "INVALID_BUYER_SIGNATURE" });
	});

	test("rejects when account_auths chain cannot be resolved to the recovered key", async () => {
		const key = PrivateKey.fromSeed("foreign-key");
		const tx = buildUnsignedTx();
		const { signature, digestBytes } = signTx(tx, key);

		// Delegation fetch throws for the unknown account — the resolver must
		// treat that branch as zero weight, not bubble the error up, and the
		// buyer is rejected because no path reaches the recovered key.
		const buyerActive: HiveActiveAuthority = {
			weight_threshold: 1,
			account_auths: [["delegated.account", 1]],
			key_auths: [],
		};

		await expect(
			verifyBuyerSignatureOrThrow({
				buyer: BUYER,
				buyerSignature: signature,
				digestBytes,
				fetchActive: async (account) => {
					if (account === BUYER) return buyerActive;
					throw new Error(`account '${account}' not found`);
				},
			}),
		).rejects.toMatchObject({ code: "INVALID_BUYER_SIGNATURE" });
	});

	test("accepts a signature via account_auths delegation when the delegate holds the key", async () => {
		const key = PrivateKey.fromSeed("delegate-key");
		const pubKeyStr = key.createPublic().toString();
		const tx = buildUnsignedTx();
		const { signature, digestBytes } = signTx(tx, key);

		const DELEGATE = "delegate.one";
		const buyerActive: HiveActiveAuthority = {
			weight_threshold: 1,
			account_auths: [[DELEGATE, 1]],
			key_auths: [],
		};
		const delegateActive: HiveActiveAuthority = {
			weight_threshold: 1,
			account_auths: [],
			key_auths: [[pubKeyStr, 1]],
		};

		await verifyBuyerSignatureOrThrow({
			buyer: BUYER,
			buyerSignature: signature,
			digestBytes,
			fetchActive: async (account) => {
				if (account === BUYER) return buyerActive;
				if (account === DELEGATE) return delegateActive;
				throw new Error(`unexpected fetch: ${account}`);
			},
		});
	});

	test("accepts a signature across a 2-level delegation chain", async () => {
		const key = PrivateKey.fromSeed("deep-key");
		const pubKeyStr = key.createPublic().toString();
		const tx = buildUnsignedTx();
		const { signature, digestBytes } = signTx(tx, key);

		const MID = "mid.level";
		const LEAF = "leaf.level";
		const chain: Readonly<Record<string, HiveActiveAuthority>> = {
			[BUYER]: { weight_threshold: 1, account_auths: [[MID, 1]], key_auths: [] },
			[MID]: { weight_threshold: 1, account_auths: [[LEAF, 1]], key_auths: [] },
			[LEAF]: { weight_threshold: 1, account_auths: [], key_auths: [[pubKeyStr, 1]] },
		};

		await verifyBuyerSignatureOrThrow({
			buyer: BUYER,
			buyerSignature: signature,
			digestBytes,
			fetchActive: async (account) => {
				const row = chain[account];
				if (!row) throw new Error(`unexpected fetch: ${account}`);
				return row;
			},
		});
	});

	test("rejects a signature reachable only through a chain deeper than MAX_SIG_CHECK_DEPTH", async () => {
		const key = PrivateKey.fromSeed("too-deep-key");
		const pubKeyStr = key.createPublic().toString();
		const tx = buildUnsignedTx();
		const { signature, digestBytes } = signTx(tx, key);

		// buyer → L1 → L2 → L3 (key). 3 hops of account_auths exceeds Hive's
		// HIVE_MAX_SIG_CHECK_DEPTH = 2, so the signature must not authorize.
		const L1 = "lvl.one";
		const L2 = "lvl.two";
		const L3 = "lvl.three";
		const chain: Readonly<Record<string, HiveActiveAuthority>> = {
			[BUYER]: { weight_threshold: 1, account_auths: [[L1, 1]], key_auths: [] },
			[L1]: { weight_threshold: 1, account_auths: [[L2, 1]], key_auths: [] },
			[L2]: { weight_threshold: 1, account_auths: [[L3, 1]], key_auths: [] },
			[L3]: { weight_threshold: 1, account_auths: [], key_auths: [[pubKeyStr, 1]] },
		};

		await expect(
			verifyBuyerSignatureOrThrow({
				buyer: BUYER,
				buyerSignature: signature,
				digestBytes,
				fetchActive: async (account) => {
					const row = chain[account];
					if (!row) throw new Error(`unexpected fetch: ${account}`);
					return row;
				},
			}),
		).rejects.toMatchObject({ code: "INVALID_BUYER_SIGNATURE" });
	});

	test("terminates on a cyclic delegation without stack overflow or RPC amplification", async () => {
		const key = PrivateKey.fromSeed("cycle-key");
		const tx = buildUnsignedTx();
		const { signature, digestBytes } = signTx(tx, key);

		// buyer delegates to peer; peer delegates back to buyer. Neither has
		// the recovered key — the resolver must bottom out and reject without
		// an infinite recursion.
		const PEER = "peer.one";
		const chain: Readonly<Record<string, HiveActiveAuthority>> = {
			[BUYER]: { weight_threshold: 1, account_auths: [[PEER, 1]], key_auths: [] },
			[PEER]: { weight_threshold: 1, account_auths: [[BUYER, 1]], key_auths: [] },
		};

		let fetchCount = 0;
		await expect(
			verifyBuyerSignatureOrThrow({
				buyer: BUYER,
				buyerSignature: signature,
				digestBytes,
				fetchActive: async (account) => {
					fetchCount++;
					if (fetchCount > 10) throw new Error("RPC amplification detected");
					const row = chain[account];
					if (!row) throw new Error(`unexpected fetch: ${account}`);
					return row;
				},
			}),
		).rejects.toMatchObject({ code: "INVALID_BUYER_SIGNATURE" });
		expect(fetchCount).toBeLessThanOrEqual(10);
	});

	test("combines direct key_auths with delegation weight to reach a threshold", async () => {
		const key = PrivateKey.fromSeed("combined-key");
		const pubKeyStr = key.createPublic().toString();
		const tx = buildUnsignedTx();
		const { signature, digestBytes } = signTx(tx, key);

		// buyer needs weight 2: key_auths gives 1, delegation to a
		// same-key-holding account gives 1 more → threshold met.
		const DELEGATE = "delegate.combined";
		const buyerActive: HiveActiveAuthority = {
			weight_threshold: 2,
			account_auths: [[DELEGATE, 1]],
			key_auths: [[pubKeyStr, 1]],
		};
		const delegateActive: HiveActiveAuthority = {
			weight_threshold: 1,
			account_auths: [],
			key_auths: [[pubKeyStr, 1]],
		};

		await verifyBuyerSignatureOrThrow({
			buyer: BUYER,
			buyerSignature: signature,
			digestBytes,
			fetchActive: async (account) => {
				if (account === BUYER) return buyerActive;
				if (account === DELEGATE) return delegateActive;
				throw new Error(`unexpected fetch: ${account}`);
			},
		});
	});

	test("tolerates numeric fields arriving as strings from the RPC", async () => {
		const key = PrivateKey.fromSeed("stringy-weights");
		const pubKeyStr = key.createPublic().toString();
		const tx = buildUnsignedTx();
		const { signature, digestBytes } = signTx(tx, key);

		const active: HiveActiveAuthority = {
			weight_threshold: "1",
			account_auths: [],
			key_auths: [[pubKeyStr, "1"]],
		};

		await verifyBuyerSignatureOrThrow({
			buyer: BUYER,
			buyerSignature: signature,
			digestBytes,
			fetchActive: async () => active,
		});
	});
});
