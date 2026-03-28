# RNG Algorithm Reference

This document specifies the NFTLox deterministic RNG algorithm so it can be independently implemented in any programming language. The algorithm is the foundation of trustless pack openings: given the same inputs, any implementation must produce identical outputs.

**Source implementation:** `packages/sdk/src/dna.ts` -- functions `deterministicRng` and `resolveDropTable`.

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

**Algorithm:** Dual-pass FNV-1a 32-bit hash.

### Detailed Steps

1. **Build the input string:**
   ```
   input = "nftlox:rng:" + seed + ":" + toString(index)
   ```

2. **Pass 1 (forward FNV-1a):**
   ```
   hash1 = 2166136261          (FNV offset basis, 32-bit)
   for each byte b in input (left to right):
       hash1 = hash1 XOR b
       hash1 = hash1 * 16777619  (FNV prime, wrapping 32-bit multiply)
   ```

3. **Pass 2 (reverse FNV-1a):**
   ```
   hash2 = 2166136261
   for each byte b in input (right to left):
       hash2 = hash2 XOR b
       hash2 = hash2 * 16777619  (wrapping 32-bit multiply)
   ```

4. **Combine:**
   ```
   combined = (abs(hash1) XOR abs(hash2)) as unsigned 32-bit integer
   ```
   The `abs()` converts the signed 32-bit result to its absolute value before XOR. The `>>> 0` (unsigned right shift by 0) in JavaScript/TypeScript converts the result to an unsigned 32-bit integer.

5. **Normalize:**
   ```
   result = combined / 4294967296   (divide by 2^32)
   ```
   The result is a float in `[0, 1)`.

### Key Implementation Notes

- **Wrapping multiply:** The multiplication `hash * 16777619` must wrap at 32 bits. In JavaScript/TypeScript, use `Math.imul(hash, 16777619)`. In C/Rust, standard `uint32_t` or `u32` multiplication wraps automatically. In Python, apply `& 0xFFFFFFFF` after each multiply.
- **Character encoding:** Input bytes are the Unicode code points of each character. For ASCII strings (which all NFTLox seeds are), this is equivalent to the ASCII byte value.
- **Signed vs unsigned:** FNV-1a produces a signed 32-bit integer in languages like JavaScript. The `Math.abs()` call before XOR, followed by `>>> 0` to convert to unsigned, is critical for consistent results.

### TypeScript Reference Implementation

```typescript
function deterministicRng(seed: string, index: number): number {
	const input = `nftlox:rng:${seed}:${index}`;

	// Pass 1: forward FNV-1a
	let hash1 = 2166136261;
	for (let i = 0; i < input.length; i++) {
		hash1 ^= input.charCodeAt(i);
		hash1 = Math.imul(hash1, 16777619);
	}

	// Pass 2: reverse FNV-1a
	let hash2 = 2166136261;
	for (let i = input.length - 1; i >= 0; i--) {
		hash2 ^= input.charCodeAt(i);
		hash2 = Math.imul(hash2, 16777619);
	}

	// Combine and normalize to [0, 1)
	const combined = (Math.abs(hash1) ^ Math.abs(hash2)) >>> 0;
	return combined / 4294967296;
}
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
CONSTANT FNV_OFFSET = 2166136261
CONSTANT FNV_PRIME  = 16777619
CONSTANT UINT32_MAX = 4294967296   // 2^32

FUNCTION deterministicRng(seed: STRING, index: INTEGER) -> FLOAT:
    input = "nftlox:rng:" + seed + ":" + toString(index)
    bytes = getAsciiBytes(input)
    length = len(bytes)

    // Forward pass
    hash1 = FNV_OFFSET
    FOR i FROM 0 TO length - 1:
        hash1 = hash1 XOR bytes[i]
        hash1 = wrappingMultiply32(hash1, FNV_PRIME)
    END FOR

    // Reverse pass
    hash2 = FNV_OFFSET
    FOR i FROM length - 1 DOWN TO 0:
        hash2 = hash2 XOR bytes[i]
        hash2 = wrappingMultiply32(hash2, FNV_PRIME)
    END FOR

    // Combine: take absolute values, XOR, interpret as unsigned 32-bit
    combined = toUnsigned32(abs(toSigned32(hash1)) XOR abs(toSigned32(hash2)))

    RETURN combined / UINT32_MAX
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

To verify your implementation, run the following against the reference code:

```typescript
import { deterministicRng } from "nftlox-sdk";

// Vector 1
deterministicRng("test-seed", 0);

// Vector 2
deterministicRng("test-seed", 1);

// Vector 3
deterministicRng("test-seed", 2);

// Vector 4: RNG seed in pack-open format
deterministicRng("abc123:999:alice", 0);
```

**How to manually trace Vector 1:**

Input string: `"nftlox:rng:test-seed:0"` (22 characters)

1. Forward FNV-1a: Start with `hash1 = 2166136261`. For each character code point (`n`=110, `f`=102, `t`=116, `l`=108, `o`=111, `x`=120, `:`=58, `r`=114, `n`=110, `g`=103, `:`=58, `t`=116, `e`=101, `s`=115, `t`=116, `-`=45, `s`=115, `e`=101, `e`=101, `d`=100, `:`=58, `0`=48), XOR with hash then multiply by `16777619` with 32-bit wrapping.
2. Reverse FNV-1a: Same process, characters in reverse order.
3. Combined: `(abs(hash1) XOR abs(hash2)) >>> 0`.
4. Result: `combined / 4294967296`.

The exact output value depends on the 32-bit wrapping arithmetic at each step. Use the reference implementation to obtain the precise floating-point result, then compare against your implementation with at least 10 decimal places of precision.

### resolveDropTable Vectors

Use this drop table for all vectors:

```json
[
	{ "seedId": "seed_common", "weight": 100 },
	{ "seedId": "seed_rare",   "weight": 20 },
	{ "seedId": "seed_epic",   "weight": 5 },
	{ "seedId": "seed_legend", "weight": 1 }
]
```

Total weight = 126.

**Vector A:** `resolveDropTable(table, 5, "test-seed")`

For each index 0..4, `deterministicRng("test-seed", i)` produces a float, multiplied by 126 to get the roll. The roll is compared against cumulative weights:
- `[0, 100)` selects `seed_common`
- `[100, 120)` selects `seed_rare`
- `[120, 125)` selects `seed_epic`
- `[125, 126)` selects `seed_legend`

Run the reference implementation to get the exact 5-element result array.

**Vector B:** `resolveDropTable(table, 3, "abc123:999:alice")`

**Vector C:** `resolveDropTable(table, 4, "tx123abc:92345678:player1")`

### Verification Procedure

1. Implement `deterministicRng` in your target language.
2. Run Vectors 1-4 and compare output against the reference TypeScript implementation.
3. Implement `resolveDropTable`.
4. Run Vectors A-C and confirm the output arrays match exactly (same seed IDs, same order).
5. If any vector differs, check:
   - Is your wrapping multiply correct at 32 bits?
   - Are you using `abs()` before XOR?
   - Is unsigned 32-bit conversion applied after XOR?
   - Are input characters treated as their Unicode code point values?
