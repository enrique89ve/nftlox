// DOM helper utilities

export const $ = (id: string) => document.getElementById(id);

// Inline SVG placeholders (no external service dependency)
export const PLACEHOLDER_SM = "data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27150%27 height=%27150%27%3E%3Crect fill=%27%231a1a1a%27 width=%27150%27 height=%27150%27/%3E%3Ctext x=%2750%25%27 y=%2750%25%27 fill=%27%23525252%27 font-family=%27sans-serif%27 font-size=%2714%27 text-anchor=%27middle%27 dy=%27.35em%27%3ENFT%3C/text%3E%3C/svg%3E";

export function log(msg: string, type = "info", containerId = "log") {
	const el = $(containerId);
	if (!el) return;
	const entry = document.createElement("div");
	entry.className = "log-entry";
	entry.innerHTML = `
		<span class="log-time">${new Date().toLocaleTimeString()}</span>
		<span class="log-msg ${type}">${msg}</span>
	`;
	el.insertBefore(entry, el.firstChild);
}

export function mintLog(msg: string, type = "info") {
	log(msg, type, "mint-log");
}
