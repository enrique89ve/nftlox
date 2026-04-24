// Error messages are table-driven so tests can assert by symbol key
// instead of matching prose. The `SEGMENT_*` variants are suffixes that get
// concatenated with a context phrase ("Account name should " or "Each account
// segment should ") so callers see a single readable sentence.

const ERRORS = {
	EMPTY: "Account name should not be empty.",
	TOO_SHORT: "Account name should be longer.",
	TOO_LONG: "Account name should be shorter.",
	SEGMENT_MUST_START_LOWERCASE: "start with a lowercase letter.",
	SEGMENT_INVALID_CHARS: "have only lowercase letters, digits, or dashes.",
	SEGMENT_MUST_END_ALNUM: "end with a lowercase letter or digit.",
	SEGMENT_TOO_SHORT: "be longer.",
} as const;

const LOWERCASE_START_REGEX = /^[a-z]/;
const SEGMENT_CHARSET_REGEX = /^[a-z0-9-]*$/;
const ALNUM_END_REGEX = /[a-z0-9]$/;
const MULTI_SEGMENT_REGEX = /\./;
const MIN_SEGMENT_LENGTH = 3;
const MAX_USERNAME_LENGTH = 16;

export function validateHiveUsername(username: string): string | null {
	if (!username) return ERRORS.EMPTY;
	if (username.length < MIN_SEGMENT_LENGTH) return ERRORS.TOO_SHORT;
	if (username.length > MAX_USERNAME_LENGTH) return ERRORS.TOO_LONG;

	const prefix = MULTI_SEGMENT_REGEX.test(username)
		? "Each account segment should "
		: "Account name should ";

	for (const segment of username.split(".")) {
		if (!LOWERCASE_START_REGEX.test(segment)) return prefix + ERRORS.SEGMENT_MUST_START_LOWERCASE;
		if (!SEGMENT_CHARSET_REGEX.test(segment)) return prefix + ERRORS.SEGMENT_INVALID_CHARS;
		if (!ALNUM_END_REGEX.test(segment)) return prefix + ERRORS.SEGMENT_MUST_END_ALNUM;
		if (segment.length < MIN_SEGMENT_LENGTH) return prefix + ERRORS.SEGMENT_TOO_SHORT;
	}
	return null;
}
