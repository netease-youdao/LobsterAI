# Markdown/Mermaid Share API Integration

## Change Summary

`/api/html-shares` now accepts two additional artifact file source types:

- `markdown_file`
- `mermaid_file`

The public share page renders these files through the same-origin text preview shell at `/s/{shareId}/`.

## Endpoint Details

Create and update continue to use the existing multipart endpoints:

- `POST /api/html-shares`
- `PUT /api/html-shares/{shareId}`

Required multipart fields remain unchanged. New accepted `sourceType` values are `markdown_file` and `mermaid_file`.

Markdown uploads should be a zip containing:

- one entry `.md` or `.markdown` file
- optional `_lobster_assets/*` image files
- optional `_lobster_share_manifest.json`

The server may optimize Markdown image assets before uploading them to NOS, using the same policy as image shares. Large PNG/JPEG assets can be resized/re-encoded, and non-transparent images may be stored as `.jpg`; when this happens, the server rewrites the entry Markdown and manifest asset paths before publishing.

Mermaid uploads should be a zip containing exactly one `.mmd` or `.mermaid` file.

## Frontend Action Items

- Add `HtmlShareSourceType.MarkdownFile` and `HtmlShareSourceType.MermaidFile`.
- Map Markdown artifacts to `markdown_file` and Mermaid artifacts to `mermaid_file`.
- Package Mermaid as a single text file zip.
- Package Markdown as entry Markdown plus local relative image assets under `_lobster_assets/`.
- Do not send remote URLs for Markdown or Mermaid shares.

## Auth Requirements

No auth changes. Electron client endpoints still require JWT Bearer auth.

## Notes & Caveats

The public page disables Electron-only local file actions. Markdown local dependencies only support images in this version.
