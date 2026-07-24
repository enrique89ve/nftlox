// NFTLox SDK -- Indexer API Client (buy + collection multisig)
//
// Endpoints exposed:
//   - POST /api/multisig/buy         → requestBuyMultisig              (node-last buy: broadcast commitment, wait, co-sign, broadcast)
//   - POST /api/multisig/collection  → requestCreateCollectionMultisig (active-auth cosign)
//   - GET  /api/payment-info/:nftId  → fetchPaymentInfo
//   - GET  /api/status               → fetchNodeAccount

import type {
	PaymentInfo,
	BuyMultisigRequest,
	BuyMultisigResponse,
	CreateCollectionMultisigRequest,
	MultisigResponse,
} from "@nftlox/protocol";
import { validateHiveUsername } from "@nftlox/protocol";
import { NFTLOX_POW_HEADER, solveMultisigPow } from "./pow";
import { IndexerError, MultisigError } from "./errors";
import { type HttpOptions, handleFetchError, headersToRecord, mergeHeaders, resolveFetch } from "./http";

export type RequestMultisigOptions = Readonly<HttpOptions & {
	powBits?: number;
}>;

export type ResolveNodeAccountOptions = Readonly<{
	readonly requireMultisigReady?: boolean;
	readonly requireNodeActivity?: boolean;
}>;

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function extractErrorMessage(body: unknown): string {
	if (isObject(body) && "error" in body) {
		return String(body.error);
	}
	return "Unknown error";
}

function extractErrorCode(body: unknown): string | null {
	if (isObject(body) && "code" in body && typeof body.code === "string") {
		return body.code;
	}
	return null;
}

function buildUrl(baseUrl: string, path: string): string {
	return new URL(path, baseUrl).toString();
}

function assertOptionalBoolean(value: unknown, field: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		throw new Error(`Protocol status malformed: ${field} must be boolean when present`);
	}
	return value;
}

export function resolveNodeAccountFromStatus(
	raw: unknown,
	options: ResolveNodeAccountOptions = {},
): string {
	if (!isObject(raw)) {
		throw new Error("Protocol status malformed: not an object");
	}

	const nodeAccount = raw.nodeAccount;
	if (typeof nodeAccount !== "string") {
		throw new Error("Protocol status malformed: nodeAccount must be string");
	}

	const usernameError = validateHiveUsername(nodeAccount);
	if (usernameError) {
		throw new Error(`Protocol status malformed: invalid nodeAccount '${nodeAccount}': ${usernameError}`);
	}

	if (options.requireMultisigReady) {
		const multisigEnabled = assertOptionalBoolean(raw.multisigEnabled, "multisigEnabled");
		const multisigSignerReady = assertOptionalBoolean(raw.multisigSignerReady, "multisigSignerReady");
		const multisigClockDriftOk = assertOptionalBoolean(raw.multisigClockDriftOk, "multisigClockDriftOk");

		if (multisigEnabled !== true) {
			throw new Error(`Indexer node '${nodeAccount}' does not have multisig enabled`);
		}
		if (multisigSignerReady !== true) {
			throw new Error(`Indexer node '${nodeAccount}' multisig signer is not ready`);
		}
		if (multisigClockDriftOk === false) {
			throw new Error(`Indexer node '${nodeAccount}' multisig clock drift check failed`);
		}
	}
	if (options.requireNodeActivity) {
		const nodeRegistered = assertOptionalBoolean(raw.nodeRegistered, "nodeRegistered");
		const nodeActivityFresh = assertOptionalBoolean(raw.nodeActivityFresh, "nodeActivityFresh");

		if (nodeRegistered !== true) {
			throw new Error(`Indexer node '${nodeAccount}' is not registered in l2_nodes`);
		}
		if (nodeActivityFresh !== true) {
			throw new Error(`Indexer node '${nodeAccount}' has no fresh settlement heartbeat`);
		}
	}

	return nodeAccount;
}

export async function fetchNodeAccount(
	indexerUrl: string,
	options: ResolveNodeAccountOptions = {},
	http?: HttpOptions,
): Promise<string> {
	const url = buildUrl(indexerUrl, "/api/status");
	const fetchImpl = resolveFetch(http);
	let res: Response;
	try {
		res = await fetchImpl(url, { headers: http?.headers, signal: http?.signal });
	} catch (error) {
		throw handleFetchError({ error, url });
	}
	if (!res.ok) {
		const bodyText = await res.text();
		const parsed = safeJsonParse(bodyText);
		throw new IndexerError({
			message: `Protocol status failed (${res.status}): ${extractErrorMessage(parsed)}`,
			url,
			statusCode: res.status,
			responseHeaders: headersToRecord(res.headers),
			responseBody: bodyText,
			data: parsed,
		});
	}

	const raw: unknown = await res.json();
	return resolveNodeAccountFromStatus(raw, options);
}

export function fetchMultisigNodeAccount(
	indexerUrl: string,
	http?: HttpOptions,
): Promise<string> {
	return fetchNodeAccount(indexerUrl, { requireMultisigReady: true, requireNodeActivity: true }, http);
}

const PAYMENT_INFO_STRING_FIELDS = [
	"nftId",
	"listingId",
	"listTxId",
	"seller",
	"currency",
	"feeAccount",
	"nodeAccount",
	"txId",
] as const;

const PAYMENT_INFO_NUMBER_FIELDS = [
	"totalPrice",
	"sellerAmount",
	"royaltyAmount",
	"feeAmount",
] as const;

function assertPaymentInfo(raw: unknown): asserts raw is PaymentInfo {
	if (!isObject(raw)) {
		throw new Error("Payment info malformed: not an object");
	}
	const r = raw;
	for (const k of PAYMENT_INFO_STRING_FIELDS) {
		if (typeof r[k] !== "string") {
			throw new Error(`Payment info malformed: ${k} must be string`);
		}
	}
	for (const k of PAYMENT_INFO_NUMBER_FIELDS) {
		if (typeof r[k] !== "number" || !Number.isFinite(r[k])) {
			throw new Error(`Payment info malformed: ${k} must be finite number`);
		}
	}
	if (r.royaltyRecipient !== null && typeof r.royaltyRecipient !== "string") {
		throw new Error("Payment info malformed: royaltyRecipient must be string|null");
	}
	if (r.seedTxId !== null && typeof r.seedTxId !== "string") {
		throw new Error("Payment info malformed: seedTxId must be string|null");
	}
}

function assertMultisigResponse(raw: unknown): asserts raw is MultisigResponse {
	if (!isObject(raw)) {
		throw new Error("Multisig response malformed: not an object");
	}
	const r = raw;
	if (typeof r.ok !== "boolean") {
		throw new Error("Multisig response malformed: ok must be boolean");
	}
	if (r.ok === true) {
		if (typeof r.signature !== "string") {
			throw new Error("Multisig response malformed: signature required on ok:true");
		}
		if (typeof r.digest !== "string") {
			throw new Error("Multisig response malformed: digest required on ok:true");
		}
		if (typeof r.expiration !== "string") {
			throw new Error("Multisig response malformed: expiration required on ok:true");
		}
	} else {
		if (typeof r.code !== "string") {
			throw new Error("Multisig response malformed: code required on ok:false");
		}
		if (typeof r.message !== "string") {
			throw new Error("Multisig response malformed: message required on ok:false");
		}
	}
}

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * Fetch payment split info from an indexer node.
 * Used by the client to build the buy transaction with correct
 * seller/royalty/fee splits before requesting multisig signing.
 */
export async function fetchPaymentInfo(
	indexerUrl: string,
	nftId: string,
	http?: HttpOptions,
): Promise<PaymentInfo> {
	const url = buildUrl(indexerUrl, `/api/payment-info/${encodeURIComponent(nftId)}`);
	const fetchImpl = resolveFetch(http);
	let res: Response;
	try {
		res = await fetchImpl(url, { headers: http?.headers, signal: http?.signal });
	} catch (error) {
		throw handleFetchError({ error, url });
	}
	if (!res.ok) {
		const bodyText = await res.text();
		const parsed = safeJsonParse(bodyText);
		throw new IndexerError({
			message: `Payment info failed (${res.status}): ${extractErrorMessage(parsed)}`,
			url,
			statusCode: res.status,
			responseHeaders: headersToRecord(res.headers),
			responseBody: bodyText,
			data: parsed,
		});
	}
	const raw: unknown = await res.json();
	assertPaymentInfo(raw);
	return raw;
}

/**
 * Shared multisig POST core — POW-protected, schema-validated.
 * Endpoint-agnostic: wrappers below supply the URL and request type.
 */
async function postMultisig(
	url: string,
	request: unknown,
	options: RequestMultisigOptions,
): Promise<MultisigResponse> {
	const powToken = await solveMultisigPow(request, options.powBits);
	const fetchImpl = resolveFetch(options);
	const headers = mergeHeaders(
		{ "Content-Type": "application/json", [NFTLOX_POW_HEADER]: powToken },
		options.headers,
	);
	let res: Response;
	try {
		res = await fetchImpl(url, {
			method: "POST",
			headers,
			body: JSON.stringify(request),
			signal: options.signal,
		});
	} catch (error) {
		throw handleFetchError({ error, url, requestBodyValues: request });
	}
	if (!res.ok) {
		const bodyText = await res.text();
		const parsed = safeJsonParse(bodyText);
		throw new MultisigError({
			message: `Multisig request failed (${res.status}): ${extractErrorMessage(parsed)}`,
			url,
			requestBodyValues: request,
			statusCode: res.status,
			responseHeaders: headersToRecord(res.headers),
			responseBody: bodyText,
			data: parsed,
			code: extractErrorCode(parsed),
		});
	}
	const raw: unknown = await res.json();
	assertMultisigResponse(raw);
	return raw;
}

/**
 * Request a node-last buy settlement.
 *
 * The caller provides a transaction that already carries the buyer's active
 * signature. The node then:
 *   1. Validates the buyer's tx against the current listing.
 *   2. Broadcasts a `buy_commitment` custom_json on-chain reserving the NFT.
 *   3. Waits for its commitment to land in a Hive block and observes whether
 *      it won the cross-node ordering race.
 *   4. Appends its own active signature and broadcasts the completed buy.
 *   5. Returns `{ txId, commitmentOpTxId }` to the caller.
 *
 * On a lost race or any failure the node releases its local lock and returns
 * a typed error (`CROSS_NODE_RESERVATION`, `COMMITMENT_INCLUSION_TIMEOUT`,
 * `BUYER_SIGNATURE_MISSING`, etc.) so clients can retry or surface to the user.
 *
	 * The unsigned transaction's `expiration` field MUST fall inside
	 * `[MULTISIG_TX_MIN_EXPIRATION_MS, MULTISIG_TX_MAX_EXPIRATION_MS]`.
	 * `RECOMMENDED_BUY_TX_EXPIRATION_MS` is the default and equals MAX: it
	 * covers PoW + Keychain + the node's irreversible-observation wait before
	 * final broadcast. Callers wanting a tighter profile may pass any value down
	 * to `MULTISIG_TX_MIN_EXPIRATION_MS`.
	 */
export async function requestBuyMultisig(
	indexerUrl: string,
	request: BuyMultisigRequest,
	options: RequestMultisigOptions = {},
): Promise<BuyMultisigResponse> {
	return postBuyMultisig(buildUrl(indexerUrl, "/api/multisig/buy"), request, options);
}

async function postBuyMultisig(
	url: string,
	request: unknown,
	options: RequestMultisigOptions,
): Promise<BuyMultisigResponse> {
	const powToken = await solveMultisigPow(request, options.powBits);
	const fetchImpl = resolveFetch(options);
	const headers = mergeHeaders(
		{ "Content-Type": "application/json", [NFTLOX_POW_HEADER]: powToken },
		options.headers,
	);
	let res: Response;
	try {
		res = await fetchImpl(url, {
			method: "POST",
			headers,
			body: JSON.stringify(request),
			signal: options.signal,
		});
	} catch (error) {
		throw handleFetchError({ error, url, requestBodyValues: request });
	}
	if (!res.ok) {
		const bodyText = await res.text();
		const parsed = safeJsonParse(bodyText);
		throw new MultisigError({
			message: `Buy multisig request failed (${res.status}): ${extractErrorMessage(parsed)}`,
			url,
			requestBodyValues: request,
			statusCode: res.status,
			responseHeaders: headersToRecord(res.headers),
			responseBody: bodyText,
			data: parsed,
			code: extractErrorCode(parsed),
		});
	}
	const raw: unknown = await res.json();
	assertBuyMultisigResponse(raw);
	return raw;
}

function assertBuyMultisigResponse(raw: unknown): asserts raw is BuyMultisigResponse {
	if (!isObject(raw) || typeof raw.ok !== "boolean") {
		throw new Error("Buy multisig response malformed: missing ok flag");
	}
	if (raw.ok === true) {
		if (typeof raw.txId !== "string" || typeof raw.commitmentOpTxId !== "string") {
			throw new Error("Buy multisig response malformed: missing txId or commitmentOpTxId");
		}
		return;
	}
	if (typeof raw.code !== "string" || typeof raw.message !== "string") {
		throw new Error("Buy multisig response malformed: missing code or message");
	}
	if (raw.commitmentOpTxId !== undefined && typeof raw.commitmentOpTxId !== "string") {
		throw new Error("Buy multisig response malformed: commitmentOpTxId must be a string");
	}
}

/**
 * Request multisig signing for a CREATE_COLLECTION transaction.
 * Validates the fee transfer + create_collection payload, then co-signs the
 * custom_json with the node's active key. The creator is derived from the
 * embedded `transaction.operations[0][1].from` (the fee transfer sender);
 * no separate creator field is required on the request body.
 */
export async function requestCreateCollectionMultisig(
	indexerUrl: string,
	request: CreateCollectionMultisigRequest,
	options: RequestMultisigOptions = {},
): Promise<MultisigResponse> {
	return postMultisig(buildUrl(indexerUrl, "/api/multisig/collection"), request, options);
}
