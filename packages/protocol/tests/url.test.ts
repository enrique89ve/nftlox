import { describe, expect, it } from "bun:test";
import { fromWireUrl, toWireUrl } from "../src/url";

describe("toWireUrl", () => {
	it("strips the https:// prefix", () => {
		expect(toWireUrl("https://example.com/img.png")).toBe("example.com/img.png");
	});

	it("preserves http:// URLs verbatim", () => {
		expect(toWireUrl("http://legacy.example/img.png")).toBe("http://legacy.example/img.png");
	});

	it("passes through URLs that are already stripped", () => {
		expect(toWireUrl("example.com/img.png")).toBe("example.com/img.png");
	});

	it("trims surrounding whitespace", () => {
		expect(toWireUrl("  https://example.com/img.png  ")).toBe("example.com/img.png");
	});

	it("detects the scheme case-insensitively", () => {
		expect(toWireUrl("HTTPS://example.com/img.png")).toBe("example.com/img.png");
		expect(toWireUrl("Https://example.com/img.png")).toBe("example.com/img.png");
	});

	it("preserves path casing after stripping", () => {
		expect(toWireUrl("https://example.com/MyImage.PNG")).toBe("example.com/MyImage.PNG");
	});

	it("preserves query strings", () => {
		expect(
			toWireUrl("https://bucket.s3.amazonaws.com/img?X-Amz-Signature=abc"),
		).toBe("bucket.s3.amazonaws.com/img?X-Amz-Signature=abc");
	});
});

describe("fromWireUrl", () => {
	it("prepends https:// to a scheme-less wire value", () => {
		expect(fromWireUrl("example.com/img.png")).toBe("https://example.com/img.png");
	});

	it("preserves http:// URLs verbatim", () => {
		expect(fromWireUrl("http://legacy.example/img.png")).toBe("http://legacy.example/img.png");
	});

	it("preserves https:// URLs verbatim (defensive — wire should be stripped, but accept either)", () => {
		expect(fromWireUrl("https://example.com/img.png")).toBe("https://example.com/img.png");
	});

	it("trims whitespace before deciding", () => {
		expect(fromWireUrl("  example.com/img.png  ")).toBe("https://example.com/img.png");
	});

	it("detects schemes case-insensitively", () => {
		expect(fromWireUrl("HTTP://legacy.example")).toBe("HTTP://legacy.example");
		expect(fromWireUrl("HTTPS://example.com")).toBe("HTTPS://example.com");
	});
});

describe("round-trip invariant", () => {
	const cases = [
		"https://example.com/img.png",
		"https://gateway.pinata.cloud/ipfs/QmXoYpizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco",
		"https://bucket.s3.amazonaws.com/img?X-Amz-Signature=abc&expires=123",
		"https://imagedelivery.net/account-hash/image-id/public",
		"http://legacy.example/img.png",
	];

	for (const url of cases) {
		it(`preserves "${url}"`, () => {
			expect(fromWireUrl(toWireUrl(url))).toBe(url);
		});
	}
});
