import { describe, it, expect } from "vitest";
import {
	createSessionStats,
	recordTurn,
	getSessionSummary,
	getStatusBarText,
	type CompressionTurn,
} from "../src/stats.js";

describe("createSessionStats", () => {
	it("creates empty stats", () => {
		const stats = createSessionStats();
		expect(stats.turns).toEqual([]);
		expect(stats.totalTokensBefore).toBe(0);
		expect(stats.totalTokensAfter).toBe(0);
		expect(stats.totalTokensSaved).toBe(0);
		expect(stats.compressionCount).toBe(0);
	});
});

describe("recordTurn", () => {
	it("records a compression turn", () => {
		const stats = createSessionStats();
		const turn: CompressionTurn = {
			tokensBefore: 1000,
			tokensAfter: 500,
			tokensSaved: 500,
			transforms: ["dedup", "trim"],
			timestamp: Date.now(),
		};

		recordTurn(stats, turn);

		expect(stats.turns).toHaveLength(1);
		expect(stats.totalTokensBefore).toBe(1000);
		expect(stats.totalTokensAfter).toBe(500);
		expect(stats.totalTokensSaved).toBe(500);
		expect(stats.compressionCount).toBe(1);
	});

	it("accumulates multiple turns", () => {
		const stats = createSessionStats();

		recordTurn(stats, {
			tokensBefore: 1000,
			tokensAfter: 500,
			tokensSaved: 500,
			transforms: ["dedup"],
			timestamp: 1000,
		});
		recordTurn(stats, {
			tokensBefore: 800,
			tokensAfter: 400,
			tokensSaved: 400,
			transforms: ["trim"],
			timestamp: 2000,
		});

		expect(stats.turns).toHaveLength(2);
		expect(stats.totalTokensBefore).toBe(1800);
		expect(stats.totalTokensAfter).toBe(900);
		expect(stats.totalTokensSaved).toBe(900);
		expect(stats.compressionCount).toBe(2);
	});
});

describe("getSessionSummary", () => {
	it("returns idle message when no compressions", () => {
		const stats = createSessionStats();
		expect(getSessionSummary(stats)).toBe("No compression data yet.");
	});

	it("formats summary with stats", () => {
		const stats = createSessionStats();
		recordTurn(stats, {
			tokensBefore: 10000,
			tokensAfter: 4000,
			tokensSaved: 6000,
			transforms: ["dedup", "trim"],
			timestamp: 1000,
		});

		const summary = getSessionSummary(stats);
		expect(summary).toContain("Turns compressed: 1");
		expect(summary).toContain("10,000");
		expect(summary).toContain("4,000");
		expect(summary).toContain("6,000");
		expect(summary).toContain("60.0%");
		expect(summary).toContain("dedup, trim");
	});
});

describe("getStatusBarText", () => {
	it("returns idle when no compressions", () => {
		const stats = createSessionStats();
		expect(getStatusBarText(stats)).toBe("Headroom: idle");
	});

	it("shows compression stats", () => {
		const stats = createSessionStats();
		recordTurn(stats, {
			tokensBefore: 1000,
			tokensAfter: 400,
			tokensSaved: 600,
			transforms: ["dedup"],
			timestamp: 1000,
		});

		const text = getStatusBarText(stats);
		expect(text).toContain("Headroom:");
		expect(text).toContain("-60%");
		expect(text).toContain("600");
	});

	// --- Round 6: edge cases ---

	it("returns idle when last turn has tokensBefore of 0", () => {
		// Edge case: compression returned uncompressed (tokensBefore=0)
		const stats = createSessionStats();
		recordTurn(stats, {
			tokensBefore: 0,
			tokensAfter: 0,
			tokensSaved: 0,
			transforms: [],
			timestamp: 1000,
		});

		expect(getStatusBarText(stats)).toBe("Headroom: idle");
	});

	it("returns idle when last turn is undefined (no turns)", () => {
		const stats = createSessionStats();
		// No turns recorded
		expect(getStatusBarText(stats)).toBe("Headroom: idle");
	});

	it("handles multiple turns and shows last turn stats", () => {
		const stats = createSessionStats();
		recordTurn(stats, {
			tokensBefore: 1000,
			tokensAfter: 800,
			tokensSaved: 200,
			transforms: ["dedup"],
			timestamp: 1000,
		});
		recordTurn(stats, {
			tokensBefore: 500,
			tokensAfter: 200,
			tokensSaved: 300,
			transforms: ["trim"],
			timestamp: 2000,
		});

		const text = getStatusBarText(stats);
		// Should show the LAST turn's stats: 300/500 = 60%
		expect(text).toContain("-60%");
		expect(text).toContain("300");
	});
});
