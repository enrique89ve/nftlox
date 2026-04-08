// Pure data transformation functions.
// Zero I/O — testable with plain objects.

export const formatSchemaErrors = (
	errors: ReadonlyArray<{ readonly field: string; readonly message: string }>,
): string =>
	errors.map((e) => `${e.field}: ${e.message}`).join("; ");
