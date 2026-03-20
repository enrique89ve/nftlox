// Shared application state
import type { SeedNFTWithArtId, HiveOperation } from "nftlox-sdk";
import type { MintingSession } from "../persistence";

export let selectedNft: { id: string; collectionId: string; edition: number; instanceDna: string } | null = null;
export let connectedUser: string | null = null;
export let uploadedSeeds: SeedNFTWithArtId[] = [];
export let previewData: any = null;
export let broadcastPhase = 0;
export let validationPassed = false;
export let currentSession: MintingSession | null = null;
export let navigationStack: string[] = ["collections"];
export let currentCollectionId: string | null = null;
export let currentNftId: string | null = null;
export let selectedTransferCollectionId: string | null = null;
export let selectedTransferNftId: string | null = null;
export let showAllNfts = true;

// Setters
export function setSelectedNft(nft: typeof selectedNft) { selectedNft = nft; }
export function setConnectedUser(user: string | null) { connectedUser = user; }
export function setUploadedSeeds(seeds: SeedNFTWithArtId[]) { uploadedSeeds = seeds; }
export function setPreviewData(data: any) { previewData = data; }
export function setBroadcastPhase(phase: number) { broadcastPhase = phase; }
export function setValidationPassed(passed: boolean) { validationPassed = passed; }
export function setCurrentSession(session: MintingSession | null) { currentSession = session; }
export function setNavigationStack(stack: string[]) { navigationStack = stack; }
export function setCurrentCollectionId(id: string | null) { currentCollectionId = id; }
export function setCurrentNftId(id: string | null) { currentNftId = id; }
export function setSelectedTransferCollectionId(id: string | null) { selectedTransferCollectionId = id; }
export function setSelectedTransferNftId(id: string | null) { selectedTransferNftId = id; }
export function setShowAllNfts(show: boolean) { showAllNfts = show; }
