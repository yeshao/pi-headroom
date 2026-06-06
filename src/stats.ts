/**
 * Compression statistics tracking.
 * Accumulates per-turn and per-session compression metrics.
 */

export interface CompressionTurn {
	tokensBefore: number;
	tokensAfter: number;
	tokensSaved: number;
	transforms: string[];
	timestamp: number;
}

export interface SessionStats {
	turns: CompressionTurn[];
	totalTokensBefore: number;
	totalTokensAfter: number;
	totalTokensSaved: number;
	compressionCount: number;
}

export function createSessionStats(): SessionStats {
	return {
		turns: [],
		totalTokensBefore: 0,
		totalTokensAfter: 0,
		totalTokensSaved: 0,
		compressionCount: 0,
	};
}

export function recordTurn(stats: SessionStats, turn: CompressionTurn): void {
	stats.turns.push(turn);
	stats.totalTokensBefore += turn.tokensBefore;
	stats.totalTokensAfter += turn.tokensAfter;
	stats.totalTokensSaved += turn.tokensSaved;
	stats.compressionCount++;
}

export function getSessionSummary(stats: SessionStats): string {
	if (stats.compressionCount === 0) {
		return "No compression data yet.";
	}

	const ratio =
		stats.totalTokensBefore > 0
			? ((stats.totalTokensSaved / stats.totalTokensBefore) * 100).toFixed(1)
			: "0.0";

	const lastTurn = stats.turns[stats.turns.length - 1];
	const lastTransforms = lastTurn.transforms.length > 0 ? lastTurn.transforms.join(", ") : "none";

	return [
		`Turns compressed: ${stats.compressionCount}`,
		`Total tokens: ${stats.totalTokensBefore.toLocaleString()} → ${stats.totalTokensAfter.toLocaleString()}`,
		`Tokens saved: ${stats.totalTokensSaved.toLocaleString()} (${ratio}%)`,
		`Last transforms: ${lastTransforms}`,
	].join("\n");
}

export function getLastTurn(stats: SessionStats): CompressionTurn | undefined {
	return stats.turns.length > 0 ? stats.turns[stats.turns.length - 1] : undefined;
}

export function getStatusBarText(stats: SessionStats): string {
	const last = getLastTurn(stats);
	if (!last || last.tokensBefore === 0) {
		return "Headroom: idle";
	}
	const ratio = ((last.tokensSaved / last.tokensBefore) * 100).toFixed(0);
	return `Headroom: -${ratio}% (${last.tokensSaved.toLocaleString()} tok)`;
}
