import { PROTOCOL_ID } from "nftlox-sdk";
import { $, escapeHtml, log } from "../shared/dom";
import { getConnectedUser } from "../shared/state";
import { broadcastOperation } from "../shared/keychain";

const HAFAH_URL = "https://api.hive.blog";
const CUSTOM_JSON_OP_TYPE = 18;
const HAFAH_PAGE_SIZE = 1000;
const HAFAH_MAX_PAGES = 25;
const HAFAH_SCAN_TIMEOUT_MS = 45_000;

type NodeStatusSummary = Readonly<{
  nodeAccount: string;
  nodeUrl: string | null;
  nodeRegistered?: boolean;
  nodeStatus?: string | null;
  nodeRegistrationBlock?: number | null;
  nodeLastHeartbeatBlock?: number | null;
  nodeActivityBlock?: number | null;
  nodeActivityAgeBlocks?: number | null;
  nodeActivityFresh?: boolean;
  multisigEnabled: boolean;
  multisigSignerReady?: boolean;
  multisigClockDriftOk?: boolean;
  multisigClockDriftMs?: number;
  lastBlock: number;
  headBlock: number;
  irreversibleBlock?: number;
  genesisBlock?: number;
  blocksBehind: number;
  inSync: boolean;
}>;

type NodeHeartbeatRecord = Readonly<{
  blockNum: number;
  stateRoot: string;
  indexerVersion: string;
  txId: string;
  createdAt: string;
}>;

type NodeProfile = Readonly<{
  account: string;
  status: "active" | "banned";
  endpoint: string;
  registeredBlock: number;
  registrationTxId: string;
  createdAt: string;
  updatedAt: string;
  lastHeartbeatBlock: number | null;
  activityBlock: number;
  activityAgeBlocks: number;
  activeForSettlement: boolean;
  staleAfterBlocks: number;
  reason: string | null;
  heartbeatCount: number;
  lastHeartbeat: NodeHeartbeatRecord | null;
}>;

type NodePageResponse = Readonly<{
  account?: string;
  status?: NodeStatusSummary;
  profile?: NodeProfile | null;
}>;

type IndexedNodeOperation = Readonly<{
  status: "confirmed" | "invalid";
  txId: string;
  operationId: string | null;
  signer: string | null;
  action: string | null;
  reason: string | null;
  blockNum: number;
  timestamp: string;
  assetIds: ReadonlyArray<string>;
}>;

type IndexedNodeOperationsPage = Readonly<{
  account: string;
  total: number;
  offset: number;
  limit: number;
  operations: ReadonlyArray<IndexedNodeOperation>;
}>;

type HiveNodeOperation = Readonly<{
  txId: string;
  operationId: string;
  blockNum: number;
  timestamp: string;
  signer: string;
  authLevel: "active" | "posting";
  payload: Record<string, unknown> | null;
  rawJson: string;
}>;

type HiveNodeOperationsPage = Readonly<{
  account: string;
  fromBlock: number;
  toBlock: number;
  windowBlocks: number;
  limit: number;
  total: number;
  operations: ReadonlyArray<HiveNodeOperation>;
}>;

type HafAHCustomJsonValue = Readonly<{
  id: string;
  json: string;
  required_auths?: ReadonlyArray<string>;
  required_posting_auths?: ReadonlyArray<string>;
}>;

type HafAHOperation = Readonly<{
  block: number;
  trx_id?: string;
  operation_id?: string | number;
  timestamp?: string;
  op: Readonly<{ type: string; value: HafAHCustomJsonValue }>;
}>;

type HafAHResponse = Readonly<{
  ops?: ReadonlyArray<HafAHOperation>;
  next_operation_begin?: string | null;
}>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isHafAHOperation(v: unknown): v is HafAHOperation {
  if (!isRecord(v)) return false;
  if (typeof v.block !== "number") return false;
  const op = v.op;
  if (!isRecord(op)) return false;
  const value = op.value;
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && typeof value.json === "string";
}

function isHafAHResponse(v: unknown): v is HafAHResponse {
  if (!isRecord(v)) return false;
  if (v.ops !== undefined && !Array.isArray(v.ops)) return false;
  const next = v.next_operation_begin;
  if (next !== undefined && next !== null && typeof next !== "string")
    return false;
  return true;
}

function parsePositiveInt(
  raw: string | null | undefined,
  fallback: number,
): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

type BuildNodeRegisterResponse = Readonly<{
  success?: boolean;
  error?: string;
  errors?: ReadonlyArray<{ message?: string }>;
  operation?: unknown;
  keyType?: "Posting" | "Active";
}>;

let currentNodeAccount: string | null = null;
let currentStatus: NodeStatusSummary | null = null;
let currentProfile: NodeProfile | null = null;
let loadingNode = false;
let scanningHive = false;
let loadingIndexed = false;
let registeringNode = false;

function registrationFeedback(message: string, tone = ""): void {
  const target = $("node-register-feedback");
  if (target) {
    target.textContent = message;
    target.dataset.tone = tone;
  }
}

function registerBusy(busy: boolean): void {
  registeringNode = busy;
  const input = $("node-register-endpoint") as HTMLInputElement | null;
  if (input) input.readOnly = busy;
  const button = $("btn-node-register") as HTMLButtonElement | null;
  if (button) {
    button.disabled = busy || loadingNode || !currentStatus;
    button.textContent = busy ? "Waiting for Keychain…" : "Publish endpoint via Keychain";
  }
}

function shortHash(
  value: string | null | undefined,
  head = 8,
  tail = 6,
): string {
  if (!value) return "-";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function formatNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString()
    : "-";
}

function formatMaybe(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function chip(label: string, tone: "good" | "warn" | "bad" | "" = ""): string {
  const className = tone ? `node-chip ${tone}` : "node-chip";
  return `<span class="${className}">${escapeHtml(label)}</span>`;
}

function renderSummary(
  status: NodeStatusSummary | null,
  profile: NodeProfile | null,
): void {
  const container = $("node-summary");
  if (!container) return;

  const identity = $("node-account");
  const message = $("node-status-message");
  if (identity) identity.textContent = status ? `@${status.nodeAccount}` : "Node unavailable";
  if (message) message.textContent = !status
    ? "Could not read node status. Check the indexer connection, then refresh status to retry."
    : status.nodeRegistered === false
      ? "This node is not registered. Publish its endpoint below, then refresh to verify the indexed registration."
      : !status.inSync
        ? "The indexer is catching up. Check the block gap before relying on its latest results."
        : profile && !profile.activeForSettlement
          ? `The registry reports this node as ineligible for settlement. ${profile.reason ?? "Inspect the node evidence for registration and heartbeat details."}`
          : !profile
            ? "Sync status is available, but registry evidence is missing. Settlement eligibility remains unknown."
            : "Registry evidence is available. Inspect signer availability separately and compare indexed activity with Hive when needed.";

  const metrics = [
    ["Registry", status?.nodeRegistered === true ? "Registered" : status?.nodeRegistered === false ? "Not registered" : "Unknown",
      status?.nodeStatus ?? "On-chain registration"],
    ["Settlement eligibility", profile ? (profile.activeForSettlement ? "Eligible" : "Not eligible") : "Unknown",
      profile?.reason ?? (profile ? "Reported by the node registry" : "Registry evidence unavailable")],
    ["Indexer sync", status ? (status.inSync ? "In sync" : "Catching up") : "Unknown",
      status ? `${formatNumber(status.blocksBehind)} blocks behind · head ${formatNumber(status.headBlock)}` : "Sync evidence unavailable"],
    ["Multisig signer", !status ? "Unknown" : !status.multisigEnabled ? "Disabled" : status.multisigSignerReady === true ? "Ready" : status.multisigSignerReady === false ? "Unavailable" : "Unknown",
      !status ? "Signer evidence unavailable" : status.multisigClockDriftOk === false ? "Clock drift requires attention" : "Signer state is separate from registry eligibility"],
  ];
  container.innerHTML = metrics.map(([label, value, note]) => `
    <div class="stat-box"><div class="stat-label">${escapeHtml(label)}</div>
    <div class="stat-value">${escapeHtml(value)}</div>
    <p class="node-stat-note">${escapeHtml(note)}</p></div>
  `).join("");
}

function renderProfile(
  status: NodeStatusSummary | null,
  profile: NodeProfile | null,
): void {
  const container = $("node-profile-grid");
  if (!container) return;

  if (!status) {
    container.innerHTML = `
			<div class="node-kv">
				<div class="node-kv-label">Node</div>
				<div class="node-kv-value">Status unavailable</div>
			</div>
		`;
    return;
  }

  const profileRows = [
    ["Node account", status.nodeAccount],
    ["Endpoint", profile?.endpoint ?? status.nodeUrl ?? "-"],
    ["Registry status", profile?.status ?? status.nodeStatus ?? "-"],
    ["Registered", status.nodeRegistered === true ? "yes" : status.nodeRegistered === false ? "no" : "unknown"],
    [
      "Registration block",
      formatMaybe(profile?.registeredBlock ?? status.nodeRegistrationBlock),
    ],
    ["Registration tx", shortHash(profile?.registrationTxId)],
    [
      "Last heartbeat block",
      formatMaybe(profile?.lastHeartbeatBlock ?? status.nodeLastHeartbeatBlock),
    ],
    ["Heartbeat count", formatMaybe(profile?.heartbeatCount)],
    [
      "Activity block",
      formatMaybe(profile?.activityBlock ?? status.nodeActivityBlock),
    ],
    [
      "Activity age",
      status.nodeActivityAgeBlocks != null
        ? `${formatNumber(status.nodeActivityAgeBlocks)} blocks`
        : "-",
    ],
    [
      "Settlement reason",
      profile?.reason ?? "Not reported",
    ],
    ["Sync last block", formatNumber(status.lastBlock)],
    ["Irreversible block", formatMaybe(status.irreversibleBlock)],
    ["Blocks behind", formatNumber(status.blocksBehind)],
    ["Multisig signer", status.multisigSignerReady === true ? "ready" : status.multisigSignerReady === false ? "unavailable" : "unknown"],
    [
      "Clock drift",
      status.multisigClockDriftMs != null
        ? `${status.multisigClockDriftMs} ms`
        : "-",
    ],
    ["Last heartbeat tx", shortHash(profile?.lastHeartbeat?.txId)],
  ];

  container.innerHTML = profileRows
    .map(
      ([label, value]) => `
		<div class="node-kv">
			<div class="node-kv-label">${escapeHtml(label)}</div>
			<div class="node-kv-value">${escapeHtml(String(value))}</div>
		</div>
	`,
    )
    .join("");

  updateRegisterForm(status, profile);
}

function updateRegisterForm(
  status: NodeStatusSummary,
  profile: NodeProfile | null,
): void {
  const endpointInput = $("node-register-endpoint") as HTMLInputElement | null;
  const note = $("node-register-note");
  if (endpointInput && !endpointInput.matches(":focus") && !endpointInput.dataset.edited)
    endpointInput.value = profile?.endpoint ?? status.nodeUrl ?? "";
  registerBusy(registeringNode);

  const connectedUser = getConnectedUser();
  const sameUser = Boolean(
    connectedUser && connectedUser === status.nodeAccount.toLowerCase(),
  );

  if (note) {
    const message = sameUser
      ? `Connected as @${status.nodeAccount}. Broadcasting node_register will use your Posting key.`
      : `Connect @${status.nodeAccount} in Keychain to broadcast node_register for this node.`;
    note.innerHTML = escapeHtml(message);
  }
}

function renderIndexedMeta(page: IndexedNodeOperationsPage): void {
  const container = $("node-indexed-meta");
  if (!container) return;
  const invalidCount = page.operations.filter(
    (op) => op.status === "invalid",
  ).length;
  container.innerHTML = [
    chip(`total ${page.total}`),
    chip(`confirmed ${page.operations.length - invalidCount}`, "good"),
    chip(`invalid ${invalidCount}`, invalidCount > 0 ? "warn" : ""),
  ].join("");
}

function renderIndexedOperations(page: IndexedNodeOperationsPage): void {
  const container = $("node-indexed-operations");
  if (!container) return;
  renderIndexedMeta(page);

  if (page.operations.length === 0) {
    container.innerHTML =
      '<div class="empty-state"><p class="empty-state-text">No indexed protocol operations for this node yet.</p></div>';
    return;
  }

  container.innerHTML = `
		<table class="data-table">
			<thead>
				<tr>
					<th>Status</th>
					<th>Action</th>
					<th>Block</th>
					<th>Tx</th>
					<th>Time</th>
					<th>Details</th>
				</tr>
			</thead>
			<tbody>
				${page.operations
          .map(
            (op) => `
					<tr>
						<td>${chip(op.status, op.status === "confirmed" ? "good" : "warn")}</td>
						<td><span class="node-code">${escapeHtml(op.action ?? "-")}</span></td>
						<td>${escapeHtml(formatNumber(op.blockNum))}</td>
						<td><span class="node-code" title="${escapeHtml(op.txId)}">${escapeHtml(shortHash(op.txId))}</span></td>
						<td>${escapeHtml(op.timestamp)}</td>
						<td>
							<details>
								<summary class="node-detail-toggle">View</summary>
								<div class="node-detail-body">${escapeHtml(op.reason ?? (op.assetIds.length > 0 ? `Asset ids: ${op.assetIds.join(", ")}` : "No extra details"))}</div>
							</details>
						</td>
					</tr>
				`,
          )
          .join("")}
			</tbody>
		</table>
	`;
}

function renderHiveMeta(page: HiveNodeOperationsPage): void {
  const container = $("node-hive-meta");
  if (!container) return;
  container.innerHTML = [
    chip(`blocks ${page.fromBlock}..${page.toBlock}`),
    chip(`total ${page.total}`),
  ].join("");
}

function renderHiveOperations(page: HiveNodeOperationsPage): void {
  const container = $("node-hive-operations");
  if (!container) return;
  renderHiveMeta(page);

  if (page.operations.length === 0) {
    container.innerHTML =
      '<div class="empty-state"><p class="empty-state-text">No recent Hive protocol operations signed by this node in the selected block window.</p></div>';
    return;
  }

  container.innerHTML = `
		<table class="data-table">
			<thead>
				<tr>
					<th>Block</th>
					<th>Tx</th>
					<th>Auth</th>
					<th>Signer</th>
					<th>Payload</th>
				</tr>
			</thead>
			<tbody>
				${page.operations
          .map((op) => {
            const details = op.payload
              ? JSON.stringify(op.payload, null, 2)
              : op.rawJson;
            return `
						<tr>
							<td>${escapeHtml(formatNumber(op.blockNum))}</td>
							<td><span class="node-code" title="${escapeHtml(op.txId)}">${escapeHtml(shortHash(op.txId))}</span></td>
							<td>${chip(op.authLevel, op.authLevel === "active" ? "warn" : "good")}</td>
							<td><span class="node-code">${escapeHtml(op.signer)}</span></td>
							<td>
								<details>
									<summary class="node-detail-toggle">View</summary>
									<div class="node-detail-body">${escapeHtml(details)}</div>
								</details>
							</td>
						</tr>
					`;
          })
          .join("")}
			</tbody>
		</table>
	`;
}

async function loadIndexedOperations(): Promise<void> {
  const container = $("node-indexed-operations");
  if (!container || !currentNodeAccount || loadingIndexed) return;
  loadingIndexed = true;
  const reload = $("btn-node-refresh-operations") as HTMLButtonElement | null;
  if (reload) reload.disabled = true;
  if ($("node-indexed-meta")) $("node-indexed-meta")!.textContent = "";
  container.innerHTML =
    '<div class="empty-state"><p class="empty-state-text">Loading indexed node operations...</p></div>';

  try {
    const response = await fetch("/api/node/operations?limit=50&offset=0", { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Indexer HTTP ${response.status}`);
    const page = (await response.json()) as IndexedNodeOperationsPage;
    renderIndexedOperations(page);
  } catch (error) {
    container.innerHTML =
      '<div class="empty-state"><p class="empty-state-text">Failed to load indexed node operations.</p></div>';
    log(`Node indexed operations failed: ${(error as Error).message}`, "error");
  } finally {
    loadingIndexed = false;
    if (reload) reload.disabled = false;
  }
}

function sortHiveOperationsDescending(
  a: HiveNodeOperation,
  b: HiveNodeOperation,
): number {
  if (a.blockNum !== b.blockNum) return b.blockNum - a.blockNum;
  if (a.timestamp !== b.timestamp)
    return b.timestamp.localeCompare(a.timestamp);
  return b.operationId.localeCompare(a.operationId, undefined, {
    numeric: true,
  });
}

function matchHafAHOperation(
  raw: unknown,
  account: string,
): HiveNodeOperation | null {
  if (!isHafAHOperation(raw)) return null;
  const value = raw.op.value;
  if (value.id !== PROTOCOL_ID) return null;

  const activeAuths = value.required_auths ?? [];
  const postingAuths = value.required_posting_auths ?? [];
  const isActive = activeAuths.some((a) => a.toLowerCase() === account);
  const isPosting = postingAuths.some((a) => a.toLowerCase() === account);
  if (!isActive && !isPosting) return null;

  let payload: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(value.json);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    payload = null;
  }

  return {
    txId: raw.trx_id ?? "",
    operationId: String(raw.operation_id ?? ""),
    blockNum: raw.block,
    timestamp: raw.timestamp ?? "",
    signer: account,
    authLevel: isActive ? "active" : "posting",
    payload,
    rawJson: value.json,
  };
}

async function scanHafAH(
  fromBlock: number,
  toBlock: number,
  account: string,
  signal: AbortSignal,
): Promise<HiveNodeOperation[]> {
  const matched: HiveNodeOperation[] = [];
  let operationBegin = "-1";

  for (let page = 0; page < HAFAH_MAX_PAGES; page++) {
    const url =
      `${HAFAH_URL}/hafah-api/operations` +
      `?from-block=${fromBlock}` +
      `&to-block=${toBlock}` +
      `&operation-types=${CUSTOM_JSON_OP_TYPE}` +
      `&page-size=${HAFAH_PAGE_SIZE}` +
      `&operation-begin=${operationBegin}`;

    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(`HafAH HTTP ${response.status}: ${response.statusText}`);
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch (jsonError) {
      const cause =
        jsonError instanceof Error ? jsonError : new Error(String(jsonError));
      throw new Error("HafAH returned non-JSON body", { cause });
    }
    if (!isHafAHResponse(raw)) {
      throw new Error("HafAH returned an unexpected response shape");
    }
    const ops = raw.ops ?? [];
    for (const op of ops) {
      const match = matchHafAHOperation(op, account);
      if (match) matched.push(match);
    }

    const next = raw.next_operation_begin;
    if (
      next === null ||
      next === undefined ||
      next === "0" ||
      next === operationBegin
    )
      break;
    operationBegin = next;
  }

  return matched;
}

async function loadHiveOperations(): Promise<void> {
  const container = $("node-hive-operations");
  if (!container || !currentNodeAccount || !currentStatus || scanningHive) return;
  scanningHive = true;
  const reload = $("btn-node-refresh-hive") as HTMLButtonElement | null;
  if (reload) { reload.disabled = true; reload.textContent = "Scanning…"; }
  if ($("node-hive-meta")) $("node-hive-meta")!.textContent = "";
  container.innerHTML =
    '<div class="empty-state"><p class="empty-state-text">Loading Hive protocol operations...</p></div>';

  const limit = parsePositiveInt(
    ($("node-hive-limit") as HTMLSelectElement | null)?.value,
    25,
  );
  const windowBlocks = parsePositiveInt(
    ($("node-hive-window") as HTMLSelectElement | null)?.value,
    2000,
  );

  const toBlock =
    currentStatus.irreversibleBlock && currentStatus.irreversibleBlock > 0
      ? currentStatus.irreversibleBlock
      : currentStatus.headBlock;
  const genesisBlock = currentStatus.genesisBlock ?? 0;
  const fromBlock = Math.max(genesisBlock, toBlock - windowBlocks + 1);
  const account = currentNodeAccount.toLowerCase();

  try {
    const signal = AbortSignal.timeout(HAFAH_SCAN_TIMEOUT_MS);
    const matched = await scanHafAH(fromBlock, toBlock, account, signal);
    const sorted = matched.slice().sort(sortHiveOperationsDescending);
    const page: HiveNodeOperationsPage = {
      account,
      fromBlock,
      toBlock,
      windowBlocks: toBlock - fromBlock + 1,
      limit,
      total: matched.length,
      operations: sorted.slice(0, limit),
    };
    renderHiveOperations(page);
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    const message =
      cause.name === "TimeoutError"
        ? "Timed out scanning Hive L1. Try a smaller window."
        : "Failed to load Hive protocol operations.";
    container.innerHTML = `<div class="empty-state"><p class="empty-state-text">${escapeHtml(message)}</p></div>`;
    log(`Node Hive operations failed: ${cause.message}`, "error");
  } finally {
    scanningHive = false;
    if (reload) { reload.disabled = false; reload.textContent = "Scan Hive"; }
  }
}

async function registerNode(): Promise<void> {
  if (registeringNode) return;
  const status = currentStatus;
  if (!status) {
    registrationFeedback("Refresh node status before publishing an endpoint.", "error");
    return;
  }

  const connectedUser = getConnectedUser();
  if (!connectedUser) {
    registrationFeedback(`Connect @${status.nodeAccount} in Keychain to publish this endpoint.`, "error");
    return;
  }

  if (connectedUser !== status.nodeAccount.toLowerCase()) {
    registrationFeedback(
      `Connected wallet @${connectedUser} does not match node account @${status.nodeAccount}`,
      "error",
    );
    return;
  }

  const endpoint =
    ($("node-register-endpoint") as HTMLInputElement | null)?.value.trim() ??
    "";

  if (!endpoint) {
    registrationFeedback("Enter the public endpoint URL for this node.", "error");
    return;
  }

  const input = $("node-register-endpoint") as HTMLInputElement | null;
  if (input && !input.reportValidity()) return;
  registerBusy(true);
  registrationFeedback("Preparing the operation. Review and approve it in Keychain.");
  try {
    const response = await fetch("/api/build/node-register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodeAccount: status.nodeAccount,
        endpoint,
      }),
    });
    if (!response.ok) throw new Error(`Build API HTTP ${response.status}`);
    const result = (await response.json()) as BuildNodeRegisterResponse;
    if (!result.success || !result.operation) {
      const firstError = result.errors?.[0]?.message;
      registerBusy(false);
      registrationFeedback(
        `node_register preview failed: ${result.error || firstError || "Unknown error"}`,
        "error",
      );
      return;
    }

    broadcastOperation(
      status.nodeAccount,
      [result.operation],
      result.keyType ?? "Posting",
      (res) => {
        const txId =
          typeof res?.result?.id === "string"
            ? res.result.id
            : typeof res?.result?.tx_id === "string"
              ? res.result.tx_id
              : "pending";
        registerBusy(false);
        registrationFeedback(`Broadcast sent: ${txId}. Waiting for indexer confirmation; refresh status to verify registration.`, "success");
        log(`node_register broadcast: ${txId}`, "success");
        setTimeout(() => {
          void loadNodeView(true);
        }, 4000);
      },
      (err) => {
        registerBusy(false);
        registrationFeedback(`Registration was not completed: ${err}. You can try again.`, "error");
        log(`node_register failed: ${err}`, "error");
      },
    );
  } catch (error) {
    registerBusy(false);
    registrationFeedback(`Registration failed: ${(error as Error).message}. Try again.`, "error");
    log(`node_register failed: ${(error as Error).message}`, "error");
  }
}

export async function loadNodeView(logSuccess = false): Promise<void> {
  const summary = $("node-summary");
  const profileGrid = $("node-profile-grid");
  const indexedMeta = $("node-indexed-meta");
  const hiveMeta = $("node-hive-meta");
  const indexedOperations = $("node-indexed-operations");
  const hiveOperations = $("node-hive-operations");
  if (!summary || !profileGrid || loadingNode) return;
  loadingNode = true;
  registerBusy(registeringNode);
  const refresh = $("btn-node-refresh") as HTMLButtonElement | null;
  if (refresh) { refresh.disabled = true; refresh.textContent = "Refreshing…"; }
  if ($("node-status-message")) $("node-status-message")!.textContent = "Fetching the latest node status…";

  try {
    const response = await fetch("/api/node", { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Indexer HTTP ${response.status}`);
    const data = (await response.json()) as NodePageResponse;
    currentNodeAccount = data.account ?? null;
    currentStatus = data.status ?? null;
    currentProfile = data.profile ?? null;

    renderSummary(currentStatus, currentProfile);
    renderProfile(currentStatus, currentProfile);

    if (currentNodeAccount) {
      await loadIndexedOperations();
    } else {
      if (indexedMeta) indexedMeta.innerHTML = "";
      if (hiveMeta) hiveMeta.innerHTML = "";
      if (indexedOperations) {
        indexedOperations.innerHTML =
          '<div class="empty-state"><p class="empty-state-text">Indexer node account unavailable.</p></div>';
      }
      if (hiveOperations) {
        hiveOperations.innerHTML =
          '<div class="empty-state"><p class="empty-state-text">Indexer node account unavailable.</p></div>';
      }
    }

    if (logSuccess && currentNodeAccount) {
      log(`Node view refreshed for @${currentNodeAccount}`, "success");
    }
  } catch (error) {
    currentNodeAccount = null;
    currentStatus = null;
    currentProfile = null;
    registerBusy(registeringNode);
    renderSummary(null, null);
    renderProfile(null, null);
    if (indexedMeta) indexedMeta.innerHTML = "";
    if (hiveMeta) hiveMeta.innerHTML = "";
    if (indexedOperations) {
      indexedOperations.innerHTML =
        '<div class="empty-state"><p class="empty-state-text">Failed to load node operations.</p></div>';
    }
    if (hiveOperations) {
      hiveOperations.innerHTML =
        '<div class="empty-state"><p class="empty-state-text">Failed to load Hive protocol operations.</p></div>';
    }
    log(`Node view failed: ${(error as Error).message}`, "error");
  } finally {
    loadingNode = false;
    registerBusy(registeringNode);
    if (refresh) { refresh.disabled = false; refresh.textContent = "Refresh status"; }
  }
}

export function initNode(): void {
  $("btn-node-refresh")?.addEventListener("click", () => {
    void loadNodeView(true);
  });
  $("btn-node-refresh-operations")?.addEventListener("click", () => {
    void loadIndexedOperations();
  });
  $("btn-node-refresh-hive")?.addEventListener("click", () => {
    void loadHiveOperations();
  });
  $("btn-node-register")?.addEventListener("click", () => {
    void registerNode();
  });
  $("node-register-endpoint")?.addEventListener("input", () => {
    const input = $("node-register-endpoint");
    if (input) input.dataset.edited = "true";
  });
  (window as Window & { loadNodeView?: () => Promise<void> }).loadNodeView =
    () => loadNodeView(false);
}
