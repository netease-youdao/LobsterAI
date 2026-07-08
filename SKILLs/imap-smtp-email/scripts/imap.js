#!/usr/bin/env node

/**
 * IMAP Email CLI
 * Works with any standard IMAP server (Gmail, ProtonMail Bridge, Fastmail, etc.)
 * Supports IMAP ID extension (RFC 2971) for 163.com and other servers
 */

const Imap = require('imap');
const { simpleParser } = require('mailparser');
const path = require('path');
const fs = require('fs');
const {
  createImapConfig,
  getTargetAccounts,
  listAccountsConfig,
  redactAccount,
  redactEmail,
  withAccountResult,
} = require('./config');

// IMAP ID information for 163.com compatibility
const IMAP_ID = {
  name: 'moltbot',
  version: '0.0.1',
  vendor: 'netease',
  'support-email': 'kefu@188.com'
};
const IMAP_OPERATION_TIMEOUT_MS = Math.max(
  1000,
  parseInt(process.env.EMAIL_IMAP_OPERATION_TIMEOUT_MS || '30000', 10) || 30000
);

// Parse command-line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0];
  const options = {};
  const positional = [];

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args[i + 1];
      options[key] = value || true;
      if (value && !value.startsWith('--')) i++;
    } else {
      positional.push(arg);
    }
  }

  return { command, options, positional };
}

function withTimeout(promise, label, timeoutMs = IMAP_OPERATION_TIMEOUT_MS) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

// Connect to IMAP server with ID support
async function connect(account) {
  const config = createImapConfig(account);
  console.error(`[imap-debug] Account: ${JSON.stringify(redactAccount(account))}`);
  console.error(`[imap-debug] Config: host=${config.host}, port=${config.port}, user=${redactEmail(config.user)}, tls=${config.tls}, rejectUnauthorized=${config.tlsOptions.rejectUnauthorized}, hasPassword=${!!config.password}`);

  return new Promise((resolve, reject) => {
    const imap = new Imap(config);

    imap.once('ready', () => {
      console.error('[imap-debug] Connection ready, sending ID command...');
      // Send IMAP ID command for 163.com compatibility
      if (typeof imap.id === 'function') {
        imap.id(IMAP_ID, (err) => {
          if (err) {
            console.warn('[imap-debug] Warning: IMAP ID command failed:', err.message);
          } else {
            console.error('[imap-debug] IMAP ID command succeeded');
          }
          resolve(imap);
        });
      } else {
        // ID not supported, continue without it
        console.error('[imap-debug] IMAP ID not supported, continuing without it');
        resolve(imap);
      }
    });

    imap.once('error', (err) => {
      console.error('[imap-debug] Connection error:', err.message, 'code:', err.code, 'source:', err.source);
      reject(new Error(`IMAP connection failed: ${err.message}`));
    });

    console.error('[imap-debug] Connecting...');
    imap.connect();
  });
}

// Open mailbox and return promise
function openBox(imap, mailbox, readOnly = false) {
  return new Promise((resolve, reject) => {
    imap.openBox(mailbox, readOnly, (err, box) => {
      if (err) reject(err);
      else resolve(box);
    });
  });
}

// Search for messages
function searchMessages(imap, criteria, fetchOptions, maxResults = null) {
  return new Promise((resolve, reject) => {
    imap.search(criteria, (err, results) => {
      if (err) {
        reject(err);
        return;
      }

      if (!results || results.length === 0) {
        resolve([]);
        return;
      }

      // IMAP search results are returned in ascending message order by common
      // servers. Fetch only the newest candidates to avoid downloading a large
      // mailbox when the user asks for a small list.
      const fetchTargets = maxResults && results.length > maxResults
        ? results.slice(-maxResults)
        : results;
      const fetch = imap.fetch(fetchTargets, fetchOptions);
      const messages = [];

      fetch.on('message', (msg) => {
        const parts = [];

        msg.on('body', (stream, info) => {
          let buffer = '';

          stream.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
          });

          stream.once('end', () => {
            parts.push({ which: info.which, body: buffer });
          });
        });

        msg.once('attributes', (attrs) => {
          parts.forEach((part) => {
            part.attributes = attrs;
          });
        });

        msg.once('end', () => {
          if (parts.length > 0) {
            messages.push(parts[0]);
          }
        });
      });

      fetch.once('error', (err) => {
        reject(err);
      });

      fetch.once('end', () => {
        resolve(messages);
      });
    });
  });
}

// Parse email from raw buffer
// summaryOnly: when true, omit full text/html to keep output compact for list views
async function parseEmail(bodyStr, { includeAttachments = false, summaryOnly = false } = {}) {
  const parsed = await simpleParser(bodyStr);

  const snippet = parsed.text
    ? parsed.text.slice(0, 200)
    : (parsed.html ? parsed.html.slice(0, 200).replace(/<[^>]*>/g, '') : '');

  // Format date as ISO 8601 with local timezone offset (e.g. "2026-03-03T07:50:00+08:00")
  // This avoids JSON.stringify converting Date to UTC, and is consistent across all platforms
  let dateStr = null;
  if (parsed.date) {
    try {
      const d = parsed.date;
      if (process.env.EMAIL_DEBUG_DATES === '1') {
        console.error(`[imap-debug] date raw: ${d}`);
        console.error(`[imap-debug] date ISO(UTC): ${d.toISOString()}`);
        console.error(`[imap-debug] date toString(local): ${d.toString()}`);
        console.error(`[imap-debug] date timezoneOffset: ${d.getTimezoneOffset()} min`);
      }
      const pad = (n) => String(n).padStart(2, '0');
      const tzOffset = -d.getTimezoneOffset();
      const sign = tzOffset >= 0 ? '+' : '-';
      const tzHours = pad(Math.floor(Math.abs(tzOffset) / 60));
      const tzMinutes = pad(Math.abs(tzOffset) % 60);
      dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
        + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
        + `${sign}${tzHours}:${tzMinutes}`;
      if (process.env.EMAIL_DEBUG_DATES === '1') {
        console.error(`[imap-debug] date formatted: ${dateStr}`);
      }
    } catch (e) {
      dateStr = parsed.date.toISOString();
    }
  }

  const result = {
    from: parsed.from?.text || 'Unknown',
    to: parsed.to?.text,
    subject: parsed.subject || '(no subject)',
    date: dateStr,
    snippet,
    attachments: parsed.attachments?.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
      content: includeAttachments ? a.content : undefined,
      cid: a.cid,
    })),
  };

  // Only include full text/html for single-email fetch, not for list views
  if (!summaryOnly) {
    result.text = parsed.text;
    result.html = parsed.html;
  }

  return result;
}

// Check for new/unread emails
async function checkEmails(account, mailbox = account.mailbox || 'INBOX', limit = 10, recentTime = null, unreadOnly = false) {
  const imap = await connect(account);

  try {
    await withTimeout(openBox(imap, mailbox), `Opening mailbox "${mailbox}"`);

    // Build search criteria
    const searchCriteria = unreadOnly ? ['UNSEEN'] : ['ALL'];

    if (recentTime) {
      const sinceDate = parseRelativeTime(recentTime);
      searchCriteria.push(['SINCE', sinceDate]);
    }

    // Fetch messages sorted by date (newest first)
    const fetchOptions = {
      bodies: [''],
      markSeen: false,
    };

    const messages = await withTimeout(
      searchMessages(imap, searchCriteria, fetchOptions, limit),
      `Checking mailbox "${mailbox}"`
    );

    // Sort by date (newest first) - parse from message attributes
    const sortedMessages = messages.sort((a, b) => {
      const dateA = a.attributes.date ? new Date(a.attributes.date) : new Date(0);
      const dateB = b.attributes.date ? new Date(b.attributes.date) : new Date(0);
      return dateB - dateA;
    }).slice(0, limit);

    const results = [];

    for (const item of sortedMessages) {
      const bodyStr = item.body;
      const parsed = await parseEmail(bodyStr, { summaryOnly: true });

      results.push({
        uid: item.attributes.uid,
        ...parsed,
        flags: item.attributes.flags,
      });
    }

    return results;
  } finally {
    imap.end();
  }
}

// Fetch full email by UID
async function fetchEmail(account, uid, mailbox = account.mailbox || 'INBOX') {
  const imap = await connect(account);

  try {
    await withTimeout(openBox(imap, mailbox), `Opening mailbox "${mailbox}"`);

    const searchCriteria = [['UID', uid]];
    const fetchOptions = {
      bodies: [''],
      markSeen: false,
    };

    const messages = await withTimeout(
      searchMessages(imap, searchCriteria, fetchOptions, 1),
      `Fetching message UID ${uid}`
    );

    if (messages.length === 0) {
      throw new Error(`Message UID ${uid} not found`);
    }

    const item = messages[0];
    const parsed = await parseEmail(item.body);

    return {
      uid: item.attributes.uid,
      ...parsed,
      flags: item.attributes.flags,
    };
  } finally {
    imap.end();
  }
}

// Download attachments from email
async function downloadAttachments(account, uid, mailbox = account.mailbox || 'INBOX', outputDir = '.', specificFilename = null) {
  const imap = await connect(account);

  try {
    await withTimeout(openBox(imap, mailbox), `Opening mailbox "${mailbox}"`);

    const searchCriteria = [['UID', uid]];
    const fetchOptions = {
      bodies: [''],
      markSeen: false,
    };

    const messages = await withTimeout(
      searchMessages(imap, searchCriteria, fetchOptions, 1),
      `Fetching message UID ${uid}`
    );

    if (messages.length === 0) {
      throw new Error(`Message UID ${uid} not found`);
    }

    const item = messages[0];
    const parsed = await parseEmail(item.body, { includeAttachments: true });

    if (!parsed.attachments || parsed.attachments.length === 0) {
      return {
        uid,
        downloaded: [],
        message: 'No attachments found',
      };
    }

    // Create output directory if it doesn't exist
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const downloaded = [];

    for (const attachment of parsed.attachments) {
      // If specificFilename is provided, only download matching attachment
      if (specificFilename && attachment.filename !== specificFilename) {
        continue;
      }
      if (attachment.content) {
        const accountOutputDir = path.join(outputDir, account.id, String(uid));
        if (!fs.existsSync(accountOutputDir)) {
          fs.mkdirSync(accountOutputDir, { recursive: true });
        }
        const filePath = path.join(accountOutputDir, attachment.filename);
        fs.writeFileSync(filePath, attachment.content);
        downloaded.push({
          filename: attachment.filename,
          path: filePath,
          size: attachment.size,
        });
      }
    }

    // If specific file was requested but not found
    if (specificFilename && downloaded.length === 0) {
      const availableFiles = parsed.attachments.map(a => a.filename).join(', ');
      return {
        uid,
        downloaded: [],
        message: `File "${specificFilename}" not found. Available attachments: ${availableFiles}`,
      };
    }

    return {
      uid,
      downloaded,
      message: `Downloaded ${downloaded.length} attachment(s)`,
    };
  } finally {
    imap.end();
  }
}

// Parse relative time (e.g., "2h", "30m", "7d") to Date
function parseRelativeTime(timeStr) {
  const match = timeStr.match(/^(\d+)(m|h|d)$/);
  if (!match) {
    throw new Error('Invalid time format. Use: 30m, 2h, 7d');
  }

  const value = parseInt(match[1]);
  const unit = match[2];
  const now = new Date();

  switch (unit) {
    case 'm': // minutes
      return new Date(now.getTime() - value * 60 * 1000);
    case 'h': // hours
      return new Date(now.getTime() - value * 60 * 60 * 1000);
    case 'd': // days
      return new Date(now.getTime() - value * 24 * 60 * 60 * 1000);
    default:
      throw new Error('Unknown time unit');
  }
}

// Search emails with criteria
async function searchEmails(account, options) {
  const imap = await connect(account);

  try {
    const mailbox = options.mailbox || account.mailbox || 'INBOX';
    await withTimeout(openBox(imap, mailbox), `Opening mailbox "${mailbox}"`);

    const criteria = [];

    if (options.unseen) criteria.push('UNSEEN');
    if (options.seen) criteria.push('SEEN');
    if (options.from) criteria.push(['FROM', options.from]);
    if (options.subject) criteria.push(['SUBJECT', options.subject]);

    // Handle relative time (--recent 2h)
    if (options.recent) {
      const sinceDate = parseRelativeTime(options.recent);
      criteria.push(['SINCE', sinceDate]);
    } else {
      // Handle absolute dates
      if (options.since) criteria.push(['SINCE', options.since]);
      if (options.before) criteria.push(['BEFORE', options.before]);
    }

    // Default to all if no criteria
    if (criteria.length === 0) criteria.push('ALL');

    const fetchOptions = {
      bodies: [''],
      markSeen: false,
    };

    const limit = parseInt(options.limit) || 20;
    const messages = await withTimeout(
      searchMessages(imap, criteria, fetchOptions, limit),
      `Searching mailbox "${mailbox}"`
    );
    const results = [];

    // Sort by date (newest first)
    const sortedMessages = messages.sort((a, b) => {
      const dateA = a.attributes.date ? new Date(a.attributes.date) : new Date(0);
      const dateB = b.attributes.date ? new Date(b.attributes.date) : new Date(0);
      return dateB - dateA;
    }).slice(0, limit);

    for (const item of sortedMessages) {
      const parsed = await parseEmail(item.body, { summaryOnly: true });
      results.push({
        uid: item.attributes.uid,
        ...parsed,
        flags: item.attributes.flags,
      });
    }

    return results;
  } finally {
    imap.end();
  }
}

// Mark message(s) as read
async function markAsRead(account, uids, mailbox = account.mailbox || 'INBOX') {
  const imap = await connect(account);

  try {
    await withTimeout(openBox(imap, mailbox), `Opening mailbox "${mailbox}"`);

    return await withTimeout(new Promise((resolve, reject) => {
      imap.addFlags(uids, '\\Seen', (err) => {
        if (err) reject(err);
        else resolve({ success: true, uids, action: 'marked as read' });
      });
    }), `Marking message(s) as read in "${mailbox}"`);
  } finally {
    imap.end();
  }
}

// Mark message(s) as unread
async function markAsUnread(account, uids, mailbox = account.mailbox || 'INBOX') {
  const imap = await connect(account);

  try {
    await withTimeout(openBox(imap, mailbox), `Opening mailbox "${mailbox}"`);

    return await withTimeout(new Promise((resolve, reject) => {
      imap.delFlags(uids, '\\Seen', (err) => {
        if (err) reject(err);
        else resolve({ success: true, uids, action: 'marked as unread' });
      });
    }), `Marking message(s) as unread in "${mailbox}"`);
  } finally {
    imap.end();
  }
}

// List all mailboxes
async function listMailboxes(account) {
  const imap = await connect(account);

  try {
    return await withTimeout(new Promise((resolve, reject) => {
      imap.getBoxes((err, boxes) => {
        if (err) reject(err);
        else resolve(formatMailboxTree(boxes));
      });
    }), 'Listing mailboxes');
  } finally {
    imap.end();
  }
}

// Format mailbox tree recursively
function formatMailboxTree(boxes, prefix = '') {
  const result = [];
  for (const [name, info] of Object.entries(boxes)) {
    const fullName = prefix ? `${prefix}${info.delimiter}${name}` : name;
    result.push({
      name: fullName,
      delimiter: info.delimiter,
      attributes: info.attribs,
    });

    if (info.children) {
      result.push(...formatMailboxTree(info.children, fullName));
    }
  }
  return result;
}

function formatCommandResult(account, command, payload, metadata = {}) {
  return withAccountResult(account, {
    success: true,
    command,
    ...metadata,
    ...payload,
  });
}

async function runForAccounts(options, operation, formatter = null) {
  const { accounts, allAccounts } = getTargetAccounts(options);
  if (!allAccounts) {
    const result = await operation(accounts[0]);
    return formatter ? formatter(accounts[0], result) : result;
  }

  const results = [];
  for (const account of accounts) {
    try {
      const result = await operation(account);
      results.push(formatter
        ? formatter(account, result)
        : withAccountResult(account, { success: true, result }));
    } catch (error) {
      results.push(withAccountResult(account, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  const successCount = results.filter(result => result.success).length;
  return {
    success: successCount === results.length,
    partial: successCount > 0 && successCount < results.length,
    results,
  };
}

// Main CLI handler
async function main() {
  const { command, options, positional } = parseArgs();

  try {
    let result;

    switch (command) {
      case 'accounts':
        result = listAccountsConfig();
        break;

      case 'check':
        result = await runForAccounts(options, account => checkEmails(
          account,
          options.mailbox || account.mailbox || 'INBOX',
          parseInt(options.limit) || 10,
          options.recent || null,
          options.unseen === true || options.unseen === 'true'
        ), (account, messages) => formatCommandResult(account, 'check', {
          count: messages.length,
          messages,
        }, {
          mailbox: options.mailbox || account.mailbox || 'INBOX',
        }));
        break;

      case 'search':
        result = await runForAccounts(options, account => searchEmails(account, options), (account, messages) => formatCommandResult(account, 'search', {
          count: messages.length,
          messages,
        }, {
          mailbox: options.mailbox || account.mailbox || 'INBOX',
        }));
        break;

      case 'list-mailboxes':
        result = await runForAccounts(options, account => listMailboxes(account), (account, mailboxes) => formatCommandResult(account, 'list-mailboxes', {
          count: mailboxes.length,
          mailboxes,
        }));
        break;

      case 'fetch': {
        if (options['all-accounts']) {
          throw new Error('--all-accounts is not supported for fetch; pass --account <id>');
        }
        if (!positional[0]) {
          throw new Error('UID required: node imap.js fetch <uid>');
        }
        const { accounts } = getTargetAccounts(options);
        result = await fetchEmail(accounts[0], positional[0], options.mailbox);
        break;
      }

      case 'download': {
        if (options['all-accounts']) {
          throw new Error('--all-accounts is not supported for download; pass --account <id>');
        }
        if (!positional[0]) {
          throw new Error('UID required: node imap.js download <uid>');
        }
        const { accounts } = getTargetAccounts(options);
        result = await downloadAttachments(
          accounts[0],
          positional[0],
          options.mailbox,
          options.dir || '.',
          options.file || null
        );
        break;
      }

      case 'mark-read':
        if (options['all-accounts']) {
          throw new Error('--all-accounts is not supported for mark-read; pass --account <id>');
        }
        if (positional.length === 0) {
          throw new Error('UID(s) required: node imap.js mark-read <uid> [uid2...]');
        }
        result = await markAsRead(getTargetAccounts(options).accounts[0], positional, options.mailbox);
        break;

      case 'mark-unread':
        if (options['all-accounts']) {
          throw new Error('--all-accounts is not supported for mark-unread; pass --account <id>');
        }
        if (positional.length === 0) {
          throw new Error('UID(s) required: node imap.js mark-unread <uid> [uid2...]');
        }
        result = await markAsUnread(getTargetAccounts(options).accounts[0], positional, options.mailbox);
        break;

      default:
        console.error('Unknown command:', command);
        console.error('Available commands: accounts, check, fetch, download, search, mark-read, mark-unread, list-mailboxes');
        process.exit(1);
    }

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
