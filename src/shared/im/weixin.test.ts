import { describe, expect, test } from 'vitest';

import { PlatformRegistry } from '../platform';
import {
  isWeixinChannel,
  isWeixinContextRejected,
  parseWeixinDeliveryRet,
  WeixinDeliveryError,
  WeixinPlugin,
} from './weixin';

describe('Weixin delivery error codes', () => {
  test('extracts the ret code from sanitized delivery errors', () => {
    expect(parseWeixinDeliveryRet(`${WeixinDeliveryError.Rejected} ret=-2 errcode=0`)).toBe(-2);
    expect(parseWeixinDeliveryRet(`${WeixinDeliveryError.AccountExpired} ret=0 errcode=-14`)).toBe(0);
    expect(parseWeixinDeliveryRet(WeixinDeliveryError.Unknown)).toBeNull();
  });

  test('treats only a ret=-2 rejection as an expired conversation context', () => {
    expect(isWeixinContextRejected(`${WeixinDeliveryError.Rejected} ret=-2 errcode=0`)).toBe(true);
    expect(isWeixinContextRejected(`${WeixinDeliveryError.Rejected} ret=-3 errcode=0`)).toBe(false);
    expect(isWeixinContextRejected(`${WeixinDeliveryError.HttpError} status=502`)).toBe(false);
    expect(isWeixinContextRejected(`${WeixinDeliveryError.ContextExpired} ret=-2 errcode=0`)).toBe(false);
  });
});

describe('isWeixinChannel', () => {
  test('matches the plugin channel id and its platform id only', () => {
    expect(isWeixinChannel(WeixinPlugin.Id)).toBe(true);
    expect(isWeixinChannel(PlatformRegistry.platformOfChannel(WeixinPlugin.Id))).toBe(true);
    expect(isWeixinChannel('wecom')).toBe(false);
    expect(isWeixinChannel('none')).toBe(false);
    expect(isWeixinChannel(undefined)).toBe(false);
  });
});
