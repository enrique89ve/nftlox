import type { Queryable } from "@/db/client.ts";
import { getStateMeta } from "@/db/queries/state-root.ts";
import { createMultisigError } from "@/api/services/multisig/errors.ts";

// F3.C — Local multisig integrity interlock. Refuses to sign after an
// independently verified local integrity failure or explicit operator action.
// An untrusted peer checkpoint mismatch must never set this flag by itself.
// Multisig entry points MUST call this BEFORE
// any other validation so a divergent node never co-signs even a malformed
// request: the safety story is "if our local state is suspect, we don't put
// our name on anything new". Operator clears the flag manually after audit
// (UPDATE state_meta SET divergent_at_block = NULL WHERE id = 1).
export async function assertNodeNotDivergent(db: Queryable): Promise<void> {
	const meta = await getStateMeta(db);
	if (meta.divergent_at_block === null) return;
	throw createMultisigError(
		"NODE_DIVERGENT",
		`Settlement node refused to sign: local state integrity interlock set at block ${meta.divergent_at_block}; operator review required`,
	);
}
