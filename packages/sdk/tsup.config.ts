import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	dts: true,
	sourcemap: true,
	target: "es2022",
	platform: "neutral",
	clean: true,
	treeshake: true,
	external: ["zod", "@nftlox/protocol"],
	splitting: false,
	minify: false,
});
