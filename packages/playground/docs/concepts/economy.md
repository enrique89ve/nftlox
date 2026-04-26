# Ecosystem Economy

NFTLox is built on Hive L1, where Resource Credits replace gas. **End users never pay a transaction fee** — every protocol action is a `custom_json` operation whose only L1 cost is RC, paid by the broadcasting account.

The protocol layers two — and only two — economic primitives on top of that base: a **collection creation fee** paid once when registering a collection, and a **marketplace payment split** that runs on every `buy`. Everything else (mint, transfer, list, unlist, lend, return, approve, set_data, …) is economically free.

This page is the single source of truth. The deep flows live in [Collections](collections.md) and [Marketplace Trading](../guides/marketplace.md).

## 0. The economy depends on the transaction model

Every fee in this document is the direct output of a specific shape of Hive `custom_json` + `transfer` transaction. The protocol does **not** maintain a "fee balance" anywhere; there is no contract that holds funds and settles later. Each economic outcome is the literal sum of operations inside one atomic Hive transaction:

| Action | Transaction shape | Economic effect |
|---|---|---|
| `create_collection` | 1 `transfer` (creator → node, HBD) **+** 1 `custom_json` co-signed by the node | Fee is paid the same instant the collection is registered. If either op is missing or rejected, the whole transaction fails — fee and registration are inseparable. |
| `buy` | 1–3 `transfer`s (buyer → seller, royalty, fee) **+** 1 `custom_json` with `required_auths = [node]` | Seller payment, royalty, protocol fee, and ownership change land or fail together. There is no window in which money has moved but ownership has not (or vice versa). |
| All other actions | 1 `custom_json` with no transfer | No fee. |

This atomicity is **why the economy is deterministic**:

1. **No off-chain accounting.** A fee that exists only as a row in a node's database can drift between nodes; a fee that *is* a `transfer` op inside the same Hive transaction as the action cannot.
2. **No partial states.** Hive evaluates the multi-op transaction atomically. The protocol leverages that to make "you paid but the action failed" impossible by construction — not handled by retry logic, but absent from the state machine.
3. **No node-side custody.** The fee transfer's `to` field is the action's signer (the co-signing node, resolved as `action:signer`). Nodes never escrow user funds; the only money a node touches is what is paid to it for that specific action.
4. **Re-derivable from the chain alone.** Given a Hive block range, an indexer can recompute every fee, every royalty split, and every seller payout by replaying the same op shapes through `calculatePaymentSplit`. No external state, no oracle, no node config feeds into the math.

If you change the transaction model — adding an op, splitting an action across blocks, introducing escrow — you change the economy. That is why the [Protocol Invariants](protocol-invariants.md) section treats the transaction shape per action as consensus, not convention.

## 1. Money flow at a glance

```
Hive L1 (RC, no monetary fee)
        │
        ▼
┌─────────────────────────────┐         ┌─────────────────────────────┐
│ create_collection           │         │ buy                         │
│   creator ──HBD──► node     │         │   buyer ──HIVE/HBD──► seller│
│   (collection creation fee) │         │                  ──► royalty│
│                             │         │                  ──► fee acc│
└─────────────────────────────┘         └─────────────────────────────┘
        ▲                                        ▲
        │                                        │
        └─ deterministic, protocol-coded ────────┘
           (no oracles, no off-chain config)
```

Both fees are **deterministic**: every indexer that processes the same block reaches the same accept/reject decision without consulting price feeds, node-local config, or wall-clock time. That is the load-bearing reason behind every rule below — a fee that is not deterministic cannot be re-derived during sync.

## 2. Free actions

The following actions carry **no monetary fee** at the protocol layer (RC still applies on Hive L1):

| Group | Actions |
|---|---|
| Core | `mint`, `transfer`, `bulk_distribute`, `set_data`, `extend_schema`, `archive_collection` |
| Node directory | `node_register`, `node_heartbeat`, `node_state_checkpoint` |
| Marketplace | `list`, `unlist`, `buy_commitment` |
| Allowances | `nft_approve`, `nft_approve_all`, `nft_transfer_from`, `data_operator_approve`, `set_data_from` |
| Lending | `nft_lend`, `nft_return` |

The authoritative registry is [`payment-requirements.ts`](../../../protocol/src/payment-requirements.ts) — any action mapped to `{ kind: "none" }` is free.

## 3. Collection creation fee

A `create_collection` transaction must include a `transfer` op from the creator to the node co-signer:

| Property | Value | Constant |
|---|---|---|
| Currency | **HBD only** | — |
| Amount (default) | **`0.100 HBD`** flat | `PROTOCOL_COLLECTION_FEE_HBD` |
| Memo | `NFTLox FEE-COL:{collectionId}` | `MEMO_PREFIX_FEE_COL` |
| Recipient | The node co-signer (`action:signer` of the `custom_json`) | — |
| Payer | Creator (`transfer:from`) | — |

Three rules carry weight:

1. **HBD only.** The validator refuses HIVE even with the right memo and recipient. HBD is pegged to USD, so the fee remains a deterministic function of L1 state. Allowing HIVE would require a live price feed that nodes could disagree on while syncing the same block.
2. **Memo is mandatory.** A bare transfer to the treasury without `NFTLox FEE-COL:{collectionId}` is treated as a voluntary gift, not a creation fee — the `create_collection` op is rejected.
3. **Recipient is `action:signer`.** The fee goes to whichever node co-signed the multisig collection request. There is no global treasury account; each node settles its own collection requests.

### Scaled fee (dormant)

The protocol ships a forward-compatible scaled adapter, gated by `INSTANCE_FEE_ENABLED` (currently `false`):

```
fee = PROTOCOL_COLLECTION_FEE_HBD + INSTANCE_FEE_UNIT_HBD * ceil(maxInstances / INSTANCE_FEE_PER_N)
    = 0.100 HBD                   + 0.001 HBD             * ceil(maxInstances / 1000)
```

Because `maxInstances` is already constrained to `0` or a positive multiple of `1000`, every existing payload is fee-aligned the moment the flag flips — no migration. `MAX_INSTANCES_PER_COLLECTION` (1,000,000) caps the worst-case fee at `0.100 + 0.001 * 1000 = 1.100 HBD`.

## 4. Marketplace payment split (`buy`)

A `buy` transaction settles the listing price between three parties in a single atomic Hive transaction:

```
feeAmount     = round3(totalPrice * PROTOCOL_FEE_BPS / 10_000)    // 1%
royaltyAmount = round3(totalPrice * royaltyPct      / 100)        // 0–50% per collection
sellerAmount  = totalPrice - royaltyAmount - feeAmount
```

| Property | Value | Constant |
|---|---|---|
| Protocol fee | **1%** of `totalPrice` | `PROTOCOL_FEE_BPS = 100` |
| Max royalty | **50%** (warning above 25%) | `MAX_ROYALTY_PCT` |
| Min listing price | **`0.100`** of the chosen currency | `MIN_PRICE_AMOUNT` |
| Currencies | `HIVE`, `HBD` | `SUPPORTED_CURRENCIES` |
| Rounding | 3 decimals (Hive native precision) | `HIVE_DECIMALS` |
| Payer | Buyer (`payload:buyer`) | — |
| Fee recipient | Settlement node (`action:signer`) | — |

### Memo conventions

Each transfer in a `buy` carries a strictly-formatted memo so the indexer and the multisig node can attribute it without ambiguity:

| Transfer | Memo | Constant |
|---|---|---|
| Seller payment | `NFTLox BUY:{nftId}` | `MEMO_PREFIX_BUY` |
| Royalty | `NFTLox ROY:{nftId}` | `MEMO_PREFIX_ROYALTY` |
| Protocol fee | `NFTLox FEE:{nftId}` | `MEMO_PREFIX_FEE` |

### Self-collapse rules

The split is computed by `calculatePaymentSplit` and emits a `transfer` only for amounts strictly greater than zero. Three collapses keep the transaction small:

- `royaltyPct == 0` **or** `royaltyRecipient == null` **or** `royaltyRecipient == seller` → no royalty transfer.
- `feeAccount == seller` → no fee transfer (the seller would just be paying themselves).
- `royaltyAmount == 0` after rounding → no royalty transfer.

The minimum a `buy` can produce is **1 transfer + 1 custom_json** (2 ops); the maximum is **3 transfers + 1 custom_json** (4 ops). The signed-buyer transaction must fall inside `[MULTISIG_TX_MIN_EXPIRATION_MS, MULTISIG_TX_MAX_EXPIRATION_MS]` (30–60 s) so the settlement node has its full commitment window to broadcast.

### Why the buyer trusts the math

`buildBuy` does **not** recompute the split — it forwards whatever the buyer-side caller passes. The settlement node and the indexer recompute it independently against `nft.listing` and reject any drift with `INVALID_PAYMENT_SPLIT`. Always read the canonical split from the indexer (`getNftBuyInfo`) and forward it verbatim.

## 5. Determinism — what is **not** in the fee schedule

Three explicit non-features keep the economy a pure function of L1 state:

- **No oracles.** The fee schedule is a constant in protocol code (`PROTOCOL_FEE_BPS`, `PROTOCOL_COLLECTION_FEE_HBD`). No HIVE/USD price feed, no governance vote, no chain-state lookup beyond the operation itself.
- **No node-local configuration.** A node operator cannot lower its protocol fee to compete on price; the schedule is consensus-coded. The only legitimate node revenue is the collection-creation fee for collections it co-signs and the protocol fee for buys it settles.
- **No retroactive adjustments.** Any change to a constant in this section is a hardfork: every existing fee transfer is re-validated against the new value during replay.

## 6. Constants reference

All values live in [`packages/protocol/src/constants.ts`](../../../protocol/src/constants.ts) and are re-exported by `nftlox-sdk`. Importing from anywhere else is drift.

| Constant | Value | Used by |
|---|---|---|
| `PROTOCOL_FEE_BPS` | `100` (1%) | Marketplace `buy` |
| `BASIS_POINTS_DENOMINATOR` | `10_000` | Royalty + fee math |
| `MAX_ROYALTY_PCT` | `50` | `create_collection` validation |
| `MIN_PRICE_AMOUNT` | `"0.100"` | `list` validation |
| `SUPPORTED_CURRENCIES` | `["HIVE", "HBD"]` | `list` / `buy` |
| `PROTOCOL_COLLECTION_FEE_HBD` | `"0.100"` | `create_collection` (flat) |
| `INSTANCE_FEE_ENABLED` | `false` | Toggle for scaled fee |
| `INSTANCE_FEE_UNIT_HBD` | `"0.001"` | Scaled fee per slot unit |
| `INSTANCE_FEE_PER_N` | `1000` | Slot granularity |
| `MAX_INSTANCES_PER_COLLECTION` | `1_000_000` | Hard cap |
| `DEFAULT_FEE_ACCOUNT` | `"nftlox"` | SDK default; on-chain is `action:signer` |
| `HIVE_DECIMALS` | `3` | Amount rounding |

## 7. Where to go next

- [Marketplace Trading](../guides/marketplace.md) — full `buy` flow, multisig orchestration, error codes.
- [Collections](collections.md) — `create_collection` payload, schema, fee transfer.
- [Protocol Invariants](protocol-invariants.md) — the broader determinism contract this economy slots into.
