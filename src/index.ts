/**
 * pi-headroom v2: Transparent LLM context compression for Pi using Headroom.
 *
 * Architecture:
 *   - Uses headroom-ai as a TypeScript library (no Python subprocess needed)
 *   - Hooks into pi's `context` event to compress messages before each LLM call
 *   - Supports compression profiles (speed/balanced/maximum)
 *   - Provides /headroom, /headroom stats, /headroom simulate, /headroom config commands
 *   - Tracks per-turn and per-session compression statistics
 *
 * Unlike v1 (which wrapped a Python proxy subprocess), this version delegates
 * all compression logic to the upstream headroom-ai SDK, giving us access to
 * the full compression pipeline, configuration surface, simulation, and metrics.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { HeadroomClient } from "./headroom-client.js";
import { HeadroomClient as HeadroomProxyClient } from "headroom-ai";
import {
	DEFAULT_CONFIG,
	type HeadroomExtensionConfig,
	type CompressionProfile,
} from "./config.js";
import {
	createSessionStats,
	recordTurn,
	getSessionSummary,
	getStatusBarText,
} from "./stats.js";
import { estimateTokens } from "./config.js";

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function headroomExtension(pi: ExtensionAPI) {
	// State — config.enabled is the single source of truth (no local shadow)
	const config: HeadroomExtensionConfig = { ...DEFAULT_CONFIG };
	const sessionStats = createSessionStats();
	let client: HeadroomClient | null = null;
	/** Store last context messages for /headroom-simulate command */
	let lastContextMessages: AgentMessage[] = [];

	// Try to create the headroom client
	try {
		client = new HeadroomClient(config);
	} catch (err) {
		// headroom-ai SDK not available — extension loaded but disabled
		client = null;
	}

	// -------------------------------------------------------------------------
	// Session lifecycle
	// -------------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		// Reset stats for new session (prevents unbounded growth across sessions)
		Object.assign(sessionStats, createSessionStats());

		if (!config.enabled || !client) {
			ctx.ui.setStatus("headroom", undefined);
			return;
		}

		if (config.showStats) {
			ctx.ui.setStatus("headroom", "Headroom: active");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("headroom", undefined);
		lastContextMessages = [];
		Object.assign(sessionStats, createSessionStats());
	});

	// -------------------------------------------------------------------------
	// Core compression hook
	// -------------------------------------------------------------------------

	pi.on("context", async (event, ctx) => {
		if (!config.enabled || !client) {
			return;
		}

		const messages = event.messages;

		// Skip compression for very short contexts
		if (messages.length < config.minContextLength) {
			return;
		}

		// Store for /headroom-simulate command
		lastContextMessages = messages;

		try {
			const { messages: compressed, result } = await client.compressMessages(messages);

			// Only record stats when compression actually ran
			if (result.compressed) {
				recordTurn(sessionStats, {
					tokensBefore: result.tokensBefore,
					tokensAfter: result.tokensAfter,
					tokensSaved: result.tokensSaved,
					transforms: result.transformsApplied,
					timestamp: Date.now(),
				});
			}

			// Update status bar (moved outside result.compressed check to avoid staleness)
			if (config.showStats) {
				ctx.ui.setStatus("headroom", getStatusBarText(sessionStats));
			}

			// Return compressed messages
			return { messages: compressed };
		} catch (err) {
			// Compression failed — log and fall through with original messages
			ctx.ui.notify(
				`Headroom compression failed: ${err instanceof Error ? err.message : String(err ?? "unknown")}`,
				"warning",
			);
			return;
		}
	});

	// -------------------------------------------------------------------------
	// Optional: compress large tool results
	// -------------------------------------------------------------------------

	pi.on("tool_result", async (event, ctx) => {
		if (!config.enabled || !client || config.maxToolResultTokens <= 0) {
			return;
		}

		// Skip compression for array-format content — format bridge converts
		// to string, which would change the content type expected by Pi's pipeline
		if (Array.isArray(event.content)) {
			return;
		}

		// Estimate token count of tool result
		const tokens = estimateTokens(event.content);
		if (tokens < config.maxToolResultTokens) {
			return;
		}

		// Wrap tool result content as a single-message context for compression
		const toolMessage: AgentMessage = {
			role: "user",
			content: event.content,
			timestamp: Date.now(),
		} as unknown as AgentMessage;

		try {
			const { messages: compressed, result } = await client.compressMessages([toolMessage]);

			if (!result.compressed) {
				return;
			}

			const newContent = (
				compressed[0] as { content?: unknown }
			).content as (typeof event.content) | undefined;

			if (newContent) {
				return { content: newContent };
			}
		} catch (err) {
			ctx.ui.notify(
				`Headroom tool result compression failed: ${err instanceof Error ? err.message : String(err ?? "unknown")}`,
				"warning",
			);
		}
	});

	// -------------------------------------------------------------------------
	// Commands
	// -------------------------------------------------------------------------

	/**
	 * /headroom — Toggle, show status, or change profile.
	 *   /headroom         — show current status
	 *   /headroom on      — enable compression
	 *   /headroom off     — disable compression
	 *   /headroom profile — set compression profile (speed|balanced|maximum)
	 */
	pi.registerCommand("headroom", {
		description: "Headroom context compression controls",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0];

			switch (subcommand) {
				case "on":
					config.enabled = true;
					ctx.ui.notify("Headroom compression enabled.", "info");
					break;

				case "off":
					config.enabled = false;
					ctx.ui.notify("Headroom compression disabled.", "info");
					break;

				case "profile": {
					const profile = parts[1] as CompressionProfile | undefined;
					if (!profile || !["speed", "balanced", "maximum"].includes(profile)) {
						ctx.ui.notify(
							"Usage: /headroom profile <speed|balanced|maximum>",
							"warning",
						);
						return;
					}
					config.profile = profile;
					client?.updateConfig(config);
					ctx.ui.notify(`Headroom profile set to: ${profile}`, "info");
					break;
				}

				default: {
					// Show status
					const status = config.enabled ? "enabled" : "disabled";
					const sdkStatus = client ? "available" : "not installed";
					const lines = [
						`Headroom: ${status}`,
						`SDK: ${sdkStatus}`,
						`Profile: ${config.profile}`,
						`Target ratio: ${config.targetRatio}`,
						`Min context length: ${config.minContextLength}`,
						`Max tool result tokens: ${config.maxToolResultTokens}`,
					];

					if (sessionStats.compressionCount > 0) {
						lines.push("", getSessionSummary(sessionStats));
					}

					ctx.ui.notify(lines.join("\n"), "info");
					break;
				}
			}

			// Respect showStats setting for status bar updates
			if (config.showStats) {
				ctx.ui.setStatus(
					"headroom",
					config.enabled && client ? getStatusBarText(sessionStats) : undefined,
				);
			}
		},
	});

	/**
	 * /headroom-simulate — Dry-run compression on current context.
	 */
	pi.registerCommand("headroom-simulate", {
		description: "Preview compression savings without modifying context",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!client) {
				ctx.ui.notify("Headroom SDK not available.", "warning");
				return;
			}

			if (lastContextMessages.length === 0) {
				ctx.ui.notify("No messages to simulate compression on.", "info");
				return;
			}

			try {
				const sim = await client.simulateCompression(lastContextMessages);

				const lines = [
					`Compression simulation:`,
					`  Tokens: ${sim.tokensBefore.toLocaleString()} → ${sim.tokensAfter.toLocaleString()}`,
					`  Savings: ${sim.tokensSaved.toLocaleString()} (${sim.estimatedSavings})`,
					`  Transforms: ${sim.transforms.join(", ") || "none"}`,
				];

				ctx.ui.notify(lines.join("\n"), "info");
			} catch (err) {
				ctx.ui.notify(
					`Simulation failed: ${err instanceof Error ? err.message : String(err ?? "unknown")}`,
					"warning",
				);
			}
		},
	});

	/**
	 * /headroom-stats — Show detailed compression statistics.
	 */
	pi.registerCommand("headroom-stats", {
		description: "Show compression statistics for this session",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (sessionStats.compressionCount === 0) {
				ctx.ui.notify("No compression data yet. Run some prompts first.", "info");
				return;
			}

			ctx.ui.notify(getSessionSummary(sessionStats), "info");
		},
	});

	/**
	 * /headroom-config — Show current headroom configuration.
	 */
	pi.registerCommand("headroom-config", {
		description: "Show current headroom configuration",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const lines = [
				`Headroom Configuration:`,
				`  Enabled: ${config.enabled}`,
				`  Profile: ${config.profile}`,
				`  Target ratio: ${config.targetRatio}`,
				`  Min context length: ${config.minContextLength}`,
				`  Max tool result tokens: ${config.maxToolResultTokens}`,
				`  Show stats in status bar: ${config.showStats}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	/**
	 * /headroom-health — Check headroom SDK status.
	 */
	pi.registerCommand("headroom-health", {
		description: "Check headroom SDK health",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!client) {
				ctx.ui.notify(
					"Headroom SDK not available. Make sure headroom-ai is installed.",
					"error",
				);
				return;
			}

			ctx.ui.notify(
				`Headroom SDK is available and ${config.enabled ? "active" : "disabled"}.`,
				"info",
			);
		},
	});

	/**
	 * headroom_retrieve — Retrieve original content from CCR compression store.
	 * Only functional when a headroom proxy is running with CCR enabled.
	 */
	pi.registerTool({
		name: "headroom_retrieve",
		label: "Headroom Retrieve",
		description: "Retrieve original (uncompressed) content from headroom's CCR store by hash. Requires a running headroom proxy with CCR enabled.",
		parameters: {
			type: "object",
			properties: {
				hash: {
					type: "string",
					description: "The CCR hash of the compressed content to retrieve",
				},
				query: {
					type: "string",
					description: "Optional search query to filter results",
				},
			},
			required: ["hash"],
		} as const,
		execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
			try {
				const hc = new HeadroomProxyClient();
				const result = await hc.retrieve(
					(params as { hash: string }).hash,
					{ query: (params as { query?: string }).query },
				);
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									hash: result.hash,
									originalContent: "originalContent" in result ? result.originalContent : null,
									originalTokens: "originalTokens" in result ? result.originalTokens : null,
									toolName: "toolName" in result ? result.toolName : null,
									retrievalCount: "retrievalCount" in result ? result.retrievalCount : null,
								},
								null,
								2,
							),
						},
					],
					details: {},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `CCR retrieve failed: ${err instanceof Error ? err.message : String(err ?? "unknown")}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});
}
