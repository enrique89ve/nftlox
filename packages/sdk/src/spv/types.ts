// SPV "Boleto Suizo" - Types
// Trustless verification system for NFTLox operations

import type { ProtocolAction, SupportedCurrency } from "@nftlox/protocol";

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

export interface HafahOperationRecord {
	operation_id: string;
	block: number;
	trx_id: string;
	timestamp: string;
	virtual_op: boolean;
	op: {
		type: string;
		value: {
			id: string;
			json: string;
			required_auths: string[];
			required_posting_auths: string[];
		};
	};
}

// ============ PARSED OPERATION ============

export interface L1ParsedOperation {
	txId: string;
	blockNum: number;
	signer: string;
	action: string;
	data: Record<string, unknown>;
	operationId: string;
}

// ============ VERIFICATION RESULTS ============

export type VerificationStatus = "verified" | "mismatch" | "error" | "not_found";

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

export interface ResolveMutableDataParams {
	readonly l1Config: HiveL1Config;
	readonly operationId: string;
	readonly expectedHash: string;
	readonly expectedActions?: readonly ProtocolAction[];
	readonly protocolId?: string;
}

export interface ResolvedMutableData {
	readonly operationId: string;
	readonly txId: string;
	readonly blockNum: number;
	readonly timestamp: string;
	readonly protocolId: string;
	readonly action: ProtocolAction;
	readonly signer: string;
	readonly mutableData: Record<string, unknown>;
	readonly hash: string;
}

export interface ResolveOperationByIdParams {
	readonly l1Config: HiveL1Config;
	readonly operationId: string;
	readonly expectedActions?: readonly ProtocolAction[];
	readonly protocolId?: string;
}

export interface ResolvedOperationById {
	readonly operationId: string;
	readonly txId: string;
	readonly blockNum: number;
	readonly timestamp: string;
	readonly protocolId: string;
	readonly version: string;
	readonly action: ProtocolAction;
	readonly signer: string;
	readonly data: Record<string, unknown>;
}

// ============ OWNERSHIP VERIFICATION ============

export interface OwnershipVerifyParams {
	nftId: string;
	expectedOwner: string;
	indexerBaseUrl: string;
	l1Config: HiveL1Config;
}

export interface OwnershipCheckResult {
	txId: string;
	blockNum: number;
	eventType: string;
	expectedSigner: string;
	l1Status: VerificationStatus;
	message: string;
	operationId?: string;
	previousOwner?: string | null;
	derivedOwner?: string | null;
}

export interface OwnershipVerificationResult {
	status: VerificationStatus;
	nftId: string;
	reportedOwner: string;
	expectedOwner: string;
	proofsChecked: number;
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
