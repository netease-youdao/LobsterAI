import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';

import { ConfigDeliveryState } from '../../../shared/openclawEngine/configDelivery';
import { IMConfigSyncNotice } from './IMConfigSyncNotice';

test.each([ConfigDeliveryState.Pending, ConfigDeliveryState.RestartRequired])(
  '%s renders saved-pending feedback as status rather than an error', deliveryState => {
    const html = renderToStaticMarkup(React.createElement(IMConfigSyncNotice, {
      result: { success: true, deliveryState }, message: '设置已保存，正在等待引擎应用。无需重复保存。',
    }));
    expect(html).toContain('role="status"');
    expect(html).toContain('无需重复保存');
    expect(html).not.toContain('role="alert"');
  },
);

test.each([ConfigDeliveryState.Applied, ConfigDeliveryState.Rejected])(
  '%s is not mislabeled as saved pending', deliveryState => {
    expect(renderToStaticMarkup(React.createElement(IMConfigSyncNotice, {
      result: { success: deliveryState === ConfigDeliveryState.Applied, deliveryState }, message: 'pending',
    }))).toBe('');
  },
);
