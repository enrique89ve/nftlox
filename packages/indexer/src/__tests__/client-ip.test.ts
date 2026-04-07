import { describe, expect, test } from "bun:test";
import { isPrivateIp, resolveClientIp } from "@/api/middleware/client-ip.ts";

describe("client IP resolver", () => {
	test("prefers public socket IP over spoofed proxy headers", () => {
		const request = new Request("http://localhost/api/test", {
			headers: {
				"cf-connecting-ip": "203.0.113.9",
				"x-real-ip": "203.0.113.10",
			},
		});

		expect(resolveClientIp(request, "198.51.100.25")).toBe("198.51.100.25");
	});

	test("trusts CF-Connecting-IP behind a private proxy", () => {
		const request = new Request("http://localhost/api/test", {
			headers: {
				"cf-connecting-ip": "203.0.113.9",
				"x-real-ip": "203.0.113.10",
			},
		});

		expect(resolveClientIp(request, "172.28.0.5")).toBe("203.0.113.9");
	});

	test("falls back to X-Forwarded-For first hop when needed", () => {
		const request = new Request("http://localhost/api/test", {
			headers: {
				"x-forwarded-for": "203.0.113.11, 172.28.0.5",
			},
		});

		expect(resolveClientIp(request, "127.0.0.1")).toBe("203.0.113.11");
	});

	test("returns unknown when no socket or trusted headers exist", () => {
		const request = new Request("http://localhost/api/test");
		expect(resolveClientIp(request)).toBe("unknown");
	});

	test("detects private IP ranges", () => {
		expect(isPrivateIp("172.28.10.5")).toBe(true);
		expect(isPrivateIp("127.0.0.1")).toBe(true);
		expect(isPrivateIp("198.51.100.25")).toBe(false);
	});
});
