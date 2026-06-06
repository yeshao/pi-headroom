/**
 * Configuration: reads pi settings and builds HeadroomConfig.
 */

import type { HeadroomConfig } from "headroom-ai";

/**
 * Compression profile presets.
 */
export type CompressionProfile = "speed" | "balanced" | "maximum";

/**
 * Extension configuration derived from pi settings.
 */
export interface HeadroomExtensionConfig {
	enabled: boolean;
	profile: CompressionProfile;
	targetRatio: number;
	/** Minimum number of messages required before compression runs */
	minContextLength: number;

	maxToolResultTokens: number;
	showStats: boolean;
}

/**
 * Default configuration matching headroom's built-in defaults.
 */
export const DEFAULT_CONFIG: HeadroomExtensionConfig = {
	enabled: true,
	profile: "balanced",
	targetRatio: 0.5,
	minContextLength: 3,
	maxToolResultTokens: 4096,
	showStats: true,
};

/**
 * Map our simplified profile to headroom's HeadroomConfig.
 * Headroom's config is deeply configurable (SmartCrusherConfig, CacheAlignerConfig,
 * IntelligentContextConfig, etc.) — we expose a simplified surface and map it.
 */
export function buildHeadroomConfig(extConfig: HeadroomExtensionConfig): HeadroomConfig {
	const base: HeadroomConfig = {};

	// Use profile setting to determine compression aggressiveness
	// If targetRatio is at its default (0.5), let the profile field control it
	const effectiveRatio = extConfig.targetRatio !== 0.5
		? extConfig.targetRatio
		: extConfig.profile === "speed"
			? 0.2
			: extConfig.profile === "maximum"
				? 0.8
				: 0.5;

	if (effectiveRatio <= 0.3) {
		base.smartCrusher = { enabled: false };
		base.cacheAligner = { enabled: false };
		base.intelligentContext = { enabled: false };
	} else if (effectiveRatio >= 0.7) {
		base.smartCrusher = {
			enabled: true,
			minTokensToCrush: 50,
			maxItemsAfterCrush: 10,
		};
		base.intelligentContext = {
			enabled: true,
			compressThreshold: effectiveRatio,
		};
	}
	// balanced (0.3-0.7): let the SDK use its defaults

	return base;
}

/**
 * Estimate token count for a message using character heuristic.
 * Rough approximation: 1 token ~ 4 chars for English, ~ 1.5 for code.
 */
export function estimateTokens(content: unknown): number {
	if (typeof content === "string") {
		return Math.ceil(content.length / 4);
	}
	if (Array.isArray(content)) {
		let total = 0;
		for (const block of content) {
			if (block && typeof block === "object" && "text" in block) {
				const text = (block as { text: unknown }).text;
				if (typeof text === "string") {
					total += Math.ceil(text.length / 4);
				}
			}
		}
		return total;
	}
	if (content && typeof content === "object" && "text" in content) {
		const text = (content as { text: unknown }).text;
		if (typeof text === "string") {
			return Math.ceil(text.length / 4);
		}
	}
	return 0;
}
