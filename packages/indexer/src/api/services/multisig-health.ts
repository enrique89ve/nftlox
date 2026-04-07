import { checkClockDrift } from "@/scanner/hive-client.ts";
import { isBeekeeperReady } from "@/api/services/beekeeper-signer.ts";

const MULTISIG_HEALTH_POLL_INTERVAL_MS = 15_000;

type DisabledReason = "signer_unavailable" | "clock_drift" | null;

type MultisigHealthState = {
	clockDriftOk: boolean;
	clockDriftMs: number | null;
	lastCheckedAt: number | null;
};

const state: MultisigHealthState = {
	clockDriftOk: true,
	clockDriftMs: null,
	lastCheckedAt: null,
};

let pollTimer: ReturnType<typeof setInterval> | null = null;

function toClockDriftMs(driftMs: number): number | null {
	return driftMs >= 0 ? driftMs : null;
}

export type MultisigHealth = Readonly<{
	multisigEnabled: boolean;
	multisigSignerReady: boolean;
	multisigClockDriftOk: boolean;
	multisigClockDriftMs: number | null;
	multisigLastCheckedAt: number | null;
	disabledReason: DisabledReason;
}>;

export async function refreshMultisigHealth(): Promise<MultisigHealth> {
	const result = await checkClockDrift();
	state.clockDriftOk = result.ok;
	state.clockDriftMs = toClockDriftMs(result.driftMs);
	state.lastCheckedAt = Date.now();
	return getMultisigHealth();
}

export async function startMultisigHealthMonitor(): Promise<void> {
	await refreshMultisigHealth();
	if (pollTimer !== null) {
		return;
	}

	pollTimer = setInterval(() => {
		void refreshMultisigHealth();
	}, MULTISIG_HEALTH_POLL_INTERVAL_MS);
	pollTimer.unref();
}

export function stopMultisigHealthMonitor(): void {
	if (pollTimer !== null) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}

export function getMultisigHealth(): MultisigHealth {
	const multisigSignerReady = isBeekeeperReady();
	const multisigClockDriftOk = state.clockDriftOk;
	const disabledReason: DisabledReason = !multisigSignerReady
		? "signer_unavailable"
		: !multisigClockDriftOk
			? "clock_drift"
			: null;

	return {
		multisigEnabled: multisigSignerReady && multisigClockDriftOk,
		multisigSignerReady,
		multisigClockDriftOk,
		multisigClockDriftMs: state.clockDriftMs,
		multisigLastCheckedAt: state.lastCheckedAt,
		disabledReason,
	};
}
