# Lynxce expert contribution / 灵策智算专家资源

Content snapshot: **2026-10-24**. Contributor: **灵策智算 LynxceAI**.

This contribution supplies the current local desktop and WorkBuddy expert sources,
their existing avatars, and the Lynxce brand mark for upstream review.

| Source | Entries | Included |
| --- | ---: | --- |
| Desktop presets | 43 | Chinese/English prompts, identities, dependency IDs and SVG avatars |
| Desktop expert teams | 53 | Complete team definitions, 328 roles including leads, and local SVG avatar mappings |
| WorkBuddy experts | 783 | Latest local package per slug, agent prompts, bundled skills, references, scripts, metadata and avatars |
| Third-party imported experts | 215 | Names, provenance and hashes only; redistribution permission for complete packages is unconfirmed |

The first three groups contain **879 entries**. Team roles are members of those
53 teams, not an additional count of standalone experts. Standalone WorkBuddy
skills are outside this expert contribution; skills bundled inside expert packages
are included.

## Browse and verify

- [index.json](index.json): all contributed entries, names, avatar paths, brand attribution,
  source revisions, dependencies and historical distribution flags.
- [desktop/presets.json](desktop/presets.json): 43 complete preset definitions.
- [desktop/teams.json](desktop/teams.json): 53 teams and their role definitions.
- [workbuddy/packages/](workbuddy/packages/): 783 unpacked source packages; original
  WorkBuddy plugin metadata is retained for migration review.
- [source-selection.json](source-selection.json): version selection and conflict evidence.
- [third-party-inventory.json](third-party-inventory.json): 215 imported items that
  are inventoried but whose prompts, archives and original icons are not included.
- [integrity.json](integrity.json): SHA-256 and size of every contributed file except
  the integrity manifest itself.

From the repository root, run:

```bash
python3 contributions/lynxce-experts/verify.py
```

Verification reads files only. It checks the inventory, source hashes, image
formats, package references, branding, and the full file integrity manifest.
It does not execute package scripts or connect to services.

## Avatars and attribution

Each contributed entry references its existing avatar and
`brand/lynxce-mark.svg`, with `author: 灵策智算 LynxceAI`.
The mark is a separate origin attribution asset; portraits are preserved without
painting a new logo onto them. A consuming catalog should display the attribution
beside the expert avatar or name.

<img src="brand/lynxce-mark.svg" width="48" alt="灵策智算" />
<img src="workbuddy/packages/lynxce-smart-factory-application-b53/avatars/expert.png" width="96" alt="智能工厂申报顾问头像" />

Desktop team avatars use the available local SVG fallback. Some team definitions
also contain remote portrait hint IDs; those IDs are not local photo assets.
No third-party imported portrait is presented as a Lynxce-owned image.

## Upstream integration

This is a **content contribution for maintainer review**, with no changes to the
Electron runtime, IPC, installed agents, or the live expert store. The current
LobsterAI expert store is published remotely and accepts assets from its existing
CDN allowlist. Repository-relative paths in this inventory are source references,
not a production `ExpertCatalog` or deployment manifest.

To publish selected entries, maintainers need to host the approved images/content
on their existing CDN, map definitions to `src/shared/agent/presets.ts`, and pass
`parseExpertCatalog` before publishing the existing store manifest. Preserve the
contribution ID namespace and attribution when mapping to upstream entries.
Large collections may need separate catalogs: the current loader limits a catalog
to 1,000 experts and 4 MiB. This contribution does not widen those limits or the
CDN allowlist.

WorkBuddy packages use WorkBuddy agent/skill/plugin conventions. They are complete
local source deliveries, but are not directly registered as LobsterAI plugins.
In particular, **397** entries declare MCP dependencies, **98** are in the local
CPS inventory, and **309** retain `needEncrypt` distribution metadata. These flags
describe their source distribution; they do not prove service connectivity,
purchase entitlement, review approval or free service access in LobsterAI.
External integrations must be configured and validated before claiming that a
converted expert works end to end. Historical WorkBuddy metadata and pricing are
preserved; this PR does not change any platform listing or charge a user.

The 43 desktop presets declare 17 distinct skill IDs from the original fork.
Those desktop skill bodies are not part of this expert snapshot; map the IDs to
available upstream skills before enabling a preset. WorkBuddy skills contained
inside the contributed expert packages are included in full.

The source selection uses the highest local semantic version, then agent/manifest
file timestamps. ZIP timestamps come from entries inside the archive, not the
archive's filesystem modification time. For 27 same-version prompt conflicts,
the selected revision and alternative hashes are recorded. An extracted directory
replaces an equivalent ZIP only when all delivery-file hashes match. No prior
revision is substituted to avoid a current distribution requirement.

## Source notices

Desktop definitions extend the Lynxce fork of LobsterAI; retain the upstream MIT
notice in [desktop/LICENSE.upstream.txt](desktop/LICENSE.upstream.txt). Existing
package notices and author metadata remain in their packages. Lynxce branding
identifies the contributor and does not imply endorsement by LobsterAI or WorkBuddy.

The EasyClaw inventory records third-party origin explicitly. Public download
availability alone was not treated as permission to relicense a complete expert
package or its portrait, so those assets remain outside this submission.

Validation of this contribution establishes file completeness and consistency.
It does not establish execution of every expert workflow, live marketplace
publication, or upstream acceptance.
