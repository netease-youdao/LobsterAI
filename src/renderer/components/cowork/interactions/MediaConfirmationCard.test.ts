import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';

import { ASK_USER_QUESTION_TOOL_NAME } from '../../../../shared/cowork/constants';
import {
  MediaConfirmationPolicy,
  MediaConfirmationStatus,
} from '../../../../shared/media/confirmation';
import MediaConfirmationCard from './MediaConfirmationCard';
import { permissionDockRequest } from './questionDockModel';

vi.mock('../../../services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

test.each([MediaConfirmationStatus.Expired, MediaConfirmationStatus.Refreshing])(
  'expired consent offers renewal instead of generation: %s',
  status => {
    const request = permissionDockRequest({
      sessionId: 'session',
      requestId: 'request',
      toolName: ASK_USER_QUESTION_TOOL_NAME,
      toolInput: {
        mediaConfirmation: {
          kind: MediaConfirmationPolicy.Kind,
          revision: 0,
          sequence: 1,
          status,
          retainedUntil: Date.now() + 10000,
        },
        questions: [
          {
            title: 'Video',
            question: 'Retained scene',
            subtitle: 'Updated price',
            options: [{ label: 'Generate paid video' }],
          },
        ],
      },
    })!;
    const html = renderToStaticMarkup(createElement(MediaConfirmationCard, { request }));
    expect(html).toContain('Retained scene');
    expect(html).toContain('Updated price');
    expect(html).toContain('mediaVideoConfirmRenew');
    expect(html).not.toContain('Generate paid video');
    expect(html).not.toContain('<textarea');
  },
);
