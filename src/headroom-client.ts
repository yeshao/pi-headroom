/**
 * Headroom SDK client wrapper.
 *
 * Uses headroom-ai as a TypeScript library (not a subprocess proxy).
 * This gives us full access to the compression pipeline, configuration,
 * simulation, and metrics — without requiring Python or a running proxy.
 */

import { compress, simulate } from "headroom-ai";
import type { CompressResult, SimulationResult, HeadroomClientOptions } from "headroom-ai";
import { buildHeadroomConfig } from "./config.js";
import type { HeadroomExtensionConfig } from "./config.js";
import { piToOpenAI, openAIToPi } from "./format-bridge.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

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

		const headroomConfig = buildHeadroomConfig(this.config);

		const result = await compress(openai, {
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
		const headroomConfig = buildHeadroomConfig(this.config);

		return simulate(openai, {
			...headroomConfig,
			fallback: true,
		});
	}
}
