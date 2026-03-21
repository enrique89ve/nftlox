// Hive Keychain broadcast helpers

type KeyType = "Posting" | "Active";

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
