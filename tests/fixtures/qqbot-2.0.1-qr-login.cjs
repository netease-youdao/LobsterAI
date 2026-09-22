// Published @tencent-connect/openclaw-qqbot 2.0.1 QR lifecycle, extracted verbatim.
var pendingSessions = /* @__PURE__ */ new Map();
function startQrLogin(accountId, source = "openclaw") {
  const key = accountId ?? "default";
  pendingSessions.get(key)?.dispose();
  pendingSessions.delete(key);
  return new Promise((resolve2) => {
    let credentialsResolve;
    let credentialsReject;
    const credentialsPromise = new Promise((res, rej) => {
      credentialsResolve = res;
      credentialsReject = rej;
    });
    const dispose = l2(
      {
        onQrDisplayed(url) {
          resolve2({
            qrDataUrl: url,
            message: "\u8BF7\u4F7F\u7528\u624B\u673A QQ \u626B\u63CF\u4E8C\u7EF4\u7801\u5B8C\u6210\u7ED1\u5B9A"
          });
        },
        onSuccess: (creds) => credentialsResolve(creds),
        onFailure: (err) => credentialsReject(err)
      },
      { displayQrCodeToConsole: true, source }
    );
    pendingSessions.set(key, { dispose, credentialsPromise });
  });
}
async function waitQrLogin(accountId) {
  const key = accountId ?? "default";
  const session = pendingSessions.get(key);
  if (!session) {
    return { connected: false, message: "\u6CA1\u6709\u6B63\u5728\u8FDB\u884C\u7684\u767B\u5F55\u4F1A\u8BDD\uFF0C\u8BF7\u5148\u8FD0\u884C login \u547D\u4EE4\u3002" };
  }
  try {
    const credentials = await session.credentialsPromise;
    pendingSessions.delete(key);
    if (credentials.length === 0) {
      return { connected: false, message: "\u672A\u83B7\u53D6\u5230 QQ Bot \u51ED\u636E\u3002" };
    }
    return {
      connected: true,
      message: `\u7ED1\u5B9A\u6210\u529F\uFF01AppID: ${credentials.map((c) => c.appId).join(", ")}`,
      credentials
    };
  } catch (err) {
    pendingSessions.delete(key);
    return {
      connected: false,
      message: `\u7ED1\u5B9A\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}
function parseChannelInput(channelInput) {
  if (!channelInput) return null;
  const parts = channelInput.trim().split(":");
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { appId: parts[0], clientSecret: parts[1] };
  }
  return null;
}
