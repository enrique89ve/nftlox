/**
 * Beekeeper-based transaction signer — dual-key (active + optional posting).
 *
 * Stores the WIFs inside beekeeper's WASM memory so they never live as plain
 * JS strings after initialization. The wallet is in-memory only (no file
 * persistence across process restarts).
 *
 * Why two keys:
 *   - `active`  → signs marketplace flows (`buy`, `create_collection` multisig).
 *   - `posting` → signs permissionless node ops (`node_register`, `node_heartbeat`)
 *                 when `NODE_REGISTER=true`. Optional; absent when the operator
 *                 runs a private (unregistered) node.
 *
 * Lifecycle:
 *   init()   — call once at startup; imports keys and caches the session.
 *   sign*()  — sign a hex digest; selector picks which key to use.
 *   close()  — tear down WASM; call on graceful shutdown.
 */

import createBeekeeper, {
	type IBeekeeperInstance,
	type IBeekeeperSession,
	type IBeekeeperUnlockedWallet,
} from "@hiveio/beekeeper";
import { createLogger } from "@/utils/logger.ts";
import { redactError } from "@/utils/redact.ts";

const log = createLogger("beekeeper-signer");

const WALLET_NAME = "nftlox-multisig";

// ============ STATE ============

let bkInstance: IBeekeeperInstance | null = null;
let bkSession: IBeekeeperSession | null = null;
let bkWallet: IBeekeeperUnlockedWallet | null = null;
let cachedActivePublicKey: string | null = null;
let cachedPostingPublicKey: string | null = null;
let initPromise: Promise<InitResult> | null = null;

export type InitResult = Readonly<{
	activePublicKey: string;
	postingPublicKey: string | null;
}>;

// ============ PUBLIC API ============

/**
 * Initialize beekeeper: create instance, session, wallet, and import keys.
 * After this call the WIF strings are no longer needed — all signing goes
 * through beekeeper's WASM memory.
 *
 * `postingKeyWif` is optional. When null/undefined, only active signing is
 * available (posting-signed ops throw).
 *
 * Safe to call concurrently — uses a promise barrier to prevent double init.
 */
export function initBeekeeperSigner(
	activeKeyWif: string,
	walletPassword: string,
	postingKeyWif?: string | null,
): Promise<InitResult> {
	if (!initPromise) {
		initPromise = doInit(activeKeyWif, walletPassword, postingKeyWif ?? null).catch((err) => {
			initPromise = null;
			throw err;
		});
	}
	return initPromise;
}

async function doInit(
	activeKeyWif: string,
	walletPassword: string,
	postingKeyWif: string | null,
): Promise<InitResult> {
	if (!walletPassword) {
		throw new Error("BEEKEEPER_PASSWORD is required — set it in your .env");
	}

	const storageRoot = process.env.BEEKEEPER_STORAGE_ROOT || "/tmp/nftlox-beekeeper";

	try {
		bkInstance = await createBeekeeper({
			enableLogs: false,
			inMemory: true,
			storageRoot,
			unlockTimeout: 31_536_000,
		});
		// Salt must be random & unique per session — beekeeper derives the
		// session token from it; static salts risk collisions across
		// processes sharing storage (README requirement, even under inMemory).
		bkSession = bkInstance.createSession(crypto.randomUUID());

		let wallet: IBeekeeperUnlockedWallet;

		if (bkSession.hasWallet(WALLET_NAME)) {
			log.info("Wallet already exists, opening and unlocking", { walletName: WALLET_NAME });
			const openResult = bkSession.openWallet(WALLET_NAME);
			if (openResult.unlocked) {
				wallet = openResult.unlocked;
			} else {
				wallet = openResult.unlock(walletPassword);
			}
		} else {
			const created = await bkSession.createWallet(WALLET_NAME, walletPassword, true);
			wallet = created.wallet;
		}

		bkWallet = wallet;

		cachedActivePublicKey = await wallet.importKey(activeKeyWif);

		if (postingKeyWif) {
			cachedPostingPublicKey = await wallet.importKey(postingKeyWif);
		}

		log.info("Beekeeper signer initialized", {
			activePublicKey: cachedActivePublicKey,
			postingPublicKey: cachedPostingPublicKey,
			storageRoot,
			isTemporary: wallet.isTemporary,
		});

		return {
			activePublicKey: cachedActivePublicKey,
			postingPublicKey: cachedPostingPublicKey,
		};
	} catch (err) {
		cleanupState();
		throw redactError(err);
	}
}

function cleanupState(): void {
	bkWallet = null;
	bkSession = null;
	bkInstance = null;
	cachedActivePublicKey = null;
	cachedPostingPublicKey = null;
}

/**
 * Sign a transaction digest (hex string) with the active key.
 * Used for marketplace flows (`buy`, `create_collection` multisig).
 */
export function signWithBeekeeper(sigDigestHex: string): string {
	if (!bkWallet || !cachedActivePublicKey) {
		throw new Error("Beekeeper signer not initialized — call initBeekeeperSigner() first");
	}
	return signWithCachedKey(sigDigestHex, cachedActivePublicKey);
}

/**
 * Sign a transaction digest (hex string) with the posting key.
 * Used for node ops (`node_register`, `node_heartbeat`).
 *
 * Throws if beekeeper was initialized without a posting key — callers should
 * only invoke this when `config.nodeRegister === true`.
 */
export function signPostingDigest(sigDigestHex: string): string {
	if (!bkWallet) {
		throw new Error("Beekeeper signer not initialized — call initBeekeeperSigner() first");
	}
	if (!cachedPostingPublicKey) {
		throw new Error(
			"Posting key not imported — pass POSTING_KEY to initBeekeeperSigner() or set NODE_REGISTER=false",
		);
	}
	return signWithCachedKey(sigDigestHex, cachedPostingPublicKey);
}

function signWithCachedKey(sigDigestHex: string, publicKey: string): string {
	try {
		return bkWallet!.signDigest(publicKey, sigDigestHex);
	} catch (err) {
		// Sanitize first — a malicious input could cause beekeeper to emit an
		// error whose message/stack embeds a WIF. Never let that reach logs
		// or bubble unredacted to upstream handlers.
		const safe = redactError(err);
		const wallets = safeListWallets();
		const keys = bkWallet ? (tryGetPublicKeys(bkWallet) ?? []) : [];

		log.error("Beekeeper signing failed", {
			error: safe.message,
			requestedKey: publicKey,
			activeWallets: wallets,
			keysInCurrentWallet: keys,
		});

		throw safe;
	}
}

function safeListWallets(): ReadonlyArray<{ name: string; unlocked: boolean }> {
	if (!bkSession) return [];
	try {
		return bkSession.listWallets().map((w) => ({ name: w.name, unlocked: !!w.unlocked }));
	} catch {
		return [];
	}
}

function tryGetPublicKeys(wallet: IBeekeeperUnlockedWallet): string[] | null {
	try {
		return wallet.getPublicKeys();
	} catch {
		return null;
	}
}

/** True when the signer has been initialized and is ready to sign (active). */
export function isBeekeeperReady(): boolean {
	return bkWallet !== null && cachedActivePublicKey !== null;
}

/** True when posting signing is available (i.e., POSTING_KEY was imported). */
export function isPostingSignerReady(): boolean {
	return bkWallet !== null && cachedPostingPublicKey !== null;
}

/** Returns the active public key derived from the imported active WIF. */
export function getSignerPublicKey(): string | null {
	return cachedActivePublicKey;
}

/** Returns the posting public key if imported, else null. */
export function getPostingSignerPublicKey(): string | null {
	return cachedPostingPublicKey;
}

/**
 * Graceful shutdown: lock wallet, close session, delete WASM instance.
 *
 * Module state is nulled BEFORE awaiting WASM teardown so a concurrent
 * `signWithBeekeeper` / `signPostingDigest` caller fails fast through the
 * init guard instead of racing into a closed session and triggering a raw
 * WASM error. `initPromise` is also reset so a future `initBeekeeperSigner`
 * (tests, hot-restart) actually re-runs `doInit` instead of returning the
 * stale cached `InitResult`.
 */
export async function closeBeekeeperSigner(): Promise<void> {
	const session = bkSession;
	const instance = bkInstance;

	cleanupState();
	initPromise = null;

	if (session) {
		try { session.close(); } catch { /* may already be closed */ }
	}
	if (instance) {
		try { await instance.delete(); } catch { /* best-effort */ }
	}

	log.info("Beekeeper signer closed");
}
