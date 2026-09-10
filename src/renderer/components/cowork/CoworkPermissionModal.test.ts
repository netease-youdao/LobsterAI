import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';

import type { ApprovalState } from '../../../shared/cowork/approval';
import type { CoworkPermissionRequest } from '../../types/cowork';
import CoworkPermissionModal from './CoworkPermissionModal';

vi.mock('../../services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

function render(phase: ApprovalState['resolution']['phase'], submissionState?: 'submitting' | 'unknown') {
  const permission: CoworkPermissionRequest = { requestId: 'a', sessionId: 's', toolName: 'Bash', toolInput: { command: 'rm -- draft.md' },
    submissionState, approval: { requestId: 'a', sessionId: 's', runId: 'r', approvalVersion: '2', operationDigest: 'digest',
      title: 'Delete draft?', summary: 'Delete draft.md', expiresAt: '2099-01-01T00:00:00Z', status: 'pending',
      remoteAllowed: phase === 'idle', requiresLocalAction: false, resolvedAt: null,
      resolution: { phase, source: null, confirmedDecision: null, confirmedAt: null } } };
  return renderToStaticMarkup(React.createElement(CoworkPermissionModal, { permission, onRespond: vi.fn() }));
}

test('both actions and the deny-on-close button are locked while another end submits', () => {
  const html = render('submitting');
  expect(html.match(/disabled=""/gu)).toHaveLength(3);
  expect(html).toContain('coworkApprovalSubmitting');
});

test('unknown results remain locked and show reconciliation instead of asking for another decision', () => {
  const html = render('unknown');
  expect(html.match(/disabled=""/gu)).toHaveLength(3);
  expect(html).toContain('coworkApprovalUnknown');
});

test('the immediate local submission overlay prevents a second decision before its first state event', () => {
  const html = render('idle', 'submitting');
  expect(html.match(/disabled=""/gu)).toHaveLength(3);
});

test('an idle desktop approval permits local actions and retains the operation risk warning', () => {
  const html = render('idle');
  expect(html).not.toContain('disabled=""');
  expect(html).toContain('coworkApproveOnce');
  expect(html).toContain('coworkCautionOperation');
});

test('a legacy local plugin that only offers permanent permission is never mislabeled allow once', () => {
  const html = renderToStaticMarkup(React.createElement(CoworkPermissionModal, {
    permission: { requestId: 'local', sessionId: 's', toolName: 'PluginApproval',
      toolInput: { allowedDecisions: ['allow-always', 'deny'] } },
    onRespond: vi.fn(),
  }));
  expect(html).toContain('coworkApproveAlways');
  expect(html).not.toContain('coworkApproveOnce');
});
