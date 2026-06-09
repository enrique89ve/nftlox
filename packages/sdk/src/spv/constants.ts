// SPV "Boleto Suizo" - Constants

export const DEFAULT_HIVE_ENDPOINTS = [
  "https://api.hive.blog",
  "https://rpc.mahdiyari.info",
  "https://anyx.io",
] as const;

// Wax default: 2_000ms (IWaxOptionsChain.apiTimeout)
// SPV needs more margin for HAFAH REST lookups (heavier than JSON-RPC)
export const DEFAULT_HIVE_TIMEOUT_MS = 4_000;
