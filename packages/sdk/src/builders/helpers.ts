import type { ZodError } from "zod";
import type { ValidationError } from "../types";

export function formatZodError(error: ZodError): ValidationError[] {
	return error.issues.map((issue) => ({
		field: issue.path.join("."),
		message: issue.message,
		code: issue.code.toUpperCase(),
	}));
}
