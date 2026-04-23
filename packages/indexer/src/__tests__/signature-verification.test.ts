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

	test("rejects when the signing key is not listed in key_auths (account_auths-only)", async () => {
		const key = PrivateKey.fromSeed("foreign-key");
		const tx = buildUnsignedTx();
		const { signature, digestBytes } = signTx(tx, key);

		const active: HiveActiveAuthority = {
			weight_threshold: 1,
			account_auths: [["delegated.account", 1]],
			key_auths: [],
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
