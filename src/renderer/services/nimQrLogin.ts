export {
  buildQrPayload,
  DEFAULT_NIM_QR_EXPIRES_IN,
  DEFAULT_NIM_QR_POLL_INTERVAL,
  isPendingBindResult,
  NimQrLoginErrorCode,
  NimQrLoginStatus,
  normalizeBindResult,
} from '../../shared/im/nimQrLogin';

export async function startQrLogin() {
  return window.electron.im.nimQrLoginStart();
}

export async function pollQrLogin(uuid: string) {
  return window.electron.im.nimQrLoginPoll(uuid);
}
