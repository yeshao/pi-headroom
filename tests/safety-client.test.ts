import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCompress } = vi.hoisted(() => ({
  mockCompress: vi.fn(),
}));

vi.mock("headroom-ai", async (importOriginal) => {
  const originalModule = await importOriginal<typeof import("headroom-ai")>();
  return { ...originalModule, compress: mockCompress };
});

import { HeadroomClient } from "../src/headroom-client.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { HeadroomExtensionConfig } from "../src/config.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

function userMsg(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 1000 } as unknown as AgentMessage;
}
function assistantMsg(text: string): AgentMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    stopReason: "stop",
    timestamp: 2000,
  } as unknown as AgentMessage;
}
function makeConfig(overrides: Partial<HeadroomExtensionConfig> = {}): HeadroomExtensionConfig {
  return { ...DEFAULT_CONFIG, minTokensPct: 0, maxTokensPct: 0, ...overrides };
}

describe("HeadroomClient.compressMessages()", () => {
  beforeEach(() => {
    mockCompress.mockReset();
    mockCompress.mockResolvedValue({
      messages: [],
      tokensBefore: 0,
      tokensAfter: 0,
      tokensSaved: 0,
      compressionRatio: 1,
      transformsApplied: [],
      ccrHashes: [],
      compressed: false,
    });
  });

  it("returns uncompressed when messages < minContextLength", async () => {
    const config: HeadroomExtensionConfig = { ...makeConfig(), minContextLength: 5 };
    const client = new HeadroomClient(config);
    const messages = [userMsg("hi"), assistantMsg("hello"), userMsg("again")];
    const { result } = await client.compressMessages(messages);
    expect(result.compressed).toBe(false);
    expect(mockCompress).not.toHaveBeenCalled();
  });

  it("calls through to SDK when messages >= minContextLength", async () => {
    const config: HeadroomExtensionConfig = { ...makeConfig(), minContextLength: 2 };
    const client = new HeadroomClient(config);
    await client.compressMessages([userMsg("a"), userMsg("b")]);
    expect(mockCompress).toHaveBeenCalledTimes(1);
  });

  it("speed profile passes smartCrusher disabled to compress", async () => {
    const config: HeadroomExtensionConfig = { ...makeConfig(), profile: "speed", minContextLength: 2 };
    const client = new HeadroomClient(config);
    await client.compressMessages([userMsg("a"), userMsg("b")]);
    const callArgs = mockCompress.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(callArgs[1].smartCrusher).toEqual({ enabled: false });
    expect(callArgs[1].cacheAligner).toEqual({ enabled: false });
    expect(callArgs[1].intelligentContext).toEqual({ enabled: false });
  });

  it("maximum profile passes smartCrusher + intelligentContext enabled", async () => {
    const config: HeadroomExtensionConfig = { ...makeConfig(), profile: "maximum", minContextLength: 2 };
    const client = new HeadroomClient(config);
    await client.compressMessages([userMsg("a"), userMsg("b")]);
    const callArgs = mockCompress.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(callArgs[1].smartCrusher).toMatchObject({ enabled: true });
    expect(callArgs[1].intelligentContext).toMatchObject({ enabled: true });
  });

  it("balanced profile passes no overrides (SDK defaults)", async () => {
    const config: HeadroomExtensionConfig = { ...makeConfig(), profile: "balanced", minContextLength: 2 };
    const client = new HeadroomClient(config);
    await client.compressMessages([userMsg("a"), userMsg("b")]);
    const callArgs = mockCompress.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(callArgs[1].smartCrusher).toBeUndefined();
    expect(callArgs[1].intelligentContext).toBeUndefined();
  });

  it("passes tokenBudget when minTokensPct/maxTokensPct configured", async () => {
    // Use minTokensPct: 0 so compression fires on small test messages
    const config: HeadroomExtensionConfig = {
      ...makeConfig(),
      minContextLength: 2,
      minTokensPct: 0,
      maxTokensPct: 0.5,
    };
    const client = new HeadroomClient(config);
    client.setModelId("gpt-4o");
    await client.compressMessages([userMsg("a"), userMsg("b")]);
    const callArgs = mockCompress.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(callArgs[1].tokenBudget).toBe(64000); // 50% of 128000
  });

  it("does not pass tokenBudget when threshold config is absent", async () => {
    const config: HeadroomExtensionConfig = {
      ...makeConfig(),
      minTokensPct: undefined,
      maxTokensPct: undefined,
      minContextLength: 2,
    };
    const client = new HeadroomClient(config);
    await client.compressMessages([userMsg("a"), userMsg("b")]);
    const callArgs = mockCompress.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(callArgs[1].tokenBudget).toBeUndefined();
  });

  it("estimateTotalTokens counts content + tool call arguments", () => {
    const client = new HeadroomClient(DEFAULT_CONFIG);
    const args = JSON.stringify({ old_string: "foo bar baz", new_string: "qux" });
    const openaiMsgs: Record<string, unknown>[] = [
      { role: "user", content: "Hello world this is a test" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "tc1",
          type: "function",
          function: { name: "edit", arguments: args },
        }],
      },
    ];
    const estimate = (client as unknown as { estimateTotalTokens: (m: Record<string, unknown>[]) => number })
      .estimateTotalTokens(openaiMsgs);
    // 26 chars / 4 = 7, 48 chars / 4 = 12, total = 19
    expect(estimate).toBe(19);
  });

  it("CCR store is accessible via getCCRStore()", () => {
    const client = new HeadroomClient(DEFAULT_CONFIG);
    const store = client.getCCRStore();
    expect(store).toBeDefined();
    expect(typeof store.retrieve).toBe("function");
  });
});
