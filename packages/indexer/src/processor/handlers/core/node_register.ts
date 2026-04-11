import type { ParsedOperation } from "@/scanner/operation-parser.ts";
import type { Queryable } from "@/db/client.ts";
import { feeOracle } from "@/utils/fee-oracle.ts";
import { DEFAULT_FEE_ACCOUNT, PROTOCOL_NODE_FEE_HBD } from "@/protocol/constants.ts";

export async function handleNodeRegister(op: ParsedOperation, txn: Queryable): Promise<ReadonlyArray<string>> {
	const data = op.data as { endpoint?: string; publicKey?: string };

	if (typeof data.endpoint !== "string" || data.endpoint.trim() === "") {
		throw new Error("Missing or invalid 'endpoint' parameter");
	}
	if (typeof data.publicKey !== "string" || data.publicKey.trim() === "") {
		throw new Error("Missing or invalid 'publicKey' parameter");
	}

	// Validate paired transfers for the fee
	const transfers = op.pairedTransfers || [];
	if (transfers.length === 0) {
		throw new Error(`Node registration requires a connection fee of ${PROTOCOL_NODE_FEE_HBD} HBD`);
	}

	// Only evaluate the FIRST transfer from the signer to the exact fee account
	const transfer = transfers[0];
	if (!transfer) throw new Error("No transfer found in payload");
	
	if (transfer.from !== op.signer) {
		throw new Error(`Fee must be paid by the registering node (${op.signer})`);
	}
	if (transfer.to !== DEFAULT_FEE_ACCOUNT) {
		throw new Error(`Fee must be paid to the protocol treasury (${DEFAULT_FEE_ACCOUNT})`);
	}

	const isValid = await feeOracle.validateFee(
		PROTOCOL_NODE_FEE_HBD, 
		transfer.amount, 
		transfer.currency
	);

	if (!isValid) {
		throw new Error(`Insufficient fee paid: ${transfer.amount} ${transfer.currency} does not meet the requirement of ${PROTOCOL_NODE_FEE_HBD} HBD`);
	}

	const feePaidHbd = transfer.currency === "HBD" ? transfer.amount : 0;
	const feePaidHive = transfer.currency === "HIVE" ? transfer.amount : 0;

	// Insert into l2_nodes DB table
	await txn`
		INSERT INTO l2_nodes (
			account,
			endpoint,
			public_key,
			status,
			fee_paid_hbd,
			fee_paid_hive,
			block_num,
			tx_id
		) VALUES (
			${op.signer},
			${data.endpoint},
			${data.publicKey},
			'active',
			${feePaidHbd},
			${feePaidHive},
			${op.blockNum},
			${op.txId}
		)
		ON CONFLICT (account) DO UPDATE SET
			endpoint = EXCLUDED.endpoint,
			public_key = EXCLUDED.public_key,
			fee_paid_hbd = l2_nodes.fee_paid_hbd + EXCLUDED.fee_paid_hbd,
			fee_paid_hive = l2_nodes.fee_paid_hive + EXCLUDED.fee_paid_hive,
			status = 'active',
			block_num = EXCLUDED.block_num,
			tx_id = EXCLUDED.tx_id,
			updated_at = NOW()
	`;

	return []; // This action evaluates node state, it emits no immutable NFT ids
}
