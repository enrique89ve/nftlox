// DOM helper utilities

export const $ = (id: string) => document.getElementById(id);

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
