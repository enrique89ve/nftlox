const PRIVATE_IP_PREFIXES = [
	"10.",
	"172.16.",
	"172.17.",
	"172.18.",
	"172.19.",
	"172.20.",
	"172.21.",
	"172.22.",
	"172.23.",
	"172.24.",
	"172.25.",
	"172.26.",
	"172.27.",
	"172.28.",
	"172.29.",
	"172.30.",
	"172.31.",
	"192.168.",
	"127.",
	"::1",
	"::ffff:127.",
] as const;

function firstForwardedIp(value: string | null): string | undefined {
	const first = value?.split(",")[0]?.trim();
	return first ? first : undefined;
}

export function isPrivateIp(ip: string): boolean {
	return PRIVATE_IP_PREFIXES.some(prefix => ip.startsWith(prefix));
}

/**
 * Resolves the trusted client IP.
 *
 * For direct public connections, the TCP socket IP wins and proxy headers are ignored.
 * For private/loopback socket IPs, trust the upstream proxy headers in priority order.
 */
export function resolveClientIp(request: Request, socketIp?: string): string {
	if (socketIp && !isPrivateIp(socketIp)) {
		return socketIp;
	}

	return firstForwardedIp(request.headers.get("cf-connecting-ip"))
		?? firstForwardedIp(request.headers.get("x-real-ip"))
		?? firstForwardedIp(request.headers.get("x-forwarded-for"))
		?? socketIp
		?? "unknown";
}
