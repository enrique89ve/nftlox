# Data Formats and Validation

Reference for all field formats, constraints, and accepted values in NFTLox payloads.

---

## artId (Seed Identifier)

The `artId` uniquely identifies a seed template within a collection. It is used to generate deterministic seed IDs.

| Rule | Constraint |
|------|-----------|
| Required | Yes |
| Max length | **14 characters** |
| Allowed characters | Letters (a-z, A-Z), numbers (0-9), hyphens (-) |
| No repeated hyphens | `--` is not allowed |
| No leading/trailing hyphens | `-foo` and `foo-` are invalid |
| Case-insensitive for duplicates | `CARD-001` and `card-001` are treated as the same |

**Valid examples:**

```
odin-allfather    (14 chars, max length)
CARD-001          (8 chars)
20001             (5 chars, numeric only)
fire-drg-001      (12 chars)
a1b2c3            (6 chars)
```

**Invalid examples:**

```
fire-dragon-001   (15 chars, exceeds 14 limit)
earth-shield-001  (16 chars, exceeds 14 limit)
--double          (repeated hyphens)
-leading          (starts with hyphen)
trailing-         (ends with hyphen)
special!char      (invalid character)
```

**Tip:** For card games with many cards, use short numeric IDs (`20001`, `00437`) or abbreviated names (`FRE-DRG-001`).

---

## Image URL

The `imageUrl` field stores a link to the NFT's visual representation.

| Rule | Constraint |
|------|-----------|
| Required | Yes (for mint) |
| Max length | **500 characters** |
| Format | Valid HTTPS URL |
| Protocol | `https://` required (`http://` rejected by Zod `.url()`) |

### Recommended Image Hosts

| Host | URL Pattern | Notes |
|------|-------------|-------|
| PeakD | `https://files.peakd.com/file/peakd-hive/username/hash.png` | Hive-native, permanent |
| IPFS | `https://ipfs.io/ipfs/Qm...` | Decentralized, use a pinning service |
| GitHub Pages | `https://user.github.io/repo/art/001.webp` | Free, good for static assets |
| Cloudflare R2 | `https://pub-xxx.r2.dev/image.png` | Fast CDN, free egress |
| Imgur | `https://i.imgur.com/hash.png` | Simple, may remove inactive images |

### Recommended Image Formats

| Format | Extension | Best For |
|--------|-----------|----------|
| **WebP** | `.webp` | Best compression/quality ratio, recommended default |
| **PNG** | `.png` | Pixel art, transparency, lossless |
| **JPEG** | `.jpg` | Photos, gradients |
| **SVG** | `.svg` | Vector graphics, icons |
| **GIF** | `.gif` | Animated NFTs (small file size) |

### imageHash (Optional)

If you provide `imageHash`, it is stored as-is for integrity verification. If omitted, the SDK auto-generates one via `generateImageHash(imageUrl)`. The hash is NOT a content hash of the image file -- it's a protocol-level identifier.

---

## Collection Fields

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `name` | string | Yes | 1-100 characters |
| `symbol` | string | Yes | 3-8 characters, uppercase A-Z and 0-9 only (`/^[A-Z0-9]{3,8}$/`) |
| `creator` | string | Yes | Valid Hive username |
| `totalPotential` | number | Yes | Non-negative integer (0 = unlimited) |
| `metadata.description` | string | Yes | 1-250 characters |
| `metadata.image` | string | Yes | Valid URL, max 500 chars |
| `metadata.externalUrl` | string | No | Valid URL |
| `rules.transferable` | boolean | Yes | Whether NFTs can be transferred |
| `rules.burnable` | boolean | Yes | Whether NFTs can be burned |
| `rules.replicable` | boolean | Yes | Whether NFTs can be replicated |
| `rules.royaltyPct` | number | Yes | 0-50 |
| `rules.royaltyRecipient` | string | No | Valid Hive username |

### Symbol Examples

```
Valid:   RGNRK, DMTCG, NFT1, AB3, ABCDEFGH
Invalid: rgnrk (lowercase), AB (too short), ABCDEFGHI (too long), NFT-1 (hyphen)
```

---

## Schema Definition

Collections can define a typed schema with immutable and mutable fields. If a schema is defined, `set_data` and `set_data_from` validate data against it.

### Supported Field Types

**Scalar types:**

| Type | Range / Description |
|------|---------------------|
| `string` | Any text |
| `bool` | true / false |
| `uint8` | 0 to 255 |
| `uint16` | 0 to 65,535 |
| `uint32` | 0 to 4,294,967,295 |
| `uint64` | 0 to Number.MAX_SAFE_INTEGER |
| `int8` | -128 to 127 |
| `int16` | -32,768 to 32,767 |
| `int32` | -2,147,483,648 to 2,147,483,647 |
| `int64` | Number.MIN_SAFE_INTEGER to Number.MAX_SAFE_INTEGER |
| `float` | IEEE 754 float |
| `double` | IEEE 754 double |

**Array types:** Append `[]` to any scalar type: `string[]`, `uint8[]`, `bool[]`, etc.

### Schema Limits

| Limit | Value |
|-------|-------|
| Max fields (total) | 64 |
| Max field name length | 64 characters |
| Mutable fields required | At least 1 if schema is defined |

### Schema Example (Card Game)

```json
{
	"schema": {
		"immutable": [
			{ "name": "card_id", "type": "uint32" },
			{ "name": "name", "type": "string" },
			{ "name": "rarity", "type": "string" },
			{ "name": "attack", "type": "uint16" },
			{ "name": "health", "type": "uint16" },
			{ "name": "mana_cost", "type": "uint8" },
			{ "name": "keywords", "type": "string[]" }
		],
		"mutable": [
			{ "name": "level", "type": "uint8" },
			{ "name": "xp", "type": "uint32" },
			{ "name": "foil", "type": "string" }
		]
	}
}
```

**Immutable fields** are set at mint time and inherited by all instances. They can never be changed.

**Mutable fields** can be updated via `set_data` (creator) or `set_data_from` (approved operator).

---

## Seed JSON Format

### Minimal Seed (No Schema)

```json
{
	"artId": "MY-NFT-001",
	"name": "My First NFT",
	"brief": "Description of this NFT seed",
	"imageUrl": "https://example.com/image.png",
	"maxSupply": 100
}
```

### Seed with Typed Data (Schema Required)

```json
{
	"artId": "FIRE-DRG-001",
	"name": "Inferno Drake",
	"brief": "Legendary fire dragon with devastating flame attacks",
	"imageUrl": "https://files.peakd.com/file/peakd-hive/user/hash.png",
	"maxSupply": 50,
	"immutableData": {
		"card_id": 1001,
		"rarity": "legendary",
		"attack": 3200,
		"health": 2800,
		"mana_cost": 8,
		"keywords": ["battlecry", "taunt"]
	}
}
```

### Batch Seed File (Array)

For minting multiple seeds at once, provide an array:

```json
[
	{
		"artId": "CARD-001",
		"name": "Fire Dragon",
		"brief": "A powerful dragon",
		"imageUrl": "https://cdn.example.com/001.webp",
		"maxSupply": 250,
		"immutableData": { "card_id": 1, "rarity": "mythic", "attack": 7, "health": 7 }
	},
	{
		"artId": "CARD-002",
		"name": "Ice Golem",
		"brief": "A frozen sentinel",
		"imageUrl": "https://cdn.example.com/002.webp",
		"maxSupply": 500,
		"immutableData": { "card_id": 2, "rarity": "epic", "attack": 4, "health": 8 }
	}
]
```

### Field Reference

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `artId` | string | Yes | 1-14 chars, alphanumeric + hyphens (see rules above) |
| `name` | string | Yes | 1-100 characters |
| `brief` | string | No | Max 250 characters |
| `imageUrl` | string | Yes | Valid HTTPS URL, max 500 chars |
| `maxSupply` | number | Yes | Positive integer (how many instances can be distributed) |
| `immutableData` | object | No | Must match collection schema if schema is defined |

---

## Hive Username

| Rule | Constraint |
|------|-----------|
| Length | 3-16 characters total |
| Segments | Dot-separated, each segment >= 3 chars |
| Characters | Lowercase letters, digits, hyphens |
| Start | Each segment starts with lowercase letter |
| End | Each segment ends with lowercase letter or digit |

**Valid:** `enrique89`, `ragnarok-admin`, `my.account`

**Invalid:** `ab` (too short), `My_Account` (uppercase, underscore), `123user` (starts with digit)

---

## Price Format

Used for marketplace listings and pack pricing.

```json
{
	"amount": "10.000",
	"currency": "HIVE"
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `amount` | string | Hive decimal format: `X.YYY` (exactly 3 decimal places) |
| `currency` | string | `"HIVE"` or `"HBD"` only |

**Minimum amount:** `0.001`

**Valid:** `"10.000"`, `"0.001"`, `"999.999"`

**Invalid:** `"10"` (no decimals), `"10.0"` (not 3 decimals), `"0.0001"` (too many decimals)

---

## Protocol Limits Summary

| Limit | Value |
|-------|-------|
| Max JSON payload | 7,372 bytes (90% of 8KB) |
| Max operations per Hive tx | 5 |
| Max name length | 100 chars |
| Max description length | 250 chars |
| Max image URL length | 500 chars |
| Max schema fields | 64 |
| Max field name length | 64 chars |
| Max artId length | 14 chars |
| Symbol length | 3-8 chars |
| Max royalty | 50% |
| Protocol fee | 1.0% (paid to co-signing node on every sale) |
| Max drop table entries | 50 (pack_create only) |
| Max items per pack | 20 |
| Max pack open batch | 50 |
| Max bulk distribute items | 50 |
| Min price | 0.001 HIVE/HBD |
