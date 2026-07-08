---
name: imap-smtp-email
description: Read and send email via IMAP/SMTP. Check for new/unread messages, fetch content, search mailboxes, mark as read/unread, and send emails with attachments. Works with any IMAP/SMTP server including Gmail, Outlook, 163.com, vip.163.com, 126.com, vip.126.com, 188.com, and vip.188.com.
official: true
version: 1.0.6
---

# IMAP/SMTP Email Tool

Read, search, and manage email via IMAP protocol. Send email via SMTP. Supports Gmail, Outlook, 163.com, vip.163.com, 126.com, vip.126.com, 188.com, vip.188.com, and any standard IMAP/SMTP server.

## Important: Configuration is Pre-configured

The `accounts.json` configuration file is automatically managed by LobsterAI Settings (邮箱设置). Legacy `.env` configuration is still supported as a fallback for older users. **Do NOT ask the user to create or edit these files — just run the commands directly.** If credentials are wrong, the scripts will return a clear error message; only then should you inform the user to check their email settings.

The configuration files are located in this skill's directory (same folder as this SKILL.md file). The scripts load them automatically via absolute paths, regardless of the current working directory.

Use the provided scripts as the only email transport interface. Do not write temporary IMAP/SMTP scripts, do not use raw sockets, OpenSSL, `net`, `tls`, or alternate mail clients, and do not inspect `.env`, `accounts.json`, or script source unless the official command output explicitly reports missing configuration and the user asks you to diagnose it. If an official command fails or times out, report that command result and suggest checking LobsterAI Settings; do not implement a fallback protocol client.

Do not claim that `node-imap`, `nodemailer`, or another dependency is broken unless an official script or verified stack trace proves it. A successful command means the configured email account works; a timeout means the current command timed out, not that the dependency is defective.

Command results intentionally redact account metadata. In user-facing replies, use the redacted account label/email from the JSON result and do not repeat full configured email addresses unless the user explicitly asks for the exact address. Email content fields such as sender, subject, and message body may still be shown when they are the requested result.

Never ask the user to send an email authorization code, app password, account password, or other credential in chat. If an account is disabled, incomplete, or has invalid credentials, ask the user to enable or update it in LobsterAI Settings > Email Settings, then rerun the official command.

For multi-account setups:
- Run `node scripts/imap.js accounts` or `node scripts/smtp.js accounts` to list configured account IDs without exposing secrets.
- Omit `--account` to use the default enabled account.
- Pass `--account <id>` to use a specific account.
- Pass `--all-accounts` only for read/list commands that support fan-out (`check`, `search`, `list-mailboxes`).
- JSON results for read/list commands include `success`, redacted account metadata, `command`, `count`, and result arrays such as `messages` or `mailboxes`.

For sending email, always review recipient, subject, sender account, and body with the user first. Sending is blocked unless `--confirmed` is passed.

For SMTP send results, `success: true` means the sending SMTP server accepted the message for processing. Do not claim final delivery or inbox receipt. Report it as "submitted to the SMTP server" and mention that the recipient provider may still reject it later via a bounce message. If `rejected` or `pending` recipients are present, call them out explicitly.

Never use a redacted account email such as `ab***@example.com` as a recipient address. If the user asks to send to another configured email account, use that account's `id` with `--to-account <id>` so the script resolves the real address internally without exposing it.

## Configuration Reference

Create `.env` in the skill folder or set environment variables:

```bash
# IMAP Configuration (receiving email)
IMAP_HOST=imap.gmail.com          # Server hostname
IMAP_PORT=993                     # Server port
IMAP_USER=your@email.com
IMAP_PASS=your_password
IMAP_TLS=true                     # Use TLS/SSL connection
IMAP_REJECT_UNAUTHORIZED=true     # Set to false for self-signed certs
IMAP_MAILBOX=INBOX                # Default mailbox

# SMTP Configuration (sending email)
SMTP_HOST=smtp.gmail.com          # SMTP server hostname
SMTP_PORT=587                     # SMTP port (587 for STARTTLS, 465 for SSL)
SMTP_SECURE=false                 # true for SSL (465), false for STARTTLS (587)
SMTP_USER=your@gmail.com          # Your email address
SMTP_PASS=your_password           # Your password or app password
SMTP_FROM=your@gmail.com          # Default sender email (optional)
SMTP_REJECT_UNAUTHORIZED=true     # Set to false for self-signed certs
```

## Common Email Servers

| Provider | IMAP Host | IMAP Port | SMTP Host | SMTP Port |
|----------|-----------|-----------|-----------|-----------|
| 163.com | imap.163.com | 993 | smtp.163.com | 465 |
| vip.163.com | imap.vip.163.com | 993 | smtp.vip.163.com | 465 |
| 126.com | imap.126.com | 993 | smtp.126.com | 465 |
| vip.126.com | imap.vip.126.com | 993 | smtp.vip.126.com | 465 |
| 188.com | imap.188.com | 993 | smtp.188.com | 465 |
| vip.188.com | imap.vip.188.com | 993 | smtp.vip.188.com | 465 |
| yeah.net | imap.yeah.net | 993 | smtp.yeah.net | 465 |
| Gmail | imap.gmail.com | 993 | smtp.gmail.com | 587 |
| Outlook | outlook.office365.com | 993 | smtp.office365.com | 587 |
| QQ Mail | imap.qq.com | 993 | smtp.qq.com | 587 |

**Important for 163.com:**
- Use **authorization code** (授权码), not account password
- Enable IMAP/SMTP in web settings first

## IMAP Commands (Receiving Email)

### accounts
List configured email accounts without exposing passwords.

```bash
node scripts/imap.js accounts
```

### check
Check for new/unread emails.

```bash
node scripts/imap.js check [--limit 10] [--mailbox INBOX] [--recent 2h]
node scripts/imap.js check --all-accounts [--limit 10]
```

Options:
- `--account <id>`: Use a specific configured account
- `--all-accounts`: Check every enabled account
- `--limit <n>`: Max results (default: 10)
- `--mailbox <name>`: Mailbox to check (default: INBOX)
- `--recent <time>`: Only show emails from last X time (e.g., 30m, 2h, 7d)

### fetch
Fetch full email content by UID.

```bash
node scripts/imap.js fetch <uid> [--mailbox INBOX]
node scripts/imap.js fetch <uid> --account <id> [--mailbox INBOX]
```

### download
Download all attachments from an email, or a specific attachment.

```bash
node scripts/imap.js download <uid> [--mailbox INBOX] [--dir <path>] [--file <filename>]
node scripts/imap.js download <uid> --account <id> [--mailbox INBOX] [--dir <path>] [--file <filename>]
```

Options:
- `--mailbox <name>`: Mailbox (default: INBOX)
- `--dir <path>`: Output directory (default: current directory)
- `--file <filename>`: Download only the specified attachment (default: download all)

### search
Search emails with filters.

```bash
node scripts/imap.js search [options]

Options:
  --unseen           Only unread messages
  --seen             Only read messages
  --from <email>     From address contains
  --subject <text>   Subject contains
  --recent <time>    From last X time (e.g., 30m, 2h, 7d)
  --since <date>     After date (YYYY-MM-DD)
  --before <date>    Before date (YYYY-MM-DD)
  --limit <n>        Max results (default: 20)
  --mailbox <name>   Mailbox to search (default: INBOX)
  --account <id>     Use a specific configured account
  --all-accounts     Search every enabled account
```

### mark-read / mark-unread
Mark message(s) as read or unread.

```bash
node scripts/imap.js mark-read <uid> [uid2 uid3...]
node scripts/imap.js mark-unread <uid> [uid2 uid3...]
node scripts/imap.js mark-read --account <id> <uid> [uid2 uid3...]
```

### list-mailboxes
List all available mailboxes/folders.

```bash
node scripts/imap.js list-mailboxes
node scripts/imap.js list-mailboxes --all-accounts
```

## SMTP Commands (Sending Email)

### accounts
List configured email accounts without exposing passwords.

```bash
node scripts/smtp.js accounts
```

### send
Submit email via SMTP. A successful command means the SMTP server accepted the message for processing, not that the recipient inbox has received it.

```bash
node scripts/smtp.js send --to <email> --subject <text> --confirmed [options]
```

**Required:**
- `--to <email>`: Recipient (comma-separated for multiple)
- `--subject <text>`: Email subject, or `--subject-file <file>`

**Optional:**
- `--body <text>`: Plain text body
- `--html`: Send body as HTML
- `--body-file <file>`: Read body from file
- `--html-file <file>`: Read HTML from file
- `--cc <email>`: CC recipients
- `--bcc <email>`: BCC recipients
- `--attach <file>`: Attachments (comma-separated)
- `--from <email>`: Override default sender
- `--account <id>`: Send from a specific configured account
- `--to-account <id>`: Send to a configured account by ID without exposing its full email address
- `--confirmed`: Required after the user confirms the email details

**Examples:**
```bash
# Simple text email
node scripts/smtp.js send --to recipient@example.com --subject "Hello" --body "World"

# HTML email
node scripts/smtp.js send --to recipient@example.com --subject "Newsletter" --html --body "<h1>Welcome</h1>"

# Email with attachment
node scripts/smtp.js send --to recipient@example.com --subject "Report" --body "Please find attached" --attach report.pdf

# Multiple recipients
node scripts/smtp.js send --to "a@example.com,b@example.com" --cc "c@example.com" --subject "Update" --body "Team update"

# Send to another configured account by ID
node scripts/smtp.js send --account default --to-account account-2 --subject "Hello" --body "World"
```

### test
Test SMTP connection by sending a test email to yourself.

```bash
node scripts/smtp.js test
```

## Dependencies

```bash
npm install
```

## Security Notes

- Store credentials in `.env` (add to `.gitignore`)
- For Gmail: use App Password if 2FA is enabled
- For 163.com: use authorization code (授权码), not account password

## Troubleshooting

**Connection timeout:**
- Verify server is running and accessible
- Check host/port configuration

**Authentication failed:**
- Verify username (usually full email address)
- Check password is correct
- For 163.com: use authorization code, not account password
- For Gmail: use App Password if 2FA enabled

**TLS/SSL errors:**
- Match `IMAP_TLS`/`SMTP_SECURE` setting to server requirements
- For self-signed certs: set `IMAP_REJECT_UNAUTHORIZED=false` or `SMTP_REJECT_UNAUTHORIZED=false`
