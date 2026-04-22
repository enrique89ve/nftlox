// Marketplace view — active listings
import { $, log, escapeHtml, PLACEHOLDER_SM } from "../shared/dom";
import { getConnectedUser } from "../shared/state";

type ListingSort = "recent" | "price_asc" | "price_desc";
type ListingCurrency = "HIVE" | "HBD" | "";
type KeyType = "Active" | "Posting";

interface MarketplaceListing {
	id: string;
	name?: string | null;
	owner?: string | null;
	collection_id?: string | null;
	collectionId?: string | null;
	image_url?: string | null;
	imageUrl?: string | null;
	listing_price?: string | null;
	listingPrice?: string | null;
	listing_currency?: string | null;
	listingCurrency?: string | null;
}

interface ListingsResponse {
	count?: number;
	listings?: MarketplaceListing[];
}

interface BuyResponse {
	success?: boolean;
	error?: string;
	code?: string;
	transaction?: { ref_block_num: number; ref_block_prefix: number; expiration: string; operations: unknown[]; extensions: unknown[]; signatures?: string[]; [key: string]: unknown };
	paymentInfo?: {
		listingId: string;
		listTxId: string;
		totalPrice?: string | number;
		currency?: string;
	};
	indexerUrl?: string;
}

interface BuyMultisigSuccess {
	ok: true;
	/** tx_id of the fully-broadcast buy transaction. */
	txId: string;
	/** tx_id of the buy_commitment op the node used to reserve the NFT. */
	commitmentOpTxId: string;
}

interface BuyMultisigError {
	ok: false;
	code: string;
	message: string;
	retryAfterMs?: number;
}

type BuyMultisigResult = BuyMultisigSuccess | BuyMultisigError;

interface KeychainSignResponse {
	success: boolean;
	error?: unknown;
	result?: unknown;
}

interface HiveKeychain {
	requestSignTx(
		username: string,
		transaction: unknown,
		keyType: KeyType,
		callback: (response: KeychainSignResponse) => void,
	): void;
}

interface MarketplaceWindow extends Window {
	loadNftDetail?: (nftId: string) => void;
	loadListings?: () => Promise<void>;
	buyFromMarketplace?: (nftId: string) => Promise<void>;
	hive_keychain?: HiveKeychain;
}

let listingsCache: MarketplaceListing[] = [];

async function broadcastSignedTransaction(signedTx: unknown): Promise<string> {
	const response = await fetch("https://api.hive.blog", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			method: "condenser_api.broadcast_transaction_synchronous",
			params: [signedTx],
			id: 1,
		}),
	});
	const raw = await response.json() as {
		error?: string | { message?: string };
		result?: { id?: string; tx_id?: string };
	};

	if (raw.error) {
		throw new Error(typeof raw.error === "string" ? raw.error : raw.error.message ?? "Broadcast failed");
	}

	return raw.result?.id ?? raw.result?.tx_id ?? "unknown";
}

export function initMarketplace() {
	$("btn-load-listings")?.addEventListener("click", loadListings);
	$("listing-sort")?.addEventListener("change", loadListings);
	$("listing-currency")?.addEventListener("change", loadListings);
	$("listing-search")?.addEventListener("input", renderListings);
	$("listing-min-price")?.addEventListener("input", renderListings);
	$("listing-max-price")?.addEventListener("input", renderListings);
	$("btn-clear-listing-filters")?.addEventListener("click", clearListingFilters);
}

async function loadListings() {
	const container = $("listings-container");
	if (!container) return;

	container.innerHTML = '<div class="empty-state"><p class="empty-state-text">Loading...</p></div>';

	const sort = getListingSort();
	const currency = getListingCurrencyFilter();

	try {
		const params = new URLSearchParams({ sort, limit: "50" });
		if (currency) params.set("currency", currency);

		const response = await fetch(`/api/marketplace/listings?${params}`);
		const data = await response.json() as ListingsResponse;
		listingsCache = data.listings ?? [];

		renderListings();
		log(`Loaded ${listingsCache.length} listings`, "success");
	} catch (e) {
		container.innerHTML = '<div class="empty-state"><p class="empty-state-text">Error loading listings</p></div>';
		log(`Error: ${(e as Error).message}`, "error");
	}
}

function renderListings() {
	const container = $("listings-container");
	if (!container) return;

	const listings = getFilteredListings();
	renderMarketplaceSummary(listings);

	if (listingsCache.length === 0) {
		container.innerHTML = '<div class="empty-state"><p class="empty-state-text">No active listings.</p></div>';
		return;
	}

	if (listings.length === 0) {
		container.innerHTML = '<div class="empty-state"><p class="empty-state-text">No listings match these filters.</p></div>';
		return;
	}

	const currentUser = getConnectedUser();
	container.innerHTML = listings.map((nft) => {
		const owner = getListingOwner(nft);
		const isOwn = Boolean(currentUser && currentUser === owner.toLowerCase());
		const price = getListingPrice(nft);
		const currency = getListingCurrency(nft);
		const collectionId = getListingCollectionId(nft);

		const actionHtml = getListingActionHtml({
			currentUser,
			isOwn,
			nftId: nft.id,
		});

		return `
			<article class="nft-card js-listing-card" data-id="${escapeHtml(nft.id)}">
				<img class="nft-image" src="${escapeHtml(getListingImage(nft))}" onerror="this.src='${PLACEHOLDER_SM}'" alt="${escapeHtml(getListingName(nft))}">
				<div class="nft-card-body">
					<div class="nft-name">${escapeHtml(getListingName(nft))}</div>
					<div class="nft-owner">@${escapeHtml(owner || "unknown")}</div>
					<div class="collection-meta" style="margin-top: 6px;">${escapeHtml(collectionId || "No collection")}</div>
					<div class="nft-card-footer">
						<div class="marketplace-price">
							<span class="marketplace-price-label">Price</span>
							<span class="marketplace-price-value">${escapeHtml(price)} ${escapeHtml(currency)}</span>
						</div>
						${actionHtml}
					</div>
				</div>
			</article>
		`;
	}).join("");

	bindListingEvents(container);
}

function getListingActionHtml(input: {
	currentUser: string | null;
	isOwn: boolean;
	nftId: string;
}): string {
	if (!input.currentUser) {
		return '<span style="color: var(--text-dim); font-size: 12px;">Connect to buy</span>';
	}

	if (input.isOwn) {
		return '<span style="color: var(--text-dim); font-size: 12px;">Your listing</span>';
	}

	return `<button class="btn btn-primary btn-sm js-buy-listing" data-id="${escapeHtml(input.nftId)}">Buy now</button>`;
}

function bindListingEvents(container: HTMLElement) {
	container.querySelectorAll<HTMLElement>(".js-listing-card").forEach((card) => {
		card.addEventListener("click", () => {
			const id = card.dataset.id;
			if (id) (window as MarketplaceWindow).loadNftDetail?.(id);
		});
	});

	container.querySelectorAll<HTMLButtonElement>(".js-buy-listing").forEach((button) => {
		button.addEventListener("click", (event) => {
			event.stopPropagation();
			const id = button.dataset.id;
			if (id) void buyFromMarketplace(id);
		});
	});
}

function getListingSort(): ListingSort {
	const value = ($("listing-sort") as HTMLSelectElement | null)?.value;
	if (value === "price_asc" || value === "price_desc") return value;
	return "recent";
}

function getListingCurrencyFilter(): ListingCurrency {
	const value = ($("listing-currency") as HTMLSelectElement | null)?.value;
	if (value === "HIVE" || value === "HBD") return value;
	return "";
}

function getListingSearchTerm(): string {
	return (($("listing-search") as HTMLInputElement | null)?.value ?? "").trim().toLowerCase();
}

function getPriceInput(id: string): number | null {
	const rawValue = (($(id) as HTMLInputElement | null)?.value ?? "").trim();
	if (!rawValue) return null;
	const value = Number(rawValue);
	return Number.isFinite(value) ? value : null;
}

function getFilteredListings(): MarketplaceListing[] {
	const query = getListingSearchTerm();
	const minPrice = getPriceInput("listing-min-price");
	const maxPrice = getPriceInput("listing-max-price");

	return listingsCache.filter((listing) => {
		const price = getListingPriceNumber(listing);
		const matchesQuery = !query || getListingSearchText(listing).includes(query);
		const matchesMin = minPrice === null || price >= minPrice;
		const matchesMax = maxPrice === null || price <= maxPrice;
		return matchesQuery && matchesMin && matchesMax;
	});
}

function getListingSearchText(listing: MarketplaceListing): string {
	return [
		listing.id,
		getListingName(listing),
		getListingOwner(listing),
		getListingCollectionId(listing),
		getListingCurrency(listing),
	].join(" ").toLowerCase();
}

function getListingName(listing: MarketplaceListing): string {
	return listing.name || "Untitled NFT";
}

function getListingOwner(listing: MarketplaceListing): string {
	return listing.owner || "";
}

function getListingCollectionId(listing: MarketplaceListing): string {
	return listing.collection_id || listing.collectionId || "";
}

function getListingImage(listing: MarketplaceListing): string {
	return listing.image_url || listing.imageUrl || "";
}

function getListingPrice(listing: MarketplaceListing): string {
	return listing.listing_price || listing.listingPrice || "0.000";
}

function getListingPriceNumber(listing: MarketplaceListing): number {
	const price = Number(getListingPrice(listing));
	return Number.isFinite(price) ? price : 0;
}

function getListingCurrency(listing: MarketplaceListing): string {
	return listing.listing_currency || listing.listingCurrency || "HIVE";
}

function renderMarketplaceSummary(listings: MarketplaceListing[]) {
	const summary = $("marketplace-summary");
	if (!summary) return;

	if (listingsCache.length === 0) {
		summary.style.display = "none";
		return;
	}

	const hiveCount = listings.filter((listing) => getListingCurrency(listing) === "HIVE").length;
	const hbdCount = listings.filter((listing) => getListingCurrency(listing) === "HBD").length;
	const lowestListing = listings.reduce<MarketplaceListing | null>((lowest, listing) => {
		if (lowest === null) return listing;
		return getListingPriceNumber(listing) < getListingPriceNumber(lowest) ? listing : lowest;
	}, null);
	const floorText = lowestListing === null
		? "-"
		: `${getListingPriceNumber(lowestListing).toFixed(3)} ${getListingCurrency(lowestListing)}`;

	summary.style.display = "grid";
	summary.innerHTML = `
		<div class="marketplace-summary-card">
			<div class="stat-label">Results</div>
			<div class="stat-value">${listings.length.toLocaleString()}</div>
		</div>
		<div class="marketplace-summary-card">
			<div class="stat-label">HIVE</div>
			<div class="stat-value">${hiveCount.toLocaleString()}</div>
		</div>
		<div class="marketplace-summary-card">
			<div class="stat-label">HBD</div>
			<div class="stat-value">${hbdCount.toLocaleString()}</div>
		</div>
		<div class="marketplace-summary-card">
			<div class="stat-label">Floor</div>
			<div class="stat-value">${escapeHtml(floorText)}</div>
		</div>
	`;
}

function clearListingFilters() {
	const search = $("listing-search") as HTMLInputElement | null;
	const minPrice = $("listing-min-price") as HTMLInputElement | null;
	const maxPrice = $("listing-max-price") as HTMLInputElement | null;
	const currency = $("listing-currency") as HTMLSelectElement | null;
	const sort = $("listing-sort") as HTMLSelectElement | null;

	if (search) search.value = "";
	if (minPrice) minPrice.value = "";
	if (maxPrice) maxPrice.value = "";
	if (currency) currency.value = "";
	if (sort) sort.value = "recent";
	void loadListings();
}

async function buyFromMarketplace(nftId: string) {
	const user = getConnectedUser();
	if (!user) {
		log("Connect wallet first", "error");
		return;
	}

	const keychain = (window as MarketplaceWindow).hive_keychain;
	if (!keychain || !keychain.requestSignTx) {
		log("Hive Keychain 3.x+ required for buying", "error");
		return;
	}

	log(`Preparing buy tx for ${nftId}...`);

	try {
		const res = await fetch("/api/marketplace/buy", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ buyer: user, nftId }),
		});
		if (!res.ok && res.status === 404) {
			log("Buy endpoint not available", "error");
			return;
		}
		const data = await res.json().catch(() => ({ success: false, error: "Invalid server response" })) as BuyResponse;

		if (!data.success) {
			log(`Buy prep failed: ${data.error}${data.code ? ` [${data.code}]` : ""}`, "error");
			return;
		}

		const transaction = data.transaction;
		if (!transaction || !data.paymentInfo || !data.indexerUrl) {
			log("Buy failed: incomplete prep response", "error");
			return;
		}

		const totalPrice = data.paymentInfo.totalPrice ?? "?";
		const currency = data.paymentInfo.currency ?? "";
		log(`Payment: ${totalPrice} ${currency}`, "info");

		log("Signing tx with Keychain (active key)...");
		keychain.requestSignTx(user, transaction, "Active", async (signRes) => {
			if (!signRes.success) {
				log(`Keychain rejected: ${typeof signRes.error === "object" ? JSON.stringify(signRes.error) : signRes.error}`, "error");
				return;
			}

			const signed = signRes.result as { signatures?: string[] } | undefined;
			const buyerSig = signed?.signatures?.[0];
			if (!buyerSig) {
				log("Keychain response missing buyer signature", "error");
				return;
			}

			transaction.signatures = [buyerSig];

			log("Reserving NFT on-chain via buy_commitment...");
			const multisigRes = await fetch(`${data.indexerUrl!.replace(/\/$/, "")}/api/multisig/buy`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ transaction }),
			});
			const multisigData = await multisigRes.json().catch(() => ({
				ok: false,
				code: "INVALID_RESPONSE",
				message: "Indexer returned non-JSON body",
			})) as BuyMultisigResult;

			if (!multisigData.ok) {
				const retry = multisigData.retryAfterMs
					? ` (retry in ${Math.ceil(multisigData.retryAfterMs / 1000)}s)` : "";
				if (multisigData.code === "CROSS_NODE_RESERVATION") {
					log(`Another buyer reserved this NFT first${retry}. Try again in a moment.`, "error");
				} else {
					log(`Buy failed [${multisigData.code}]: ${multisigData.message}${retry}`, "error");
				}
				return;
			}

			log(`Bought! tx=${multisigData.txId} (commitment=${multisigData.commitmentOpTxId})`, "success");
			setTimeout(loadListings, 5000);
		});
	} catch (err) {
		log(`Error: ${(err as Error).message}`, "error");
	}
}

(window as MarketplaceWindow).loadListings = loadListings;
(window as MarketplaceWindow).buyFromMarketplace = buyFromMarketplace;
