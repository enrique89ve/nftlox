// NFTLox Schema Templates & Builder
// Pre-built schemas for common use cases + fluent API for custom schemas.

import type { CollectionSchema, SchemaField, SchemaFieldType } from "./types";

// ============ PRE-BUILT TEMPLATES ============

export const GAMING_SCHEMA: CollectionSchema = {
	immutable: [
		{ name: "rarity", type: "string" },
		{ name: "element", type: "string" },
		{ name: "base_power", type: "uint32" },
		{ name: "class", type: "string" },
	],
	mutable: [
		{ name: "level", type: "uint16" },
		{ name: "xp", type: "uint32" },
		{ name: "health", type: "uint32" },
		{ name: "wins", type: "uint32" },
		{ name: "losses", type: "uint32" },
		{ name: "equipped", type: "string[]" },
	],
} as const;

export const ART_SCHEMA: CollectionSchema = {
	immutable: [
		{ name: "artist", type: "string" },
		{ name: "medium", type: "string" },
		{ name: "year", type: "uint16" },
		{ name: "edition_of", type: "uint16" },
		{ name: "dimensions", type: "string" },
	],
	mutable: [
		{ name: "exhibition", type: "string" },
		{ name: "certificate_url", type: "string" },
	],
} as const;

export const COLLECTIBLE_SCHEMA: CollectionSchema = {
	immutable: [
		{ name: "rarity", type: "string" },
		{ name: "series", type: "string" },
		{ name: "card_number", type: "uint32" },
		{ name: "total_in_series", type: "uint32" },
	],
	mutable: [
		{ name: "condition", type: "string" },
		{ name: "grade", type: "uint8" },
	],
} as const;

export const MUSIC_SCHEMA: CollectionSchema = {
	immutable: [
		{ name: "artist", type: "string" },
		{ name: "album", type: "string" },
		{ name: "track_number", type: "uint8" },
		{ name: "duration_seconds", type: "uint32" },
		{ name: "genre", type: "string" },
	],
	mutable: [
		{ name: "play_count", type: "uint32" },
		{ name: "license_url", type: "string" },
	],
} as const;

// ============ RAGNAROK CARD GAME TEMPLATES ============
// Based on Norse Mythos card game mechanics:
// - 8 card types (minion, spell, weapon, artifact, armor, hero, pet, token)
// - 12 hero classes, 10 races, 6 Norse mechanics
// - 3-stage pet evolution system
// - Leveling system with XP from ranked matches

/** Minion/Creature cards - the core unit with attack/health stats */
export const RAGNAROK_MINION_SCHEMA: CollectionSchema = {
	immutable: [
		{ name: "card_id", type: "uint32" },
		{ name: "card_type", type: "string" },
		{ name: "mana_cost", type: "uint8" },
		{ name: "rarity", type: "string" },
		{ name: "hero_class", type: "string" },
		{ name: "race", type: "string" },
		{ name: "base_attack", type: "uint16" },
		{ name: "base_health", type: "uint16" },
		{ name: "keywords", type: "string[]" },
		{ name: "collectible", type: "bool" },
		{ name: "edition", type: "string" },
		{ name: "foil", type: "string" },
	],
	mutable: [
		{ name: "level", type: "uint8" },
		{ name: "xp", type: "uint32" },
		{ name: "wins", type: "uint32" },
		{ name: "losses", type: "uint32" },
	],
} as const;

/** Spell cards - instant effects, no attack/health */
export const RAGNAROK_SPELL_SCHEMA: CollectionSchema = {
	immutable: [
		{ name: "card_id", type: "uint32" },
		{ name: "card_type", type: "string" },
		{ name: "mana_cost", type: "uint8" },
		{ name: "rarity", type: "string" },
		{ name: "hero_class", type: "string" },
		{ name: "spell_effect", type: "string" },
		{ name: "keywords", type: "string[]" },
		{ name: "collectible", type: "bool" },
		{ name: "edition", type: "string" },
		{ name: "foil", type: "string" },
	],
	mutable: [
		{ name: "level", type: "uint8" },
		{ name: "xp", type: "uint32" },
	],
} as const;

/** Weapon cards - equippable items with attack/durability */
export const RAGNAROK_WEAPON_SCHEMA: CollectionSchema = {
	immutable: [
		{ name: "card_id", type: "uint32" },
		{ name: "card_type", type: "string" },
		{ name: "mana_cost", type: "uint8" },
		{ name: "rarity", type: "string" },
		{ name: "hero_class", type: "string" },
		{ name: "base_attack", type: "uint16" },
		{ name: "durability", type: "uint8" },
		{ name: "keywords", type: "string[]" },
		{ name: "edition", type: "string" },
		{ name: "foil", type: "string" },
	],
	mutable: [
		{ name: "level", type: "uint8" },
		{ name: "xp", type: "uint32" },
	],
} as const;

/** Pet cards - 3-stage evolution system with elements */
export const RAGNAROK_PET_SCHEMA: CollectionSchema = {
	immutable: [
		{ name: "card_id", type: "uint32" },
		{ name: "card_type", type: "string" },
		{ name: "mana_cost", type: "uint8" },
		{ name: "rarity", type: "string" },
		{ name: "pet_family", type: "string" },
		{ name: "element", type: "string" },
		{ name: "pet_stage", type: "uint8" },
		{ name: "base_attack", type: "uint16" },
		{ name: "base_health", type: "uint16" },
		{ name: "evolves_into", type: "uint32" },
		{ name: "evolves_from", type: "uint32" },
		{ name: "evolution_trigger", type: "string" },
		{ name: "keywords", type: "string[]" },
		{ name: "edition", type: "string" },
		{ name: "foil", type: "string" },
	],
	mutable: [
		{ name: "level", type: "uint8" },
		{ name: "xp", type: "uint32" },
		{ name: "evolution_progress", type: "uint16" },
	],
} as const;

/** Armor cards - slot-based gear (helm/chest/greaves) */
export const RAGNAROK_ARMOR_SCHEMA: CollectionSchema = {
	immutable: [
		{ name: "card_id", type: "uint32" },
		{ name: "card_type", type: "string" },
		{ name: "mana_cost", type: "uint8" },
		{ name: "rarity", type: "string" },
		{ name: "armor_slot", type: "string" },
		{ name: "armor_value", type: "uint8" },
		{ name: "set_id", type: "string" },
		{ name: "passive_type", type: "string" },
		{ name: "edition", type: "string" },
		{ name: "foil", type: "string" },
	],
	mutable: [
		{ name: "level", type: "uint8" },
		{ name: "xp", type: "uint32" },
	],
} as const;

/** Hero cards - playable characters with class and hero power */
export const RAGNAROK_HERO_SCHEMA: CollectionSchema = {
	immutable: [
		{ name: "card_id", type: "uint32" },
		{ name: "card_type", type: "string" },
		{ name: "rarity", type: "string" },
		{ name: "hero_class", type: "string" },
		{ name: "mythology", type: "string" },
		{ name: "hero_power_id", type: "uint32" },
		{ name: "base_health", type: "uint16" },
		{ name: "keywords", type: "string[]" },
		{ name: "edition", type: "string" },
		{ name: "foil", type: "string" },
	],
	mutable: [
		{ name: "level", type: "uint8" },
		{ name: "xp", type: "uint32" },
		{ name: "wins", type: "uint32" },
		{ name: "losses", type: "uint32" },
		{ name: "elo_rating", type: "uint32" },
	],
} as const;

// ============ FLUENT SCHEMA BUILDER ============

type SchemaBuilderState = {
	readonly immutable: SchemaField[];
	readonly mutable: SchemaField[];
};

type SchemaBuilder = {
	readonly immutable: (name: string, type: SchemaFieldType) => SchemaBuilder;
	readonly mutable: (name: string, type: SchemaFieldType) => SchemaBuilder;
	readonly build: () => CollectionSchema;
};

export function createSchemaBuilder(): SchemaBuilder {
	const state: SchemaBuilderState = { immutable: [], mutable: [] };

	const builder: SchemaBuilder = {
		immutable: (name: string, type: SchemaFieldType) => {
			state.immutable.push({ name, type });
			return builder;
		},
		mutable: (name: string, type: SchemaFieldType) => {
			state.mutable.push({ name, type });
			return builder;
		},
		build: () => ({
			immutable: [...state.immutable],
			mutable: [...state.mutable],
		}),
	};

	return builder;
}
