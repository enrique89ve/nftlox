import { config } from "@/config.ts";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

const currentLevel = LEVELS[config.logLevel] ?? LEVELS.info;

const timestamp = () => new Date().toISOString();

const format = (level: string, scope: string, msg: string, data?: unknown) => {
	const base = `[${timestamp()}] [${level.toUpperCase()}] [${scope}] ${msg}`;
	return data !== undefined ? `${base} ${JSON.stringify(data)}` : base;
};

export const createLogger = (scope: string) => ({
	debug: (msg: string, data?: unknown) => {
		if (currentLevel <= LEVELS.debug) console.debug(format("debug", scope, msg, data));
	},
	info: (msg: string, data?: unknown) => {
		if (currentLevel <= LEVELS.info) console.info(format("info", scope, msg, data));
	},
	warn: (msg: string, data?: unknown) => {
		if (currentLevel <= LEVELS.warn) console.warn(format("warn", scope, msg, data));
	},
	error: (msg: string, data?: unknown) => {
		if (currentLevel <= LEVELS.error) console.error(format("error", scope, msg, data));
	},
});
