/**
 * Format bridge: Pi AgentMessage ↔ OpenAI-compatible messages for headroom.
 *
 * Pi uses OpenAI-format messages (UserMessage, AssistantMessage, ToolResultMessage)
 * with some Pi-specific extensions:
 *   - ThinkingContent in assistant messages (not in OpenAI spec)
 *   - `api` and `timestamp` fields on messages
 *   - ToolCall.arguments is a Record (not a string)
 *
 * The headroom SDK's compress() accepts any[] and auto-detects format, but it
 * doesn't understand ThinkingContent. We strip it before compression and
 * re-attach it after. Thinking blocks are stored directly on the OpenAI message
 * object (_piThinking field) so they survive compression reordering/removal.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent, ThinkingContent } from "@earendil-works/pi-ai";
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** OpenAI-compatible message as headroom understands */
interface OpenAIMessage {
	role: "user" | "assistant" | "tool";
	content?: string | unknown[];
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
	name?: string;
	/** Pi-specific: thinking blocks stripped during compression, restored after */
	_piThinking?: ThinkingContent[];
	[index: string]: unknown;
}

interface OpenAIToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

// ---------------------------------------------------------------------------
// Pi → OpenAI
// ---------------------------------------------------------------------------

/**
 * Convert Pi AgentMessage[] to OpenAI-compatible messages for headroom compression.
 * Strips ThinkingContent and stores it on the message's _piThinking field
 * (survives compression reordering). Serializes ToolCall arguments.
 */
export function piToOpenAI(messages: AgentMessage[]): OpenAIMessage[] {
	const openai: OpenAIMessage[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		switch (msg.role) {
			case "user": {
				const content = extractTextContent(msg.content);
				openai.push({ role: "user", content });
				break;
			}

			case "assistant": {
				const assistantMsg = msg as unknown as {
					role: "assistant";
					content: (TextContent | ThinkingContent | unknown)[];
					api?: unknown;
					timestamp?: number;
					stopReason?: string;
					usage?: unknown;
				};

				// Extract and strip thinking content
				const thinking: ThinkingContent[] = [];
				const textAndToolCalls: unknown[] = [];
				for (const block of assistantMsg.content) {
					if (block && typeof block === "object" && "type" in block) {
						if ((block as { type: string }).type === "thinking") {
							thinking.push(block as ThinkingContent);
						} else {
							textAndToolCalls.push(block);
						}
					} else {
						textAndToolCalls.push(block);
					}
				}

				// Build OpenAI-compatible assistant message
				const oaiMsg: OpenAIMessage = { role: "assistant" };

				// Store thinking blocks on the message itself (not in a separate map)
				if (thinking.length > 0) {
					oaiMsg._piThinking = thinking;
				}

				// Extract text content
				const textParts: string[] = [];
				const toolCalls: OpenAIToolCall[] = [];

				for (const block of textAndToolCalls) {
					if (block && typeof block === "object") {
						const b = block as { type: string; [k: string]: unknown };
						if (b.type === "text" && typeof b.text === "string") {
							textParts.push(b.text);
						} else if (b.type === "toolCall") {
							const tc = block as unknown as {
								id: string;
								function: { name: string; arguments: unknown };
							};
							toolCalls.push({
								id: tc.id,
								type: "function",
								function: {
									name: tc.function.name,
									arguments:
										typeof tc.function.arguments === "string"
											? tc.function.arguments
											: JSON.stringify(tc.function.arguments),
								},
							});
						}
					}
				}

				if (textParts.length > 0) {
					oaiMsg.content = textParts.join("\n");
				}
				if (toolCalls.length > 0) {
					oaiMsg.tool_calls = toolCalls;
				}

				// Preserve stopReason and usage for reconstruction
				if (assistantMsg.stopReason) {
					oaiMsg._piStopReason = assistantMsg.stopReason;
				}
				if (assistantMsg.usage) {
					oaiMsg._piUsage = assistantMsg.usage;
				}

				openai.push(oaiMsg);
				break;
			}

			case "toolResult": {
				const trMsg = msg as unknown as {
					role: "toolResult";
					toolCallId: string;
					toolName: string;
					content: (TextContent | unknown)[];
					isError?: boolean;
				};

				// Extract text content from tool result
				const textParts: string[] = [];
				for (const block of trMsg.content) {
					if (block && typeof block === "object" && "type" in block) {
						const b = block as { type: string; text?: string };
						if (b.type === "text" && typeof b.text === "string") {
							textParts.push(b.text);
						}
					}
				}

				const oaiMsg: OpenAIMessage = {
					role: "tool",
					tool_call_id: trMsg.toolCallId,
					content: textParts.join("\n"),
				};

				// Preserve error status
				if (trMsg.isError) {
					oaiMsg._piIsError = true;
				}
				if (trMsg.toolName) {
					oaiMsg._piToolName = trMsg.toolName;
				}

				openai.push(oaiMsg);
				break;
			}

			default:
				// Unknown role — pass through as-is (headroom will handle or ignore)
				openai.push(msg as unknown as OpenAIMessage);
				break;
		}
	}

	return openai;
}

// ---------------------------------------------------------------------------
// OpenAI → Pi
// ---------------------------------------------------------------------------

/**
 * Convert compressed OpenAI messages back to Pi AgentMessage[].
 * Restores ThinkingContent from _piThinking field and Pi-specific fields.
 */
export function openAIToPi(messages: unknown[]): AgentMessage[] {
	const result: AgentMessage[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i] as OpenAIMessage;

		switch (msg.role) {
			case "user": {
				result.push({
					role: "user",
					content: msg.content ?? "",
					timestamp: Date.now(),
				} as unknown as AgentMessage);
				break;
			}

			case "assistant": {
				const content: unknown[] = [];

				// Restore thinking blocks from the message itself
				const thinking = msg._piThinking;
				if (thinking) {
					for (const t of thinking) {
						content.push(t);
					}
					// Clean up _piThinking to avoid stale data on result.messages
					msg._piThinking = undefined;
				}

				// Restore text content
				if (typeof msg.content === "string" && msg.content) {
					content.push({ type: "text", text: msg.content });
				}

				// Restore tool calls (with Record arguments for Pi)
				if (msg.tool_calls) {
					for (const tc of msg.tool_calls) {
						let args: unknown = tc.function.arguments;
						try {
							args = JSON.parse(tc.function.arguments);
						} catch {
							// Keep as string if not valid JSON
						}
						content.push({
							type: "toolCall",
							id: tc.id,
							function: {
								name: tc.function.name,
								arguments: args,
							},
						});
					}
				}

				const assistantMsg: Record<string, unknown> = {
					role: "assistant",
					content,
				};

				if (msg._piStopReason) {
					assistantMsg.stopReason = msg._piStopReason;
				}
				if (msg._piUsage) {
					assistantMsg.usage = msg._piUsage;
				}

				result.push(assistantMsg as unknown as AgentMessage);
				break;
			}

			case "tool": {
				const textContent: unknown[] = [];
				if (typeof msg.content === "string") {
					textContent.push({ type: "text", text: msg.content });
				}

				const toolMsg: Record<string, unknown> = {
					role: "toolResult",
					toolCallId: msg.tool_call_id ?? "",
					content: textContent,
				};

				if (msg._piIsError !== undefined) {
					toolMsg.isError = msg._piIsError;
				}
				if (msg._piToolName) {
					toolMsg.toolName = msg._piToolName;
				}

				result.push(toolMsg as unknown as AgentMessage);
				break;
			}

			default:
				result.push(msg as unknown as AgentMessage);
				break;
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a text string from Pi message content.
 * Pi user content can be a string or an array of TextContent/ImageContent blocks.
 * For headroom compression, we need a plain string.
 */
export function extractTextContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			if (block && typeof block === "object" && "text" in block) {
				const text = (block as { text: unknown }).text;
				if (typeof text === "string") {
					parts.push(text);
				}
			}
		}
		return parts.join("\n");
	}
	return "";
}
