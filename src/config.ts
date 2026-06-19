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
	/**
	 * Minimum percentage of model context window that must be used before
	 * compression fires. Compression only kicks in when current token usage
	 * exceeds this threshold. Default 0.3 (30%).
	 *
	 * This adapts automatically to whatever model Pi is running — a 200K
	 * window fires at ~60K tokens, a 128K window at ~38K.
	 */
	minTokensPct?: number;
	/**
	 * Target ceiling percentage for post-compression context usage.
	 * When compression fires, it aims to bring token usage below this
	 * percentage of the model's window. Default 0.5 (50%).
	 *
	 * minTokensPct = when to start compressing ("we need to do something").
	 * maxTokensPct = how aggressively ("don't let us get this high").
	 */
	maxTokensPct?: number;
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
	minTokensPct: 0.3,
	maxTokensPct: 0.5,
};

/**
 * Model context window sizes (in tokens). Used for threshold-based profiles.
 * Pi supports many models; these are the common ones. Unknown models default to 128K.
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	"claude-3-5-sonnet": 128000,
	"claude-3-5-haiku": 128000,
	"claude-4-opus": 200000,
	"claude-4-sonnet": 200000,
	"claude-4": 200000,
	"gpt-4o": 128000,
	"gpt-4o-mini": 128000,
	"o4-mini": 200000,
	"o3": 200000,
	"gemini-2.5-pro": 200000,
	"gemini-2.5-flash": 1000000,
};

const DEFAULT_CONTEXT_WINDOW = 128000;

/**
 * Resolve the context window size for a given model identifier.
 * Falls back to 128K for unknown models.
 */
export function resolveContextWindow(modelId: string): number {
	// Exact match first
	if (MODEL_CONTEXT_WINDOWS[modelId]) {
		return MODEL_CONTEXT_WINDOWS[modelId];
	}
	// Prefix match (e.g., "claude-4-opus-20250514" → "claude-4-opus")
	for (const [key, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
		if (modelId.startsWith(key)) {
			return size;
		}
	}
	return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Compute the token budget from threshold-based profile settings.
 *
 * Returns the absolute token count that corresponds to maxTokensPct
 * of the model's context window. The caller compares current token
 * usage against minTokensPct to decide when to compress, then passes
 * this budget as the tokenBudget to the compressor.
 *
 * Returns undefined if threshold-based profiles are not configured,
 * signaling that the profile preset (targetRatio) should be used instead.
 */
export function computeTokenBudget(
	modelId: string,
	config: HeadroomExtensionConfig,
): number | undefined {
	if (config.minTokensPct === undefined || config.maxTokensPct === undefined) {
		return undefined;
	}

	const windowSize = resolveContextWindow(modelId);
	return Math.floor(windowSize * config.maxTokensPct);
}

/**
 * Check whether compression should fire based on current token usage.
 * Returns true if currentTokens exceeds minTokensPct of the window.
 *
 * When false, the caller should skip compression entirely (saves the
 * prompt cache in short sessions where compression would cost more
 * than it saves).
 */
export function shouldCompress(
	currentTokens: number,
	modelId: string,
	config: HeadroomExtensionConfig,
): boolean {
	if (config.minTokensPct === undefined) {
		return true; // No threshold configured — always compress
	}
	const windowSize = resolveContextWindow(modelId);
	const threshold = Math.floor(windowSize * config.minTokensPct);
	return currentTokens >= threshold;
}

/**
 * Map our simplified profile to headroom's HeadroomConfig.
 * Headroom's config is deeply configurable (SmartCrusherConfig, CacheAlignerConfig,
 * IntelligentContextConfig, etc.) — we expose a simplified surface and map it.
 */
export function buildHeadroomConfig(extConfig: HeadroomExtensionConfig): HeadroomConfig {
	const base: HeadroomConfig = {};

	// Use profile setting to determine compression aggressiveness.
	// If targetRatio is at its default (0.5), let the profile field control it.
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
				const text = (block as Record<string, unknown>).text;
				if (typeof text === "string") {
					total += Math.ceil(text.length / 4);
				}
			}
		}
		return total;
	}
	if (content && typeof content === "object" && "text" in content) {
		const text = (content as Record<string, unknown>).text;
		if (typeof text === "string") {
			return Math.ceil(text.length / 4);
		}
	}
	return 0;
}
