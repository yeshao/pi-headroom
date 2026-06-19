import { describe, it, expect } from "vitest";
import {
	resolveContextWindow,
	shouldCompress,
	computeTokenBudget,
	buildHeadroomConfig,
	DEFAULT_CONFIG,
} from "../src/config";
import type { HeadroomExtensionConfig } from "../src/config";

describe("resolveContextWindow", () => {
	it("returns 200000 for claude-4-opus", () => {
		expect(resolveContextWindow("claude-4-opus")).toBe(200000);
	});

	it("returns 128000 for gpt-4o", () => {
		expect(resolveContextWindow("gpt-4o")).toBe(128000);
	});

	it("returns 128000 default for unknown model", () => {
		expect(resolveContextWindow("unknown-model")).toBe(128000);
	});
});

describe("shouldCompress", () => {
	it("returns false when below 30% threshold", () => {
		// 30% of 200000 = 60000; 40000 < 60000
		expect(shouldCompress(40000, "claude-4-opus", DEFAULT_CONFIG)).toBe(false);
	});

	it("returns true when above 30% threshold", () => {
		// 30% of 200000 = 60000; 70000 >= 60000
		expect(shouldCompress(70000, "claude-4-opus", DEFAULT_CONFIG)).toBe(true);
	});
});

describe("computeTokenBudget", () => {
	it("returns 100000 for claude-4-opus at 50% of 200K", () => {
		const config: HeadroomExtensionConfig = {
			...DEFAULT_CONFIG,
			minTokensPct: 0.3,
			maxTokensPct: 0.5,
		};
		expect(computeTokenBudget("claude-4-opus", config)).toBe(100000);
	});

	it("returns 64000 for gpt-4o at 50% of 128K", () => {
		const config: HeadroomExtensionConfig = {
			...DEFAULT_CONFIG,
			minTokensPct: 0.3,
			maxTokensPct: 0.5,
		};
		expect(computeTokenBudget("gpt-4o", config)).toBe(64000);
	});
});

describe("buildHeadroomConfig", () => {
	it("disables smartCrusher for speed profile", () => {
		const config: HeadroomExtensionConfig = {
			...DEFAULT_CONFIG,
			profile: "speed",
		};
		const result = buildHeadroomConfig(config);
		expect(result.smartCrusher?.enabled).toBe(false);
		expect(result.intelligentContext?.enabled).toBe(false);
	});

	it("enables smartCrusher and intelligentContext for maximum profile", () => {
		const config: HeadroomExtensionConfig = {
			...DEFAULT_CONFIG,
			profile: "maximum",
		};
		const result = buildHeadroomConfig(config);
		expect(result.smartCrusher?.enabled).toBe(true);
		expect(result.intelligentContext?.enabled).toBe(true);
	});

	it("returns empty overrides for balanced profile", () => {
		const config: HeadroomExtensionConfig = {
			...DEFAULT_CONFIG,
			profile: "balanced",
		};
		const result = buildHeadroomConfig(config);
		expect(result.smartCrusher).toBeUndefined();
		expect(result.intelligentContext).toBeUndefined();
	});
});
