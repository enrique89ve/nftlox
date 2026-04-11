// Scenario routes — step-by-step operation sequences for common game use cases
//
// These endpoints return pre-built payloads that demonstrate how a game server
// would use NFTLox in custodial mode (players don't need Hive accounts).

import {
	PROTOCOL_VERSION,
	PROTOCOL_ID,
	generateDeterministicCollectionId,
	generateDeterministicSeedId,
	generateDeterministicInstanceId,
	generateOriginDna,
} from "nftlox-sdk";

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json" },
	});

// ============ SHARED CONSTANTS ============

const GAME_ACCOUNT = "game-server";
const COLLECTION_NAME = "Dragon Masters TCG";
const COLLECTION_SYMBOL = "DMTCG";

const COLLECTION_ID = await generateDeterministicCollectionId(GAME_ACCOUNT, COLLECTION_NAME, COLLECTION_SYMBOL);
const ORIGIN_DNA = await generateOriginDna(COLLECTION_ID);

const SEED_IDS = {
	fireDragon: await generateDeterministicSeedId(COLLECTION_ID, "FIRE-DRAGON-001"),
	iceGolem: await generateDeterministicSeedId(COLLECTION_ID, "ICE-GOLEM-001"),
	windSpell: await generateDeterministicSeedId(COLLECTION_ID, "WIND-SPELL-001"),
	earthShield: await generateDeterministicSeedId(COLLECTION_ID, "EARTH-SHIELD-001"),
	starterWolf: await generateDeterministicSeedId(COLLECTION_ID, "STARTER-WOLF-001"),
};

const INSTANCE_IDS = {
	starterWolf1: await generateDeterministicInstanceId(SEED_IDS.starterWolf, 1),
	starterWolf2: await generateDeterministicInstanceId(SEED_IDS.starterWolf, 2),
	starterWolf3: await generateDeterministicInstanceId(SEED_IDS.starterWolf, 3),
	fireDragon1: await generateDeterministicInstanceId(SEED_IDS.fireDragon, 1),
	iceGolem1: await generateDeterministicInstanceId(SEED_IDS.iceGolem, 1),
};

const PLAYERS = {
	player1: "p_a1b2c3d4e5f6",
	player2: "p_f6e5d4c3b2a1",
	player3: "p_x7y8z9w0v1u2",
};

// ============ SCHEMA ============

const GAME_SCHEMA = {
	immutable: [
		{ name: "card_type", type: "string" },
		{ name: "element", type: "string" },
		{ name: "rarity", type: "string" },
		{ name: "base_attack", type: "uint16" },
		{ name: "base_defense", type: "uint16" },
	],
	mutable: [
		{ name: "game_owner", type: "string" },
		{ name: "level", type: "uint8" },
		{ name: "xp", type: "uint32" },
		{ name: "wins", type: "uint32" },
		{ name: "lent_to", type: "string" },
		{ name: "equipped", type: "bool" },
		{ name: "custom_name", type: "string" },
	],
};

// ============ HELPER ============

function buildCustomJson(signer: string, action: string, data: unknown) {
	return [
		"custom_json",
		{
			required_auths: [],
			required_posting_auths: [signer],
			id: PROTOCOL_ID,
			json: JSON.stringify({
				protocol: PROTOCOL_ID,
				version: PROTOCOL_VERSION,
				action,
				data,
			}),
		},
	];
}

// ============ SCENARIO ROUTES ============

type RouteHandler = (req: Request) => Response | Promise<Response>;

export const scenarioRoutes: Record<string, RouteHandler> = {

	// ── Index: list all scenarios ──────────────────────────────────
	"/api/scenarios": () => json({
		title: "NFTLox Game Scenarios",
		description: "Step-by-step operation sequences for common game use cases. All scenarios use a custodial model where the game server (game-server) owns all NFTs on-chain.",
		gameAccount: GAME_ACCOUNT,
		collectionId: COLLECTION_ID,
		seedIds: SEED_IDS,
		scenarios: [
			{
				id: "setup",
				name: "Game Setup (Custodial)",
				description: "Create collection with schema, mint card seeds, distribute instances to the game server",
				endpoint: "/api/scenarios/setup",
			},
			{
				id: "assign-cards",
				name: "Assign Cards to Players",
				description: "Game assigns cards to players by updating mutableData.game_owner with their in-game hash ID",
				endpoint: "/api/scenarios/assign-cards",
			},
			{
				id: "lend-cards",
				name: "Lend Starter Cards",
				description: "Game lends free starter cards to new players so they can play without owning any cards",
				endpoint: "/api/scenarios/lend-cards",
			},
			{
				id: "in-game-trade",
				name: "In-Game Trading",
				description: "Players trade cards between each other — the game server updates mutableData to reflect the new owner",
				endpoint: "/api/scenarios/in-game-trade",
			},
			{
				id: "level-up",
				name: "Level Up & Stats Update",
				description: "Game updates card stats (level, XP, wins) after matches",
				endpoint: "/api/scenarios/level-up",
			},
			{
				id: "graduation",
				name: "Player Graduation to Web3",
				description: "Player creates a Hive account and receives real on-chain ownership. Then delegates back to the game.",
				endpoint: "/api/scenarios/graduation",
			},
		],
	}),

	// ── Scenario 1: Game Setup ────────────────────────────────────
	"/api/scenarios/setup": () => json({
		scenario: "Game Setup (Custodial)",
		description: "The game server creates a collection with a typed schema, mints card seeds, and distributes instances to itself. No player accounts needed.",
		gameAccount: GAME_ACCOUNT,
		generatedIds: {
			collectionId: COLLECTION_ID,
			originDna: ORIGIN_DNA,
			seedIds: SEED_IDS,
		},
		steps: [
			{
				step: 1,
				action: "create_collection",
				description: "Create the card game collection with immutable and mutable schema fields",
				endpoint: "POST /api/build/collection",
				payload: {
					creator: GAME_ACCOUNT,
					name: COLLECTION_NAME,
					symbol: COLLECTION_SYMBOL,
					description: "Dragon Masters Trading Card Game — fully on-chain card game",
					imageUrl: "https://example.com/dragon-masters-logo.png",
					totalPotential: 100000,
					transferable: true,
					burnable: true,
					royaltyPct: 5,
					royaltyRecipient: GAME_ACCOUNT,
					schema: GAME_SCHEMA,
				},
				notes: [
					"schema.immutable: card stats that NEVER change (type, element, rarity, base stats)",
					"schema.mutable: game state that changes constantly (owner, level, xp, lending status)",
					"transferable: true allows future graduation to real player accounts",
				],
			},
			{
				step: 2,
				action: "mint (seeds)",
				description: "Mint each card type as a seed NFT. Seeds define the template; instances are the actual cards players hold.",
				endpoint: "POST /api/build/seeds",
				payload: {
					collectionId: COLLECTION_ID,
					owner: GAME_ACCOUNT,
					seeds: [
						{
							artId: "FIRE-DRAGON-001",
							name: "Inferno Drake",
							imageUrl: "https://example.com/inferno-drake.png",
							maxSupply: 50,
						},
						{
							artId: "STARTER-WOLF-001",
							name: "Shadow Wolf",
							imageUrl: "https://example.com/shadow-wolf.png",
							maxSupply: 50000,
						},
					],
				},
				notes: [
					"maxSupply controls scarcity: Legendary=50, Starter=50000",
					"artId is deterministic — re-minting with same artId is idempotent",
				],
			},
			{
				step: 3,
				action: "bulk_distribute",
				description: "Pre-mint instances WITHOUT a recipient. The game server becomes the owner of all instances.",
				endpoint: "POST /api/build/bulk-distribute",
				payload: {
					signer: GAME_ACCOUNT,
					items: [
						{ seedId: SEED_IDS.starterWolf, quantity: 100, seedTxId: "<seed mint txid>" },
						{ seedId: SEED_IDS.fireDragon, quantity: 10, seedTxId: "<seed mint txid>" },
					],
					mutableData: {
						game_owner: "",
						level: 1,
						xp: 0,
						wins: 0,
						lent_to: "",
						equipped: false,
						custom_name: "",
					},
				},
				notes: [
					"NO 'to' field = owner defaults to the signer (game-server)",
					"All 110 instances are owned by game-server on-chain",
					"mutableData initializes every card at level 1 with no in-game owner",
					"game_owner is empty — cards sit in the game's 'vault' until assigned",
				],
			},
		],
	}),

	// ── Scenario 2: Assign Cards to Players ───────────────────────
	"/api/scenarios/assign-cards": () => json({
		scenario: "Assign Cards to Players",
		description: "When a player earns or buys a card in-game, the game server updates mutableData.game_owner to their player hash. The on-chain owner is still the game server.",
		steps: [
			{
				step: 1,
				action: "set_data",
				description: "Player 1 wins a match and earns the Inferno Drake card",
				endpoint: "POST /api/build/set-data",
				payload: {
					issuer: GAME_ACCOUNT,
					nftId: INSTANCE_IDS.fireDragon1,
					instanceDna: "will-be-filled-by-indexer",
					mutableData: {
						game_owner: PLAYERS.player1,
					},
				},
				notes: [
					"Only mutableData.game_owner changes — other fields (level, xp) stay as-is",
					"The game server signs this as the collection creator",
					"Player 1 never touches blockchain — they just see 'You earned Inferno Drake!' in the game UI",
				],
			},
			{
				step: 2,
				action: "set_data",
				description: "New player 2 registers and receives a free starter card",
				endpoint: "POST /api/build/set-data",
				payload: {
					issuer: GAME_ACCOUNT,
					nftId: INSTANCE_IDS.starterWolf1,
					instanceDna: "will-be-filled-by-indexer",
					mutableData: {
						game_owner: PLAYERS.player2,
					},
				},
				notes: [
					"The game server just flips game_owner from '' to the player's hash ID",
					"Player thinks they 'got a free card' — they don't know it's an NFT on Hive",
				],
			},
			{
				step: 3,
				action: "set_data (batch)",
				description: "Player 3 registers and gets 3 starter cards at once",
				endpoint: "POST /api/build/set-data (called 3 times)",
				payloads: [
					{
						issuer: GAME_ACCOUNT,
						nftId: INSTANCE_IDS.starterWolf1,
						instanceDna: "will-be-filled-by-indexer",
						mutableData: { game_owner: PLAYERS.player3 },
					},
					{
						issuer: GAME_ACCOUNT,
						nftId: INSTANCE_IDS.starterWolf2,
						instanceDna: "will-be-filled-by-indexer",
						mutableData: { game_owner: PLAYERS.player3 },
					},
					{
						issuer: GAME_ACCOUNT,
						nftId: INSTANCE_IDS.starterWolf3,
						instanceDna: "will-be-filled-by-indexer",
						mutableData: { game_owner: PLAYERS.player3 },
					},
				],
				notes: [
					"Each set_data is a separate custom_json operation",
					"Can batch up to 5 per Hive transaction to save block space",
				],
			},
		],
	}),

	// ── Scenario 3: Lend Starter Cards ────────────────────────────
	"/api/scenarios/lend-cards": () => json({
		scenario: "Lend Starter Cards",
		description: "The game lends free starter cards to new players so they can try the game. Lending is tracked via mutableData — NO on-chain lending needed since the game owns everything.",
		keyInsight: "In custodial mode, 'lending' is just a mutableData flag. The game owns the NFT on-chain, so it controls everything via set_data.",
		steps: [
			{
				step: 1,
				action: "set_data",
				description: "Game lends 2 starter cards to a trial player",
				endpoint: "POST /api/build/set-data",
				payloads: [
					{
						issuer: GAME_ACCOUNT,
						nftId: INSTANCE_IDS.starterWolf1,
						instanceDna: "will-be-filled-by-indexer",
						mutableData: {
							game_owner: "",
							lent_to: PLAYERS.player1,
						},
					},
					{
						issuer: GAME_ACCOUNT,
						nftId: INSTANCE_IDS.starterWolf2,
						instanceDna: "will-be-filled-by-indexer",
						mutableData: {
							game_owner: "",
							lent_to: PLAYERS.player1,
						},
					},
				],
				notes: [
					"game_owner stays empty — the player does NOT own the card",
					"lent_to marks who is currently using the card",
					"The game UI shows these cards in the player's 'Borrowed' section",
					"The game server enforces: borrowed cards cannot be traded",
				],
			},
			{
				step: 2,
				action: "set_data",
				description: "Player finishes trial — game reclaims the lent cards",
				endpoint: "POST /api/build/set-data",
				payloads: [
					{
						issuer: GAME_ACCOUNT,
						nftId: INSTANCE_IDS.starterWolf1,
						instanceDna: "will-be-filled-by-indexer",
						mutableData: {
							lent_to: "",
						},
					},
					{
						issuer: GAME_ACCOUNT,
						nftId: INSTANCE_IDS.starterWolf2,
						instanceDna: "will-be-filled-by-indexer",
						mutableData: {
							lent_to: "",
						},
					},
				],
				notes: [
					"Clearing lent_to returns the cards to the game's vault",
					"Cards are now available to lend to another player",
					"All of this is a single on-chain operation — instant and cheap",
				],
			},
			{
				step: 3,
				action: "set_data",
				description: "Trial player liked the game — game assigns them their own starter cards",
				endpoint: "POST /api/build/set-data",
				payloads: [
					{
						issuer: GAME_ACCOUNT,
						nftId: INSTANCE_IDS.starterWolf3,
						instanceDna: "will-be-filled-by-indexer",
						mutableData: {
							game_owner: PLAYERS.player1,
							lent_to: "",
						},
					},
				],
				notes: [
					"Now player1 OWNS the card (game_owner = their hash)",
					"lent_to is empty — this is their card, not borrowed",
					"Player sees 'You received Shadow Wolf!' in the game UI",
				],
			},
		],
		gameLogic: {
			description: "The game server enforces these rules in its own code — NOT in the NFTLox protocol:",
			rules: [
				"Cards with lent_to != '' cannot be traded by the borrower",
				"Cards with lent_to != '' can be reclaimed at any time by the game",
				"Lent cards don't count toward the borrower's collection stats",
				"Only cards with game_owner == player hash can be traded or customized",
			],
		},
	}),

	// ── Scenario 4: In-Game Trading ───────────────────────────────
	"/api/scenarios/in-game-trade": () => json({
		scenario: "In-Game Trading",
		description: "Players trade cards between each other within the game. The game server executes the swap by updating mutableData. Players just click 'Trade' in the UI.",
		steps: [
			{
				step: 1,
				action: "set_data",
				description: "Player 1 trades their Inferno Drake to Player 2 for an Ice Golem",
				endpoint: "POST /api/build/set-data (called 2 times atomically)",
				payloads: [
					{
						_label: "Transfer Inferno Drake: Player 1 → Player 2",
						issuer: GAME_ACCOUNT,
						nftId: INSTANCE_IDS.fireDragon1,
						instanceDna: "will-be-filled-by-indexer",
						mutableData: {
							game_owner: PLAYERS.player2,
						},
					},
					{
						_label: "Transfer Ice Golem: Player 2 → Player 1",
						issuer: GAME_ACCOUNT,
						nftId: INSTANCE_IDS.iceGolem1,
						instanceDna: "will-be-filled-by-indexer",
						mutableData: {
							game_owner: PLAYERS.player1,
						},
					},
				],
				notes: [
					"Both set_data operations go in the SAME Hive transaction",
					"Since both update mutableData on NFTs owned by the game server, both will succeed or the game server has a bug in its own payload construction",
					"On-chain owner (game-server) never changes — only mutableData.game_owner changes",
					"Players just see 'Trade complete!' in the game UI",
					"Note: Hive transactions are NOT atomic at the NFTLox protocol level — if the second operation has invalid data, the first may still be applied. The game server should validate payloads before broadcasting.",
				],
			},
			{
				step: 2,
				action: "set_data",
				description: "Player 2 sells a card to Player 3 for in-game currency",
				endpoint: "POST /api/build/set-data",
				payload: {
					_label: "Transfer Starter Wolf: Player 2 → Player 3",
					issuer: GAME_ACCOUNT,
					nftId: INSTANCE_IDS.starterWolf1,
					instanceDna: "will-be-filled-by-indexer",
					mutableData: {
						game_owner: PLAYERS.player3,
					},
				},
				notes: [
					"The game charges in-game currency (gold, gems) in its own database",
					"NFTLox only records the ownership change on-chain",
					"This is a 'sale' for the players, but on-chain it's just a data update",
				],
			},
		],
		atomicSwaps: {
			description: "Both set_data calls go in one Hive transaction (max 5 operations per tx). Since the game server owns all NFTs and controls the payloads, failures should only happen due to bugs in payload construction. Validate payloads before broadcasting.",
			example: buildCustomJson(GAME_ACCOUNT, "set_data", {
				nftId: "<instance_id>",
				instanceDna: "<dna>",
				mutableData: { game_owner: "<new_player_hash>" },
			}),
		},
	}),

	// ── Scenario 5: Level Up & Stats ──────────────────────────────
	"/api/scenarios/level-up": () => json({
		scenario: "Level Up & Stats Update",
		description: "After matches, the game server updates card stats on-chain. This creates an immutable audit trail of player progression.",
		steps: [
			{
				step: 1,
				action: "set_data",
				description: "Player 1 wins a match — their Inferno Drake levels up",
				endpoint: "POST /api/build/set-data",
				payload: {
					issuer: GAME_ACCOUNT,
					nftId: INSTANCE_IDS.fireDragon1,
					instanceDna: "will-be-filled-by-indexer",
					mutableData: {
						level: 5,
						xp: 2450,
						wins: 12,
					},
				},
				notes: [
					"Only the changed fields are included in mutableData",
					"game_owner, lent_to, equipped are NOT included — they stay as-is",
					"Each update is recorded on-chain with block number and tx hash",
				],
			},
			{
				step: 2,
				action: "set_data",
				description: "Player 1 equips their card and gives it a custom name",
				endpoint: "POST /api/build/set-data",
				payload: {
					issuer: GAME_ACCOUNT,
					nftId: INSTANCE_IDS.fireDragon1,
					instanceDna: "will-be-filled-by-indexer",
					mutableData: {
						equipped: true,
						custom_name: "Blaze King",
					},
				},
			},
			{
				step: 3,
				action: "set_data (batch after tournament)",
				description: "Tournament ends — game updates multiple cards at once",
				endpoint: "POST /api/build/set-data (batch of 5)",
				payloads: [
					{ issuer: GAME_ACCOUNT, nftId: INSTANCE_IDS.fireDragon1, instanceDna: "from-indexer", mutableData: { wins: 20, xp: 5000, level: 8 } },
					{ issuer: GAME_ACCOUNT, nftId: INSTANCE_IDS.iceGolem1, instanceDna: "from-indexer", mutableData: { wins: 15, xp: 3800, level: 6 } },
					{ issuer: GAME_ACCOUNT, nftId: INSTANCE_IDS.starterWolf1, instanceDna: "from-indexer", mutableData: { wins: 8, xp: 1200, level: 3 } },
					{ issuer: GAME_ACCOUNT, nftId: INSTANCE_IDS.starterWolf2, instanceDna: "from-indexer", mutableData: { wins: 5, xp: 800, level: 2 } },
					{ issuer: GAME_ACCOUNT, nftId: INSTANCE_IDS.starterWolf3, instanceDna: "from-indexer", mutableData: { wins: 3, xp: 400, level: 2 } },
				],
				notes: [
					"5 set_data operations fit in 1 Hive transaction",
					"Game server batches updates after each match or tournament",
					"On-chain: immutable audit trail of all stat changes",
				],
			},
		],
	}),

	// ── Scenario 6: Player Graduation to Web3 ─────────────────────
	"/api/scenarios/graduation": () => json({
		scenario: "Player Graduation to Web3",
		description: "A player discovers their cards are real NFTs, creates a Hive account, and receives on-chain ownership. They can then delegate operations back to the game to keep playing seamlessly.",
		phases: [
			{
				phase: "A",
				name: "Transfer Ownership",
				description: "Game transfers the NFT to the player's Hive account",
				steps: [
					{
						step: 1,
						action: "transfer",
						description: "Game transfers Inferno Drake to the player's new Hive account",
						endpoint: "POST /api/build/transfer",
						payload: {
							nftId: INSTANCE_IDS.fireDragon1,
							from: GAME_ACCOUNT,
							to: "player1-hive",
						},
						notes: [
							"On-chain owner changes: game-server → player1-hive",
							"This is a REAL transfer — the player now controls the NFT",
							"mutableData is preserved (level, xp, wins all stay)",
						],
					},
				],
			},
			{
				phase: "B",
				name: "Delegate Back to Game",
				description: "Player approves the game server to operate their NFTs, keeping the seamless experience",
				steps: [
					{
						step: 2,
						action: "nft_approve_all",
						description: "Player approves the game server for their entire collection",
						endpoint: "POST /api/build/nft-approve-all",
						signedBy: "player1-hive (the player signs this ONE time)",
						payload: {
							collectionId: COLLECTION_ID,
							spender: GAME_ACCOUNT,
							approved: true,
							owner: "player1-hive",
						},
						notes: [
							"Player signs this ONCE — then the game can operate their cards again",
							"This is the ONLY blockchain interaction the player needs to do",
							"After this, the experience is identical to custodial mode",
						],
					},
					{
						step: 3,
						action: "data_operator_approve",
						description: "Collection creator approves the game server as data operator (one-time setup)",
						endpoint: "POST /api/build/data-operator-approve",
						signedBy: "game-server (creator, already set up)",
						payload: {
							collectionId: COLLECTION_ID,
							operator: GAME_ACCOUNT,
							approved: true,
							creator: GAME_ACCOUNT,
						},
						notes: [
							"This is usually done ONCE during game setup",
							"Allows the game to call set_data_from on any NFT in the collection",
							"Even NFTs owned by graduated players can have their data updated",
						],
					},
				],
			},
			{
				phase: "C",
				name: "Game Continues Operating",
				description: "Game server operates the graduated player's NFTs via delegation",
				steps: [
					{
						step: 4,
						action: "nft_transfer_from",
						description: "Game trades the player's card to another player (via delegation)",
						endpoint: "POST /api/build/nft-transfer-from",
						signedBy: "game-server (as approved spender)",
						payload: {
							from: "player1-hive",
							to: "player2-hive",
							instanceId: INSTANCE_IDS.fireDragon1,
							spender: GAME_ACCOUNT,
						},
					},
					{
						step: 5,
						action: "set_data_from",
						description: "Game updates card stats (via data operator)",
						endpoint: "POST /api/build/set-data-from",
						signedBy: "game-server (as data operator)",
						payload: {
							nftId: INSTANCE_IDS.fireDragon1,
							instanceDna: "will-be-filled-by-indexer",
							operator: GAME_ACCOUNT,
							mutableData: {
								level: 10,
								xp: 8000,
								wins: 30,
							},
						},
					},
				],
			},
			{
				phase: "D",
				name: "Player Takes Full Control",
				description: "Player can always operate their own NFTs directly — the delegation doesn't remove their rights",
				steps: [
					{
						step: 6,
						action: "transfer (by player)",
						description: "Player sells their card on an external marketplace",
						signedBy: "player1-hive (direct, no game involved)",
						endpoint: "POST /api/build/transfer",
						payload: {
							nftId: INSTANCE_IDS.iceGolem1,
							from: "player1-hive",
							to: "buyer-account",
						},
						notes: [
							"Player can ALWAYS transfer their own NFTs — delegation is additive",
							"Game server and player can both operate — no conflicts",
							"Player can revoke delegation anytime with nft_approve_all(approved: false)",
						],
					},
				],
			},
		],
		summary: {
			playerActions: "Player only needs to sign ONE transaction (nft_approve_all) to keep playing seamlessly",
			gameActions: "Game uses nft_transfer_from + set_data_from for everything else",
			playerRights: "Player retains full ownership and can operate independently at any time",
			revocation: "Player can revoke game's access with nft_approve_all(approved: false)",
		},
	}),
};
