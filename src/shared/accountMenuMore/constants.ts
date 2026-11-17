export const AccountMenuMoreIpc = {
  Get: 'account-menu-more:get',
} as const;

export const AccountMenuMoreApi = {
  Get: '/api/client-menu/account-more',
} as const;

export const AccountMenuMoreItemKind = {
  Link: 'link',
  Group: 'group',
} as const;

export type AccountMenuMoreItemKind = typeof AccountMenuMoreItemKind[keyof typeof AccountMenuMoreItemKind];

export interface AccountMenuMoreLinkItem {
  kind: 'link';
  key: string;
  label: string;
  labelEn: string;
  /** Always an https URL; main drops anything else before it reaches the renderer. */
  url: string;
}

/** Opens a further submenu; groups are only allowed at the top level. */
export interface AccountMenuMoreGroupItem {
  kind: 'group';
  key: string;
  label: string;
  labelEn: string;
  children: AccountMenuMoreLinkItem[];
}

export type AccountMenuMoreItem = AccountMenuMoreLinkItem | AccountMenuMoreGroupItem;

export interface AccountMenuMoreState {
  items: AccountMenuMoreItem[];
}

export interface AccountMenuMoreBridge {
  /** Null when the server is unreachable, older than this feature, or has no links configured. */
  get: () => Promise<AccountMenuMoreState | null>;
}
