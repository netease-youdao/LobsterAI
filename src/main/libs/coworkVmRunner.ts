import { app } from 'electron';
import { spawn, type ChildProcessByStdio } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import type { Readable } from 'stream';
import { StringDecoder } from 'string_decoder';
import { v4 as uuidv4 } from 'uuid';
import type { SandboxRuntimeInfo } from './coworkSandboxRuntime';
import { coworkLog } from './coworkLogger';

export type CoworkSandboxPaths = {
  baseDir: string;
  ipcDir: string;
  requestsDir: string;
  responsesDir: string;
  streamsDir: string;
};

export type SandboxLauncherMode = 'direct' | 'launchctl';

export type SandboxRequestInfo = {
  requestId: string;
  requestPath: string;
  streamPath: string;
};

export type SandboxCwdMapping = {
  hostPath: string;
  guestPath: string;
  mountTag: string;
};

export type SandboxExtraMount = {
  hostPath: string;
  mountTag: string;
};

export function ensureCoworkSandboxDirs(sessionId: string): CoworkSandboxPaths {
  const baseDir = path.join(app.getPath('userData'), 'cowork', 'sandbox');
  const ipcDir = path.join(baseDir, 'ipc', sessionId);
  const requestsDir = path.join(ipcDir, 'requests');
  const responsesDir = path.join(ipcDir, 'responses');
  const streamsDir = path.join(ipcDir, 'streams');

  fs.mkdirSync(requestsDir, { recursive: true });
  fs.mkdirSync(responsesDir, { recursive: true });
  fs.mkdirSync(streamsDir, { recursive: true });

  return {
    baseDir,
    ipcDir,
    requestsDir,
    responsesDir,
    streamsDir,
  };
}

export function resolveSandboxCwd(cwd: string): SandboxCwdMapping {
  // On all platforms, mount the host directory to /workspace/project inside the VM
  // This ensures a consistent Linux path inside the Alpine VM
  return {
    hostPath: cwd,
    guestPath: '/workspace/project',
    mountTag: 'work',
  };
}

const SKILL_SYNC_IGNORE = new Set([
  'node_modules', '.git', '__pycache__', 'dist', '.DS_Store', 'Thumbs.db',
  '.server.pid', '.server.log', '.connection',
]);
const SKILL_SYNC_MAX_FILE_SIZE = 1 * 1024 * 1024; // 1 MB

/**
 * Collect skill files for transfer into the sandbox VM.
 * Walks the skills directory, skipping heavy/transient dirs and large files.
 * Returns an array of { path, data } entries with forward-slash relative paths.
 */
export function collectSkillFilesForSandbox(
  skillsRoot: string
): { path: string; data: Buffer }[] {
  const result: { path: string; data: Buffer }[] = [];
  if (!fs.existsSync(skillsRoot)) {
    coworkLog('WARN', 'collectSkillFiles', `Skills root does not exist: ${skillsRoot}`);
    return result;
  }

  coworkLog('INFO', 'collectSkillFiles', `Scanning skills root: ${skillsRoot}`);

  function scan(dir: string, base: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKILL_SYNC_IGNORE.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        scan(fullPath, relPath);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size <= SKILL_SYNC_MAX_FILE_SIZE) {
            result.push({ path: relPath, data: fs.readFileSync(fullPath) });
          } else {
            coworkLog('WARN', 'collectSkillFiles', `Skipping oversized file: ${relPath} (${stat.size} bytes)`);
          }
        } catch { /* skip unreadable files */ }
      }
    }
  }

  scan(skillsRoot, '');
  coworkLog('INFO', 'collectSkillFiles', `Collected ${result.length} files from ${skillsRoot}`, {
    files: result.map(f => f.path).join(', '),
  });
  return result;
}

export function buildSandboxRequest(
  paths: CoworkSandboxPaths,
  input: Record<string, unknown>
): SandboxRequestInfo {
  const requestId = uuidv4();
  const requestPath = path.join(paths.requestsDir, `${requestId}.json`);
  const streamPath = path.join(paths.streamsDir, `${requestId}.log`);
  fs.writeFileSync(requestPath, JSON.stringify(input));
  return { requestId, requestPath, streamPath };
}

function getPreferredAccel(): string | null {
  if (process.env.COWORK_SANDBOX_ACCEL) {
    return process.env.COWORK_SANDBOX_ACCEL;
  }
  if (process.platform === 'darwin') {
    return 'hvf';
  }
  if (process.platform === 'win32') {
    return 'whpx';
  }
  if (process.platform === 'linux') {
    return 'kvm';
  }
  return null;
}

function resolveRuntimeRoot(runtimeBinary: string): string {
  return path.resolve(path.dirname(runtimeBinary), '..');
}

function resolveAarch64Firmware(options: {
  runtime: SandboxRuntimeInfo;
  ipcDir: string;
}): { codePath: string; varsPath: string } | null {
  if (options.runtime.arch !== 'arm64') return null;
  const runtimeRoot = resolveRuntimeRoot(options.runtime.runtimeBinary);
  const codePath = path.join(runtimeRoot, 'share', 'qemu', 'edk2-aarch64-code.fd');
  const varsTemplate = path.join(runtimeRoot, 'share', 'qemu', 'edk2-arm-vars.fd');
  if (!fs.existsSync(codePath) || !fs.existsSync(varsTemplate)) {
    return null;
  }

  const varsPath = path.join(options.ipcDir, 'edk2-vars.fd');
  if (!fs.existsSync(varsPath)) {
    try {
      fs.copyFileSync(varsTemplate, varsPath);
    } catch (error) {
      console.warn('Failed to prepare QEMU vars file:', error);
    }
  }
  return { codePath, varsPath };
}

function buildQemuArgs(options: {
  runtime: SandboxRuntimeInfo;
  ipcDir: string;
  cwdMapping: SandboxCwdMapping;
  extraMounts?: SandboxExtraMount[];
  accelOverride?: string | null;
  ipcPort?: number;
  skillsDir?: string;
  memoryMb?: number;
}): string[] {
  const memoryMb = options.memoryMb
    ?? (process.env.COWORK_SANDBOX_MEMORY ? parseInt(process.env.COWORK_SANDBOX_MEMORY, 10) : null)
    ?? 4096;
  const args: string[] = [
    '-m', String(memoryMb),
    '-smp', '2',
    '-nographic',
    '-snapshot',
  ];

  const accel = options.accelOverride !== undefined
    ? options.accelOverride
    : getPreferredAccel();
  if (accel) {
    const accelArg = accel === 'tcg' ? 'tcg,thread=multi' : accel;
    args.push('-accel', accelArg);
  }

  if (options.runtime.arch === 'arm64') {
    const cpu = accel && accel !== 'tcg' ? 'host' : 'cortex-a57';
    args.push('-machine', 'virt', '-cpu', cpu);

    const kernelPath = options.runtime.kernelPath;
    const initrdPath = options.runtime.initrdPath;
    const hasKernel = Boolean(kernelPath && initrdPath && fs.existsSync(kernelPath) && fs.existsSync(initrdPath));

    if (hasKernel) {
      args.push(
        '-kernel', kernelPath as string,
        '-initrd', initrdPath as string,
        '-append',
        [
          'root=/dev/vda2',
          'rootfstype=ext4',
          'rw',
          'console=ttyAMA0,115200',
          'loglevel=4',
          'init=/sbin/init',
          'quiet',
        ].join(' ')
      );
    } else {
      const firmware = resolveAarch64Firmware(options);
      if (firmware) {
        args.push(
          '-drive', `if=pflash,format=raw,readonly=on,file=${firmware.codePath}`,
          '-drive', `if=pflash,format=raw,file=${firmware.varsPath}`
        );
      }
    }
  }

  args.push(
    '-drive', `file=${options.runtime.imagePath},if=virtio,format=qcow2`,
    '-netdev', 'user,id=net0',
    '-device', 'virtio-net,netdev=net0'
  );

  if (options.runtime.platform === 'win32') {
    // Windows QEMU does not support virtfs (9p filesystem).
    // Use virtio-serial as a bidirectional IPC channel instead.
    if (options.ipcPort) {
      args.push(
        '-device', 'virtio-serial-pci',
        '-chardev', `socket,id=ipc,host=127.0.0.1,port=${options.ipcPort},server=on,wait=off`,
        '-device', 'virtserialport,chardev=ipc,name=ipc.0'
      );
    }
  } else {
    // macOS / Linux: use virtfs (9p) for shared directories
    args.push(
      '-virtfs',
      `local,path=${options.ipcDir},mount_tag=ipc,security_model=none`
    );
    args.push(
      '-virtfs',
      `local,path=${options.cwdMapping.hostPath},mount_tag=${options.cwdMapping.mountTag},security_model=none`
    );
    for (const mount of options.extraMounts ?? []) {
      args.push(
        '-virtfs',
        `local,path=${mount.hostPath},mount_tag=${mount.mountTag},security_model=none`
      );
    }
    const hasExplicitExtraMounts = (options.extraMounts ?? []).length > 0;
    if (!hasExplicitExtraMounts && options.skillsDir && fs.existsSync(options.skillsDir)) {
      args.push(
        '-virtfs',
        `local,path=${options.skillsDir},mount_tag=skills,security_model=none`
      );
    }
  }

  args.push(
    '-serial',
    `file:${path.join(options.ipcDir, 'serial.log')}`
  );

  return args;
}

/**
 * Find a free TCP port on 127.0.0.1 by briefly binding to port 0.
 */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

export function spawnCoworkSandboxVm(options: {
  runtime: SandboxRuntimeInfo;
  ipcDir: string;
  cwdMapping: SandboxCwdMapping;
  extraMounts?: SandboxExtraMount[];
  accelOverride?: string | null;
  launcher?: SandboxLauncherMode;
  ipcPort?: number;
  skillsDir?: string;
  memoryMb?: number;
}): ChildProcessByStdio<null, Readable, Readable> {
  const args = buildQemuArgs(options);

  coworkLog('INFO', 'spawnSandboxVm', 'Spawning QEMU', {
    runtimeBinary: options.runtime.runtimeBinary,
    runtimeExists: fs.existsSync(options.runtime.runtimeBinary),
    imageExists: fs.existsSync(options.runtime.imagePath),
    ipcPort: options.ipcPort ?? null,
    launcher: options.launcher ?? 'direct',
    accelOverride: options.accelOverride ?? null,
    memoryMb: options.memoryMb ?? null,
    args: args.join(' '),
  });

  if (options.launcher === 'launchctl' && process.platform === 'darwin') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid !== null) {
      return spawn('/bin/launchctl', ['asuser', String(uid), options.runtime.runtimeBinary, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
  }
  return spawn(options.runtime.runtimeBinary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

// ---------------------------------------------------------------------------
// VirtioSerialBridge — TCP bridge for Windows virtio-serial IPC
// ---------------------------------------------------------------------------
// QEMU exposes the guest's virtio-serial port as a TCP server.  The bridge
// connects as a TCP client and translates JSON-line messages:
//   Guest → Host: heartbeat, stream, response  → written to local ipcDir files
//   Host → Guest: request, permission_response  → sent over TCP
// This keeps the existing file-polling code (waitForVmReady, readSandboxStream)
// working unchanged on the host side.
// ---------------------------------------------------------------------------

export class VirtioSerialBridge {
  private socket: net.Socket | null = null;
  private buffer = '';
  private ipcDir: string;
  private hostCwd: string | null = null;
  private connected = false;
  // Chunked transfer buffers: transferId -> { chunks, totalChunks, path }
  private pendingTransfers: Map<string, {
    chunks: Map<number, Buffer>;
    totalChunks: number;
    path: string;
  }> = new Map();

  constructor(ipcDir: string, hostCwd?: string) {
    this.ipcDir = ipcDir;
    this.hostCwd = hostCwd ?? null;
  }

  /** Update the host CWD for file sync (e.g. on multi-turn continuation) */
  setHostCwd(hostCwd: string): void {
    this.hostCwd = hostCwd;
  }

  /**
   * Try to connect to QEMU's virtio-serial TCP server with retries.
   * QEMU may need a moment to start listening after spawn.
   */
  async connect(port: number, timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    const retryDelay = 500;
    let attempts = 0;
    let lastError: string | undefined;

    coworkLog('INFO', 'VirtioSerialBridge', `Connecting to QEMU serial on port ${port}`, {
      timeoutMs,
    });

    while (Date.now() - start < timeoutMs) {
      attempts++;
      try {
        await this.tryConnect(port);
        this.connected = true;
        coworkLog('INFO', 'VirtioSerialBridge', `Connected to QEMU serial on port ${port}`, {
          attempts,
          elapsed: Date.now() - start,
        });
        console.log(`[VirtioSerialBridge] Connected to QEMU serial on port ${port}`);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        await new Promise(r => setTimeout(r, retryDelay));
      }
    }

    coworkLog('ERROR', 'VirtioSerialBridge', `Failed to connect to port ${port}`, {
      attempts,
      elapsed: Date.now() - start,
      lastError,
    });
    throw new Error(`[VirtioSerialBridge] Failed to connect to port ${port} within ${timeoutMs}ms`);
  }

  private tryConnect(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
        this.socket = sock;
        this.setupReader(sock);
        resolve();
      });
      sock.on('error', reject);
    });
  }

  private setupReader(sock: net.Socket): void {
    const decoder = new StringDecoder('utf8');

    sock.on('data', (chunk: Buffer) => {
      this.buffer += decoder.write(chunk);
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) this.handleLine(line);
      }
    });
    sock.on('close', () => {
      const tail = decoder.end();
      if (tail) {
        this.buffer += tail;
      }
      const finalLine = this.buffer.trim();
      if (finalLine) {
        this.handleLine(finalLine);
      }
      this.buffer = '';
      this.connected = false;
      console.warn('[VirtioSerialBridge] Connection closed');
    });
    sock.on('error', (err) => {
      console.warn('[VirtioSerialBridge] Socket error:', err.message);
    });
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // skip non-JSON lines (e.g. kernel boot messages)
    }

    const msgType = String(msg.type ?? '');

    if (msgType === 'heartbeat') {
      try {
        fs.writeFileSync(path.join(this.ipcDir, 'heartbeat'), JSON.stringify(msg));
      } catch { /* best effort */ }
      return;
    }

    if (msgType === 'stream') {
      const requestId = String(msg.requestId ?? '');
      const streamLine = String(msg.line ?? '');
      if (requestId && streamLine) {
        const streamPath = path.join(this.ipcDir, 'streams', `${requestId}.log`);
        try {
          fs.appendFileSync(streamPath, streamLine + '\n');
        } catch { /* best effort */ }
      }
      return;
    }

    if (msgType === 'file_sync') {
      this.handleFileSync(msg);
      return;
    }

    if (msgType === 'file_sync_chunk') {
      this.handleFileSyncChunk(msg);
      return;
    }

    if (msgType === 'file_sync_complete') {
      this.handleFileSyncComplete(msg);
      return;
    }
  }

  // -------------------------------------------------------------------------
  // File sync handlers — guest -> host file transfer
  // -------------------------------------------------------------------------

  /**
   * Validate and resolve a guest-relative path to an absolute host path.
   * Returns null if the path is invalid or escapes the host CWD.
   */
  private resolveHostPath(relativePath: string): string | null {
    if (!this.hostCwd) return null;
    if (!relativePath) return null;

    // Normalize forward slashes from guest to platform separators
    const normalized = relativePath.replace(/\//g, path.sep);
    const resolved = path.resolve(this.hostCwd, normalized);

    // Security: ensure resolved path stays within hostCwd
    const resolvedCwd = path.resolve(this.hostCwd);
    if (!resolved.startsWith(resolvedCwd + path.sep) && resolved !== resolvedCwd) {
      console.warn(`[VirtioSerialBridge] Rejected path traversal: ${relativePath}`);
      return null;
    }

    return resolved;
  }

  private handleFileSync(msg: Record<string, unknown>): void {
    const relativePath = String(msg.path ?? '');
    const data = String(msg.data ?? '');

    const hostPath = this.resolveHostPath(relativePath);
    if (!hostPath) return;

    try {
      // Ensure parent directory exists
      fs.mkdirSync(path.dirname(hostPath), { recursive: true });
      // Decode base64 and write
      fs.writeFileSync(hostPath, Buffer.from(data, 'base64'));
      console.log(`[VirtioSerialBridge] File synced: ${relativePath}`);
    } catch (error) {
      console.warn(`[VirtioSerialBridge] File sync error for ${relativePath}:`, error);
    }
  }

  private handleFileSyncChunk(msg: Record<string, unknown>): void {
    const transferId = String(msg.transferId ?? '');
    const relativePath = String(msg.path ?? '');
    const chunkIndex = Number(msg.chunkIndex ?? 0);
    const totalChunks = Number(msg.totalChunks ?? 0);
    const data = String(msg.data ?? '');

    if (!transferId || !relativePath || !data) return;

    // Validate path early
    if (!this.resolveHostPath(relativePath)) return;

    if (!this.pendingTransfers.has(transferId)) {
      this.pendingTransfers.set(transferId, {
        chunks: new Map(),
        totalChunks,
        path: relativePath,
      });
    }

    const transfer = this.pendingTransfers.get(transferId)!;
    transfer.chunks.set(chunkIndex, Buffer.from(data, 'base64'));

    // If all chunks received, assemble and write immediately
    if (transfer.chunks.size === transfer.totalChunks) {
      this.assembleAndWriteChunked(transferId);
    }
  }

  private handleFileSyncComplete(msg: Record<string, unknown>): void {
    const transferId = String(msg.transferId ?? '');
    if (!transferId) return;

    const transfer = this.pendingTransfers.get(transferId);
    if (transfer && transfer.chunks.size === transfer.totalChunks) {
      this.assembleAndWriteChunked(transferId);
    }

    // Clean up incomplete transfers after timeout
    setTimeout(() => {
      if (this.pendingTransfers.has(transferId)) {
        console.warn(`[VirtioSerialBridge] Cleaning up incomplete transfer ${transferId}`);
        this.pendingTransfers.delete(transferId);
      }
    }, 30000);
  }

  private assembleAndWriteChunked(transferId: string): void {
    const transfer = this.pendingTransfers.get(transferId);
    if (!transfer) return;

    const hostPath = this.resolveHostPath(transfer.path);
    if (!hostPath) {
      this.pendingTransfers.delete(transferId);
      return;
    }

    try {
      fs.mkdirSync(path.dirname(hostPath), { recursive: true });

      // Assemble chunks in order
      const buffers: Buffer[] = [];
      for (let i = 0; i < transfer.totalChunks; i++) {
        const chunk = transfer.chunks.get(i);
        if (!chunk) {
          console.warn(`[VirtioSerialBridge] Missing chunk ${i} for transfer ${transferId}`);
          this.pendingTransfers.delete(transferId);
          return;
        }
        buffers.push(chunk);
      }

      fs.writeFileSync(hostPath, Buffer.concat(buffers));
      console.log(`[VirtioSerialBridge] Chunked file synced: ${transfer.path}`);
    } catch (error) {
      console.warn(`[VirtioSerialBridge] Chunked file write error for ${transfer.path}:`, error);
    } finally {
      this.pendingTransfers.delete(transferId);
    }
  }

  /** Send a sandbox request to the guest via serial */
  sendRequest(requestId: string, data: Record<string, unknown>): void {
    this.sendLine({ type: 'request', requestId, data });
  }

  /** Send a permission response to the guest via serial */
  sendPermissionResponse(requestId: string, result: Record<string, unknown>): void {
    this.sendLine({ type: 'permission_response', requestId, result });
  }

  /** Send a host tool response to the guest via serial */
  sendHostToolResponse(requestId: string, payload: Record<string, unknown>): void {
    this.sendLine({
      type: 'host_tool_response',
      requestId,
      ...payload,
    });
  }

  /**
   * Push a file from host to guest via serial.
   * Used to transfer skill files into the sandbox on Windows (where 9p is unavailable).
   */
  pushFile(basePath: string, relativePath: string, data: Buffer): void {
    coworkLog('INFO', 'VirtioSerialBridge', `pushFile: ${relativePath} (${data.length} bytes) -> ${basePath}/${relativePath}`);
    const CHUNK_SIZE = 512 * 1024; // 512 KB per chunk
    // Use forward slashes for cross-platform path consistency
    const syncPath = relativePath.replace(/\\/g, '/');

    if (data.length <= CHUNK_SIZE) {
      this.sendLine({
        type: 'push_file',
        basePath,
        path: syncPath,
        data: data.toString('base64'),
      });
    } else {
      // Chunked transfer for large files
      const transferId = uuidv4();
      const totalChunks = Math.ceil(data.length / CHUNK_SIZE);
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, data.length);
        this.sendLine({
          type: 'push_file_chunk',
          transferId,
          basePath,
          path: syncPath,
          chunkIndex: i,
          totalChunks,
          data: data.subarray(start, end).toString('base64'),
        });
      }
      this.sendLine({
        type: 'push_file_complete',
        transferId,
        basePath,
        path: syncPath,
        totalChunks,
      });
    }
  }

  private sendLine(data: Record<string, unknown>): void {
    if (this.socket && this.connected) {
      this.socket.write(JSON.stringify(data) + '\n');
    } else {
      coworkLog('WARN', 'VirtioSerialBridge', `sendLine dropped (not connected): type=${String(data.type ?? 'unknown')}`);
    }
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
    this.pendingTransfers.clear();
  }
}
