import { HtmlShareAccessMode, HtmlShareStatus } from '@shared/htmlShare/constants';
import { describe, expect, test } from 'vitest';

import {
  ArtifactFileShareCopyUnavailableReason,
  buildArtifactFileShareCopyText,
} from './artifactFileShareCopy';

const labels = {
  link: '链接',
  shareCode: '分享码',
};

describe('buildArtifactFileShareCopyText', () => {
  test('formats code access with the localized labels', () => {
    expect(
      buildArtifactFileShareCopyText({
        accessMode: HtmlShareAccessMode.Code,
        labels,
        shareCode: 'ABCD',
        url: 'https://share.example/s/123',
      }),
    ).toEqual({
      copyable: true,
      text: '链接: https://share.example/s/123\n分享码: ABCD',
    });
  });

  test('returns only the raw URL for public access', () => {
    expect(
      buildArtifactFileShareCopyText({
        accessMode: HtmlShareAccessMode.Public,
        labels,
        shareCode: 'IGNORED',
        url: 'https://share.example/s/123',
      }),
    ).toEqual({
      copyable: true,
      text: 'https://share.example/s/123',
    });
  });

  test.each([
    {
      accessMode: HtmlShareAccessMode.Code,
      expectedText: '链接: https://share.example/s/123\n分享码: ABCD',
      shareCode: 'ABCD',
    },
    {
      accessMode: HtmlShareAccessMode.Public,
      expectedText: 'https://share.example/s/123',
      shareCode: undefined,
    },
  ])(
    'keeps $accessMode copy formatting while the share is disabled',
    ({ accessMode, expectedText, shareCode }) => {
      expect(
        buildArtifactFileShareCopyText({
          accessMode,
          labels,
          shareCode,
          status: HtmlShareStatus.Disabled,
          url: 'https://share.example/s/123',
        }),
      ).toEqual({
        copyable: true,
        text: expectedText,
      });
    },
  );

  test.each([undefined, null, '', '   '])('rejects a missing URL (%s)', url => {
    expect(
      buildArtifactFileShareCopyText({
        accessMode: HtmlShareAccessMode.Public,
        labels,
        url,
      }),
    ).toEqual({
      copyable: false,
      reason: ArtifactFileShareCopyUnavailableReason.MissingUrl,
      text: null,
    });
  });

  test.each([undefined, null, '', '   '])(
    'rejects a missing share code for code access (%s)',
    shareCode => {
      expect(
        buildArtifactFileShareCopyText({
          accessMode: HtmlShareAccessMode.Code,
          labels,
          shareCode,
          url: 'https://share.example/s/123',
        }),
      ).toEqual({
        copyable: false,
        reason: ArtifactFileShareCopyUnavailableReason.MissingShareCode,
        text: null,
      });
    },
  );

  test('trims URL and share code whitespace', () => {
    expect(
      buildArtifactFileShareCopyText({
        accessMode: HtmlShareAccessMode.Code,
        labels,
        shareCode: '  ABCD  ',
        url: '  https://share.example/s/123  ',
      }),
    ).toEqual({
      copyable: true,
      text: '链接: https://share.example/s/123\n分享码: ABCD',
    });
  });
});
