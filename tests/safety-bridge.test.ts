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
	opts: {
		toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
		timestamp?: number;
	} = {},
): AgentMessage {
	const content: unknown[] = [];
	if (text) content.push({ type: "text", text });
	for (const tc of opts.toolCalls ?? []) {
		content.push({
			type: "toolCall",
			id: tc.id,
			function: { name: tc.name, arguments: JSON.stringify(tc.args) },
		});
	}
	return { role: "assistant", content, timestamp: opts.timestamp ?? 2000 } as unknown as AgentMessage;
}

function toolResultMsg(toolCallId: string, text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		content: [{ type: "text", text }],
		timestamp: 3000,
	} as unknown as AgentMessage;
}

function generateSourceCode(lineCount: number): string {
	return Array.from({ length: lineCount }, (_, i) => `// line ${i + 1}: const x${i + 1} = ${(i + 1) * 2};`).join("\n");
}

function buildReadEditSession(sourceCode: string): AgentMessage[] {
	return [
		userMsg("Please read the file and make an edit"),
		assistantMsg("", { toolCalls: [{ id: "read-1", name: "read", args: { path: "src/index.ts" } }] }),
		toolResultMsg("read-1", sourceCode),
		assistantMsg("", {
			toolCalls: [{
				id: "edit-1",
				name: "edit",
				args: { path: "src/index.ts", old_string: "const x1 = 2;", new_string: "const x1 = 42;" },
			}],
		}),
		assistantMsg("I've updated the file for you."),
	];
}

function extractAllText(messages: AgentMessage[]): string {
	const parts: string[] = [];
	for (const msg of messages) {
		const m = msg as unknown as { content: unknown };
		if (typeof m.content === "string") {
			parts.push(m.content);
		} else if (Array.isArray(m.content)) {
			for (const block of m.content) {
				if (block && typeof block === "object" && "text" in block && typeof (block as { text: unknown }).text === "string") {
					parts.push((block as { text: string }).text);
				}
			}
		}
	}
	return parts.join("\n");
}

interface ToolCallMatch { id: string; name: string; args: Record<string, unknown>; }

function findToolCall(messages: AgentMessage[], name: string): ToolCallMatch | undefined {
	for (const msg of messages) {
		const m = msg as unknown as { role: string; content: unknown[] };
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const block of m.content) {
			if (!block || typeof block !== "object" || !("type" in block)) continue;
			if ((block as { type: string }).type !== "toolCall") continue;
			const tc = block as { type: string; id: string; function: { name: string; arguments: unknown } };
			if (tc.function.name !== name) continue;
			let parsed: Record<string, unknown>;
			if (typeof tc.function.arguments === "string") {
				try { parsed = JSON.parse(tc.function.arguments); } catch { parsed = { raw: tc.function.arguments }; }
			} else {
				parsed = tc.function.arguments as Record<string, unknown>;
			}
			return { id: tc.id, name: tc.function.name, args: parsed };
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("format bridge round-trip (piToOpenAI → openAIToPi)", () => {
	it("preserves user message text", () => {
		const original = [userMsg("Hello, please analyze this codebase")];
		const restored = openAIToPi(piToOpenAI(original));
		expect(restored).toHaveLength(1);
		expect(restored[0].role).toBe("user");
		expect((restored[0] as unknown as { content: string }).content).toBe("Hello, please analyze this codebase");
	});

	it("preserves tool call arguments (edit old_string/new_string)", () => {
		const original = [
			assistantMsg("", {
				toolCalls: [{
					id: "edit-1", name: "edit",
					args: { path: "src/main.ts", old_string: "function old() { return 1; }", new_string: "function updated() { return 42; }" },
				}],
			}),
		];
		const found = findToolCall(openAIToPi(piToOpenAI(original)), "edit");
		expect(found).toBeDefined();
		expect(found!.args.path).toBe("src/main.ts");
		expect(found!.args.old_string).toBe("function old() { return 1; }");
		expect(found!.args.new_string).toBe("function updated() { return 42; }");
	});

	it("preserves tool result content (source code)", () => {
		const sourceCode = "import { foo } from './bar';\n\nexport const x = foo();";
		const restored = openAIToPi(piToOpenAI([toolResultMsg("call-1", sourceCode)]));
		expect(restored).toHaveLength(1);
		expect(restored[0].role).toBe("toolResult");
		const content = (restored[0] as unknown as { content: unknown[] }).content;
		expect((content[0] as unknown as { type: string; text: string }).text).toBe(sourceCode);
	});

	it("preserves large content (200+ lines) through round-trip", () => {
		const sourceCode = generateSourceCode(250);
		const restored = openAIToPi(piToOpenAI(buildReadEditSession(sourceCode)));
		expect(restored).toHaveLength(5);
		const tr = (restored[2] as unknown as { content: unknown[] }).content;
		expect((tr[0] as unknown as { text: string }).text).toBe(sourceCode);
		const edit = findToolCall(restored, "edit");
		expect(edit).toBeDefined();
		expect(edit!.args.old_string).toBe("const x1 = 2;");
		expect(edit!.args.new_string).toBe("const x1 = 42;");
	});

	it("preserves multiple read results", () => {
		const files = ["export const a = 1;", "export const b = 2;", "export const c = 3;"];
		const original = [
			userMsg("read three files"),
			assistantMsg("", { toolCalls: [
				{ id: "r1", name: "read", args: { path: "a.ts" } },
				{ id: "r2", name: "read", args: { path: "b.ts" } },
				{ id: "r3", name: "read", args: { path: "c.ts" } },
			] }),
			toolResultMsg("r1", files[0]),
			toolResultMsg("r2", files[1]),
			toolResultMsg("r3", files[2]),
		];
		const restored = openAIToPi(piToOpenAI(original));
		expect(restored).toHaveLength(5);
		for (let i = 0; i < 3; i++) {
			const tr = (restored[2 + i] as unknown as { content: unknown[] }).content;
			expect((tr[0] as unknown as { text: string }).text).toBe(files[i]);
		}
	});

	it("findToolCall parses JSON string args and returns undefined for missing", () => {
		const messages = buildReadEditSession("const x = 1;");
		const read = findToolCall(messages, "read");
		expect(read).toBeDefined();
		expect(read!.args).toEqual({ path: "src/index.ts" });
		expect(findToolCall(messages, "nonexistent")).toBeUndefined();
	});

	it("full session round-trip preserves all text content", () => {
		const messages = buildReadEditSession(generateSourceCode(50));
		const before = extractAllText(messages);
		const after = extractAllText(openAIToPi(piToOpenAI(messages)));
		expect(after).toBe(before);
	});
});
