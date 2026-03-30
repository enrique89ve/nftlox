# RNG Algorithm Reference

This document specifies the NFTLox deterministic RNG algorithm so it can be independently implemented in any programming language. The algorithm is the foundation of trustless pack openings: given the same inputs, any implementation must produce identical outputs.

**Source implementation:** `packages/sdk/src/dna.ts` -- functions `deterministicRng` and `resolveDropTable`.

---

## Cryptographic Functions in NFTLox

NFTLox uses two distinct algorithms for different purposes:

| Function | Algorithm | Purpose | Collision resistance |
|----------|-----------|---------|---------------------|
| **Identity & uniqueness** (DNA, IDs, hashes, listing IDs) | **SHA-256** (via `crypto.subtle`) | Deterministic, collision-resistant identifiers | ~2^128 (birthday bound) -- effectively unlimited |
| **RNG for drop tables** | **SHA-256** (53-bit extraction) | Weighted random selection for pack openings | 256-bit hash, 53-bit output precision -- no practical ceiling |

**Why SHA-256 for everything?** SHA-256 provides 256-bit avalanche and uniform distribution. For identity (DNA, IDs), the full hash output guarantees collision resistance. For RNG, we extract 53 bits (JS safe integer precision) from the hash to produce a float in `[0, 1)` with uniform distribution. No practical ceiling on drop table size or selection count.

---

## Table of Contents

1. [deterministicRng(seed, index)](#1-deterministicrng-seed-index)
2. [resolveDropTable(dropTable, itemCount, rngSeed)](#2-resolvedroptable-droptable-itemcount-rngseed)
3. [RNG Seed Format](#3-rng-seed-format)
4. [Pseudocode](#4-pseudocode)
5. [Test Vectors](#5-test-vectors)

---

## 1. deterministicRng(seed, index)

Returns a deterministic float in the range `[0, 1)` for a given seed string and index number.

**Algorithm:** SHA-256 with 53-bit extraction.

### Detailed Steps

1. **Build the input string:**
   ```
   input = "nftlox:rng:" + seed + ":" + toString(index)
   ```

2. **Hash with SHA-256:**
   ```
   hash = SHA-256(input)    // 32 bytes (256 bits)
   ```

3. **Extract 53 bits** (JS safe integer precision):
   ```
   hi = first 4 bytes as uint32 big-endian, right-shifted 11 bits  // 21 bits
   lo = next 4 bytes as uint32 big-endian                          // 32 bits
   combined = hi * 2^32 + lo                                       // 53 bits total
   ```
4. **Normalize:**
   ```
   result = combined / 2^53
   ```
   The result is a float in `[0, 1)` with full JavaScript floating-point precision.

### Key Implementation Notes

- **SHA-256 is available everywhere:** Node.js (`crypto.createHash`), Bun (same API), browsers (`crypto.subtle.digest` -- async variant), Python (`hashlib.sha256`), Rust (`sha2` crate), Go (`crypto/sha256`).
- **53-bit extraction:** JavaScript's `Number` type has 53 bits of integer precision (IEEE 754 double). We extract exactly 53 bits from the SHA-256 output to avoid precision loss.
- **Big-endian byte order:** The first 8 bytes of the hash are read as two big-endian uint32 values. This is deterministic across platforms.
- **Character encoding:** The input string is UTF-8 encoded before hashing. For ASCII strings (which all NFTLox RNG seeds are), this is equivalent to the raw byte values.

### TypeScript Reference Implementation

```typescript
import { createHash } from "crypto";

function deterministicRng(seed: string, index: number): number {
	const input = `nftlox:rng:${seed}:${index}`;
	const hash = createHash("sha256").update(input).digest();
	const hi = hash.readUInt32BE(0) >>> 11; // top 21 bits
	const lo = hash.readUInt32BE(4);        // next 32 bits = 53 total
	return (hi * 0x100000000 + lo) / 0x20000000000000; // / 2^53
}
```

### Python Reference Implementation

```python
import hashlib
import struct

def deterministic_rng(seed: str, index: int) -> float:
    input_str = f"nftlox:rng:{seed}:{index}"
    h = hashlib.sha256(input_str.encode()).digest()
    hi = struct.unpack(">I", h[0:4])[0] >> 11  # top 21 bits
    lo = struct.unpack(">I", h[4:8])[0]         # next 32 bits
    return (hi * 0x100000000 + lo) / 0x20000000000000
```

---

## 2. resolveDropTable(dropTable, itemCount, rngSeed)

Selects `itemCount` items from a weighted drop table using `deterministicRng`. Each selection is independent (sampling with replacement) -- the same seed can be selected multiple times.

### Inputs

| Parameter | Type | Description |
|-----------|------|-------------|
| `dropTable` | `Array<{ seedId: string, weight: number }>` | Weighted entries. Weight must be > 0. |
| `itemCount` | `number` | How many items to select (e.g., 5 for a 5-card pack). |
| `rngSeed` | `string` | The RNG seed string (see [RNG Seed Format](#3-rng-seed-format)). |

### Algorithm

```
totalWeight = sum of all entry.weight values

for i from 0 to itemCount - 1:
    roll = deterministicRng(rngSeed, i) * totalWeight
    cumulative = 0
    for each entry in dropTable (in order):
        cumulative = cumulative + entry.weight
        if roll < cumulative:
            select entry.seedId
            break
    if nothing selected (floating-point edge case):
        select last entry in dropTable
```

### Properties

- **Deterministic:** Same inputs always produce the same output array, in the same order.
- **With replacement:** An item can be selected more than once. If `resolveDropTable` returns `["seed_A", "seed_A", "seed_B"]`, it means seed A was selected twice.
- **Order matters:** The drop table order affects which entry is selected for a given roll value. Always use the same entry ordering for reproducibility.
- **No size limit:** Unlike `pack_create` (capped at 50 entries), the local drop table can have any number of entries.

### TypeScript Reference Implementation

```typescript
function resolveDropTable(
	dropTable: Array<{ seedId: string; weight: number }>,
	itemCount: number,
	rngSeed: string,
): string[] {
	if (dropTable.length === 0) {
		throw new Error("dropTable cannot be empty");
	}

	const totalWeight = dropTable.reduce((sum, entry) => sum + entry.weight, 0);
	if (totalWeight <= 0) {
		throw new Error("totalWeight must be greater than 0");
	}

	const results: string[] = [];

	for (let i = 0; i < itemCount; i++) {
		const roll = deterministicRng(rngSeed, i) * totalWeight;
		let cumulative = 0;
		let selected = false;

		for (const entry of dropTable) {
			cumulative += entry.weight;
			if (roll < cumulative) {
				results.push(entry.seedId);
				selected = true;
				break;
			}
		}

		if (!selected) {
			results.push(dropTable[dropTable.length - 1]!.seedId);
		}
	}

	return results;
}
```

---

## 3. RNG Seed Format

For pack openings, the RNG seed is constructed from immutable blockchain data:

```
rngSeed = "${transactionId}:${blockNumber}:${signerUsername}"
```

| Component | Source | Example |
|-----------|--------|---------|
| `transactionId` | The Hive transaction ID of the player's payment | `abc123def456789012345678901234567890abcd` |
| `blockNumber` | The block number where the payment was included | `92345678` |
| `signerUsername` | The player's Hive username (who sent the payment) | `player-alice` |

**Example:**
```
abc123def456789012345678901234567890abcd:92345678:player-alice
```

All three components are publicly readable from the Hive blockchain, making the RNG seed fully transparent and auditable.

The format can include an optional context suffix for different use cases:

```
rngSeed = "${transactionId}:${blockNumber}:${signerUsername}:${context}"
```

The `context` field can differentiate between different RNG uses within the same transaction (e.g., `"pack-open"`, `"bonus-roll"`).

---

## 4. Pseudocode

This language-independent pseudocode covers the complete algorithm. Use it to implement the RNG in any language.

```
CONSTANT TWO_POW_53 = 9007199254740992   // 2^53

FUNCTION deterministicRng(seed: STRING, index: INTEGER) -> FLOAT:
    input = "nftlox:rng:" + seed + ":" + toString(index)
    hash = SHA256(input)                    // 32 bytes

    hi = readUint32BigEndian(hash, offset=0) >> 11   // top 21 bits
    lo = readUint32BigEndian(hash, offset=4)          // next 32 bits

    combined = hi * 4294967296 + lo                   // 53-bit integer

    RETURN combined / TWO_POW_53
END FUNCTION


FUNCTION resolveDropTable(
    dropTable: ARRAY OF { seedId: STRING, weight: NUMBER },
    itemCount: INTEGER,
    rngSeed: STRING,
) -> ARRAY OF STRING:

    totalWeight = 0
    FOR EACH entry IN dropTable:
        totalWeight = totalWeight + entry.weight
    END FOR

    results = EMPTY ARRAY

    FOR i FROM 0 TO itemCount - 1:
        roll = deterministicRng(rngSeed, i) * totalWeight
        cumulative = 0

        FOR EACH entry IN dropTable:
            cumulative = cumulative + entry.weight
            IF roll < cumulative:
                APPEND entry.seedId TO results
                BREAK
            END IF
        END FOR

        // Fallback for floating-point edge case
        IF nothing was appended:
            APPEND dropTable[LAST].seedId TO results
        END IF
    END FOR

    RETURN results
END FUNCTION


// Helper: 32-bit wrapping multiply
FUNCTION wrappingMultiply32(a: INTEGER, b: INTEGER) -> INTEGER:
    RETURN (a * b) MOD 2^32    // Keep only low 32 bits
END FUNCTION

// Helper: interpret as signed 32-bit
FUNCTION toSigned32(n: INTEGER) -> INTEGER:
    n = n MOD 2^32
    IF n >= 2^31:
        RETURN n - 2^32
    RETURN n
END FUNCTION

// Helper: interpret as unsigned 32-bit
FUNCTION toUnsigned32(n: INTEGER) -> INTEGER:
    RETURN n MOD 2^32
END FUNCTION
```

### Language-Specific Notes

| Language | Wrapping multiply | Unsigned 32-bit conversion |
|----------|-------------------|---------------------------|
| **JavaScript/TypeScript** | `Math.imul(a, b)` | `(value) >>> 0` |
| **Python** | `(a * b) & 0xFFFFFFFF` | `value & 0xFFFFFFFF` |
| **Rust** | `a.wrapping_mul(b)` on `u32`/`i32` | `value as u32` |
| **C/C++** | Natural `uint32_t` multiply | Cast to `uint32_t` |
| **Go** | Natural `int32` multiply | `uint32(value)` |
| **Java** | Natural `int` multiply (32-bit) | `Integer.toUnsignedLong(value)` |

---

## 5. Test Vectors

Use these test vectors to verify your implementation produces correct results. Run the reference TypeScript implementation from `packages/sdk/src/dna.ts` to generate additional vectors as needed.

### deterministicRng Vectors

| Vector | Input | Expected Output |
|--------|-------|-----------------|
| 1 | `deterministicRng("test-seed", 0)` | `0.6388407883190451` |
| 2 | `deterministicRng("test-seed", 1)` | `0.07153829138479328` |
| 3 | `deterministicRng("test-seed", 2)` | `0.641578527515963` |
| 4 | `deterministicRng("abc123:999:alice", 0)` | `0.9480245541428474` |

**How to manually trace Vector 1:**

Input string: `"nftlox:rng:test-seed:0"`

1. Compute `SHA-256("nftlox:rng:test-seed:0")` to get 32 bytes
2. Read bytes 0-3 as uint32 big-endian, shift right 11 → `hi` (21 bits)
3. Read bytes 4-7 as uint32 big-endian → `lo` (32 bits)
4. `combined = hi * 4294967296 + lo` (53-bit integer)
5. `result = combined / 9007199254740992` (divide by 2^53)
6. Expected: `0.6388407883190451`

### resolveDropTable Vectors

Drop table for all vectors:

```json
[
	{ "seedId": "seed_common", "weight": 100 },
	{ "seedId": "seed_rare",   "weight": 20 },
	{ "seedId": "seed_epic",   "weight": 5 },
	{ "seedId": "seed_legend", "weight": 1 }
]
```

Total weight = 126. Cumulative thresholds: `[0, 100)` → common, `[100, 120)` → rare, `[120, 125)` → epic, `[125, 126)` → legend.

| Vector | Input | Expected Result |
|--------|-------|-----------------|
| A | `resolveDropTable(table, 5, "test-seed")` | `["seed_common", "seed_common", "seed_common", "seed_common", "seed_common"]` |
| B | `resolveDropTable(table, 3, "abc123:999:alice")` | `["seed_rare", "seed_common", "seed_common"]` |
| C | `resolveDropTable(table, 4, "tx123abc:92345678:player1")` | `["seed_rare", "seed_rare", "seed_rare", "seed_common"]` |

### Verification Procedure

1. Implement `deterministicRng` in your target language using SHA-256.
2. Run Vectors 1-4 and compare output to at least 15 decimal places.
3. Implement `resolveDropTable`.
4. Run Vectors A-C and confirm the output arrays match exactly (same seed IDs, same order).
5. If any vector differs, check:
   - Is your SHA-256 implementation producing correct output? (test with a known SHA-256 vector first)
   - Are you reading bytes in big-endian order?
   - Is the right-shift by 11 applied to the first uint32, not the second?
   - Are you using 53-bit precision (not 32-bit)?
