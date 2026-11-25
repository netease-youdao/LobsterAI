import { getHostState } from '../shared-state.mjs';

export const AGENT_ROSTER_PATH = '/api/lobsterai/agents';
export const inject = ['connection'];

export function apply(ctx) {
  const state = getHostState(ctx);
  // Connection Fetch routes admit only authenticated owner peers.
  ctx.connection.fetch.register({
    path: AGENT_ROSTER_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const agents = [...state.agents.values()].map(({ id, name, enabled }) => ({ id, name, enabled }));
      return Response.json({ agents }, { headers: { 'Cache-Control': 'no-store' } });
    },
  });
}
