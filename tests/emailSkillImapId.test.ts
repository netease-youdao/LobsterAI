import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

const REPO_EMAIL_SKILL_DIR = path.resolve(process.cwd(), 'SKILLs', 'imap-smtp-email');
const HAS_REAL_IMAP_DEPS = fs.existsSync(path.join(REPO_EMAIL_SKILL_DIR, 'node_modules', 'imap', 'package.json'));

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-email-imap-id-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function runNodeAsync(
  scriptPath: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function writeTestAccount(skillDir: string, port: number): void {
  fs.writeFileSync(
    path.join(skillDir, 'accounts.json'),
    `${JSON.stringify({
      version: 1,
      defaultAccountId: 'test-imap',
      accounts: [
        {
          id: 'test-imap',
          name: 'Loopback IMAP',
          enabled: true,
          provider: 'custom',
          email: 'reader@example.invalid',
          password: 'test-password',
          imapHost: '127.0.0.1',
          imapPort: port,
          imapTls: false,
          imapRejectUnauthorized: false,
          smtpHost: '',
          smtpPort: 587,
          smtpSecure: false,
          smtpRejectUnauthorized: false,
          smtpFrom: 'reader@example.invalid',
          mailbox: 'INBOX',
          requireSendConfirmation: true,
        },
      ],
    }, null, 2)}\n`,
    'utf8',
  );
}

interface MockImapServerHandle {
  port: number;
  commands: string[];
  close: () => Promise<void>;
}

async function startLoopbackImapServer(options: {
  advertiseId: boolean;
  subject: string;
}): Promise<MockImapServerHandle> {
  const commands: string[] = [];
  const capLine = options.advertiseId
    ? 'IMAP4rev1 AUTH=PLAIN ID'
    : 'IMAP4rev1 AUTH=PLAIN';
  const rawMessage = [
    'From: Sender <sender@example.invalid>',
    'To: Reader <reader@example.invalid>',
    `Subject: ${options.subject}`,
    'Date: Sun, 22 Nov 2026 10:00:00 +0000',
    'Message-ID: <test-1@example.invalid>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Hello from loopback IMAP test.',
    '',
  ].join('\r\n');

  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write(`* OK [CAPABILITY ${capLine}] Mock IMAP ready\r\n`);

    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newlineIdx = buffer.indexOf('\r\n');
      while (newlineIdx >= 0) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 2);
        newlineIdx = buffer.indexOf('\r\n');
        if (!line.trim()) continue;

        const spaceIdx = line.indexOf(' ');
        if (spaceIdx < 0) continue;
        const tag = line.slice(0, spaceIdx);
        const rest = line.slice(spaceIdx + 1).trim();
        const tokens = rest.split(/\s+/);
        const verb = (tokens[0] || '').toUpperCase();
        const subVerb = verb === 'UID' ? `${verb} ${(tokens[1] || '').toUpperCase()}` : verb;
        commands.push(subVerb);

        if (verb === 'CAPABILITY') {
          socket.write(`* CAPABILITY ${capLine}\r\n${tag} OK CAPABILITY completed\r\n`);
        } else if (verb === 'LOGIN') {
          socket.write(`${tag} OK LOGIN completed\r\n`);
        } else if (verb === 'ID') {
          if (!options.advertiseId) {
            socket.write(`${tag} BAD ID not supported\r\n`);
          } else {
            socket.write(`* ID ("name" "mock-imap")\r\n${tag} OK ID completed\r\n`);
          }
        } else if (verb === 'LIST') {
          socket.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK LIST completed\r\n`);
        } else if (verb === 'NOOP') {
          socket.write(`${tag} OK NOOP completed\r\n`);
        } else if (verb === 'SELECT' || verb === 'EXAMINE') {
          socket.write(
            `* 1 EXISTS\r\n* 0 RECENT\r\n* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n* OK [UIDVALIDITY 1]\r\n* OK [UIDNEXT 2]\r\n${tag} OK [READ-ONLY] SELECT completed\r\n`,
          );
        } else if (subVerb === 'UID SEARCH' || verb === 'SEARCH') {
          socket.write(`* SEARCH 1\r\n${tag} OK SEARCH completed\r\n`);
        } else if (subVerb === 'UID FETCH' || verb === 'FETCH') {
          const byteLen = Buffer.byteLength(rawMessage, 'utf8');
          socket.write(
            `* 1 FETCH (UID 1 FLAGS () INTERNALDATE "22-Nov-2026 10:00:00 +0000" BODY[] {${byteLen}}\r\n${rawMessage})\r\n${tag} OK FETCH completed\r\n`,
          );
        } else if (verb === 'LOGOUT') {
          socket.write(`* BYE Mock IMAP logging out\r\n${tag} OK LOGOUT completed\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK ${verb} completed\r\n`);
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind mock IMAP server');
  }

  return {
    port: address.port,
    commands,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}

describe('imap-smtp-email optional IMAP ID capability handling', () => {
  test('only invokes imap.id() when serverSupports("ID") is true, avoiding synchronous throw from node-imap', async () => {
    const root = createTempDir();
    const skillDir = path.join(root, 'imap-smtp-email');
    const scriptsDir = path.join(skillDir, 'scripts');
    const nodeModulesDir = path.join(skillDir, 'node_modules');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(path.join(nodeModulesDir, 'imap'), { recursive: true });
    fs.mkdirSync(path.join(nodeModulesDir, 'mailparser'), { recursive: true });
    fs.symlinkSync(path.resolve(process.cwd(), 'node_modules', 'dotenv'), path.join(nodeModulesDir, 'dotenv'), 'dir');

    for (const file of ['config.js', 'imap.js', 'attachment-storage.js']) {
      fs.copyFileSync(path.join(REPO_EMAIL_SKILL_DIR, 'scripts', file), path.join(scriptsDir, file));
    }
    writeTestAccount(skillDir, 14300);

    // Faithful minimal stub of node-imap's Connection.prototype.id() synchronous throw.
    fs.writeFileSync(
      path.join(nodeModulesDir, 'imap', 'index.js'),
      `const { EventEmitter } = require('events');
class StubImap extends EventEmitter {
  constructor() { super(); }
  serverSupports(cap) {
    return cap === 'ID' && process.env.TEST_ADVERTISE_IMAP_ID === '1';
  }
  id(identification, cb) {
    if (!this.serverSupports('ID')) {
      throw new Error('Server does not support ID');
    }
    console.error('[stub-imap] ID_CALLED=' + JSON.stringify(identification.name));
    cb(null);
  }
  connect() {
    process.nextTick(() => this.emit('ready'));
  }
  openBox(_mailbox, _readOnly, cb) {
    cb(null, { messages: { total: 0 } });
  }
  search(_criteria, cb) {
    cb(null, []);
  }
  end() {
    process.nextTick(() => this.emit('end'));
  }
}
module.exports = StubImap;
`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(nodeModulesDir, 'mailparser', 'index.js'),
      'module.exports = { simpleParser: async () => ({}) };\n',
      'utf8',
    );

    const noIdRun = await runNodeAsync(
      path.join(scriptsDir, 'imap.js'),
      ['check', '--limit', '5'],
      {
        cwd: skillDir,
        env: { ...process.env, SKILLS_ROOT: root, TEST_ADVERTISE_IMAP_ID: '0' },
      },
    );
    expect(noIdRun.status, noIdRun.stderr).toBe(0);
    expect(JSON.parse(noIdRun.stdout)).toMatchObject({ success: true, count: 0 });
    expect(noIdRun.stderr).not.toContain('ID_CALLED=');

    const withIdRun = await runNodeAsync(
      path.join(scriptsDir, 'imap.js'),
      ['check', '--limit', '5'],
      {
        cwd: skillDir,
        env: { ...process.env, SKILLS_ROOT: root, TEST_ADVERTISE_IMAP_ID: '1' },
      },
    );
    expect(withIdRun.status, withIdRun.stderr).toBe(0);
    expect(JSON.parse(withIdRun.stdout)).toMatchObject({ success: true, count: 0 });
    expect(withIdRun.stderr).toContain('ID_CALLED="moltbot"');
  });

  test.skipIf(!HAS_REAL_IMAP_DEPS)(
    'real node-imap E2E: reads messages from loopback IMAP servers both without and with ID capability',
    async () => {
      const root = createTempDir();
      const skillCfgDir = path.join(root, 'imap-smtp-email');
      const scriptsDir = path.join(skillCfgDir, 'scripts');
      fs.mkdirSync(scriptsDir, { recursive: true });
      for (const file of ['config.js', 'imap.js', 'attachment-storage.js']) {
        fs.copyFileSync(path.join(REPO_EMAIL_SKILL_DIR, 'scripts', file), path.join(scriptsDir, file));
      }
      fs.symlinkSync(
        path.join(REPO_EMAIL_SKILL_DIR, 'node_modules'),
        path.join(skillCfgDir, 'node_modules'),
        'dir',
      );
      const isolatedImapScript = path.join(scriptsDir, 'imap.js');

      const noIdServer = await startLoopbackImapServer({
        advertiseId: false,
        subject: 'IMAP_NO_ID_OK_3344',
      });
      try {
        writeTestAccount(skillCfgDir, noIdServer.port);
        const res = await runNodeAsync(
          isolatedImapScript,
          ['check', '--limit', '5'],
          {
            cwd: skillCfgDir,
            env: { ...process.env, SKILLS_ROOT: root },
          },
        );
        expect(res.status, res.stderr).toBe(0);
        const parsed = JSON.parse(res.stdout) as { messages?: Array<{ subject?: string }> };
        expect(parsed.messages?.[0]?.subject).toBe('IMAP_NO_ID_OK_3344');
        expect(noIdServer.commands).not.toContain('ID');
      } finally {
        await noIdServer.close();
      }

      const withIdServer = await startLoopbackImapServer({
        advertiseId: true,
        subject: 'IMAP_WITH_ID_OK_5566',
      });
      try {
        writeTestAccount(skillCfgDir, withIdServer.port);
        const res = await runNodeAsync(
          isolatedImapScript,
          ['check', '--limit', '5'],
          {
            cwd: skillCfgDir,
            env: { ...process.env, SKILLS_ROOT: root },
          },
        );
        expect(res.status, res.stderr).toBe(0);
        const parsed = JSON.parse(res.stdout) as { messages?: Array<{ subject?: string }> };
        expect(parsed.messages?.[0]?.subject).toBe('IMAP_WITH_ID_OK_5566');
        expect(withIdServer.commands).toContain('ID');
      } finally {
        await withIdServer.close();
      }
    },
  );
});
