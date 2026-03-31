# Permission Model & Key Security

This guide covers the NFTLox permission model, recommended account architecture for games, and key security best practices.

---

## Permission Model

### Who Can Do What

| Role | Actions | Key Required |
|------|---------|-------------|
| **Collection creator** | `create_collection`, `mint`, `extend_schema`, `set_data`, `data_operator_approve` | Posting (except `data_operator_approve` = Active) |
| **Seed owner** | `bulk_distribute`, `transfer` (only if `distributed === 0`), `burn`, `replicate`, `list` (only if `distributed === 0`), `unlist` | Posting for `bulk_distribute`; Active for the rest |
| **NFT/Instance owner** | `transfer`, `burn`, `list`, `unlist`, `nft_approve`, `nft_lend`, `set_owner_data` | Active (except `set_owner_data`, `unlist` = Posting) |
| **Approved operator** | `set_data_from` | Posting |
| **Approved spender** | `nft_transfer_from`, `pack_transfer_from` | Posting |

**Key distinction**: The collection creator controls the **schema and metadata**. The seed owner controls **custody and distribution exclusively** — the collection creator has NO distribution rights over seeds they don't own. Seeds with distributed instances (`distributed > 0`) cannot be transferred, listed, sold, delegated, or lent.

### Key Types

The protocol has **10 actions requiring active key** and **15 using posting key**.

| Key required | Actions |
|---|---|
| **Active key** (10) | `transfer`, `burn`, `list`, `buy`, `pack_buy`, `pack_transfer`, `nft_approve`, `nft_approve_all`, `pack_approve`, `data_operator_approve` |
| **Posting key** (15) | `create_collection`, `mint`, `replicate`, `bulk_distribute`, `set_data`, `set_owner_data`, `extend_schema`, `unlist`, `pack_create`, `pack_open`, `nft_transfer_from`, `pack_transfer_from`, `set_data_from`, `nft_lend`, `nft_return` |

Active-key actions use `required_auths` while posting-key actions use `required_posting_auths` in the `custom_json` operation.

---

## Recommended Account Architecture for Games

### Single Account (simplest -- creator IS the game server)

For a game like Ragnarok, the creator and the game server are typically the same account:

```
ragnarok-game (creator + seed owner + game server)
  - Creates collection, mints seeds, distributes instances, updates stats
  - Seeds are non-transferable once instances are distributed
  - Posting key on the server for bulk_distribute and set_data
  - Active key in secure vault for one-time setup (data_operator_approve)
```

### Two Accounts (security isolation)

If you need a separate game server account for security isolation:

```
ragnarok-game (creator + seed owner)   ragnarok-server (operator)
  - Creates collection                   - Calls set_data_from (posting key)
  - Mints seeds                          - Cannot distribute (not seed owner)
  - Calls data_operator_approve          - Cannot transfer/list/approve seeds
  - Calls bulk_distribute (as owner)
```

The creator retains seed ownership and handles distribution. Only the seed owner can call `bulk_distribute` — the collection creator role alone is insufficient. The server only updates mutable data via operator delegation. Seeds cannot be approved or lent.

---

## Key Security Guide

### Which Keys Go Where

| Key | Where | Used For |
|-----|-------|----------|
| **Active key** | Secure vault, offline | One-time setup: `data_operator_approve`. Never on a server. |
| **Posting key** | Game server (env var) | Recurring ops: `bulk_distribute`, `set_data`, `set_data_from`, `mint` |
| **Owner/Master key** | Cold storage only | Account recovery. Never used in game operations. |

### Risk Matrix

| If compromised... | Active key | Posting key |
|-------------------|-----------|-------------|
| Can transfer NFTs? | Yes | No |
| Can list/sell NFTs? | Yes | No |
| Can modify game data? | Yes | Yes |
| Can distribute packs? | Yes | Yes |
| Can approve operators? | Yes | No |
| **Blast radius** | **Total loss of assets** | **Game data corruption only** |

**Best practice**: Only the posting key should exist on a running server. The active key should be used once for setup (`data_operator_approve`) and stored offline.

### Security Recommendations

- **Never expose private keys in client-side code.** Use environment variables or a secure key management system.
- For browser-based applications, consider using [Hive Keychain](https://hive-keychain.com/) which handles signing without exposing keys.
- In production, use `.env` files or secret managers rather than raw WIF keys in source.

---

## Mutable Data Merge Behavior

When `set_data` or `set_data_from` is called, mutable data is **shallow-merged** (overwrite per key):

```typescript
// Current mutable_data: { level: 5, xp: 1000, wins: 10, losses: 2 }
// set_data_from with:   { xp: 1500, wins: 11 }
// Result:               { level: 5, xp: 1500, wins: 11, losses: 2 }
//                         ^unchanged  ^overwritten  ^overwritten  ^unchanged
```

The indexer does NOT add values -- it replaces each key you send. Your game server must read current state, compute new values, and write the result.
