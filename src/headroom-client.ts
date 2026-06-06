/**
 * Headroom SDK client wrapper.
 *
 * Uses headroom-ai as a TypeScript library (not a subprocess proxy).
 * This gives us full access to the compression pipeline, configuration,
 * simulation, and metrics — without requiring Python or a running proxy.
 */

import { compress, simulate } from "headroom-ai";
import type { CompressResult, SimulationResult } from "headroom-ai";
import { buildHeadroomConfig } from "./config.js";
import type { HeadroomExtensionConfig } from "./config.js";
import { piToOpenAI, openAIToPi } from "./format-bridge.js";
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

export class HeadroomClient {
	private config: HeadroomExtensionConfig;

	constructor(config: HeadroomExtensionConfig) {
		this.config = config;
	}

	updateConfig(config: HeadroomExtensionConfig): void {
		this.config = config;
	}

	/**
	 * Compress a Pi AgentMessage[] using the headroom SDK.
	 * Handles format conversion (Pi → OpenAI → compress → OpenAI → Pi).
	 *
	 * Returns the compressed messages and the raw SDK result. When the SDK
	 * falls back (proxy unavailable), result.compressed is false and the
	 * original messages are returned unchanged.
	 */
	async compressMessages(messages: AgentMessage[]): Promise<{
		messages: AgentMessage[];
		result: CompressResult;
	}> {
		const openai = piToOpenAI(messages);
		const clean = sanitizeForSDK(openai);

		const headroomConfig = buildHeadroomConfig(this.config);

		const result = await compress(clean, {
			...headroomConfig,
			fallback: true, // Return uncompressed on failure
		});

		const compressedPi = openAIToPi(result.messages);

		return {
			messages: compressedPi,
			result,
		};
	}

	/**
	 * Simulate compression without modifying messages.
	 * Returns estimated savings and transform plan.
	 */
	async simulateCompression(messages: AgentMessage[]): Promise<SimulationResult> {
		const openai = piToOpenAI(messages);
		const clean = sanitizeForSDK(openai);
		const headroomConfig = buildHeadroomConfig(this.config);

		return simulate(clean, {
			...headroomConfig,
			fallback: true,
		});
	}
}
