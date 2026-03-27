import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const VIEWPORT = {
  width: 900,
  height: 1200,
  deviceScaleFactor: 2,
};

const here = path.dirname(fileURLToPath(import.meta.url));
const inputHtml = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.join(here, "index.html");
const outputImage = process.argv[3]
  ? path.resolve(process.cwd(), process.argv[3])
  : path.join(here, "briefing-clip.png");

function findBrowserPath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "No local browser found. Set CHROME_PATH to a Chrome/Chromium/Edge executable.",
  );
}

async function waitForDevToolsEndpoint(userDataDir, timeoutMs = 15000) {
  const activePortPath = path.join(userDataDir, "DevToolsActivePort");
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(activePortPath)) {
      const [port, wsPath] = fs.readFileSync(activePortPath, "utf8").trim().split("\n");
      if (port && wsPath) {
        return `ws://127.0.0.1:${port}${wsPath}`;
      }
    }
    await delay(100);
  }

  throw new Error("Timed out waiting for the local browser DevTools endpoint.");
}

class CDPConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);

      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message || "CDP request failed."));
        } else {
          pending.resolve(message.result || {});
        }
        return;
      }

      this.listeners = this.listeners.filter((listener) => {
        const methodMatches = listener.method === message.method;
        const sessionMatches = listener.sessionId === undefined || listener.sessionId === message.sessionId;
        const predicateMatches = !listener.predicate || listener.predicate(message);

        if (!methodMatches || !sessionMatches || !predicateMatches) {
          return true;
        }

        clearTimeout(listener.timeoutId);
        listener.resolve(message);
        return false;
      });
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return new CDPConnection(ws);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  waitForEvent(method, { sessionId, timeoutMs = 15000, predicate } = {}) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.listeners = this.listeners.filter((listener) => listener !== entry);
        reject(new Error(`Timed out waiting for CDP event ${method}.`));
      }, timeoutMs);

      const entry = {
        method,
        sessionId,
        predicate,
        resolve,
        timeoutId,
      };

      this.listeners.push(entry);
    });
  }

  async close() {
    for (const [id, pending] of this.pending) {
      pending.reject(new Error(`CDP connection closed before request ${id} completed.`));
    }
    this.pending.clear();
    this.listeners.forEach((listener) => clearTimeout(listener.timeoutId));
    this.listeners = [];

    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
      await new Promise((resolve) => {
        this.ws.addEventListener("close", resolve, { once: true });
      });
    }
  }
}

function launchBrowser(browserPath, userDataDir) {
  const stderr = [];
  const processHandle = spawn(
    browserPath,
    [
      "--headless",
      "--disable-gpu",
      "--hide-scrollbars",
      "--mute-audio",
      "--allow-file-access-from-files",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      "about:blank",
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  processHandle.stderr.on("data", (chunk) => {
    stderr.push(String(chunk));
  });

  return {
    process: processHandle,
    getStderr: () => stderr.join(""),
  };
}

async function cleanupBrowser(handle, userDataDir) {
  if (handle && handle.process && !handle.process.killed) {
    handle.process.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => handle.process.once("exit", resolve)),
      delay(1500),
    ]);
    if (!handle.process.killed) {
      handle.process.kill("SIGKILL");
    }
  }

  fs.rmSync(userDataDir, { recursive: true, force: true });
}

async function main() {
  const browserPath = findBrowserPath();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "briefing-clip-browser-"));
  const browserHandle = launchBrowser(browserPath, userDataDir);
  let connection;
  let targetId;
  let sessionId;

  try {
    const wsUrl = await waitForDevToolsEndpoint(userDataDir);
    connection = await CDPConnection.connect(wsUrl);

    const target = await connection.send("Target.createTarget", {
      url: "about:blank",
    });
    targetId = target.targetId;

    const attached = await connection.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    sessionId = attached.sessionId;

    await connection.send("Page.enable", {}, sessionId);
    await connection.send("Runtime.enable", {}, sessionId);
    await connection.send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: VIEWPORT.deviceScaleFactor,
      mobile: false,
      screenWidth: VIEWPORT.width,
      screenHeight: VIEWPORT.height,
    }, sessionId);

    await Promise.all([
      connection.waitForEvent("Page.loadEventFired", { sessionId }),
      connection.send("Page.navigate", { url: `file://${inputHtml}` }, sessionId),
    ]);

    await connection.send("Runtime.evaluate", {
      expression: `
        new Promise(async (resolve) => {
          if (document.fonts && document.fonts.ready) {
            await document.fonts.ready;
          }
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
          resolve(true);
        })
      `,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);

    const metrics = await connection.send("Page.getLayoutMetrics", {}, sessionId);
    const contentSize = metrics.cssContentSize || { width: VIEWPORT.width, height: VIEWPORT.height };
    const width = Math.max(Math.ceil(contentSize.width), VIEWPORT.width);
    const height = Math.max(Math.ceil(contentSize.height), VIEWPORT.height);

    const screenshot = await connection.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width,
        height,
        scale: 1,
      },
    }, sessionId);

    fs.writeFileSync(outputImage, Buffer.from(screenshot.data, "base64"));
    console.log(`[OK] Saved screenshot to ${outputImage}`);
  } catch (error) {
    const stderr = browserHandle.getStderr().trim();
    if (stderr) {
      error.message += `\n\nBrowser stderr:\n${stderr}`;
    }
    throw error;
  } finally {
    if (connection && targetId) {
      try {
        await connection.send("Target.closeTarget", { targetId });
      } catch {}
    }
    if (connection) {
      await connection.close();
    }
    await cleanupBrowser(browserHandle, userDataDir);
  }
}

await main();
