import { describe, it, expect } from "vitest";
import {
	DEFAULT_CONFIG,
	buildHeadroomConfig,
	estimateTokens,
	type HeadroomExtensionConfig,
	type CompressionProfile,
} from "../src/config.js";

describe("DEFAULT_CONFIG", () => {
	it("has sensible defaults", () => {
		expect(DEFAULT_CONFIG.enabled).toBe(true);
		expect(DEFAULT_CONFIG.profile).toBe("balanced");
		expect(DEFAULT_CONFIG.targetRatio).toBe(0.5);
		expect(DEFAULT_CONFIG.minContextLength).toBe(3);
		expect(DEFAULT_CONFIG.maxToolResultTokens).toBe(4096);
		expect(DEFAULT_CONFIG.showStats).toBe(true);
	});
});

describe("buildHeadroomConfig", () => {
	it("returns empty config for balanced profile (SDK defaults)", () => {
		const config = buildHeadroomConfig({ ...DEFAULT_CONFIG, profile: "balanced" });
		expect(config.smartCrusher).toBeUndefined();
		expect(config.cacheAligner).toBeUndefined();
	});

	it("disables sub-configs for low targetRatio (speed)", () => {
		const config = buildHeadroomConfig({ ...DEFAULT_CONFIG, targetRatio: 0.2 });
		expect(config.smartCrusher).toEqual({ enabled: false });
		expect(config.cacheAligner).toEqual({ enabled: false });
		expect(config.intelligentContext).toEqual({ enabled: false });
	});

	it("enables aggressive compression for high targetRatio (maximum)", () => {
		const config = buildHeadroomConfig({ ...DEFAULT_CONFIG, targetRatio: 0.8 });
		expect(config.smartCrusher).toBeDefined();
		expect((config.smartCrusher as Record<string, unknown>).enabled).toBe(true);
		expect(config.intelligentContext).toBeDefined();
		expect((config.intelligentContext as Record<string, unknown>).enabled).toBe(true);
	});

	// --- Round 6: test coverage gaps ---

	it("targetRatio overrides profile when targetRatio is non-default", () => {
		// profile=maximum but targetRatio=0.2 → should use speed settings (targetRatio wins)
		const config = buildHeadroomConfig({
			...DEFAULT_CONFIG,
			profile: "maximum",
			targetRatio: 0.2,
		});
		expect(config.smartCrusher).toEqual({ enabled: false });
		expect(config.cacheAligner).toEqual({ enabled: false });
		expect(config.intelligentContext).toEqual({ enabled: false });
	});

	it("profile=maximum with default targetRatio uses maximum settings", () => {
		// targetRatio=0.5 (default) so profile=maximum → effectiveRatio=0.8
		const config = buildHeadroomConfig({
			...DEFAULT_CONFIG,
			profile: "maximum",
			targetRatio: 0.5,
		});
		expect(config.smartCrusher).toBeDefined();
		expect((config.smartCrusher as Record<string, unknown>).enabled).toBe(true);
	});

	it("profile=speed with default targetRatio uses speed settings", () => {
		// targetRatio=0.5 (default) so profile=speed → effectiveRatio=0.2
		const config = buildHeadroomConfig({
			...DEFAULT_CONFIG,
			profile: "speed",
			targetRatio: 0.5,
		});
		expect(config.smartCrusher).toEqual({ enabled: false });
		expect(config.cacheAligner).toEqual({ enabled: false });
		expect(config.intelligentContext).toEqual({ enabled: false });
	});

	it("targetRatio at boundary 0.3 uses speed settings", () => {
		const config = buildHeadroomConfig({ ...DEFAULT_CONFIG, targetRatio: 0.3 });
		expect(config.smartCrusher).toEqual({ enabled: false });
	});

	it("targetRatio at boundary 0.7 uses maximum settings", () => {
		const config = buildHeadroomConfig({ ...DEFAULT_CONFIG, targetRatio: 0.7 });
		expect(config.smartCrusher).toBeDefined();
		expect((config.smartCrusher as Record<string, unknown>).enabled).toBe(true);
	});

	it("targetRatio in middle range (0.5) uses SDK defaults", () => {
		const config = buildHeadroomConfig({ ...DEFAULT_CONFIG, targetRatio: 0.5 });
		expect(config.smartCrusher).toBeUndefined();
		expect(config.cacheAligner).toBeUndefined();
		expect(config.intelligentContext).toBeUndefined();
	});

	it("compressThreshold is set to effectiveRatio for maximum", () => {
		const config = buildHeadroomConfig({ ...DEFAULT_CONFIG, targetRatio: 0.9 });
		expect(config.intelligentContext).toBeDefined();
		expect((config.intelligentContext as Record<string, unknown>).compressThreshold).toBe(0.9);
	});
});

describe("estimateTokens", () => {
	it("estimates string content", () => {
		expect(estimateTokens("hello")).toBe(2); // 5 chars / 4 = 1.25 → ceil = 2
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("a".repeat(100))).toBe(25);
	});

	it("estimates array of text blocks", () => {
		const blocks = [
			{ type: "text", text: "hello" },
			{ type: "text", text: "world" },
		];
		expect(estimateTokens(blocks)).toBe(4); // per-block ceil: 2+2
	});

	it("ignores non-text blocks in arrays", () => {
		const blocks = [
			{ type: "text", text: "hello" },
			{ type: "thinking", thinking: "..." },
		];
		expect(estimateTokens(blocks)).toBe(2);
	});

	it("handles single text block object", () => {
		expect(estimateTokens({ type: "text", text: "hello" })).toBe(2);
	});

	it("returns 0 for unknown types", () => {
		expect(estimateTokens(null)).toBe(0);
		expect(estimateTokens(undefined)).toBe(0);
		expect(estimateTokens(42)).toBe(0);
		expect(estimateTokens(true)).toBe(0);
	});

	// --- Round 6: edge cases ---

	it("handles multi-byte unicode characters (CJK)", () => {
		// 4 CJK characters — each is 3 bytes in UTF-8 but 1 char in JS string length
		// estimateTokens uses char length / 4, so 4 chars → 1 token
		expect(estimateTokens("你好世界")).toBe(1);
	});

	it("handles emoji (surrogate pairs)", () => {
		// 😀 is 2 code units in JS (surrogate pair), length = 2
		// 2 / 4 = 0.5 → ceil = 1
		expect(estimateTokens("😀")).toBe(1);
	});

	it("handles very long strings without overflow", () => {
		const long = "a".repeat(1_000_000);
		expect(estimateTokens(long)).toBe(250_000);
	});

	it("handles empty array", () => {
		expect(estimateTokens([])).toBe(0);
	});

	it("handles array with only non-text blocks", () => {
		const blocks = [
			{ type: "thinking", thinking: "..." },
			{ type: "image", image_url: "..." },
		];
		expect(estimateTokens(blocks)).toBe(0);
	});

	it("handles mixed text and non-text blocks", () => {
		const blocks = [
			{ type: "text", text: "hello" },
			{ type: "image", image_url: "..." },
			{ type: "text", text: "world" },
		];
		expect(estimateTokens(blocks)).toBe(4); // 2+2 per text block (ceil(5/4)=2 each), image ignored → ceil(5/4)=2 each
	});
});
