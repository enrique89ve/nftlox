# NFTLox Packs Engine

Pure pack logic for NFTLox.

This package is intentionally narrow:

- validates pack definitions
- computes reservation demand per seed
- resolves deterministic pack openings
- produces a `bulk_distribute` delivery plan

This package does **not** own:

- pack balances
- payments
- inventory
- idempotency persistence
- database state
- SPV/auditor verification of pack-opening claims against Hive L1

Those concerns belong in an external backend or service. The core protocol remains focused on property and NFT supply.
