# IMAP/SMTP Email Skill

Read and send email via IMAP/SMTP protocol. Works with any IMAP/SMTP server including Gmail, Outlook, 163.com, vip.163.com, 126.com, vip.126.com, 188.com, and vip.188.com.

## Quick Setup

1. **Configure accounts in LobsterAI Settings > Email.**

LobsterAI writes `accounts.json` for multi-account setups. Existing `.env` files are still read as a legacy single-account fallback.

Optional legacy `.env` format:

```bash
# IMAP Configuration (receiving email)
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_USER=your@gmail.com
IMAP_PASS=your_app_password
IMAP_TLS=true
IMAP_MAILBOX=INBOX

# SMTP Configuration (sending email)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your@gmail.com
SMTP_PASS=your_app_password
SMTP_FROM=your@gmail.com
```

2. **Install dependencies:**
```bash
npm install
```

3. **Test the connection:**
```bash
node scripts/imap.js check
node scripts/smtp.js test
```

## Account Selection

```bash
# Use the default enabled account
node scripts/imap.js check

# List account IDs without secrets
node scripts/imap.js accounts
node scripts/smtp.js accounts

# Use a specific account
node scripts/imap.js check --account work

# Fan out to every enabled account for read/list commands
node scripts/imap.js check --all-accounts
node scripts/imap.js search --all-accounts --unseen
node scripts/imap.js list-mailboxes --all-accounts
```

## IMAP Commands (Receiving Email)

### Check for new emails
```bash
node scripts/imap.js check --limit 10
node scripts/imap.js check --account work --limit 10
node scripts/imap.js check --all-accounts --limit 10
node scripts/imap.js check --recent 2h        # Last 2 hours
node scripts/imap.js check --recent 30m       # Last 30 minutes
```

### Fetch specific email
```bash
node scripts/imap.js fetch <uid>
node scripts/imap.js fetch <uid> --account work
```

### Search emails
```bash
node scripts/imap.js search --unseen
node scripts/imap.js search --all-accounts --unseen
node scripts/imap.js search --from "sender@example.com"
node scripts/imap.js search --subject "important"
node scripts/imap.js search --recent 24h
```

### Mark as read/unread
```bash
node scripts/imap.js mark-read <uid>
node scripts/imap.js mark-unread <uid> --account work
```

### List mailboxes
```bash
node scripts/imap.js list-mailboxes
node scripts/imap.js list-mailboxes --all-accounts
```

## SMTP Commands (Sending Email)

### Test SMTP connection
```bash
node scripts/smtp.js test
node scripts/smtp.js test --account work
```

### Send email
```bash
# Simple text email
node scripts/smtp.js send --to recipient@example.com --subject "Hello" --body "World" --confirmed

# HTML email
node scripts/smtp.js send --to recipient@example.com --subject "Newsletter" --html --body "<h1>Welcome</h1>" --confirmed

# Email with attachment
node scripts/smtp.js send --to recipient@example.com --subject "Report" --body "Please find attached" --attach report.pdf --confirmed

# Multiple recipients
node scripts/smtp.js send --account work --to "a@example.com,b@example.com" --cc "c@example.com" --subject "Update" --body "Team update" --confirmed
```

Sending is blocked unless `--confirmed` is passed after the user confirms recipient, subject, sender account, and body.

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

## Configuration Options

**IMAP:**
- `IMAP_HOST` - Server hostname
- `IMAP_PORT` - Server port
- `IMAP_USER` - Your email address
- `IMAP_PASS` - Your password or app-specific password
- `IMAP_TLS` - Use TLS (true for SSL, false for STARTTLS)
- `IMAP_REJECT_UNAUTHORIZED` - Accept self-signed certs
- `IMAP_MAILBOX` - Default mailbox (INBOX)

**SMTP:**
- `SMTP_HOST` - Server hostname
- `SMTP_PORT` - Server port (587 for STARTTLS, 465 for SSL)
- `SMTP_SECURE` - true for SSL (465), false for STARTTLS (587)
- `SMTP_USER` - Your email address
- `SMTP_PASS` - Your password or app-specific password
- `SMTP_FROM` - Default sender email (optional)
- `SMTP_REJECT_UNAUTHORIZED` - Accept self-signed certs
- `EMAIL_REQUIRE_SEND_CONFIRMATION` - Set to `false` only for trusted automation that may send without `--confirmed`

## Troubleshooting

**Connection errors:**
- Verify IMAP/SMTP server is running and accessible
- Check host/port settings in `.env`

**Authentication failed:**
- For Gmail: Use App Password (not account password if 2FA enabled)
- For 163.com: Use authorization code (授权码), not account password

**TLS/SSL errors:**
- For self-signed certs: Set `IMAP_REJECT_UNAUTHORIZED=false` or `SMTP_REJECT_UNAUTHORIZED=false`

## Files

- `SKILL.md` - Skill documentation
- `accounts.json` - Multi-account credentials managed by LobsterAI Settings
- `scripts/imap.js` - IMAP CLI tool
- `scripts/smtp.js` - SMTP CLI tool
- `package.json` - Node.js dependencies
- `.env` - Legacy single-account credentials fallback
