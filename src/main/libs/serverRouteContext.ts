export interface ServerRouteContext {
  readonly apiBaseUrl: string;
  readonly authSessionKey: string;
  readonly routeEpoch: number;
}

/** Observe committed route/account changes, including an otherwise idle A → B → A. */
export class ServerRouteContextTracker {
  private current: ServerRouteContext | null = null;

  /** Display sampling must not resolve endpoints or read account storage. */
  peekEpoch(): number { return this.current?.routeEpoch ?? 0; }

  capture(apiBaseUrl: string, authSessionKey: string): ServerRouteContext {
    if (this.current?.apiBaseUrl !== apiBaseUrl || this.current.authSessionKey !== authSessionKey) {
      this.current = Object.freeze({ apiBaseUrl, authSessionKey, routeEpoch: (this.current?.routeEpoch ?? 0) + 1 });
    }
    return this.current;
  }
}
