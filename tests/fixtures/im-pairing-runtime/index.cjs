// Isolated integration fixture. No external IM connection or notification.
module.exports = {
  id: 'im-pairing-fixture',
  register(api) {
    let notifications = 0;
    const pairing = {
      idLabel: 'fixture sender',
      resolveApprovalStoreEntry: request => `fixture-allow:${request.id}`,
      notifyApproval: async () => { notifications++; throw new Error('Unexpected pairing notification'); },
    };
    api.registerChannel({ plugin: {
      id: 'email',
      meta: { id: 'email', label: 'Pairing fixture', selectionLabel: 'Pairing fixture', docsPath: '/fixture', blurb: 'Local test only' },
      capabilities: { chatTypes: ['direct'] },
      config: {
        listAccountIds: () => ['bot-one', 'bot-two'],
        resolveAccount: (_cfg, accountId) => ({ accountId, configured: true, dmPolicy: 'pairing' }),
        isConfigured: () => true,
      },
      pairing,
    } });
    api.registerGatewayMethod('im-pairing-fixture.seed', async ({ params, respond }) => {
      try {
        const result = await api.runtime.channel.pairing.upsertPairingRequest({
          channel: 'email', accountId: params.accountId, id: params.id, pairingAdapter: pairing,
        });
        respond(true, result);
      } catch (error) {
        respond(false, undefined, { code: 'UNAVAILABLE', message: String(error) });
      }
    }, { scope: 'operator.pairing' });
    api.registerGatewayMethod('im-pairing-fixture.allowed', async ({ params, respond }) => {
      try {
        const entries = await api.runtime.channel.pairing.readAllowFromStore({
          channel: 'email', accountId: params.accountId,
        });
        respond(true, { entries, notifications });
      } catch (error) {
        respond(false, undefined, { code: 'UNAVAILABLE', message: String(error) });
      }
    }, { scope: 'operator.pairing' });
  },
};
