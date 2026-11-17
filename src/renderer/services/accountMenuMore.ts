import {
  AccountMenuMoreItemKind,
  type AccountMenuMoreLinkItem,
  type AccountMenuMoreState,
} from '@shared/accountMenuMore/constants';

export interface AccountMenuMoreLink {
  kind: typeof AccountMenuMoreItemKind.Link;
  /** Unique across the whole menu; links inside a group are prefixed with the group key. */
  key: string;
  label: string;
  url: string;
}

export interface AccountMenuMoreGroup {
  kind: typeof AccountMenuMoreItemKind.Group;
  key: string;
  label: string;
  links: AccountMenuMoreLink[];
}

export type AccountMenuMoreNode = AccountMenuMoreLink | AccountMenuMoreGroup;

const toLink = (
  item: AccountMenuMoreLinkItem,
  isEnglish: boolean,
  keyPrefix = '',
): AccountMenuMoreLink => ({
  kind: AccountMenuMoreItemKind.Link,
  key: `${keyPrefix}${item.key}`,
  label: isEnglish ? item.labelEn || item.label : item.label,
  url: item.url,
});

export function getAccountMenuMoreNodes(
  state: AccountMenuMoreState | null,
  isEnglish: boolean,
): AccountMenuMoreNode[] {
  return (state?.items ?? []).map(item => (
    item.kind === AccountMenuMoreItemKind.Group
      ? {
        kind: AccountMenuMoreItemKind.Group,
        key: item.key,
        label: isEnglish ? item.labelEn || item.label : item.label,
        links: item.children.map(child => toLink(child, isEnglish, `${item.key}.`)),
      }
      : toLink(item, isEnglish)
  ));
}

type AccountMenuMoreLoader = () => Promise<AccountMenuMoreState | null>;

/**
 * Keeps the last menu so later opens render it at once while a fresh copy
 * loads; concurrent requests share one lookup.
 */
export class AccountMenuMoreStore {
  private cached: AccountMenuMoreState | null = null;
  private loaded = false;
  private inFlight: Promise<AccountMenuMoreState | null> | null = null;

  constructor(private readonly loader: AccountMenuMoreLoader) {}

  getCached(): AccountMenuMoreState | null {
    return this.cached;
  }

  /** False until the first lookup settles, so the submenu can show a loading state instead of "empty". */
  hasLoaded(): boolean {
    return this.loaded;
  }

  load(): Promise<AccountMenuMoreState | null> {
    if (this.inFlight) return this.inFlight;
    const request = this.loader()
      .catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.debug(`[AccountMenuMore] menu unavailable: ${errorMessage}`);
        return null;
      })
      .then(state => {
        this.cached = state;
        this.loaded = true;
        return state;
      })
      .finally(() => {
        if (this.inFlight === request) this.inFlight = null;
      });
    this.inFlight = request;
    return request;
  }

  /** Warms the first open only; every open still refreshes through load(). */
  prefetch(): void {
    if (this.loaded || this.inFlight) return;
    void this.load();
  }
}

export const accountMenuMoreStore = new AccountMenuMoreStore(
  () => window.electron.accountMenuMore.get(),
);
