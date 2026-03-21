// Shared application state (browser-safe — no SDK imports)
// Views read connectedUser from window global set by app.ts

const STORAGE_KEY = "nftlox_user";

export function getConnectedUser(): string | null {
	return (window as any).__connectedUser ?? localStorage.getItem(STORAGE_KEY);
}

export function persistUser(username: string): void {
	localStorage.setItem(STORAGE_KEY, username);
	(window as any).__connectedUser = username;
}

export function clearUser(): void {
	localStorage.removeItem(STORAGE_KEY);
	(window as any).__connectedUser = null;
}
