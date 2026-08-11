import {
	ACTION_BULK_DISTRIBUTE,
	ACTION_MINT,
	ACTION_NFT_LEND,
	ACTION_NFT_TRANSFER_FROM,
	ACTION_TRANSFER,
	BURN_RECIPIENT,
	getAuthMismatchReason,
	validateHiveUsername,
} from "@/protocol/index.ts";
import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import type {
	HiveAccountClient,
	HiveAccountObservation,
} from "@/scanner/account-client.ts";
import { accountCreatedBeforeOperation } from "@/utils/hive-timestamp.ts";

export type AccountValidationDecision =
	| Readonly<{ readonly kind: "not-required" }>
	| Readonly<{ readonly kind: "accepted"; readonly account: string }>
	| Readonly<{ readonly kind: "rejected"; readonly reason: string }>;

export type AccountValidationMap = ReadonlyMap<string, AccountValidationDecision>;

type AccountTarget =
	| Readonly<{ readonly kind: "not-required" }>
	| Readonly<{
			readonly kind: "lookup";
			readonly account: string;
			readonly operationAt: string;
	  }>
	| Readonly<{ readonly kind: "rejected"; readonly reason: string }>;

export type AccountValidationPlan = Readonly<{
	readonly targets: ReadonlyMap<string, AccountTarget>;
	readonly accounts: readonly string[];
}>;

function hasOwnField(data: Record<string, unknown>, field: string): boolean {
	return Object.prototype.hasOwnProperty.call(data, field);
}

function invalidAccountField(field: string): AccountTarget {
	return {
		kind: "rejected",
		reason: `Missing or invalid ${field}: expected a non-empty Hive account name`,
	};
}

function accountTarget(
	value: unknown,
	field: string,
	signer: string,
	allowSigner: boolean,
	operationAt: string,
): AccountTarget {
	if (typeof value !== "string" || value.length === 0) {
		return invalidAccountField(field);
	}
	if (value === BURN_RECIPIENT) return { kind: "not-required" };

	const usernameError = validateHiveUsername(value);
	if (usernameError) {
		return {
			kind: "rejected",
			reason: `Invalid Hive username for ${field} ("${value}"): ${usernameError}`,
		};
	}
	if (allowSigner && value === signer) return { kind: "not-required" };
	return { kind: "lookup", account: value, operationAt };
}

function targetForOperation(op: ParsedOperation): AccountTarget {
	const authCheck = getAuthMismatchReason(op.action, op.authLevel);
	if (!authCheck.ok) return { kind: "rejected", reason: authCheck.message };

	const data = op.data;

	if (op.action === ACTION_TRANSFER) {
		const target = accountTarget(data.to, "to", op.signer, false, op.timestamp);
		if (target.kind === "lookup" && target.account === op.signer) {
			return {
				kind: "rejected",
				reason: "Cannot transfer NFT to yourself",
			};
		}
		return target;
	}

	if (op.action === ACTION_MINT) {
		if (!hasOwnField(data, "owner")) return { kind: "not-required" };
		return accountTarget(data.owner, "owner", op.signer, true, op.timestamp);
	}

	if (op.action === ACTION_BULK_DISTRIBUTE) {
		if (!hasOwnField(data, "to")) return { kind: "not-required" };
		return accountTarget(data.to, "to", op.signer, true, op.timestamp);
	}

	if (op.action === ACTION_NFT_TRANSFER_FROM) {
		return accountTarget(data.to, "to", op.signer, true, op.timestamp);
	}

	if (op.action === ACTION_NFT_LEND) {
		return accountTarget(data.borrower, "borrower", op.signer, true, op.timestamp);
	}

	return { kind: "not-required" };
}

export function buildAccountValidationPlan(
	ops: readonly ParsedOperation[],
): AccountValidationPlan {
	const targets = new Map<string, AccountTarget>();
	const accounts = new Set<string>();

	for (const op of ops) {
		if (targets.has(op.operationId)) {
			throw new Error(`Duplicate operationId in account validation plan: ${op.operationId}`);
		}
		const target = targetForOperation(op);
		targets.set(op.operationId, target);
		if (target.kind === "lookup") accounts.add(target.account);
	}

	return {
		targets,
		accounts: [...accounts],
	};
}

function decideAccountTarget(
	target: Extract<AccountTarget, { readonly kind: "lookup" }>,
	accounts: ReadonlyMap<string, HiveAccountObservation>,
): AccountValidationDecision {
	const account = accounts.get(target.account);
	if (!account) {
		return {
			kind: "rejected",
			reason: `Hive account does not exist: ${target.account}`,
		};
	}
	if (!accountCreatedBeforeOperation(account.createdAt, target.operationAt)) {
		return {
			kind: "rejected",
			reason: `Hive account ${target.account} did not exist before operation timestamp ${target.operationAt}`,
		};
	}
	return { kind: "accepted", account: target.account };
}

export async function prepareAccountValidation(
	ops: readonly ParsedOperation[],
	client: HiveAccountClient,
): Promise<AccountValidationMap> {
	const plan = buildAccountValidationPlan(ops);
	const accounts: ReadonlyMap<string, HiveAccountObservation> = plan.accounts.length === 0
		? new Map<string, HiveAccountObservation>()
		: (await client.lookup(plan.accounts)).accounts;

	const decisions = new Map<string, AccountValidationDecision>();
	for (const [operationId, target] of plan.targets) {
		switch (target.kind) {
			case "not-required":
				decisions.set(operationId, target);
				break;
			case "rejected":
				decisions.set(operationId, target);
				break;
			case "lookup":
				decisions.set(operationId, decideAccountTarget(target, accounts));
				break;
			default: {
				const exhaustive: never = target;
				throw new Error(`Unhandled account target: ${JSON.stringify(exhaustive)}`);
			}
		}
	}

	return decisions;
}
