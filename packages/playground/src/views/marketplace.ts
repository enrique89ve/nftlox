// Marketplace view — active listings
import { $, log, escapeHtml, PLACEHOLDER_SM } from "../shared/dom";
import { getConnectedUser } from "../shared/state";

export function initMarketplace() {
	$("btn-load-listings")?.addEventListener("click", loadListings);
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

		const currentUser = getConnectedUser();
		const debugTab = document.querySelector('.advanced-tab[data-tab="tab-debug"]') as HTMLElement | null;
		const debugUiEnabled = debugTab?.style.display !== "none";
		container.innerHTML = listings.map((nft: Record<string, unknown>) => {
			const isOwn = currentUser && currentUser === nft.owner;

			let actionHtml = "";
			if (!isOwn && currentUser && debugUiEnabled) {
				actionHtml = `<span style="color: var(--text-dim); font-size: 11px;">Buy via multisig (see Debug tab)</span>`;
			}

			return `
				<div class="nft-card" data-id="${escapeHtml(nft.id as string)}" onclick="loadNftDetail('${escapeHtml(nft.id as string)}')">
					<img class="nft-image" src="${escapeHtml(nft.image_url as string)}" onerror="this.src='${PLACEHOLDER_SM}'">
					<div class="nft-card-body">
						<div class="nft-name">${escapeHtml(nft.name as string)}</div>
						<div class="nft-owner">@${escapeHtml(nft.owner as string)}</div>
						<div class="nft-meta">
							<span style="color: var(--accent); font-weight: 600; font-size: 13px;">${escapeHtml(nft.listing_price as string)} ${escapeHtml(nft.listing_currency as string)}</span>
							${actionHtml}
						</div>
					</div>
				</div>
			`;
		}).join("");

		log(`Loaded ${listings.length} listings`, "success");
	} catch (e) {
		container.innerHTML = '<div class="empty-state"><p class="empty-state-text">Error loading listings</p></div>';
		log(`Error: ${(e as Error).message}`, "error");
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).loadListings = loadListings;
