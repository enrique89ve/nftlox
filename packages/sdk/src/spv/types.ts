// SPV "Boleto Suizo" - Types
// Trustless verification system for NFTLox pack operations

import type { SupportedCurrency } from "../constants.ts";

// ============ L1 CLIENT CONFIG ============

export interface HiveL1Config {
	endpoints: string[];
	timeoutMs: number;
}

// ============ HAFAH API TYPES ============

export interface HafahTransaction {
	transaction_id: string;
	block_num: number;
	transaction_num: number;
	operations: Array<{
		type: string;
		value: Record<string, unknown>;
	}>;
}

// ============ PARSED OPERATION ============

export interface L1ParsedOperation {
	txId: string;
	blockNum: number;
	signer: string;
	action: string;
	data: Record<string, unknown>;
}

// ============ VERIFICATION RESULTS ============

export type VerificationStatus = "verified" | "mismatch" | "error" | "not_found";

export interface SpvMismatch {
	packIndex: number;
	itemIndex: number;
	field: string;
	expected: string;
	actual: string;
	severity: "critical" | "warning";
}

export interface ReportedMintedNft {
	instanceId: string;
	seedId: string;
	packIndex: number;
}

export interface PackOpenVerificationResult {
	status: VerificationStatus;
	txId: string;
	blockNum: number;
	signer: string;
	packId: string;
	expectedSeedIds: string[];
	reportedMintedNfts: ReportedMintedNft[];
	mismatches: SpvMismatch[];
	verifiedAt: number;
	durationMs: number;
	message: string;
}

export interface OnChainVerificationResult {
	status: VerificationStatus;
	txId: string;
	blockNum: number;
	foundOnChain: boolean;
	actionMatch: boolean;
	signerMatch: boolean;
	rawPayload?: Record<string, unknown>;
	message: string;
}

// ============ OWNERSHIP VERIFICATION ============

export interface OwnershipVerifyParams {
	nftId: string;
	expectedOwner: string;
	indexerBaseUrl: string;
	l1Config: HiveL1Config;
	sampleSize: number;
}

export interface OwnershipCheckResult {
	txId: string;
	blockNum: number;
	eventType: string;
	expectedSigner: string;
	l1Status: VerificationStatus;
	message: string;
}

export interface OwnershipVerificationResult {
	status: VerificationStatus;
	nftId: string;
	reportedOwner: string;
	expectedOwner: string;
	totalEvents: number;
	sampledEvents: number;
	checks: OwnershipCheckResult[];
	verifiedAt: number;
	durationMs: number;
	message: string;
}

// ============ LISTING PRICE VERIFICATION ============

export type OnChainPrice = { readonly amount: string; readonly currency: SupportedCurrency };

export type ListingPriceVerifyParams = {
	readonly listTxId: string;
	readonly expectedPrice: { readonly amount: number; readonly currency: SupportedCurrency };
	readonly expectedSeller: string;
	readonly expectedNftId: string;
	readonly l1Config: HiveL1Config;
};

export type ListingPriceVerificationResult = {
	readonly status: VerificationStatus;
	readonly listTxId: string;
	readonly blockNum: number;
	readonly onChainPrice: OnChainPrice | null;
	readonly onChainSeller: string | null;
	readonly onChainNftId: string | null;
	readonly message: string;
};

// ============ AUDITOR ============

export interface AuditorConfig {
	indexerBaseUrl: string;
	hiveEndpoints: string[];
	hiveTimeoutMs: number;
	sampleSize: number;
}

export interface AuditReport {
	startedAt: number;
	completedAt: number;
	durationMs: number;
	samplesChecked: number;
	verified: number;
	mismatches: number;
	errors: number;
	results: PackOpenVerificationResult[];
}
