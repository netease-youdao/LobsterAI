# Explicit Context Cache Models

## Change Summary

`lobsterai-server` adds explicit context cache support metadata for package models:

- `qwen3.5-plus` and `qwen3.6-plus` are available through OpenAI-compatible Chat Completions for both `LobsterAI` and `YoudaoInner` providers.
- Claude employee models can be exposed through either Anthropic Messages or OpenAI-compatible Chat Completions, depending on server route metadata.
- `/api/models/available` now returns `explicitContextCache` so the client can generate cache-aware OpenClaw model config.
- `/v1/messages` now resolves models through DB pricing/routes and only accepts `apiFormat="anthropic"` models.
- `/api/proxy/chat/completions` does not inject cache markers; LobsterAI/OpenClaw must send `cache_control` in the upstream payload when explicit cache is enabled.

## Endpoint Details

### GET `/api/models/available`

Auth: `Authorization: Bearer <accessToken>`

Response item additions:

```json
{
  "modelId": "qwen3.6-plus-YoudaoInner",
  "modelName": "qwen3.6-plus-YoudaoInner",
  "provider": "YoudaoInner",
  "apiFormat": "openai",
  "supportsImage": true,
  "supportsThinking": true,
  "contextWindow": 1000000,
  "explicitContextCache": true
}
```

Claude employee model example:

```json
{
  "modelId": "claude-sonnet-4-6",
  "provider": "YoudaoInner",
  "apiFormat": "openai",
  "explicitContextCache": true
}
```

Anthropic-format Claude models can still be returned with `"apiFormat": "anthropic"` and the same `explicitContextCache` flag.

### POST `/v1/messages`

Auth: local Lobster proxy token forwarded as `Authorization`.

Only Anthropic-format DB models are accepted. `claude-sonnet-4-6-YoudaoInner` is employee-only; C-end users must not see or call it.

## Frontend Action Items

- Preserve `apiFormat`, `provider`, `modelName`, `contextWindow`, and `explicitContextCache` from `/api/models/available`.
- Generate `openclaw.json` per model:
  - Qwen OpenAI-compatible: `"api": "openai-completions"` plus `cacheRetention="short"`, `contextCacheProvider="dashscope"`, `contextCacheMode="explicit"`.
  - Claude: `"api": "anthropic-messages"` plus `cacheRetention="short"`.
  - Claude OpenAI-compatible: `"api": "openai-completions"` plus `cacheRetention="short"`, `contextCacheProvider="anthropic-compatible"`, `contextCacheMode="explicit"`.
- If server model metadata is not loaded yet, still infer these defaults for `qwen3.5*`, `qwen3.6*`, and `claude-*` LobsterAI server model IDs.
- Ensure OpenClaw runtime patch `openclaw-dashscope-context-cache.patch` is included for v2026.6.1.

## Auth Requirements

All proxy endpoints require Electron JWT Bearer auth at the server boundary. Claude is restricted to `YoudaoInner` employee-visible models.

## Notes & Caveats

OpenAI-compatible explicit cache requires actual request payload markers: `"cache_control": {"type": "ephemeral"}` on the system/developer message, the last conversation message, and the last tool definition when present. Cache usage display relies on upstream usage fields returned by the server after proxying.
