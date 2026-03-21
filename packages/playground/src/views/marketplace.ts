// Marketplace view — listings and recent sales
import { $, log, PLACEHOLDER_SM } from "../shared/dom";
import { getConnectedUser } from "../shared/state";
import { broadcastOperation } from "../shared/keychain";

export function initMarketplace() {
	$("btn-load-listings")?.addEventListener("click", loadListings);
	$("btn-load-sales")?.addEventListener("click", loadRecentSales);
	$("listing-sort")?.addEventListener("change", loadListings);
	$("listing-currency")?.addEventListener("change", loadListings);
}

async function loadListings() {
	const container = $("listings-container");
	if (!container) return;

	container.innerHTML = '<div class="empty-state"><p class="empty-state-text">Loading...</p></div>';

	const sort = ($("listing-sort") as HTMLSelectElement)?.value || "recent";
	const currency = ($("listing-currency") as HTMLSelectElement)?.value || "";

	try {
		const params = new URLSearchParams({ sort, limit: "50" });
		if (currency) params.set("currency", currency);

		const response = await fetch(`/api/marketplace/listings?${params}`);
		const data = await response.json();
		const listings = data.listings || [];

		if (listings.length === 0) {
			container.innerHTML = '<div class="empty-state"><p class="empty-state-text">No active listings</p></div>';
			return;
		}

		container.innerHTML = listings.map((nft: any) => `
			<div class="nft-card" data-id="${nft.id}">
				<img class="nft-image" src="${nft.image_url}" onerror="this.src='${PLACEHOLDER_SM}'">
				<div class="nft-name">${nft.name}</div>
				<div class="nft-owner">@${nft.owner}</div>
				<div class="nft-id" style="display: flex; justify-content: space-between; align-items: center;">
					<span style="color: var(--accent); font-weight: 600;">${nft.listing_price} ${nft.listing_currency}</span>
					${getConnectedUser() && getConnectedUser() !== nft.owner ? `<button class="btn btn-sm btn-primary" onclick="buyListing('${nft.id}')">Buy</button>` : ""}
				</div>
			</div>
		`).join("");

		log(`Loaded ${listings.length} listings`, "success");
	} catch (e) {
		container.innerHTML = '<div class="empty-state"><p class="empty-state-text">Error loading listings</p></div>';
		log(`Error: ${(e as Error).message}`, "error");
	}
}

async function loadRecentSales() {
	const container = $("sales-container");
	if (!container) return;

	container.innerHTML = '<div class="empty-state"><p class="empty-state-text">Loading...</p></div>';

	try {
		const response = await fetch("/api/marketplace/recent-sales?limit=20");
		const data = await response.json();
		const sales = data.sales || [];

		if (sales.length === 0) {
			container.innerHTML = '<div class="empty-state"><p class="empty-state-text">No recent sales</p></div>';
			return;
		}

		container.innerHTML = `<table class="data-table">
			<thead><tr>
				<th>NFT</th><th>Price</th><th>From</th><th>To</th><th>Date</th>
			</tr></thead>
			<tbody>${sales.map((s: any) => `
				<tr>
					<td>${s.nft_name || s.nft_id}</td>
					<td style="color: var(--accent); font-weight: 500;">${s.price_amount} ${s.price_currency}</td>
					<td>@${s.from_account}</td>
					<td>@${s.to_account}</td>
					<td style="color: var(--text-dim);">${new Date(s.timestamp).toLocaleDateString()}</td>
				</tr>
			`).join("")}</tbody>
		</table>`;

		log(`Loaded ${sales.length} recent sales`, "success");
	} catch (e) {
		container.innerHTML = '<div class="empty-state"><p class="empty-state-text">Error loading sales</p></div>';
		log(`Error: ${(e as Error).message}`, "error");
	}
}

async function buyListing(nftId: string) {
	const user = getConnectedUser();
	if (!user) {
		log("Connect wallet first", "error");
		return;
	}

	log(`Building buy operation for ${nftId}...`);

	try {
		const response = await fetch("/api/build/buy", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				nftId,
				buyer: user,
				paymentTxId: "pending",
			}),
		});
		const result = await response.json();

		if (!result.success) {
			log(`Error: ${result.errors?.[0]?.message || result.error}`, "error");
			return;
		}

		broadcastOperation(
			user,
			[result.operation],
			"Posting",
			() => {
				log(`Buy successful for ${nftId}!`, "success");
				loadListings();
			},
			(err) => log(`Buy failed: ${err}`, "error"),
		);
	} catch (e) {
		log(`Error: ${(e as Error).message}`, "error");
	}
}

(window as any).buyListing = buyListing;
(window as any).loadListings = loadListings;
(window as any).loadRecentSales = loadRecentSales;
