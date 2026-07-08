# IM inbound media display after OpenClaw 6.1

## Background

After upgrading to OpenClaw `v2026.6.1`, IM channel sessions can receive and process inbound images correctly, but LobsterAI may render only the generated text description and omit the original image in the user message bubble.

The issue was reproduced with WeChat/WeCom-style OpenClaw channel history. OpenClaw's own web UI shows the image, and the local transcript contains media fields such as:

```json
{
  "role": "user",
  "content": "[Image]\nDescription:\n...",
  "MediaPath": "C:\\Users\\yangwn\\AppData\\Roaming\\LobsterAI\\openclaw\\state\\media\\inbound\\4938ca3d-e7ee-41e2-bbce-795462523831.jpg",
  "MediaPaths": ["C:\\Users\\yangwn\\AppData\\Roaming\\LobsterAI\\openclaw\\state\\media\\inbound\\4938ca3d-e7ee-41e2-bbce-795462523831.jpg"],
  "MediaType": "image/jpeg",
  "MediaTypes": ["image/jpeg"]
}
```

LobsterAI's history extraction previously copied only `role`, text, timestamp, usage, and model metadata. The `MediaPath(s)` fields were dropped before the renderer saw the message.

## Existing Legacy Path

PR `#1856` introduced display-side cleanup in `src/renderer/utils/userMessageDisplay.ts`. That code handles older IM message shapes where media metadata is embedded in message text, for example:

```text
[media attached: C:\...\openclaw\state\media\inbound\a.jpg (image/jpeg)]
```

That path is intentionally display-only and separate from artifact detection. It strips IM/plugin metadata from the user message and appends renderable markdown image syntax.

## Chosen Approach

Keep the `#1856` legacy text extraction logic, and add a metadata path for OpenClaw 6.1:

1. `src/main/libs/openclawHistory.ts` now extracts `MediaPath`, `MediaPaths`, `MediaType`, and `MediaTypes`.
2. `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` converts those media refs into message metadata:

```json
{
  "localMediaAttachments": [
    {
      "localPath": "C:\\...\\openclaw\\state\\media\\inbound\\a.jpg",
      "mimeType": "image/jpeg",
      "name": "a.jpg"
    }
  ]
}
```

3. `src/renderer/utils/userMessageDisplay.ts` accepts those metadata attachments and reuses the existing display path to append markdown images.
4. `src/renderer/components/cowork/UserMessageItem.tsx` passes `metadata.localMediaAttachments` into the display transform.

This keeps inbound IM images in the user message bubble and does not route them through artifact detection or the artifact panel.

## Compatibility Notes

- The legacy `#1856` extraction remains in place for older transcripts and plugins that still embed `[media attached: ...]` or bare inbound paths in message text.
- The new metadata path deduplicates against the legacy text path, so a message carrying both forms should not render the same image twice.
- Metadata stores only local path, MIME type, and file name. It does not persist base64 image data, avoiding SQLite growth and history loading overhead.
- Rendering still goes through the existing local file image handling in `MarkdownContent`, which normalizes Windows and macOS paths to the `localfile://` protocol.
- History reconciliation now compares local media metadata in addition to role/text. This prevents "text already in sync" shortcuts from skipping a missing image metadata update.

