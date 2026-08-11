# Protocol Invariants

This page is the public reasoning model for NFTLox state transitions. It exists so protocol changes can be reviewed against explicit rules instead of handler-by-handler intuition.

Every accepted operation must preserve these invariants.

---

## Authority

The signer is derived from the Hive `custom_json` authority, not from a payload field.

| Invariant | Rule |
|---|---|
| A1 | A protocol action can only act for the account in `required_auths` or `required_posting_auths`. |
| A2 | Owner-scoped actions use `op.signer` as the owner authority. |
| A3 | Operator-scoped actions use `op.signer` as the delegated operator and must prove an existing approval. |
| A4 | Payload fields can identify targets, but they cannot grant authority by themselves. |
| A5 | Actions in `NODE_SIGNED_ACTIONS` (`buy_commitment`, `buy`) additionally require `op.signer` to be a registered active settlement node at processing time. Enforced via `requiresActiveNodeSigner(action)`. Orthogonal to the auth-level rule in `ACTION_AUTH_LEVEL`. |

Examples:

- `nft_approve_all` stores `owner = op.signer`; the payload does not contain an owner field.
- `nft_transfer_from` accepts `from` in the payload, but it still requires `op.signer` to match an instance or collection approval from that owner.
- `create_collection`, `buy_commitment`, and `buy` require active authority because they are node-cosigned flows with native-token consequences. `buy_commitment` and `buy` further require the signer to be an active settlement node (A5); `create_collection` is active-signed by the creator, not by a node.

---

## Ownership

`nfts.owner` is the current owner. It changes only through ownership-changing actions.

| Action | Ownership effect |
|---|---|
| `mint` | Creates a seed and sets its initial owner. |
| `bulk_distribute` | Creates instances and sets their initial owner. |
| `transfer` | Moves ownership from the signer to another account, or burns via `to = BURN_RECIPIENT` (the reserved Hive `null` account). |
| `nft_transfer_from` | Moves ownership through an instance or collection approval. |
| `buy` | Moves ownership after marketplace settlement. |
| `list`, `unlist` | Do not change owner. |
| `nft_lend`, `nft_return` | Do not change owner. They change use/custody state only. |

Each ownership change updates the current owner anchor:

- `previous_owner`
- `owner_action`
- `owner_operation_id`
- `owner_block_num`

Creation anchors stay fixed.

---

## Collection Approvals

`nft_approve_all` is collection-scoped transfer authority for the current owner while the approval remains active.

| Invariant | Rule |
|---|---|
| C1 | `approved: true` requires the signer to own at least one NFT in the collection. |
| C2 | A collection approval covers all current NFTs the owner has in that collection. |
| C3 | Future acquisitions are covered only while the approval row remains active. |
| C4 | The approval is automatically removed when the owner has zero NFTs left in the collection. |
| C5 | The zero-holdings cleanup must run no matter which action emptied the owner: `transfer`, `buy`, `burn`, or `nft_transfer_from`. |

This avoids zombie approvals: a delegated spender cannot empty an owner's collection and keep hidden transfer authority for a later reacquisition.

Instance approvals are narrower:

- `nft_approve` applies to one instance.
- It is cleared when ownership changes, the NFT is burned, bought, transferred, lent, or moved through `nft_transfer_from`.

---

## Listings

Listings are exclusive with ownership-changing and lending flows.

| Invariant | Rule |
|---|---|
| L1 | Active listings block direct ownership and custody changes such as `transfer`, `nft_transfer_from`, `burn`, and `nft_lend`. |
| L2 | `buy` requires a valid active listing; expired or unlisted listings cannot settle. |
| L3 | Expired listings may be replaced or cleared by the action that proves they are expired. |
| L4 | `unlist` clears the listing row immediately. Exclusivity with in-flight settlements is provided by the `buy_commitment` gate below (L5), not by a post-unlist delay. |
| L5 | While a `buy_commitment` holds an NFT (`status = "pending_sale"`), `unlist`, `transfer`, `nft_transfer_from`, `burn`, `nft_lend`, and re-listing are all rejected. The NFT returns to `active` only when the matching `buy` settles or the commitment TTL expires. |
| L6 | `collection_stats.listed` changes exactly once for each listed-to-active or active-to-listed transition. |

Exclusivity between unlist and in-flight buys is enforced by the node-last
multisig flow: a settlement node only broadcasts `buy_commitment` after it
observes a still-active listing, and `handleUnlist` refuses any row already
in `pending_sale`. The on-chain commitment TTL (`BUY_COMMITMENT_TTL_BLOCKS`,
40 blocks ≈ 120 s @ 3 s/block) bounds how long an unlisted-but-reserved NFT
can stay in that state. The HTTP-side observation budget
(`BUY_COMMITMENT_OBSERVATION_TIMEOUT_MS = 60 s`) is shorter and only governs
the local node's wait; the on-chain reservation and the local `buyLock`
(TTL = `BUY_TX_TTL_MS`) outlive it.

---

## Seeds And Instances

Seeds are templates. Instances are tradable assets created from seeds.

| Invariant | Rule |
|---|---|
| S1 | `mint` creates seeds only. |
| S2 | `bulk_distribute` creates instances only. |
| S3 | Only the current seed owner can distribute from that seed. |
| S4 | A seed with distributed instances cannot change ownership, be listed, be delegated, or be lent. |
| S5 | Instance provenance is anchored by `seed_id` and creation operation fields, not by the seed's later owner. |

---

## Data Operators

Data delegation and transfer delegation are separate systems.

| Invariant | Rule |
|---|---|
| D1 | `data_operator_approve` grants mutable-data write authority, not transfer authority. |
| D2 | `nft_approve` and `nft_approve_all` grant transfer authority, not mutable-data authority. |
| D3 | `set_data_from` requires a collection data operator and cannot change ownership. |

Games should prefer `data_operator_approve` when the server only needs to update gameplay data.

---

## Network State & Determinism

Independent indexers must converge on the same projected state for the same Hive block stream. The protocol exposes that convergence as a public, byte-comparable commitment so divergence is detectable by anyone — including the buyer about to settle a `buy`.

| Invariant | Rule |
|---|---|
| N1 | The projected `state_root` is the incremental XOR over a fixed subset of every NFT's SPV fields (`owner`, `previous_owner`, `owner_action`, `owner_operation_id`, `owner_block_num`, `id`). The subset is consensus — adding or removing a field is a hardfork. |
| N2 | The state-root is updated inside the same transaction as the NFT mutation that changes it. Drift between the projection and its commitment is impossible by construction. |
| N3 | At every `STATE_CHECKPOINT_INTERVAL_BLOCKS` boundary (1000 blocks ≈ 50 min), a registered node MAY publish a `node_state_checkpoint` custom_json carrying `{ blockNum, stateRoot }`. The handler enforces alignment (`blockNum % N === 0`) so peers compare the same boundaries. |
| N4 | A mismatch between the local checkpoint and a peer's `node_state_checkpoint` is recorded as advisory evidence and logged for investigation. It MUST NOT set `state_meta.divergent_at_block` by itself because peer registration is permissionless and peer count is not a Sybil-resistant quorum. The local interlock is reserved for an independently verified local integrity failure or explicit operator action. |
| N5 | Nodes also publish `node_heartbeat` at most every `MIN_HEARTBEAT_INTERVAL_BLOCKS` (5000 blocks). A node with no heartbeat in `MAX_NODE_HEARTBEAT_STALENESS_BLOCKS` (10000 blocks) is treated as inactive and its signatures stop settling globally — the same accept/reject decision on every indexer because the threshold is block-denominated, not wall-clock. |

### Why this matters for the autonomy thesis

A divergent indexer is exactly the failure mode that turns a "decentralized" NFT into a centralized one. N3+N4 reduce that risk to a single-byte comparison anyone can run, while avoiding a Sybil-triggered global veto: a free identity must not be able to disable every honest settlement node. Multisig endpoints (`/api/multisig/buy`, `/api/multisig/collection`) still call `assertNodeNotDivergent` **before** any other validation, but `NODE_DIVERGENT` (HTTP 503) now means this node's local integrity interlock was set by verified evidence or an operator.

---

## Review Checklist

Before adding or changing a handler, verify:

- The signer role is derived from Hive authority and matches the action's role.
- Ownership-changing actions update owner anchors and clear stale listing fields.
- Any action that can empty an owner's collection runs collection-approval cleanup after the owner count actually reaches zero.
- Listing status and `collection_stats.listed` move together.
- Instance approvals do not survive ownership changes or destructive state changes.
- Data operator permissions never imply transfer rights.
- Seed distribution locks are preserved.
