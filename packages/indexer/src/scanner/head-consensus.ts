export type ConsensusHead = Readonly<{
	headBlock: number;
	irreversibleBlock: number;
}>;

function compareConsensusHeads(a: ConsensusHead, b: ConsensusHead): number {
	const irreversibleDelta = a.irreversibleBlock - b.irreversibleBlock;
	if (irreversibleDelta !== 0) return irreversibleDelta;
	return a.headBlock - b.headBlock;
}

export function selectConsensusSample<T>(
	samples: readonly T[],
	getHead: (sample: T) => ConsensusHead,
): T {
	if (samples.length === 0) {
		throw new Error("Cannot select blockchain head from an empty sample set");
	}

	const sorted = [...samples].sort((left, right) => compareConsensusHeads(getHead(left), getHead(right)));
	return sorted[Math.floor((sorted.length - 1) / 2)]!;
}
