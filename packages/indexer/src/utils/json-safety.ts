// Defenses applied at every untrusted-JSON boundary in the indexer:
// the on-chain operation parser and the multisig HTTP parser both
// consume blockchain- or client-supplied payloads. Anything that lands
// here is reachable from a malicious actor.

/**
 * `JSON.parse` reviver that drops `__proto__` and `constructor` keys so
 * user-supplied payloads cannot poison objects downstream.
 *
 * Without this, a payload like `{"data": {"__proto__": {"admin": true}}}`
 * creates the key as an own property today, but any code that later spreads
 * or merges that object with `Object.assign`, structured clone through
 * prototype-aware libraries, or `for..in` loops without `hasOwnProperty`
 * guards can escalate it into actual prototype pollution. Strip at the
 * earliest boundary instead of auditing every consumer.
 */
export function prototypePollutionReviver(key: string, value: unknown): unknown {
	if (key === "__proto__" || key === "constructor") return undefined;
	return value;
}
