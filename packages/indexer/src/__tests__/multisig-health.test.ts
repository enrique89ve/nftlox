import { afterEach, describe, expect, mock, test } from "bun:test";

const mockCheckClockDrift = mock(() => Promise.resolve({ ok: true, driftMs: 1200 }));
let signerReady = true;

mock.module("@/scanner/hive-client.ts", () => ({
	checkClockDrift: mockCheckClockDrift,
	getBlockchainHead: () => Promise.resolve({ headBlock: 0, irreversibleBlock: 0 }),
}));

mock.module("@/api/services/beekeeper-signer.ts", () => ({
	isBeekeeperReady: () => signerReady,
}));

const {
	getMultisigHealth,
	refreshMultisigHealth,
	stopMultisigHealthMonitor,
} = await import("@/api/services/multisig-health.ts");

describe("multisig health", () => {
	afterEach(() => {
		stopMultisigHealthMonitor();
		signerReady = true;
		mockCheckClockDrift.mockReset();
		mockCheckClockDrift.mockImplementation(() => Promise.resolve({ ok: true, driftMs: 1200 }));
	});

	test("enables multisig when signer is ready and clock drift is acceptable", async () => {
		await refreshMultisigHealth();

		expect(getMultisigHealth()).toEqual({
			multisigEnabled: true,
			multisigSignerReady: true,
			multisigClockDriftOk: true,
			multisigClockDriftMs: 1200,
			multisigLastCheckedAt: expect.any(Number),
			disabledReason: null,
		});
	});

	test("disables multisig when clock drift exceeds the threshold", async () => {
		mockCheckClockDrift.mockImplementation(() => Promise.resolve({ ok: false, driftMs: 20_000 }));
		await refreshMultisigHealth();

		expect(getMultisigHealth()).toEqual({
			multisigEnabled: false,
			multisigSignerReady: true,
			multisigClockDriftOk: false,
			multisigClockDriftMs: 20_000,
			multisigLastCheckedAt: expect.any(Number),
			disabledReason: "clock_drift",
		});
	});

	test("disables multisig when signer is not initialized", async () => {
		signerReady = false;
		await refreshMultisigHealth();

		expect(getMultisigHealth()).toEqual({
			multisigEnabled: false,
			multisigSignerReady: false,
			multisigClockDriftOk: true,
			multisigClockDriftMs: 1200,
			multisigLastCheckedAt: expect.any(Number),
			disabledReason: "signer_unavailable",
		});
	});

	test("reports null clock drift when the drift check cannot measure it", async () => {
		mockCheckClockDrift.mockImplementation(() => Promise.resolve({ ok: true, driftMs: -1 }));
		await refreshMultisigHealth();

		expect(getMultisigHealth()).toEqual({
			multisigEnabled: true,
			multisigSignerReady: true,
			multisigClockDriftOk: true,
			multisigClockDriftMs: null,
			multisigLastCheckedAt: expect.any(Number),
			disabledReason: null,
		});
	});
});
