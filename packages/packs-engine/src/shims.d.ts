declare module "crypto" {
	interface HashDigestBuffer {
		readUInt32BE(offset: number): number;
	}

	interface Hash {
		update(input: string): Hash;
		digest(): HashDigestBuffer;
	}

	export function createHash(algorithm: string): Hash;
}
