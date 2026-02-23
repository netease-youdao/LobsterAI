type WebBroadcastFn = (channel: string, ...args: unknown[]) => void;

let webBroadcastFn: WebBroadcastFn | null = null;

export const setWebEventBroadcaster = (fn: WebBroadcastFn | null): void => {
  webBroadcastFn = fn;
};

export const broadcastWebEvent = (channel: string, ...args: unknown[]): void => {
  if (!webBroadcastFn) return;
  webBroadcastFn(channel, ...args);
};
