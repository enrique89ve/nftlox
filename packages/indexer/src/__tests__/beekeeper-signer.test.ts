/**
 * Integration tests for the beekeeper-based signer.
 *
 * Exercises the real `@hiveio/beekeeper` WASM (no mocks) to verify:
 *   - `signWithBeekeeper` / `signPostingDigest` produce signatures that
 *     recover to the imported active/posting public keys.
 *   - `initBeekeeperSigner` is idempotent under concurrent callers and
 *     recovers cleanly after a failed init.
 *   - `closeBeekeeperSigner` nulls module state before awaiting WASM
 *     teardown, so concurrent signing callers can't race into a
 *     torn-down session (TOCTOU regression guard).
 *
 * Per-test WIFs are minted with `hive-tx` `PrivateKey.randomKey()` so no
 * real credential ever lives in source or logs.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { PrivateKey, Signature } from "hive-tx";
import {
	closeBeekeeperSigner,
	getPostingSignerPublicKey,
	getSignerPublicKey,
	initBeekeeperSigner,
	isBeekeeperReady,
	isPostingSignerReady,
	signPostingDigest,
	signWithBeekeeper,
} from "@/api/services/beekeeper-signer.ts";

const TEST_PASSWORD = "nftlox-integration-test-password";

type KeyPair = Readonly<{
	readonly wif: string;
	readonly publicKey: string;
}>;

function makeKeyPair(): KeyPair {
	const privateKey = PrivateKey.randomKey();
	return {
		wif: privateKey.toString(),
		publicKey: privateKey.createPublic().toString(),
	};
}

function makeDigest(): Readonly<{ readonly hex: string; readonly bytes: Uint8Array }> {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return { hex, bytes };
}

function recoverPublicKey(signatureHex: string, digestBytes: Uint8Array): string {
	return Signature.from(signatureHex).getPublicKey(digestBytes).toString();
}

describe("beekeeper-signer integration", () => {
	afterEach(async () => {
		try {
			await closeBeekeeperSigner();
		} catch {
			/* best-effort teardown — some tests exercise failure paths */
		}
	});

	describe("happy path — dual-key signing", () => {
		test("signWithBeekeeper produces a signature recoverable to the active public key", async () => {
			const activeKey = makeKeyPair();

			const result = await initBeekeeperSigner(activeKey.wif, TEST_PASSWORD, null);

			expect(result.activePublicKey).toBe(activeKey.publicKey);
			expect(result.postingPublicKey).toBeNull();
			expect(isBeekeeperReady()).toBe(true);
			expect(isPostingSignerReady()).toBe(false);
			expect(getSignerPublicKey()).toBe(activeKey.publicKey);

			const digest = makeDigest();
			const signatureHex = signWithBeekeeper(digest.hex);

			expect(recoverPublicKey(signatureHex, digest.bytes)).toBe(activeKey.publicKey);
		});

		test("signPostingDigest produces a signature recoverable to the posting public key", async () => {
			const activeKey = makeKeyPair();
			const postingKey = makeKeyPair();

			const result = await initBeekeeperSigner(activeKey.wif, TEST_PASSWORD, postingKey.wif);

			expect(result.activePublicKey).toBe(activeKey.publicKey);
			expect(result.postingPublicKey).toBe(postingKey.publicKey);
			expect(isPostingSignerReady()).toBe(true);
			expect(getPostingSignerPublicKey()).toBe(postingKey.publicKey);

			const digest = makeDigest();
			const signatureHex = signPostingDigest(digest.hex);

			expect(recoverPublicKey(signatureHex, digest.bytes)).toBe(postingKey.publicKey);
		});

		test("active and posting signatures are distinct — each recovers to its own key", async () => {
			const activeKey = makeKeyPair();
			const postingKey = makeKeyPair();
			await initBeekeeperSigner(activeKey.wif, TEST_PASSWORD, postingKey.wif);

			const digest = makeDigest();
			const activeSigHex = signWithBeekeeper(digest.hex);
			const postingSigHex = signPostingDigest(digest.hex);

			expect(activeSigHex).not.toBe(postingSigHex);
			expect(recoverPublicKey(activeSigHex, digest.bytes)).toBe(activeKey.publicKey);
			expect(recoverPublicKey(postingSigHex, digest.bytes)).toBe(postingKey.publicKey);
		});

		test("signPostingDigest throws a typed error when the posting key was not imported", async () => {
			const activeKey = makeKeyPair();
			await initBeekeeperSigner(activeKey.wif, TEST_PASSWORD, null);

			const digest = makeDigest();
			expect(() => signPostingDigest(digest.hex)).toThrow(/Posting key not imported/);
		});
	});

	describe("init idempotency and failure recovery", () => {
		test("concurrent initBeekeeperSigner calls share the same InitResult", async () => {
			const activeKey = makeKeyPair();

			const first = initBeekeeperSigner(activeKey.wif, TEST_PASSWORD, null);
			const second = initBeekeeperSigner(activeKey.wif, TEST_PASSWORD, null);

			const [a, b] = await Promise.all([first, second]);

			expect(a).toEqual(b);
			expect(a.activePublicKey).toBe(activeKey.publicKey);
		});

		test("init after a failed init recovers cleanly", async () => {
			const activeKey = makeKeyPair();

			await expect(initBeekeeperSigner(activeKey.wif, "")).rejects.toThrow(/BEEKEEPER_PASSWORD is required/);
			expect(isBeekeeperReady()).toBe(false);

			const result = await initBeekeeperSigner(activeKey.wif, TEST_PASSWORD, null);
			expect(result.activePublicKey).toBe(activeKey.publicKey);
			expect(isBeekeeperReady()).toBe(true);

			const digest = makeDigest();
			const signatureHex = signWithBeekeeper(digest.hex);
			expect(recoverPublicKey(signatureHex, digest.bytes)).toBe(activeKey.publicKey);
		});
	});

	describe("shutdown race (TOCTOU regression guard)", () => {
		test("signWithBeekeeper invoked mid-close fails fast with the init guard, not a WASM error", async () => {
			const activeKey = makeKeyPair();
			await initBeekeeperSigner(activeKey.wif, TEST_PASSWORD, null);

			const digest = makeDigest();
			const closePromise = closeBeekeeperSigner();

			let caught: unknown = null;
			try {
				signWithBeekeeper(digest.hex);
			} catch (err) {
				caught = err;
			}

			await closePromise;

			expect(caught).toBeInstanceOf(Error);
			expect((caught as Error).message).toMatch(/Beekeeper signer not initialized/);
		});
	});
});
