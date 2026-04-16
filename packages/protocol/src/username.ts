export function validateHiveUsername(username: string): string | null {
	if (!username) return "Account name should not be empty.";
	if (username.length < 3) return "Account name should be longer.";
	if (username.length > 16) return "Account name should be shorter.";

	const suffix = /\./.test(username)
		? "Each account segment should "
		: "Account name should ";

	for (const segment of username.split(".")) {
		if (!/^[a-z]/.test(segment))
			return suffix + "start with a lowercase letter.";
		if (!/^[a-z0-9-]*$/.test(segment))
			return suffix + "have only lowercase letters, digits, or dashes.";
		if (!/[a-z0-9]$/.test(segment))
			return suffix + "end with a lowercase letter or digit.";
		if (segment.length < 3) return suffix + "be longer.";
	}
	return null;
}
