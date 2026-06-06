# BugFind Report: pi-headroom v2

**Audit date:** 2026-06-06
**Scope:** 5 TypeScript source files, 807 lines total
**Methodology:** BugFind Hunt stage — 64 bug class taxonomy, parallel agent audit

## Summary

| | Count |
|---|---|
| Critical | 1 |
| High | 5 |
| Medium | 2 |
| False positives | 0 |
| **Total confirmed** | **8** |

---

## Findings

### CRITICAL

**BUG-01 — Incorrect Assumptions: Thinking block index mis-mapping after compression**
- **File:** `src/format-bridge.ts:233`
- **Class:** `incorrect_assumptions`
- **Code:**
  ```ts
  // piToOpenAI stores thinking blocks by ORIGINAL array index:
  extras.thinkingBlocks[String(i)] = thinking; // line 103

  // openAIToPi looks them up by COMPRESSED array index:
  const thinking = extras.thinkingBlocks[String(i)]; // line 233
  ```
- **Why it's a bug:** `openAIToPi` iterates the compressed message array (output from headroom's `compress()`), but the extras indices were assigned during `piToOpenAI` which uses the original array. When any headroom transform removes or reorders messages (rollingWindow, smartCrusher, intelligentContext), the compressed array is shorter or differently ordered. Thinking blocks get attached to wrong messages or silently dropped.
- **Reproduction:** Send 8 messages where message at index 3 has thinking content. Enable `rollingWindow` with `keepLastTurns: 2`. After compression, `compressed[]` has 3 entries. `extras.thinkingBlocks['3']` maps to compressed index 3, which doesn't exist — the thinking content is lost.
- **Impact:** Silent loss of model reasoning data. Since thinking content carries internal model state, losing or mis-attaching it breaks the conversation continuity. The next LLM call sees incorrect context.

### HIGH

**BUG-02 — Incorrect Boolean Logic / Dead Logic: No-op ternary for user content**
- **File:** `src/format-bridge.ts:67`
- **Class:** `incorrect_boolean_logic`, `dead_code`
- **Code:**
  ```ts
  const content = typeof msg.content === "string" ? msg.content : msg.content;
  ```
- **Why it's a bug:** Both branches of the ternary are identical. Pi user messages can be `string | (TextContent | ImageContent)[]`. When content is an array (multimodal user input with images), it passes through unchanged instead of being stringified or extracted. The headroom SDK expects user content as a string in OpenAI format, so array content may be misparsed or rejected.
- **Reproduction:** Create a user message with `content: [{ type: "image", ... }, { type: "text", text: "describe this" }]`. `piToOpenAI()` emits `{ role: "user", content: [{ type: "image", ... }, ...] }` — headroom treats this as unknown format.
- **Impact:** Multimodal user messages silently break compression.

**BUG-03 — Error Handling: Silent exception swallowing**
- **File:** `src/index.ts:154-156`
- **Class:** `error_handling`
- **Code:**
  ```ts
  } catch {
      // Compression failed — use original content
  }
  ```
- **Why it's a bug:** Bare `catch` with empty body. If `compressed[0]` is undefined (e.g., headroom returns empty array), `compressed[0].content` throws `TypeError` on line 148 — which is silently swallowed. No user notification, no debug trail, no fallback.
- **Reproduction:** Trigger `tool_result` hook while headroom compressor returns empty `messages` array. TypeError thrown and swallowed; tool result silently forwarded with original content.
- **Impact:** Silent corruption path with zero observability.

**BUG-04 — Error Handling: Never checks result.compressed**
- **File:** `src/headroom-client.ts:39-49`
- **Class:** `error_handling`
- **Code:**
  ```ts
  const result = await compress(openai, { ...headroomConfig, fallback: true });
  const compressedPi = openAIToPi(result.messages, messages, extras);
  return { messages: compressedPi, result };
  ```
- **Why it's a bug:** With `fallback: true`, the SDK returns `{ compressed: false, messages: original }` when the proxy is unavailable. The code never checks `result.compressed`. Falls through to record stats as if compression occurred (ratio=1, 0 tokens saved) — the stats are indistinguishable from "compression ran but found nothing to compress."
- **Reproduction:** Disconnect from headroom proxy. Run prompts. Stats show "Headroom: -0%" with no indication compression never ran.
- **Impact:** Misleading statistics; operator can't distinguish "compression is working but nothing to save" from "compression is broken."

**BUG-05 — Incorrect Assumptions: protectRecent semantics**
- **File:** `src/index.ts:85`
- **Class:** `incorrect_assumptions`
- **Code:**
  ```ts
  if (messages.length <= config.protectRecent + 1) { return; }
  ```
- **Why it's a bug:** Field named `protectRecent` implies it selectively protects N most recent messages from compression. In reality it's a total-length guard: compression is skipped outright when the message count is ≤ N+1. When messages exceed that threshold, ALL messages (including recent ones) are compressed — no selective protection exists.
- **Reproduction:** Set `protectRecent: 5`. With 6 messages, compression runs on all 6 — including the 5 most recent ones.
- **Impact:** User-visible setting name is misleading. The field should be renamed to `minContextLength` or actual selective protection should be implemented.

**BUG-06 — Dead Code: config.enabled shadowed**
- **File:** `src/config.ts:17` vs `src/index.ts:41`
- **Class:** `dead_code`
- **Code:**
  ```ts
  // config.ts — declared but never read:
  export interface HeadroomExtensionConfig { enabled: boolean; ... }

  // index.ts — local variable shadows it:
  let enabled = true;
  ```
- **Why it's a bug:** Setting `config.enabled = false` has zero effect because all code paths use the local `let enabled` variable. User changing this setting sees it displayed in `/headroom-config` output but it doesn't control behavior.
- **Reproduction:** Set `enabled: false` in DEFAULT_CONFIG. Extension starts with compression active because `let enabled = true` on the next line.
- **Impact:** Configuration vs. behavior disconnect. User setting is dead code.

### MEDIUM

**BUG-07 — Dead Code: config.targetRatio never reaches headroom SDK**
- **File:** `src/config.ts:18,31,48-71` vs `src/index.ts:293`
- **Class:** `dead_code`
- **Code:** `buildHeadroomConfig()` only sets sub-config enable/disable flags per profile. The `targetRatio` field is declared, defaulted, displayed, but never passed to either `compress()` options or `HeadroomConfig`.
- **Why it's a bug:** User-visible configuration that has zero effect on compression behavior. Changing `targetRatio` from 0.5 to 0.8 does nothing.
- **Impact:** Configuration widget that doesn't work — user expects it to control compression aggressiveness but it's ignored.

**BUG-08 — Dead Code: config.compressUserMessages never checked**
- **File:** `src/config.ts:20,33` vs `src/index.ts`
- **Class:** `dead_code`
- **Code:** The field `compressUserMessages` is declared, defaulted to `false`, and displayed in status/config output — but is never read in any conditional check. The context handler compresses all messages unconditionally.
- **Impact:** User sees a setting in their config output that doesn't control anything.

---

## False Positives Debunked

None — all 8 findings confirmed through code inspection.

---

## Priority Fix Order

1. **BUG-01** (Critical) — Fix `openAIToPi` index mapping. Either use message identity instead of array index, or pass a lookup key alongside each message through the compression pipeline.
2. **BUG-02** (High) — Fix no-op ternary: extract text from array content or pass through properly.
3. **BUG-04** (High) — Check `result.compressed` and skip stats recording on failure.
4. **BUG-03** (High) — Add logging to empty catch block.
5. **BUG-05** (High) — Rename `protectRecent` to `minContextLength` or implement selective protection.
6. **BUG-06** (Medium) — Remove local `enabled` variable, use `config.enabled` throughout.
7. **BUG-07** (Medium) — Pass `targetRatio` to headroom SDK in `buildHeadroomConfig()`.
8. **BUG-08** (Medium) — Either wire up `compressUserMessages` or remove it from the config.
