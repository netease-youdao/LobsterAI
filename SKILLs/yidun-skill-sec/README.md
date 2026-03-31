# yidun-skill-sec ⚡

> Hybrid local-cloud security scanner for AI agent skills. Scans fast, scores precisely, fails safely.

---

## Overview

`yidun-skill-sec` is a security vetting skill that analyzes third-party code packages before installation. It combines static behavioral analysis with cloud threat intelligence to produce a quantified safety score, catching malware, data exfiltration, privilege abuse, prompt injection, and obfuscation — before anything runs.

Built by the **Yidun Security Team** for the [ClawHub](https://clawhub.com) ecosystem.

## Security Disclosure

This skill uploads **non-sensitive metadata** (file hashes, behavior tag names, and extracted code snippets that triggered detections) to a Yidun threat intelligence endpoint. The following is explicitly **not uploaded**: full source code, user credentials, environment variables, or personal data.

The cloud endpoint (`as.dun.163.com`) is operated by **NetEase Yidun**, a licensed cybersecurity service provider. Cloud analysis is **enabled by default** and strongly recommended. It can be explicitly disabled by setting `YIDUN_SKILL_SEC_CLOUD=false` if network access is restricted or not desired.

---

## How It Works

Every scan runs through four phases:

```
Phase 0 · Source Vetting     — Where does this package come from?
Phase 1 · Fingerprint        — What files are in it? (SHA-256 hash manifest)
Phase 2 · Behavioral Scan    — What does the code try to do? (static analysis)
Phase 3 · Cloud Intel        — Is it known malicious? (cloud check, default on)
                                          ↓
                               Final threat score (0–100)
```

### Scoring

| Signal | Weight (online) | Weight (timeout fallback) |
|--------|:--------------:|:------------------------:|
| Source vetting | 15% | 20% |
| Behavioral scan | 40% | 55% |
| Cloud confidence | 30% | — |
| Privilege surface | 15% | 25% |

### Threat Levels

| Score | Level | Action |
|-------|-------|--------|
| 80–100 | 🟢 CLEAR | Install normally |
| 60–79 | 🟢 MINOR | Install with awareness |
| 40–59 | 🟡 ELEVATED | User review required |
| 20–39 | 🔴 SEVERE | Explicit user consent required |
| 0–19 | ⛔ CRITICAL | Blocked — do not install |

---

## Detection Coverage

### Phase 0 — Source Vetting

| Tag | Triggers On | Score Impact |
|-----|-------------|:------------:|
| `SRC_UNKNOWN_REGISTRY` | Package from unrecognized or unofficial registry | +20 |
| `SRC_BLACKLISTED_DOMAIN` | Install URL matches known malicious domain (cloud check) | +40 ⛔ |
| `SRC_UNTRUSTED_AUTHOR` | New account (<30d), unverified, or prior malware history | +15 |

> `SRC_BLACKLISTED_DOMAIN` is a **hard block** — scan halts immediately, no install.

### Phase 2 — Behavioral Tags

| Tag | What It Detects |
|-----|----------------|
| `NET_OUTBOUND` | HTTP/HTTPS calls to external hosts |
| `NET_IP_RAW` | Connections to raw IP addresses |
| `FS_READ_SENSITIVE` | Access to `~/.ssh`, `~/.aws`, `~/.env`, key files |
| `FS_WRITE_SYSTEM` | Writes outside the project workspace |
| `EXEC_SHELL` | Shell subprocess spawning |
| `EXEC_DYNAMIC` | `eval()`, `exec()`, dynamic code execution |
| `ENCODE_DECODE` | Base64/hex chains (potential obfuscation) |
| `CRED_HARVEST` | Reads API keys, tokens, passwords from env/files |
| `PRIV_ESCALATION` | `sudo`, `chmod 777`, `setuid` patterns |
| `OBFUSCATED` | Minified/packed code, unreadable variable names |
| `AGENT_MEMORY` | Accesses agent identity/memory files |
| `PKG_INSTALL` | Installs unlisted system packages |
| `COOKIE_SESSION` | Reads browser cookies or session tokens |
| `BYPASS_SAFETY` | `--no-verify`, `--force`, `--skip-ssl`, `GIT_SSL_NO_VERIFY` |
| `DESTRUCTIVE_OP` | `rm -rf`, `DROP TABLE`, `git reset --hard`, `dd if=` |
| `PROMPT_INJECT` | Natural language directives targeting the AI agent, attempting to override its rules, bypass constraints, or assume an unrestricted persona |
| `ARCHIVE_EXEC_RISK` | Package contains compressed/archive files (`.zip`, `.tar.gz`, `.whl`, etc.) — inherent risk, NOT extracted |

> **Hard rules** ("floor to X" = verdict cannot be better than X; a naturally worse level stays):
> - `CRED_HARVEST` → floor to SEVERE · `PRIV_ESCALATION` → floor to SEVERE · `PROMPT_INJECT` → floor to SEVERE
> - `DESTRUCTIVE_OP` → floor to ELEVATED
> - `CRED_HARVEST` + `PRIV_ESCALATION` → force CRITICAL
> - `PROMPT_INJECT` + any of (`CRED_HARVEST`, `NET_OUTBOUND`, `EXEC_DYNAMIC`) → force CRITICAL

### Example Context Exemption

Patterns matched inside **documentation or example contexts** (Markdown code blocks, code comments, non-executable file types like `.md`/`.txt`) receive a **75% severity reduction** (minimum +3 residual). This prevents false positives from security tutorials and usage examples in documentation.

| Rule | Effect |
|------|--------|
| Severity reduction | 75% off for example-context matches (e.g. `CRED_HARVEST` +35 → +8) |
| Hard rule exemption | Tags matched **only** in example contexts do not trigger hard rules |
| Report annotation | Shown as `[EXAMPLE]` in scan reports |

**Never exempted**: executable files (`.sh`, `.py`, `.js`), lifecycle scripts (`install`/`postinstall`), `PROMPT_INJECT` tag (text IS the attack surface), and files parsed at runtime.

---

## Cloud Intelligence

Cloud analysis calls `POST https://as.dun.163.com/v1/agent-sec/skill/check` and is **enabled by default**.

- Uploads fingerprint, behavior tags, and redacted evidence artifacts (all evidence passes through a local redaction pipeline before upload)
- Server performs deep content analysis and domain blacklist matching
- Returns confidence score, threat labels, and per-tag deduction breakdown

**Domain blacklist**: Phase 0 checks against a **local embedded list** (offline-safe). When cloud is enabled, the full cloud-augmented blacklist is checked in Phase 3 with retroactive verdict updates.

| Mode | How | Behavior |
|------|-----|---------|
| Cloud ON | Default / `YIDUN_SKILL_SEC_CLOUD=true` | Full scan with remote threat intel |
| Cloud OFF | `YIDUN_SKILL_SEC_CLOUD=false` | Local-only, domain blacklist skipped |
| Timeout fallback | Cloud ON, `curl` times out (10s) | Auto-downgrade, -10 score penalty, user notified |

---

## Sample Report

```
⚡ YIDUN-SKILL-SEC Scan Report
> data-processor · v1.2.3 · clawhub.com · by some-author · 2026-03-12 13:47

Phase 0 · Source Vetting
  Registry: clawhub.com → ✅ trusted
  Domain:   ✅ clean
  Author:   verified (2y 3m) → ✅
  Source score: 100/100 · Tags: none

Phase 1 · Fingerprint
  4 files · SHA-256 7f3a9b... · main.py config.yml fetch.py setup.sh

Phase 2 · Behavioral Scan
  NET_OUTBOUND     fetch.py:12   -15
  FS_WRITE_SYSTEM  setup.sh:8    -20
  EXEC_SHELL       setup.sh:15   -10
  Local score: 100 - 15 - 20 - 10 = 55/100

Phase 3 · Cloud Intel
  Mode: cloud · Cache: miss
  Cloud score: 48/100 · Labels: NET_OUTBOUND, FS_WRITE_SYSTEM, EXEC_SHELL

Privilege Surface · Network: api.dataproc.io (-20) · FS: /usr/local/bin (-20) · Shell: subprocess (-20) · Creds: no
  Surface score: 100 - 20 - 20 - 20 = 40/100

🎯 Score: 15%×100 + 40%×55 + 30%×48 + 15%×40 = 57/100 · 🟡 ELEVATED
⚠️ Requires confirmation — network calls + system writes + shell exec need justification
```

---

## Requirements

| Tool | Purpose |
|------|---------|
| `curl` | Cloud API calls |
| `jq` | JSON response parsing |
| `openssl` | File hash computation |

Supported OS: Linux · macOS · Windows

---

## Installation

```bash
clawhub install yidun-skill-sec
```

---

*Scan first, install later.* ⚡  
**Author**: Yidun Security Team · **License**: MIT
