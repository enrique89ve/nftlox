const HIVE_UTC_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z?$/;

/**
 * Validates a Hive timestamp and returns a fixed-width ISO UTC representation.
 * Hive APIs commonly omit the trailing `Z`; treating that form as local time
 * would make replay depend on the host timezone.
 */
export function normalizeHiveTimestampToUtc(raw: unknown, label: string): string {
	if (typeof raw !== "string") {
		throw new Error(`${label} must be a string, got ${typeof raw}`);
	}

	const match = HIVE_UTC_TIMESTAMP_RE.exec(raw);
	if (!match) throw new Error(`Invalid ${label} format: ${raw}`);

	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	const fraction = match[7] ?? "";
	const millisecond = fraction.length === 0 ? 0 : Number(fraction.padEnd(3, "0"));
	const epochMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
	const date = new Date(epochMs);

	if (
		!Number.isFinite(epochMs) ||
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day ||
		date.getUTCHours() !== hour ||
		date.getUTCMinutes() !== minute ||
		date.getUTCSeconds() !== second ||
		date.getUTCMilliseconds() !== millisecond
	) {
		throw new Error(`Invalid ${label} value: ${raw}`);
	}

	return date.toISOString();
}

/** Fixed-width canonical ISO timestamps preserve chronological string order. */
export function accountCreatedBeforeOperation(
	accountCreatedAtUtc: string,
	operationAtUtc: string,
): boolean {
	return accountCreatedAtUtc < operationAtUtc;
}
