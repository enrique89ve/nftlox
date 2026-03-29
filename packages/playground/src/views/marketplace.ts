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
		container.innerHTML = listings.map((nft: Record<string, unknown>) => {
			const isOwn = currentUser && currentUser === nft.owner;

			let actionHtml = "";
			if (!isOwn && currentUser) {
				actionHtml = `<button class="btn btn-primary" style="font-size: 11px; padding: 4px 12px; margin-top: 4px;" onclick="event.stopPropagation(); buyFromMarketplace('${escapeHtml(nft.id as string)}', '${escapeHtml(nft.listing_id as string)}', '${escapeHtml(nft.listing_tx_id as string)}')">Buy ${escapeHtml(nft.listing_price as string)} ${escapeHtml(nft.listing_currency as string)}</button>`;
			} else if (isOwn) {
				actionHtml = `<span style="color: var(--text-dim); font-size: 11px;">Your listing</span>`;
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

async function buyFromMarketplace(nftId: string, listingId: string, listTxId: string) {
	const user = getConnectedUser();
	if (!user) {
		log("Connect wallet first", "error");
		return;
	}

	const keychain = (window as any).hive_keychain;
	if (!keychain || !keychain.requestSignTx) {
		log("Hive Keychain 3.x+ required for buying", "error");
		return;
	}

	log(`Requesting multisig for ${nftId}...`);

	try {
		const res = await fetch("/api/debug/multisig-buy", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ buyer: user, nftId }),
		});
		const data = await res.json();

		if (!data.success) {
			log(`Buy failed: ${data.error}${data.code ? ` [${data.code}]` : ""}`, "error");
			return;
		}

		const transaction = data.transaction;
		transaction.signatures = [data.nodeSignature];

		log(`Payment: ${data.paymentInfo.totalPrice} ${data.paymentInfo.currency}`, "info");

		keychain.requestSignTx(
			user,
			transaction,
			"Active",
			async (res: any) => {
				if (!res.success) {
					log(`Keychain rejected: ${typeof res.error === "object" ? JSON.stringify(res.error) : res.error}`, "error");
					return;
				}

				log("Broadcasting...");
				try {
					const rpcRes = await fetch("https://api.hive.blog", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							jsonrpc: "2.0",
							method: "condenser_api.broadcast_transaction_synchronous",
							params: [res.result],
							id: 1,
						}),
					});
					const rpcData = await rpcRes.json();

					if (rpcData.error) {
						log(`Broadcast failed: ${rpcData.error.message ?? JSON.stringify(rpcData.error)}`, "error");
						return;
					}

					log(`Bought! TX: ${rpcData.result?.id ?? rpcData.result?.tx_id}`, "success");
					setTimeout(loadListings, 5000);
				} catch (err) {
					log(`Broadcast error: ${(err as Error).message}`, "error");
				}
			},
		);
	} catch (err) {
		log(`Error: ${(err as Error).message}`, "error");
	}
}

(window as any).loadListings = loadListings;
(window as any).buyFromMarketplace = buyFromMarketplace;
