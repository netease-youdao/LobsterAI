// Host-side anchor for `@lobsterai/dsh-embed-shell`.
// Mounting this row allows `@deepseek-ai/dsh-client-modules` to discover and
// serve `./client.js` to DSH web surfaces without touching other `@lobsterai/dsh-bundle`
// host rows.

export const name = 'lobster-embed-shell';

export function apply() {
  // No host-side side effects; all chromeless embed logic runs in `./client.js`
  // and activates only when the browser URL carries `#lobster-embed=1`.
}
