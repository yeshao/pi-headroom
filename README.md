# pi-headroom

Transparent LLM context compression for [Pi](https://pi.dev) using [Headroom](https://github.com/chopratejas/headroom).

Compresses the message array before each LLM call via the `context` event hook. Achieves 60–95% token reduction with zero accuracy loss. No Python required — runs headroom-ai as an in-process TypeScript library.

## Architecture

```
Pi agent loop
  │
  ├─ context event fires (before each LLM call)
  │
  ├─ pi-headroom intercepts
  │   ├─ Convert Pi messages → OpenAI format (strip ThinkingContent → _piThinking)
  │   ├─ headroom-ai SDK compress() (in-process, no subprocess)
  │   ├─ Validate tool call/result pairing (restore orphaned pairs)
  │   ├─ Convert compressed OpenAI → Pi messages (restore ThinkingContent)
  │   └─ Record stats
  │
  └─ Compressed messages sent to LLM
```

**Key design decisions:**
- **SDK as library, not proxy.** No Python venv, no subprocess, no HTTP proxy port. The headroom-ai SDK's `compress()` function runs in-process, giving us full access to the compression pipeline, configuration, simulation, and metrics.
- **Thinking content preserved.** Pi's `ThinkingContent` blocks are stored on each message as `_piThinking` before compression, so they survive message reordering/removal by the compressor.
- **Format-bridge is minimal.** Pi messages are already OpenAI-compatible. The bridge only handles ThinkingContent strip/restore, ToolCall argument serialization, and Pi-specific field preservation.
- **Tool call pairing validation.** After compression, validates that every `tool_calls[].id` in assistant messages has a corresponding `tool` result message (and vice versa). Orphaned pairs are restored from the original message array to prevent LLM errors on the next turn.

## Installation

```bash
# Clone into Pi extensions directory
git clone https://github.com/yeshao/pi-headroom.git ~/.omp/agent/extensions/pi-headroom

# Or for project-level
git clone https://github.com/yeshao/pi-headroom.git .omp/extensions/pi-headroom
```

## Commands

| Command | Description |
|---------|-------------|
| `/headroom` | Show status, config, and compression stats |
| `/headroom on` | Enable compression |
| `/headroom off` | Disable compression |
| `/headroom profile <speed\|balanced\|maximum>` | Set compression profile |
| `/headroom profile <speed\|balanced\|maximum>` | Set compression profile |
| `/headroom-simulate` | Preview compression savings on current context |
| `/headroom-stats` | Show detailed session statistics |
| `/headroom-config` | Show current headroom configuration |
| `/headroom-health` | Check headroom SDK availability |

### Profiles

| Profile | Target ratio | Behavior | Use case |
|---------|-------------|----------|----------|
| `speed` | 0.2 | Smart crusher + cache aligner disabled | Fast responses, minimal compression |
| `balanced` | 0.5 | Default headroom behavior | Good token savings with quality |
| `maximum` | 0.8 | Smart crusher + intelligent context enabled | Maximum token savings |

Profiles take effect when `targetRatio` is at its default (0.5). Set `targetRatio` explicitly to override profile-based selection.

## Tools

| Tool | Description |
|------|-------------|
| `headroom_retrieve` | Retrieve original (uncompressed) content from headroom's CCR store by hash. Requires a running headroom proxy with CCR enabled. |

## Configuration

The extension reads settings from Pi's settings system. Relevant config keys:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `headroom.enabled` | `boolean` | `true` | Enable/disable compression |
| `headroom.profile` | `enum` | `"balanced"` | Compression profile: `"speed"`, `"balanced"`, `"maximum"` |
| `headroom.targetRatio` | `number` | `0.5` | Target compression ratio (0.0–1.0). Overrides profile when non-default. |
| `headroom.minContextLength` | `number` | `3` | Minimum message count before compression runs |
| `headroom.maxToolResultTokens` | `number` | `4096` | Compress tool results exceeding this token count |
| `headroom.showStats` | `boolean` | `true` | Show compression stats in status bar |
| `headroom.minTokensPct` | `number` | `0.3` | Minimum % of context window used before compression fires (default 30%) |
| `headroom.maxTokensPct` | `number` | `0.5` | Target ceiling % after compression (default 50%) |

## How It Works

### Compression pipeline

1. **Format bridge** (`format-bridge.ts`): Converts Pi `AgentMessage[]` to OpenAI-compatible messages. Strips `ThinkingContent` blocks and stores them as `_piThinking` on each message (survives compression reordering). Serializes `ToolCall` arguments from `Record<string, unknown>` to JSON strings.

2. **SDK compression** (`headroom-ai`): The `compress()` function accepts any message array, auto-detects format, and applies content-aware compression transforms (dedup, trim, smart crush, rolling window, etc.).

3. **Format bridge (reverse)**: Converts compressed OpenAI messages back to Pi `AgentMessage[]`. Restores `ThinkingContent` from `_piThinking`. Parses JSON tool call arguments back to `Record`.

### Event hooks

| Hook | Purpose |
|------|---------|
| `context` | **Core**: compresses messages before each LLM call, validates tool call pairing |
| `tool_result` | Optionally compresses large tool result outputs (>maxToolResultTokens), handles both string and `TextContent[]` formats, records compression stats |
| `session_start` | Resets compression statistics, updates status bar |
| `session_shutdown` | Cleans up references, resets statistics |

### Statistics tracking

Per-turn and per-session compression metrics are tracked: tokens before/after, tokens saved, compression ratio, transforms applied. Displayed via `/headroom stats` and the status bar.

## Dependencies

- `headroom-ai` ^0.22.4 — the upstream compression SDK

## Project Structure

```
pi-headroom/
├── package.json            # Pi extension manifest
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── src/
│   ├── index.ts            # Extension entry: hooks, commands, tools
│   ├── headroom-client.ts  # headroom-ai SDK wrapper with threshold logic
│   ├── format-bridge.ts    # Pi ↔ OpenAI message format conversion
│   ├── ccr-store.ts         # CCR hash→original content retrieval
│   ├── config.ts           # Configuration, profiles, token thresholds
│   └── stats.ts            # Compression statistics tracking
└── tests/
    ├── format-bridge.test.ts  # Format conversion tests
    ├── config.test.ts         # Configuration and token estimation
    ├── stats.test.ts          # Statistics tracking
    ├── regression.test.ts     # Regression tests for fixed bugs
    ├── safety-bridge.test.ts   # Format bridge round-trip safety
    ├── safety-client.test.ts   # Wrapper logic with real SDK (fallback mode)
    └── safety-config.test.ts   # Threshold and profile pure function tests
```

## Development

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Run tests
npm test
```


## Comparison with Other pi-headroom Implementations

There are several pi-headroom extensions on GitHub. Here's how this one compares:

### yeshao/pi-headroom (this repo)

| Aspect | Approach |
|--------|----------|
| **SDK usage** | headroom-ai npm SDK as in-process library (no Python subprocess) |
| **Compression profiles** | `speed` / `balanced` / `maximum` presets + `targetRatio` override |
| **Threshold-based compression** | `minTokensPct` / `maxTokensPct` adapt to model context window size |
| **Format bridge** | Pi ↔ OpenAI conversion with ThinkingContent preservation |
| **Tool call safety** | Pairing validation (restores orphaned tool call/result pairs) |
| **CCR** | Hash-based content retrieval via proxy's /v1/retrieve endpoint |
| **Tests** | 106 tests across 7 files (format bridge, config, regression, safety) |

**Strengths:**
- **No Python dependency.** Runs headroom-ai as an in-process TypeScript library — no venv, no subprocess, no proxy port to manage.
- **Model-adaptive thresholds.** `minTokensPct`/`maxTokensPct` automatically scale to the model's context window (e.g., 30% of 200K = 60K tokens for Claude 4 Opus, 30% of 128K = 38K for GPT-4o). Avoids cache invalidation in short sessions.
- **ThinkingContent preservation.** Stores Pi's `ThinkingContent` blocks on each message before compression, so they survive message reordering/removal by the compressor.
- **Tool call pairing validation.** Post-compression validation ensures every `tool_calls[].id` has a corresponding result message, preventing LLM errors.
- **CCR integration.** Wraps the proxy's retrieve endpoint so the LLM can recover original content by hash.
- **Comprehensive tests.** 106 tests including format bridge round-trip, threshold logic, and profile mapping.

**Weaknesses:**
- **No ContentRouter safety pipeline.** The npm SDK's `compress()` does not expose `ContentRouterConfig` fields (`exclude_tools`, `protect_recent_code`, `protect_analysis_context`, `read_lifecycle`). This means we can't exclude Read/Write/Edit tool results from compression at the SDK level — we rely on the compressor's built-in defaults.
- **No proxy auto-management.** Unlike mslavov/pi-headroom, we don't auto-install or auto-start the headroom proxy. The user must run it separately.
- **Token estimation is heuristic.** Uses `len(string) / 4` which is crude for CJK text, code with lots of punctuation, or structured data.
- **Hardcoded model context windows.** The `MODEL_CONTEXT_WINDOWS` table will need manual updates as new models are released (falls back to 128K for unknown models).

### mslavov/pi-headroom (10 stars)

| Aspect | Approach |
|--------|----------|
| **SDK usage** | headroom Python proxy (auto-managed lifecycle) |
| **Compression profiles** | Passes through headroom defaults |
| **Auto-management** | Installs `headroom-ai[proxy]`, starts/stops proxy automatically |
| **Tests** | None |

**Its strengths over us:** Zero-config proxy lifecycle (install, start, health check, crash recovery, graceful shutdown). More battle-tested because it uses the Python pipeline that headroom itself maintains.

**Its weaknesses vs us:** Requires Python ≥3.10. No threshold-based profiles. No ThinkingContent preservation. No tool call pairing validation. No tests.

### brutaldeluxe82/pi-headroom

| Aspect | Approach |
|--------|----------|
| **SDK usage** | Python JSONL bridge (long-lived child process) |
| **Compression profiles** | Per-tool profiles via Headroom's native `ContentRouterConfig` |
| **Safety pipeline** | Full ContentRouter: `exclude_tools`, `protect_recent_code`, `protect_analysis_context`, `ReadLifecycle` |
| **Thresholds** | `minTokensPct`/`maxTokensPct` with model-adaptive context windows |
| **Tests** | None |

**Its strengths over us:** Full ContentRouter safety pipeline — Read/Write/Edit are never compressed, stale reads are safely compressed, recent code is protected. This is the safest approach for preventing edit-breaking compression.

**Its weaknesses vs us:** Requires Python 3.12 + `uv`. No tests. No ThinkingContent preservation. Single-file 1091-line extension is harder to maintain.

### Summary

| Dimension | yeshao (this) | mslavov | brutaldeluxe82 |
|-----------|--------------|---------|----------------|
| **Install friction** | Lowest (no Python) | Medium (auto-managed Python) | Highest (Python 3.12 + uv) |
| **Safety depth** | Good (pairing validation) | Basic (exclude_tools) | Best (full ContentRouter) |
| **Config granularity** | Good (profiles + thresholds) | Basic (defaults) | Good (thresholds + per-tool) |
| **Test coverage** | 106 tests | 0 | 0 |
| **Maintenance** | Clean 5-file structure | Clean 3-file structure | Single 1091-line file |

---

## License

Apache-2.0
