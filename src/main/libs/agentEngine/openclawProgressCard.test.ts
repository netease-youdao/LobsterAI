import { expect, test, vi } from 'vitest';

import { ProgressCardGatewayMethod, ProgressCardStepStatus } from '../../../shared/cowork/progressCard';
import { OpenClawProgressCards } from './openclawProgressCard';

const card = {
  sessionKey: 'agent:main:lobsterai:one',
  revision: 2,
  updatedAt: 100,
  steps: [{ step: 'Check', status: ProgressCardStepStatus.InProgress }],
};

const setup = () => {
  const request = vi.fn().mockResolvedValue({ card });
  let client = { request };
  let sessionKey = card.sessionKey;
  const changed = vi.fn();
  const cards = new OpenClawProgressCards({
    client: () => client,
    sessionKey: () => sessionKey,
    changed,
  });
  return {
    cards,
    request,
    changed,
    reconnect: () => {
      client = { request: vi.fn().mockResolvedValue({ card }) };
      cards.reconnected();
    },
    switchKey: () => {
      sessionKey = 'agent:main:lobsterai:two';
    },
  };
};

test('reads the saved card and forwards only changes to watched sessions', async () => {
  const { cards, request, changed } = setup();
  expect(await cards.get('local')).toEqual(card);
  expect(request).toHaveBeenCalledWith(ProgressCardGatewayMethod.Get, { sessionKey: card.sessionKey });

  cards.changed({ sessionKey: 'agent:main:lobsterai:other', revision: 3 });
  expect(changed).not.toHaveBeenCalled();
  cards.changed({ sessionKey: card.sessionKey.toUpperCase(), revision: null });
  expect(changed).toHaveBeenCalledWith('local');
});

test('every watching session rereads after a reconnect', async () => {
  const { cards, changed, reconnect } = setup();
  await cards.get('local');
  reconnect();
  expect(changed).toHaveBeenCalledWith('local');
});

test.each(['reconnect', 'switchKey'] as const)('a reply that crossed a %s is dropped', async (action) => {
  const harness = setup();
  let resolve!: (value: unknown) => void;
  harness.request.mockImplementationOnce(() => new Promise((next) => { resolve = next; }));
  const pending = harness.cards.get('local');
  harness[action]();
  resolve({ card });
  await expect(pending).rejects.toThrow('changed');
});

test('clears with the revision on screen, even an unfinished card', async () => {
  const { cards, request } = setup();
  request.mockResolvedValueOnce({ card }).mockResolvedValueOnce({ card: null });
  expect(await cards.dismiss('local', 2)).toBeNull();
  expect(request).toHaveBeenLastCalledWith(ProgressCardGatewayMethod.Put, {
    sessionKey: card.sessionKey,
    expectedRevision: 2,
  });
});

test('a card the agent rewrote meanwhile survives the close and comes back', async () => {
  const { cards, request } = setup();
  const rewritten = { ...card, revision: 3 };
  request.mockResolvedValueOnce({ card: rewritten });
  expect(await cards.dismiss('local', 2)).toEqual(rewritten);
  expect(request).toHaveBeenCalledTimes(1);
});

test('rejects invalid revisions and cards of another session', async () => {
  const { cards, request } = setup();
  await expect(cards.dismiss('local', 0)).rejects.toThrow();
  request.mockResolvedValueOnce({ card: { ...card, sessionKey: 'agent:main:lobsterai:other' } });
  await expect(cards.get('local')).rejects.toThrow();
});
