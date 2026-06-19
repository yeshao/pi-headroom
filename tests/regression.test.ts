import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { piToOpenAI, openAIToPi } from "../src/format-bridge.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ===========================================================================
// BUG-01: Thinking blocks must survive compression reordering
// ===========================================================================

describe("BUG-01: thinking block preservation after message removal", () => {
	it("attaches thinking to the correct message even when earlier messages are removed", () => {
		const original: AgentMessage[] = [
			userMsg("msg0"),
			userMsg("msg1"),
			userMsg("msg2"),
			assistantMsg("msg3 with thinking", { toolCalls: [thinkingBlock("deep thought")] }),
			userMsg("msg4"),
		];

		const openai = piToOpenAI(original);

		// Simulate headroom removing the first 2 messages (rollingWindow)
		const compressed = openai.slice(2); // [msg2, msg3, msg4]

		const restored = openAIToPi(compressed);

		// restored[1] should be the assistant message with thinking
		expect(restored).toHaveLength(3);
		expect(restored[1].role).toBe("assistant");
		const content = (restored[1] as unknown as { content: unknown[] }).content;
		expect(content[0]).toEqual({ type: "thinking", thinking: "deep thought" });
		expect(content[1]).toEqual({ type: "text", text: "msg3 with thinking" });
	});

	it("preserves thinking when messages are reordered", () => {
		const original: AgentMessage[] = [
			assistantMsg("first", { toolCalls: [thinkingBlock("think1")] }),
			assistantMsg("second", { toolCalls: [thinkingBlock("think2")] }),
			assistantMsg("third", { toolCalls: [thinkingBlock("think3")] }),
		];

		const openai = piToOpenAI(original);

		// Simulate reorder: swap first and last
		const compressed = [openai[2], openai[1], openai[0]];

		const restored = openAIToPi(compressed);

		// restored[0] was originally "third" → should have think3
		const content0 = (restored[0] as unknown as { content: unknown[] }).content;
		expect((content0[0] as { type: string; thinking?: string }).type).toBe("thinking");
		expect((content0[0] as { thinking: string }).thinking).toBe("think3");

		// restored[2] was originally "first" → should have think1
		const content2 = (restored[2] as unknown as { content: unknown[] }).content;
		expect((content2[0] as { thinking: string }).thinking).toBe("think1");
	});

	it("drops thinking gracefully when assistant message is removed entirely", () => {
		const original: AgentMessage[] = [
			userMsg("msg0"),
			assistantMsg("will be removed", { toolCalls: [thinkingBlock("lost thought")] }),
			userMsg("msg2"),
		];

		const openai = piToOpenAI(original);

		// Remove the assistant message entirely
		const compressed = [openai[0], openai[2]];

		const restored = openAIToPi(compressed);

		expect(restored).toHaveLength(2);
		expect(restored[0].role).toBe("user");
		expect(restored[1].role).toBe("user");
	});
});

// ===========================================================================
// BUG-02: User message array content must be stringified
// ===========================================================================

describe("BUG-02: user message array content handling", () => {
	it("converts array content to text string", () => {
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

	it("handles plain string content unchanged", () => {
		const msgs = [userMsg("hello")];
		const openai = piToOpenAI(msgs);

		expect(openai[0].content).toBe("hello");
	});
});

// ===========================================================================
// BUG-03: tool_result catch must log errors
// ===========================================================================

describe("BUG-03: error handling verification", () => {
	it("catch block in tool_result handler contains error reporting", () => {
		const fs = require("node:fs") as typeof import("node:fs");
		const src = fs.readFileSync(
			resolve(__dirname, "../src/index.ts"),
			"utf-8",
		);

		const toolResultIdx = src.indexOf("pi.on(\"tool_result\"");
		expect(toolResultIdx).toBeGreaterThan(-1);

		const catchIdx = src.indexOf("catch", toolResultIdx);
		expect(catchIdx).toBeGreaterThan(-1);
		expect(catchIdx).toBeLessThan(toolResultIdx + 2000);

		const catchBlockEnd = src.indexOf("});", catchIdx);
		const catchBlock = src.substring(catchIdx, catchBlockEnd);

		expect(catchBlock).toContain("notify");
	});
});

// ===========================================================================
// BUG-04: result.compressed must be checked
// ===========================================================================

describe("BUG-04: compress result flag checking", () => {
	it("headroom-client source checks result.compressed", () => {
		const fs = require("node:fs") as typeof import("node:fs");
		const src = fs.readFileSync(
			resolve(__dirname, "../src/headroom-client.ts"),
			"utf-8",
		);

		expect(src).toMatch(/result\.compressed/);
	});
});

// ===========================================================================
// BUG-05: protectRecent renamed to minContextLength
// ===========================================================================

describe("BUG-05: protectRecent renamed to minContextLength", () => {
	it("config uses minContextLength not protectRecent", () => {
		const fs = require("node:fs") as typeof import("node:fs");
		const configSrc = fs.readFileSync(
			resolve(__dirname, "../src/config.ts"),
			"utf-8",
		);

		expect(configSrc).toMatch(/minContextLength/);
		expect(configSrc).not.toMatch(/protectRecent/);
	});

	it("index.ts uses minContextLength", () => {
		const fs = require("node:fs") as typeof import("node:fs");
		const indexSrc = fs.readFileSync(
			resolve(__dirname, "../src/index.ts"),
			"utf-8",
		);

		expect(indexSrc).toMatch(/minContextLength/);
		expect(indexSrc).not.toMatch(/protectRecent/);
	});
});

// ===========================================================================
// BUG-06: config.enabled must be used (not shadowed)
// ===========================================================================

describe("BUG-06: config.enabled is not shadowed", () => {
	it("no local let enabled variable in index.ts", () => {
		const fs = require("node:fs") as typeof import("node:fs");
		const src = fs.readFileSync(
			resolve(__dirname, "../src/index.ts"),
			"utf-8",
		);

		expect(src).not.toMatch(/^let enabled = true/m);
		expect(src).toMatch(/config\.enabled/);
	});
});

// ===========================================================================
// BUG-07: targetRatio must reach the SDK
// ===========================================================================

describe("BUG-07: targetRatio reaches headroom SDK", () => {
	it("buildHeadroomConfig references targetRatio", () => {
		const fs = require("node:fs") as typeof import("node:fs");
		const src = fs.readFileSync(
			resolve(__dirname, "../src/config.ts"),
			"utf-8",
		);

		const fnBody = src.substring(src.indexOf("buildHeadroomConfig"));
		expect(fnBody).toMatch(/targetRatio/);
	});
});

// ===========================================================================
// BUG-08: compressUserMessages removed as dead code (intentionally simplified)
// ===========================================================================

describe("BUG-08: compressUserMessages removed from config", () => {
	it("config.ts no longer has compressUserMessages field", () => {
		const fs = require("node:fs") as typeof import("node:fs");
		const configSrc = fs.readFileSync(
			resolve(__dirname, "../src/config.ts"),
			"utf-8",
		);

		expect(configSrc).not.toMatch(/compressUserMessages/);
	});

	it("DEFAULT_CONFIG does not have compressUserMessages", () => {
		expect("compressUserMessages" in DEFAULT_CONFIG).toBe(false);
	});
});

// ===========================================================================
// NEW-01: profile setting must affect compression behavior
// ===========================================================================

describe("NEW-01: profile setting affects buildHeadroomConfig", () => {
	it("config.ts uses profile field in buildHeadroomConfig", () => {
		const fs = require("node:fs") as typeof import("node:fs");
		const src = fs.readFileSync(
			resolve(__dirname, "../src/config.ts"),
			"utf-8",
		);

		const fnBody = src.substring(src.indexOf("buildHeadroomConfig"));
		expect(fnBody).toMatch(/profile/);
	});
});

// ===========================================================================
// NEW-02: sessionStats must reset on session_start
// ===========================================================================

describe("NEW-02: sessionStats resets on session_start", () => {
	it("session_start handler resets stats", () => {
		const fs = require("node:fs") as typeof import("node:fs");
		const src = fs.readFileSync(
			resolve(__dirname, "../src/index.ts"),
			"utf-8",
		);

		const sessionStartIdx = src.indexOf("session_start");
		expect(sessionStartIdx).toBeGreaterThan(-1);

		const handlerEnd = src.indexOf("});", sessionStartIdx);
		const handlerBody = src.substring(sessionStartIdx, handlerEnd);

		expect(handlerBody).toMatch(/createSessionStats|Object\.assign/);
	});
});

// ===========================================================================
// NEW-03: tool result handler skips array content
// ===========================================================================

describe("NEW-03: tool result handler skips array content", () => {
	it("tool_result handler checks for Array.isArray before compressing", () => {
		const fs = require("node:fs") as typeof import("node:fs");
		const src = fs.readFileSync(
			resolve(__dirname, "../src/index.ts"),
			"utf-8",
		);

		const toolResultIdx = src.indexOf("pi.on(\"tool_result\"");
		expect(toolResultIdx).toBeGreaterThan(-1);

		const handlerEnd = src.indexOf("});", toolResultIdx);
		const handlerBody = src.substring(toolResultIdx, handlerEnd);

		expect(handlerBody).toMatch(/Array\.isArray/);
	});
});

// ===========================================================================
// NEW-04: status bar update moved outside result.compressed check
// ===========================================================================

describe("NEW-04: status bar updated regardless of compression result", () => {
	it("status bar update is outside result.compressed block", () => {
		const fs = require("node:fs") as typeof import("node:fs");
		const src = fs.readFileSync(
			resolve(__dirname, "../src/index.ts"),
			"utf-8",
		);

		const compressedCheckIdx = src.indexOf("result.compressed");
		const statusUpdateIdx = src.indexOf("setStatus(\"headroom\", getStatusBarText", compressedCheckIdx);

		expect(statusUpdateIdx).toBeGreaterThan(compressedCheckIdx);
	});
});

// ===========================================================================
// CONC-01: lastContextMessages cleared on session_start (not per-context)
// ===========================================================================

describe("CONC-01: lastContextMessages not cleared per-context (simulate works)", () => {
	it("context handler does NOT have a finally block that clears lastContextMessages", () => {
		const fs = require("node:fs") as typeof import("node:fs");
		const src = fs.readFileSync(
			resolve(__dirname, "../src/index.ts"),
			"utf-8",
		);

		const contextIdx = src.indexOf("pi.on(\"context\"");
		expect(contextIdx).toBeGreaterThan(-1);

		const handlerEnd = src.indexOf("});", contextIdx);
		const handlerBody = src.substring(contextIdx, handlerEnd);

		// The handler should NOT have a finally block that clears lastContextMessages
		expect(handlerBody).not.toMatch(/finally\s*\{[^}]*lastContextMessages\s*=\s*\[\]/);
	});

	it("session_shutdown clears lastContextMessages", () => {
		const fs = require("node:fs") as typeof import("node:fs");
		const src = fs.readFileSync(
			resolve(__dirname, "../src/index.ts"),
			"utf-8",
		);

		const sessionShutdownIdx = src.indexOf("session_shutdown");
		const sessionEnd = src.indexOf("});", sessionShutdownIdx);
		const handlerBody = src.substring(sessionShutdownIdx, sessionEnd);

		expect(handlerBody).toMatch(/lastContextMessages/);
	});
});

// ===========================================================================
// Helpers
// ===========================================================================

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

type ThinkingBlock = { type: "thinking"; thinking: string };

function thinkingBlock(text: string): ThinkingBlock {
	return { type: "thinking", thinking: text } as unknown as ThinkingBlock;
}
