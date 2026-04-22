import { MAX_URL_LENGTH } from "./constants";

const HTTP_PROTOCOL_REGEX = /^https?:\/\//i;

function toNodeEndpointUrl(endpoint: string): URL {
	const candidate = HTTP_PROTOCOL_REGEX.test(endpoint) ? endpoint : `https://${endpoint}`;
	return new URL(candidate);
}

function normalizeNodeEndpointPath(pathname: string): string {
	if (pathname === "/") return "";
	const trimmed = pathname.replace(/\/+$/, "");
	return trimmed === "/" ? "" : trimmed;
}

export function validateNodeEndpoint(endpoint: string): string | null {
	const trimmed = endpoint.trim();
	if (trimmed === "") return "Endpoint is required";
	if (trimmed.length > MAX_URL_LENGTH) {
		return `Endpoint must be at most ${MAX_URL_LENGTH} characters`;
	}

	let url: URL;
	try {
		url = toNodeEndpointUrl(trimmed);
	} catch {
		return "Endpoint must be a valid host or http(s) URL";
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return "Endpoint must use http or https protocol";
	}

	if (url.username !== "" || url.password !== "") {
		return "Endpoint must not include credentials";
	}

	if (url.host === "") {
		return "Endpoint must include a host";
	}

	if (url.hash !== "") {
		return "Endpoint must not include URL fragments";
	}

	return null;
}

export function normalizeNodeEndpoint(endpoint: string): string {
	const error = validateNodeEndpoint(endpoint);
	if (error !== null) throw new Error(error);

	const url = toNodeEndpointUrl(endpoint.trim());
	const normalizedPath = normalizeNodeEndpointPath(url.pathname);
	return `${url.host.toLowerCase()}${normalizedPath}${url.search}`;
}
