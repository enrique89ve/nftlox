/**
 * Beekeeper-based transaction signer.
 *
 * Stores the active key inside beekeeper's WASM memory so it never
 * lives as a plain JS string after initialization. The wallet is
 * temporary (in-memory only, no file persistence).
 *
 * Lifecycle:
 *   init()   — call once at startup; imports the key and caches the session.
 *   sign()   — sign a hex digest; reuses the cached session.
 *   close()  — tear down WASM; call on graceful shutdown.
 */

import createBeekeeper, {
	type IBeekeeperInstance,
	type IBeekeeperSession,
	type IBeekeeperUnlockedWallet,
} from "@hiveio/beekeeper";
import { createLogger } from "@/utils/logger.ts";

const log = createLogger("beekeeper-signer");

const WALLET_NAME = "nftlox-multisig";
const SESSION_SALT = "nftlox-indexer";

// ============ STATE ============

let bkInstance: IBeekeeperInstance | null = null;
let bkSession: IBeekeeperSession | null = null;
let bkWallet: IBeekeeperUnlockedWallet | null = null;
let cachedPublicKey: string | null = null;
let initPromise: Promise<string> | null = null;

// ============ PUBLIC API ============

/**
 * Initialize beekeeper: create instance, session, wallet, and import key.
 * After this call the WIF string is no longer needed — all signing goes
 * through beekeeper's WASM memory.
 *
 * Safe to call concurrently — uses a promise barrier to prevent double init.
 */
export function initBeekeeperSigner(activeKeyWif: string, walletPassword: string): Promise<string> {
	if (!initPromise) {
		initPromise = doInit(activeKeyWif, walletPassword);
	}
	return initPromise;
}

async function doInit(activeKeyWif: string, walletPassword: string): Promise<string> {
	if (!walletPassword) {
		throw new Error("BEEKEEPER_PASSWORD is required — set it in your .env");
	}

	bkInstance = await createBeekeeper({ enableLogs: false, inMemory: true });
	bkSession = bkInstance.createSession(SESSION_SALT);

	const { wallet } = await bkSession.createWallet(WALLET_NAME, walletPassword, true);
	bkWallet = wallet;

	cachedPublicKey = await wallet.importKey(activeKeyWif);
	log.info("Beekeeper signer initialized", { publicKey: cachedPublicKey });

	return cachedPublicKey;
}

/**
 * Sign a transaction digest (hex string).
 * Returns the signature in the format Hive expects.
 */
export function signWithBeekeeper(sigDigestHex: string): string {
	if (!bkWallet || !cachedPublicKey) {
		throw new Error("Beekeeper signer not initialized — call initBeekeeperSigner() first");
	}

	return bkWallet.signDigest(cachedPublicKey, sigDigestHex);
}

/** True when the signer has been initialized and is ready to sign. */
export function isBeekeeperReady(): boolean {
	return bkWallet !== null && cachedPublicKey !== null;
}

/** Returns the public key derived from the imported active key. */
export function getSignerPublicKey(): string | null {
	return cachedPublicKey;
}

/**
 * Graceful shutdown: lock wallet, close session, delete WASM instance.
 */
export async function closeBeekeeperSigner(): Promise<void> {
	if (bkSession) {
		try { bkSession.close(); } catch { /* may already be closed */ }
	}
	if (bkInstance) {
		try { await bkInstance.delete(); } catch { /* best-effort */ }
	}

	bkWallet = null;
	bkSession = null;
	bkInstance = null;
	cachedPublicKey = null;

	log.info("Beekeeper signer closed");
}
