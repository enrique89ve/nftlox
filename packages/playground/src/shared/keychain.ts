// Hive Keychain broadcast helpers

type KeyType = "Posting" | "Active";

export function getKeyType(operationJson: string): KeyType {
	// Operations that require Active key (state-changing)
	const activeActions = [
		"set_data", "data_operator_approve", "set_data_from",
		"nft_approve", "nft_approve_all", "nft_transfer_from",
		"pack_approve", "pack_transfer_from",
		"nft_lend", "nft_return",
	];

	try {
		const parsed = JSON.parse(operationJson);
		const action = parsed?.action || "";
		if (activeActions.includes(action)) return "Active";
	} catch { /* ignore */ }

	// Check if operation uses required_auths (Active key)
	// vs required_posting_auths (Posting key)
	return "Posting";
}

export function broadcastOperation(
	user: string,
	operations: unknown[],
	keyType: KeyType,
	onSuccess: (res: any) => void,
	onError: (err: string) => void,
) {
	const keychain = (window as any).hive_keychain;
	if (!keychain) {
		onError("Hive Keychain not detected. Install the extension.");
		return;
	}

	keychain.requestBroadcast(
		user,
		operations,
		keyType,
		(res: any) => {
			if (res.success) {
				onSuccess(res);
			} else {
				const err = typeof res.error === "object" ? JSON.stringify(res.error) : res.error;
				onError(err);
			}
		},
	);
}
