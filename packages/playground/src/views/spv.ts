// SPV Verification view
import { $, escapeHtml, log } from "../shared/dom";
import type {
	OnChainVerificationResult,
	OwnershipVerificationResult,
	PackOpenVerificationResult,
	VerificationStatus,
} from "nftlox-sdk";

type SpvResult = OwnershipVerificationResult | OnChainVerificationResult | PackOpenVerificationResult;

interface ErrorResponse {
	error: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const VALID_STATUSES = new Set<VerificationStatus>(["verified", "mismatch", "error", "not_found"]);

const isVerificationStatus = (value: unknown): value is VerificationStatus =>
	typeof value === "string" && VALID_STATUSES.has(value as VerificationStatus);

const isErrorResponse = (value: unknown): value is ErrorResponse =>
	isRecord(value) && typeof value.error === "string";

const isSpvResult = (value: unknown): value is SpvResult =>
	isRecord(value) && isVerificationStatus(value.status) && typeof value.message === "string";

const getDurationMs = (result: SpvResult): number | null => {
	if (!("durationMs" in result)) return null;
	return typeof result.durationMs === "number" ? result.durationMs : null;
};

export function initSpv() {
	$("btn-verify-ownership")?.addEventListener("click", verifyOwnership);
	$("btn-verify-on-chain")?.addEventListener("click", verifyOnChain);
	$("btn-verify-pack-open")?.addEventListener("click", verifyPackOpen);
}

function renderResult(containerId: string, result: SpvResult) {
	const container = $(containerId);
	if (!container) return;

	const statusColors: Record<VerificationStatus, string> = {
		verified: "var(--accent)",
		mismatch: "var(--error)",
		error: "var(--warning)",
		not_found: "var(--text-dim)",
	};

	const statusLabels: Record<VerificationStatus, string> = {
		verified: "VERIFIED",
		mismatch: "MISMATCH",
		error: "ERROR",
		not_found: "NOT FOUND",
	};

	const color = statusColors[result.status];
	const label = statusLabels[result.status];
	const message = escapeHtml(result.message || "");
	const rawResult = escapeHtml(JSON.stringify(result, null, 2));
	const durationMs = getDurationMs(result);

	container.style.display = "block";
	container.innerHTML = `
		<div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
			<span style="background: ${color}; color: var(--bg); padding: 4px 12px; border-radius: 4px; font-weight: 600; font-size: 13px;">${label}</span>
			<span style="color: var(--text-muted); font-size: 13px;">${message}</span>
		</div>
		${durationMs !== null ? `<div style="font-size: 12px; color: var(--text-dim); margin-bottom: 12px;">Completed in ${durationMs}ms</div>` : ""}
		<details>
			<summary style="cursor: pointer; color: var(--text-muted); font-size: 13px;">Raw Result</summary>
			<pre style="background: var(--bg); padding: 12px; border-radius: 6px; font-size: 12px; overflow-x: auto; margin-top: 8px;">${rawResult}</pre>
		</details>
	`;
}

async function verifyOwnership() {
	const nftId = ($("spv-ownership-nft") as HTMLInputElement)?.value.trim();
	const expectedOwner = ($("spv-ownership-owner") as HTMLInputElement)?.value.trim().toLowerCase();

	if (!nftId || !expectedOwner) {
		log("Fill NFT ID and expected owner", "error");
		return;
	}

	log("Verifying ownership against Hive L1...");

	try {
		const response = await fetch("/api/spv/verify-ownership", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ nftId, expectedOwner }),
		});
		const result: unknown = await response.json();

		if (isErrorResponse(result)) {
			log(`Error: ${result.error}`, "error");
			return;
		}

		if (!isSpvResult(result)) {
			log("Unexpected ownership verification response shape", "error");
			return;
		}

		renderResult("spv-ownership-result", result);
		log(`Ownership verification: ${result.status}`, result.status === "verified" ? "success" : "error");
	} catch (e) {
		log(`Error: ${(e as Error).message}`, "error");
	}
}

async function verifyOnChain() {
	const txId = ($("spv-onchain-txid") as HTMLInputElement)?.value.trim();
	const blockNum = parseInt(($("spv-onchain-block") as HTMLInputElement)?.value || "0", 10);
	const expectedAction = ($("spv-onchain-action") as HTMLInputElement)?.value.trim();
	const expectedSigner = ($("spv-onchain-signer") as HTMLInputElement)?.value.trim().toLowerCase();

	if (!txId) {
		log("Enter a transaction ID", "error");
		return;
	}

	log("Verifying operation on Hive L1...");

	try {
		const response = await fetch("/api/spv/verify-on-chain", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ txId, blockNum, expectedAction, expectedSigner }),
		});
		const result: unknown = await response.json();

		if (isErrorResponse(result)) {
			log(`Error: ${result.error}`, "error");
			return;
		}

		if (!isSpvResult(result)) {
			log("Unexpected on-chain verification response shape", "error");
			return;
		}

		renderResult("spv-onchain-result", result);
		log(`On-chain verification: ${result.status}`, result.status === "verified" ? "success" : "error");
	} catch (e) {
		log(`Error: ${(e as Error).message}`, "error");
	}
}

async function verifyPackOpen() {
	const txId = ($("spv-pack-txid") as HTMLInputElement)?.value.trim();
	const blockNum = parseInt(($("spv-pack-block") as HTMLInputElement)?.value || "0", 10);

	if (!txId || !blockNum) {
		log("Enter transaction ID and block number", "error");
		return;
	}

	log("Verifying pack open against Hive L1...");

	try {
		const response = await fetch("/api/spv/verify-pack-open", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ txId, blockNum }),
		});
		const result: unknown = await response.json();

		if (isErrorResponse(result)) {
			log(`Error: ${result.error}`, "error");
			return;
		}

		if (!isSpvResult(result)) {
			log("Unexpected pack verification response shape", "error");
			return;
		}

		renderResult("spv-pack-result", result);
		log(`Pack open verification: ${result.status}`, result.status === "verified" ? "success" : "error");
	} catch (e) {
		log(`Error: ${(e as Error).message}`, "error");
	}
}
