import { describe, it, expect } from "vitest";
import { piToOpenAI, openAIToPi } from "../src/format-bridge.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userMsg(text: string, ts = 1000): AgentMessage {
	return { role: "user", content: text, timestamp: ts } as unknown as AgentMessage;
}

function assistantMsg(
	text: string,
	opts: { toolCalls?: ThinkingBlock[]; timestamp?: number; stopReason?: string } = {},
): AgentMessage {
	const content: unknown[] = [];
	if (text) content.push({ type: "text", text });
	if (opts.toolCalls) content.push(...opts.toolCalls);
	return {
		role: "assistant",
		content,
		api: "openai.completions.azure",
		timestamp: opts.timestamp ?? 2000,
		stopReason: opts.stopReason ?? "stop",
	} as unknown as AgentMessage;
}

function toolResultMsg(
	toolCallId: string,
	text: string,
	toolName = "read",
	isError = false,
): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
	} as unknown as AgentMessage;
}

function thinkingBlock(text: string): ThinkingBlock {
	return { type: "thinking", thinking: text } as unknown as ThinkingBlock;
}

type ThinkingBlock = { type: "thinking"; thinking: string };

function toolCallBlock(id: string, name: string, args: unknown): unknown {
	return {
		type: "toolCall",
		id,
		function: { name, arguments: args },
	};
}

// ===========================================================================
// piToOpenAI
// ===========================================================================

describe("piToOpenAI", () => {
	it("converts user messages", () => {
		const msgs = [userMsg("hello")];
		const openai = piToOpenAI(msgs);

		expect(openai).toHaveLength(1);
		expect(openai[0].role).toBe("user");
		expect(openai[0].content).toBe("hello");
	});

	it("converts assistant text messages", () => {
		const msgs = [assistantMsg("I'll help you")];
		const openai = piToOpenAI(msgs);

		expect(openai).toHaveLength(1);
		expect(openai[0].role).toBe("assistant");
		expect(openai[0].content).toBe("I'll help you");
	});

	it("strips thinking content and stores on message via _piThinking", () => {
		const msgs = [
			assistantMsg("response", {
				toolCalls: [thinkingBlock("let me think...")],
			}),
		];
		const openai = piToOpenAI(msgs);

		expect(openai[0].content).toBe("response");
		expect(openai[0]._piThinking).toHaveLength(1);
		expect(openai[0]._piThinking![0].thinking).toBe("let me think...");
	});

	it("converts tool calls with Record arguments to string", () => {
		const tc = toolCallBlock("call_1", "edit", { file: "test.ts", line: 42 });
		const msgs = [assistantMsg("", { toolCalls: [tc] })];
		const openai = piToOpenAI(msgs);

		expect(openai[0].tool_calls).toHaveLength(1);
		expect(openai[0].tool_calls![0].function.name).toBe("edit");
		expect(openai[0].tool_calls![0].function.arguments).toBe(
			JSON.stringify({ file: "test.ts", line: 42 }),
		);
	});

	it("converts tool messages", () => {
		const msgs = [toolResultMsg("call_1", "file contents here")];
		const openai = piToOpenAI(msgs);

		expect(openai).toHaveLength(1);
		expect(openai[0].role).toBe("tool");
		expect(openai[0].tool_call_id).toBe("call_1");
		expect(openai[0].content).toBe("file contents here");
	});

	it("converts mixed conversation", () => {
		const msgs = [
			userMsg("read file x"),
			assistantMsg("ok", { toolCalls: [toolCallBlock("c1", "read", { path: "x" })] }),
			toolResultMsg("c1", "file contents"),
			assistantMsg("the file says hello"),
		];
		const openai = piToOpenAI(msgs);

		expect(openai).toHaveLength(4);
		expect(openai[0].role).toBe("user");
		expect(openai[1].role).toBe("assistant");
		expect(openai[1].tool_calls).toHaveLength(1);
		expect(openai[2].role).toBe("tool");
		expect(openai[3].role).toBe("assistant");
	});

	it("converts array user content to text string", () => {
		const msg: AgentMessage = {
			role: "user",
			content: [
				{ type: "text", text: "describe this" },
				{ type: "image", image_url: "https://example.com/img.png" },
			],
			timestamp: 1000,
		} as unknown as AgentMessage;

		const openai = piToOpenAI([msg]);

		expect(openai).toHaveLength(1);
		expect(openai[0].role).toBe("user");
		expect(typeof openai[0].content).toBe("string");
		expect(openai[0].content).toContain("describe this");
	});

	// --- Round 6: edge cases ---

	it("handles empty message array", () => {
		const openai = piToOpenAI([]);
		expect(openai).toHaveLength(0);
	});

	it("handles user message with null content", () => {
		const msg: AgentMessage = {
			role: "user",
			content: null,
			timestamp: 1000,
		} as unknown as AgentMessage;

		const openai = piToOpenAI([msg]);
		expect(openai).toHaveLength(1);
		expect(openai[0].content).toBe("");
	});

	it("handles user message with undefined content", () => {
		const msg: AgentMessage = {
			role: "user",
			content: undefined,
			timestamp: 1000,
		} as unknown as AgentMessage;

		const openai = piToOpenAI([msg]);
		expect(openai).toHaveLength(1);
		expect(openai[0].content).toBe("");
	});

	it("handles user message with empty string content", () => {
		const openai = piToOpenAI([userMsg("")]);
		expect(openai).toHaveLength(1);
		expect(openai[0].content).toBe("");
	});

	it("handles assistant message with only tool calls (no text)", () => {
		const tc = toolCallBlock("c1", "read", { path: "file.ts" });
		const msgs = [assistantMsg("", { toolCalls: [tc] })];
		const openai = piToOpenAI(msgs);

		expect(openai[0].role).toBe("assistant");
		expect(openai[0].content).toBeUndefined();
		expect(openai[0].tool_calls).toHaveLength(1);
	});

	it("handles assistant message with multiple tool calls", () => {
		const tc1 = toolCallBlock("c1", "read", { path: "a.ts" });
		const tc2 = toolCallBlock("c2", "edit", { path: "b.ts" });
		const msgs = [assistantMsg("working", { toolCalls: [tc1, tc2] })];
		const openai = piToOpenAI(msgs);

		expect(openai[0].role).toBe("assistant");
		expect(openai[0].content).toBe("working");
		expect(openai[0].tool_calls).toHaveLength(2);
	});

	it("handles tool error flag preservation", () => {
		const msgs = [toolResultMsg("c1", "error output", "bash", true)];
		const openai = piToOpenAI(msgs);

		expect(openai[0]._piIsError).toBe(true);
	});

	it("passes through unknown role messages as-is", () => {
		const msg = { role: "system", content: "you are a helpful assistant" } as unknown as AgentMessage;
		const openai = piToOpenAI([msg]);

		expect(openai).toHaveLength(1);
		expect(openai[0].role).toBe("system");
		expect(openai[0].content).toBe("you are a helpful assistant");
	});

	it("handles user message with empty array content", () => {
		const msg: AgentMessage = {
			role: "user",
			content: [],
			timestamp: 1000,
		} as unknown as AgentMessage;

		const openai = piToOpenAI([msg]);
		expect(openai[0].content).toBe("");
	});
});

// ===========================================================================
// openAIToPi
// ===========================================================================

describe("openAIToPi", () => {
	it("converts user messages back", () => {
		const original = [userMsg("hello")];
		const openai = piToOpenAI(original);
		const restored = openAIToPi(openai);

		expect(restored).toHaveLength(1);
		expect(restored[0].role).toBe("user");
		expect((restored[0] as unknown as { content: unknown }).content).toBe("hello");
	});

	it("converts assistant text back", () => {
		const original = [assistantMsg("response")];
		const openai = piToOpenAI(original);
		const restored = openAIToPi(openai);

		expect(restored).toHaveLength(1);
		expect(restored[0].role).toBe("assistant");
	});

	it("restores thinking blocks from _piThinking field", () => {
		const original = [
			assistantMsg("response", { toolCalls: [thinkingBlock("thought")] }),
		];
		const openai = piToOpenAI(original);
		const restored = openAIToPi(openai);

		const content = (restored[0] as unknown as { content: unknown[] }).content;
		expect(content).toHaveLength(2);
		expect((content[0] as { type: string }).type).toBe("thinking");
		expect((content[1] as { type: string }).type).toBe("text");
	});

	it("restores tool calls with parsed arguments", () => {
		const tc = toolCallBlock("call_1", "edit", { line: 10 });
		const original = [assistantMsg("", { toolCalls: [tc] })];
		const openai = piToOpenAI(original);
		const restored = openAIToPi(openai);

		const content = (restored[0] as unknown as { content: unknown[] }).content;
		expect(content).toHaveLength(1);
		const restoredTc = content[0] as { type: string; id: string; function: { name: string; arguments: unknown } };
		expect(restoredTc.type).toBe("toolCall");
		expect(restoredTc.function.name).toBe("edit");
		expect(restoredTc.function.arguments).toEqual({ line: 10 });
	});

	it("converts tool messages back", () => {
		const original = [toolResultMsg("call_1", "output")];
		const openai = piToOpenAI(original);
		const restored = openAIToPi(openai);

		expect(restored[0].role).toBe("toolResult");
		const restoredTr = restored[0] as unknown as { toolCallId: string; content: unknown[] };
		expect(restoredTr.toolCallId).toBe("call_1");
		expect((restoredTr.content[0] as { text: string }).text).toBe("output");
	});

	// --- Round 6: edge cases ---

	it("handles empty compressed array", () => {
		const restored = openAIToPi([]);
		expect(restored).toHaveLength(0);
	});

	it("cleans up _piThinking from messages after extraction", () => {
		const original = [
			assistantMsg("response", { toolCalls: [thinkingBlock("thought")] }),
		];
		const openai = piToOpenAI(original);

		// Before openAIToPi, _piThinking should be present
		expect(openai[0]._piThinking).toBeDefined();

		openAIToPi(openai);

		// After openAIToPi, _piThinking should be cleaned up
		expect(openai[0]._piThinking).toBeUndefined();
	});

	it("handles message without _piThinking field", () => {
		const openaiMsg = { role: "assistant", content: "hello" };
		const restored = openAIToPi([openaiMsg]);

		expect(restored).toHaveLength(1);
		expect(restored[0].role).toBe("assistant");
		const content = (restored[0] as unknown as { content: unknown[] }).content;
		expect(content).toHaveLength(1);
		expect((content[0] as { type: string }).type).toBe("text");
	});

	it("handles tool message without _piIsError", () => {
		const openaiMsg = { role: "tool", tool_call_id: "c1", content: "output" };
		const restored = openAIToPi([openaiMsg]);

		expect(restored[0].role).toBe("toolResult");
		const restoredTr = restored[0] as unknown as { isError?: boolean };
		expect(restoredTr.isError).toBeUndefined();
	});

	it("handles unknown role messages as-is", () => {
		const openaiMsg = { role: "system", content: "helpful assistant" };
		const restored = openAIToPi([openaiMsg]);

		expect(restored).toHaveLength(1);
		expect(restored[0].role).toBe("system");
	});
});

// ===========================================================================
// Round-trip
// ===========================================================================

describe("round-trip", () => {
	it("preserves conversation through pi→openai→pi", () => {
		const original: AgentMessage[] = [
			userMsg("hello"),
			assistantMsg("hi there"),
			userMsg("read file"),
			assistantMsg("", { toolCalls: [toolCallBlock("c1", "read", { path: "f" })] }),
			toolResultMsg("c1", "content"),
			assistantMsg("done"),
		];

		const openai = piToOpenAI(original);
		const restored = openAIToPi(openai);

		expect(restored.length).toBe(original.length);

		for (let i = 0; i < restored.length; i++) {
			expect(restored[i].role).toBe(original[i].role);
		}

		expect((restored[0] as unknown as { content: string }).content).toBe("hello");

		const rest1 = restored[1] as unknown as { content: unknown[] };
		expect(rest1.content[0]).toEqual({ type: "text", text: "hi there" });

		const rest3 = restored[3] as unknown as { content: unknown[] };
		const restTc = rest3.content[0] as { type: string; function: { name: string } };
		expect(restTc.type).toBe("toolCall");
		expect(restTc.function.name).toBe("read");

		const rest4 = restored[4] as unknown as { content: unknown[] };
		expect((rest4.content[0] as { text: string }).text).toBe("content");
	});

	it("preserves thinking blocks through round-trip", () => {
		const original: AgentMessage[] = [
			assistantMsg("answer", { toolCalls: [thinkingBlock("deep thought")] }),
		];

		const openai = piToOpenAI(original);
		const restored = openAIToPi(openai);

		const content = (restored[0] as unknown as { content: unknown[] }).content;
		expect(content.length).toBeGreaterThanOrEqual(2);
		expect((content[0] as { type: string }).type).toBe("thinking");
	});

	it("handles error tool results through round-trip", () => {
		const original: AgentMessage[] = [
			toolResultMsg("c1", "error", "bash", true),
		];

		const openai = piToOpenAI(original);
		const restored = openAIToPi(openai);

		expect(restored[0].role).toBe("toolResult");
		const restoredTr = restored[0] as unknown as { isError?: boolean };
		expect(restoredTr.isError).toBe(true);
	});
});
