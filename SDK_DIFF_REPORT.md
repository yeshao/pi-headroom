# headroom-ai npm SDK vs Python ContentRouter — Gap Analysis

## Executive Summary

The `headroom-ai` npm package (v0.22.4) is **an HTTP client for the Headroom Python proxy** — it does NOT run compression in-process. The `compress()` function sends messages via `POST /v1/compress` to a local proxy server (default `http://localhost:8787`). This means the npm SDK and the Python proxy (`mslavov`'s approach) are architecturally identical — both depend on the Python backend.

## Evidence

### compress() implementation (from source)

```js
async function compress(messages, options = {}) {
  // ... hooks, format detection, toOpenAI conversion ...
  const client = providedClient ?? new HeadroomClient(clientOptions);
  const result = await client.compress(openaiMessages, { model, tokenBudget });
  // ... fromOpenAI conversion, post hooks ...
}
```

### HeadroomClient._doCompress() implementation

```js
async _doCompress(messages, model, tokenBudget) {
  const body = { messages, model };
  if (tokenBudget) body.token_budget = tokenBudget;
  if (this.config) body.config = deepSnakeCase(this.config);
  const response = await this._fetch("/v1/compress", {
    method: "POST",
    body: JSON.stringify(body)
  });
  // ... parse response ...
}
```

**Conclusion**: Every call to `compress()` hits the local Python proxy over HTTP. There is zero in-process compression logic in the npm package.

## What the npm SDK provides

### Full HeadroomConfig fields (passed to proxy as `config`)

| Field | Type | Status |
|-------|------|--------|
| `storeUrl` | string | Present |
| `defaultMode` | `"audit" \| "optimize" \| "simulate"` | Present |
| `modelContextLimits` | Record<string, number> | Present |
| `toolCrusher` | ToolCrusherConfig | Present |
| `smartCrusher` | SmartCrusherConfig | Present |
| `cacheAligner` | CacheAlignerConfig | Present |
| `rollingWindow` | RollingWindowConfig | Present |
| `cacheOptimizer` | CacheOptimizerConfig | Present |
| `ccr` | CCRConfig | Present |
| `prefixFreeze` | PrefixFreezeConfig | Present |
| `contentRouterEnabled` | boolean | Present |
| `intelligentContext` | IntelligentContextConfig | Present |
| `generateDiffArtifact` | boolean | Present |

### Sub-configs available

- **SmartCrusherConfig**: `enabled`, `minItemsToAnalyze`, `minTokensToCrush`, `varianceThreshold`, `uniquenessThreshold`, `similarityThreshold`, `maxItemsAfterCrush`, `preserveChangePoints`, `useFeedbackHints`, `toinConfidenceThreshold`, `relevance`, `anchor`, `dedupIdenticalItems`, `firstFraction`, `lastFraction`
- **IntelligentContextConfig**: `enabled`, `keepSystem`, `keepLastTurns`, `outputBufferTokens`, `useImportanceScoring`, `scoringWeights`, `recencyDecayRate`, `toinIntegration`, `compressThreshold`, `summarizationEnabled`, `summarizationModel`, `summaryMaxTokens`, `summarizeThreshold`
- **CCRConfig**: `enabled`, `storeMaxEntries`, `storeTtlSeconds`, `injectRetrievalMarker`, `feedbackEnabled`, `minItemsToCache`, `injectTool`, `injectSystemInstructions`, `markerTemplate`

## What's MISSING vs Python ContentRouter

| Python Feature | npm SDK Equivalent | Gap |
|---|---|---|
| `ContentRouterConfig.exclude_tools` | Not available | **GAP**: Can't exclude Read/Write/Edit from npm SDK |
| `ContentRouterConfig.protect_recent_code` | Not available | **GAP**: Can't protect recent code blocks |
| `ContentRouterConfig.protect_analysis_context` | Not available | **GAP**: Can't protect analysis context |
| `ContentRouterConfig.read_lifecycle.compress_stale` | Not available | **GAP**: Can't control stale read compression |
| `ContentRouterConfig.read_lifecycle.compress_superseded` | Not available | **GAP**: Can't control superseded read compression |
| `ContentRouter.apply()` (message-level) | Not available | **GAP**: No message-level ContentRouter access |
| Per-tool profile resolution (`DEFAULT_TOOL_PROFILES`) | Not available | **GAP**: No per-tool profile selection |
| Python `compress()` direct call | Requires running proxy | **DEPENDENCY**: Proxy must be running |

## What this means for yeshao/pi-headroom

1. **The "no Python" advantage is illusory.** The npm `compress()` calls the Python proxy over HTTP. The proxy must be running somewhere. The difference from `mslavov` is only that the proxy lifecycle is external (user's responsibility) rather than auto-managed.

2. **The `buildHeadroomConfig()` function only covers `HeadroomConfig`** fields (smartCrusher, cacheAligner, ccr, etc.). It does NOT expose the `ContentRouterConfig` fields that `brutaldeluxe82` uses (exclude_tools, protect_recent_code, read_lifecycle). This means your extension has weaker safety guarantees than `brutaldeluxe82`.

3. **CCR hashes are returned** (`ccrHashes` in `CompressResult`) but the SDK has no `retrieve()` persistence — you'd need to store the hash→original mapping yourself.

4. **The `headroom-client.ts` wrapper is an unnecessary abstraction.** It wraps `HeadroomClient` with format conversion that the SDK already does internally (`toOpenAI`, `fromOpenAI`). The `sanitizeForSDK()` stripping `_pi*` fields is defensive but the SDK's `detectFormat()` handles format auto-detection.

## Recommendations

1. **Either** run a proxy (like `mslavov`) and accept the Python dependency, losing the "no Python" differentiator
2. **Or** call the Python `ContentRouter` directly via a minimal sidecar for safety-critical decisions, keeping the npm SDK for the actual compression
3. **Or** accept the safety gap and document it clearly — the `HeadroomConfig` knobs you DO have (smartCrusher, intelligentContext, ccr) may be sufficient for most use cases
