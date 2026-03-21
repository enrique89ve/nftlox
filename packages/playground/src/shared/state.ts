// Shared application state (browser-safe — no SDK imports)
// Views read connectedUser from window global set by app.ts

export function getConnectedUser(): string | null {
	return (window as any).__connectedUser ?? null;
}
