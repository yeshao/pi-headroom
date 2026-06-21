/**
 * Headroom SDK client wrapper.
 *
 * Uses headroom-ai as a TypeScript library (not a subprocess proxy).
 * This gives us full access to the compression pipeline, configuration,
 * simulation, and metrics — without requiring Python or a running proxy.
 *
 * Maintains a CCR (Compress-Cache-Retrieve) store backed by the proxy's
 * own CCR cache, so original content can be retrieved across turns within
 * a session.
 */

import { compress, simulate } from "headroom-ai";
import type { CompressResult, SimulationResult } from "headroom-ai";
import { buildHeadroomConfig, computeTokenBudget, estimateTokens, shouldCompress } from "./config.js";
import type { HeadroomExtensionConfig } from "./config.js";
import { piToOpenAI, openAIToPi } from "./format-bridge.js";
import { CCRStore } from "./ccr-store.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Strip Pi-internal fields (_piThinking, _piStopReason, etc.) from messages
 * before passing them to the headroom SDK. The SDK's format detector chokes on
 * unexpected fields and throws "Cannot read properties of undefined (reading 'name')".
 */
function sanitizeForSDK(messages: Record<string, unknown>[]): Record<string, unknown>[] {
	return messages.map((msg) => {
		const clean: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(msg)) {
			if (!key.startsWith("_pi")) {
				clean[key] = value;
			}
		}
		return clean;
	});
}

/**
 * Create a fallback CompressResult for when compression is skipped
 * (threshold not met) or fails.
 */
function makeSkipResult(messages: AgentMessage[]): {
	messages: AgentMessage[];
	result: CompressResult;
} {
	return {
		messages,
		result: {
			messages: messages as unknown as Record<string, unknown>[],
			tokensBefore: 0,
			tokensAfter: 0,
			tokensSaved: 0,
			compressionRatio: 1,
			transformsApplied: [],
			ccrHashes: [],
			compressed: false,
		},
	};
}

export class HeadroomClient {
	private config: HeadroomExtensionConfig;
	private ccrStore: CCRStore;
	private modelId = "gpt-4o";

	constructor(config: HeadroomExtensionConfig) {
		this.config = config;
		this.ccrStore = new CCRStore(this);
	}

	updateConfig(config: HeadroomExtensionConfig): void {
		this.config = config;
	}

	getCCRStore(): CCRStore {
		return this.ccrStore;
	}


	/**
	 * Set the model ID for threshold-based compression.
	 * Should be called when Pi reports which model it's using.
	 */
	setModelId(modelId: string): void {
		this.modelId = modelId;
	}

	/**
	 * Compress a Pi AgentMessage[] using the headroom SDK.
	 * Handles format conversion (Pi → OpenAI → compress → OpenAI → Pi).
	 *
	 * Uses threshold-based profiles when minTokensPct/maxTokensPct are
	 * configured: compression only fires when current usage exceeds the
	 * minTokensPct threshold, and targets the maxTokensPct ceiling.
	 *
	 * Returns the compressed messages and the raw SDK result. When the SDK
	 * falls back (proxy unavailable), result.compressed is false and the
	 * original messages are returned unchanged.
	 *
	 * CCR hashes from the result can be passed to getCCRStore().retrieve()
	 * to fetch original content from the proxy's cache.
	 */
	async compressMessages(messages: AgentMessage[]): Promise<{
		messages: AgentMessage[];
		result: CompressResult;
	}> {
		if (messages.length < this.config.minContextLength) {
			return makeSkipResult(messages);
		}

		const openai = piToOpenAI(messages);
		const clean = sanitizeForSDK(openai);

		// Estimate total tokens to decide whether to compress
		const estimatedTokens = this.estimateTotalTokens(openai);
		if (!shouldCompress(estimatedTokens, this.modelId, this.config)) {
			return makeSkipResult(messages);
		}

		const headroomConfig = buildHeadroomConfig(this.config);
		const tokenBudget = computeTokenBudget(this.modelId, this.config);

		const result = await compress(clean, {
			...headroomConfig,
			...(tokenBudget !== undefined ? { tokenBudget } : {}),
			fallback: true, // Return uncompressed on failure
		});

		// Safely convert back to Pi messages — never throw
		try {
			const compressedPi = openAIToPi(result.messages);
			return {
				messages: compressedPi,
				result,
			};
		} catch (e) {
			console.error("[pi-headroom] openAIToPi failed, returning original messages:", e);
			return makeSkipResult(messages);
		}
	}

	/**
	 * Simulate compression without modifying messages.
	 * Returns estimated savings and transform plan.
	 */
	async simulateCompression(messages: AgentMessage[]): Promise<SimulationResult> {
		const openai = piToOpenAI(messages);
		const clean = sanitizeForSDK(openai);
		const headroomConfig = buildHeadroomConfig(this.config);
		const tokenBudget = computeTokenBudget(this.modelId, this.config);

		return simulate(clean, {
			...headroomConfig,
			...(tokenBudget !== undefined ? { tokenBudget } : {}),
			fallback: true,
		});
	}

	/**
	 * Estimate total token count for an array of OpenAI-format messages.
	 */
	private estimateTotalTokens(messages: Record<string, unknown>[]): number {
		let total = 0;
		for (const msg of messages) {
			const content = msg.content;
			total += estimateTokens(content);
			const toolCalls = msg.tool_calls;
			if (Array.isArray(toolCalls)) {
				for (const tc of toolCalls) {
					const func = (tc as Record<string, unknown>).function;
					if (func && typeof func === "object") {
						const args = (func as Record<string, unknown>).arguments;
						if (typeof args === "string") {
							total += estimateTokens(args);
						}
					}
				}
			}
		}
		return total;
	}
}
