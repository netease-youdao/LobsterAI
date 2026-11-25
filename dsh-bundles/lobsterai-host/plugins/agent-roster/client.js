// DSH loads browser plugins through its web module loader.
window.__ModuleLoader__.load({
  id: '@lobsterai/dsh-agent-roster',
  factory(require) {
    const { createElement: h, useEffect, useState } = require('react');
    const { IconAgentPresetOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives');

    const PANEL_ID = 'lobsterai-agents';
    const ROSTER_PATH = 'api/lobsterai/agents';
    const LOCALE_NS = 'lobsteraiAgentRoster';
    const messages = {
      zh: {
        title: '我的 Agent',
        refresh: '刷新',
        loading: '正在加载 Agent…',
        loadError: '无法加载 Agent，请刷新重试。',
        empty: '暂无 Agent',
        disabled: '已停用',
      },
      en: {
        title: 'My Agents',
        refresh: 'Refresh',
        loading: 'Loading agents…',
        loadError: 'Could not load agents. Refresh to try again.',
        empty: 'No agents yet',
        disabled: 'Disabled',
      },
    };

    const panelStyle = {
      height: '100%',
      overflowY: 'auto',
      padding: '32px 24px',
      boxSizing: 'border-box',
    };
    const headerStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 16,
    };
    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 16,
      padding: '12px 0',
      borderBottom: '1px solid var(--dsw-alias-border-l3)',
      overflowWrap: 'anywhere',
    };

    function AgentRoster({ t }) {
      const [agents, setAgents] = useState(null);
      const [error, setError] = useState(false);
      const [refreshKey, setRefreshKey] = useState(0);

      useEffect(() => {
        const controller = new AbortController();

        async function load() {
          try {
            const response = await fetch(ROSTER_PATH, { signal: controller.signal });
            if (!response.ok) throw new Error('Agent roster request failed');
            const roster = await response.json();
            if (!controller.signal.aborted) {
              setAgents(roster.agents);
              setError(false);
            }
          } catch {
            if (!controller.signal.aborted) setError(true);
          }
        }

        void load();
        return () => controller.abort();
      }, [refreshKey]);

      let content;
      if (error) {
        content = h('p', { role: 'alert' }, t('loadError'));
      } else if (agents === null) {
        content = h('p', { role: 'status' }, t('loading'));
      } else if (agents.length === 0) {
        content = h('p', null, t('empty'));
      } else {
        content = h('ul', { style: { listStyle: 'none', margin: 0, padding: 0 } },
          agents.map(agent => h('li', { key: agent.id, style: rowStyle },
            h('span', null, agent.name),
            !agent.enabled && h('span', { style: { flexShrink: 0, opacity: 0.7 } }, t('disabled')),
          )));
      }

      return h('section', { 'aria-label': t('title'), style: panelStyle },
        h('div', { style: { maxWidth: 600, margin: '0 auto' } },
          h('header', { style: headerStyle },
            h('h1', { style: { fontSize: 22, margin: '0 0 12px' } }, t('title')),
            h('button', {
              type: 'button',
              onClick: () => setRefreshKey(key => key + 1),
              style: { padding: '6px 12px', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 8 },
            }, t('refresh')),
          ),
          content,
        ),
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(LOCALE_NS, messages), 'LobsterAI agent roster translations');
      const t = ctx.locale.bind(LOCALE_NS);
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: LOCALE_NS,
        inject: () => ({ t }),
      }, AgentRoster));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        label: () => t('title'),
        locale: LOCALE_NS,
      }, ({ size }) => h(IconAgentPresetOutlineRegular, { size })));
    }

    return { inject: ['locale', 'slots'], apply };
  },
});
