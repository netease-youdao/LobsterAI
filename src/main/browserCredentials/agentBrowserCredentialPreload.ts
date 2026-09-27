import '../browserPasskeys/passkeyPreload';

import { ipcRenderer } from 'electron';

import {
  BrowserCredentialGuestChannel,
  type BrowserCredentialGuestCommand,
  BrowserCredentialGuestCommandType,
  type BrowserCredentialGuestResult,
  BrowserCredentialGuestResultKind,
} from './credentialLoginProtocol';

const visibleInput = (input: HTMLInputElement): boolean => {
  if (input.disabled || input.readOnly) return false;
  const style = window.getComputedStyle(input);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = input.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};

const allInputs = (): HTMLInputElement[] => Array.from(document.querySelectorAll('input'))
  .filter((element): element is HTMLInputElement => element instanceof HTMLInputElement)
  .filter(visibleInput);

const fieldText = (input: HTMLInputElement): string => [
  input.type,
  input.name,
  input.id,
  input.autocomplete,
  input.placeholder,
  input.getAttribute('aria-label') ?? '',
].join(' ').toLowerCase();

const findPasswordInput = (inputs: HTMLInputElement[]): HTMLInputElement | undefined => (
  inputs.find(input => input.type.toLowerCase() === 'password')
);

const usernameScore = (input: HTMLInputElement): number => {
  const type = input.type.toLowerCase();
  if (!['text', 'email', 'tel', ''].includes(type)) return Number.NEGATIVE_INFINITY;
  const text = fieldText(input);
  let score = 0;
  if (input.autocomplete === 'username') score += 100;
  if (type === 'email') score += 50;
  if (/user|email|account|login|phone|mobile|用户名|邮箱|账号|手机号/.test(text)) score += 30;
  if (/search|query|coupon|promo|验证码|verification|captcha|otp/.test(text)) score -= 100;
  return score;
};

const findUsernameInput = (inputs: HTMLInputElement[]): HTMLInputElement | undefined => (
  inputs
    .map(input => ({ input, score: usernameScore(input) }))
    .filter(item => Number.isFinite(item.score) && item.score >= 0)
    .sort((left, right) => right.score - left.score)[0]?.input
);

const hasMfaInput = (inputs: HTMLInputElement[]): boolean => inputs.some(input => {
  const text = fieldText(input);
  return input.autocomplete === 'one-time-code'
    || /\botp\b|one.?time|two.?factor|2fa|verification.?code|authenticator|动态码|验证码/.test(text);
});

const hasCaptcha = (): boolean => Boolean(document.querySelector([
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  '[class*="recaptcha"]',
  '[class*="hcaptcha"]',
  '[id*="recaptcha"]',
  '[id*="hcaptcha"]',
].join(',')));

const inspect = (): BrowserCredentialGuestResultKind => {
  if (hasCaptcha()) return BrowserCredentialGuestResultKind.Captcha;
  const inputs = allInputs();
  if (findPasswordInput(inputs)) return BrowserCredentialGuestResultKind.PasswordForm;
  if (hasMfaInput(inputs)) return BrowserCredentialGuestResultKind.MfaForm;
  if (findUsernameInput(inputs)) return BrowserCredentialGuestResultKind.UsernameForm;
  return BrowserCredentialGuestResultKind.NoLoginForm;
};

const setInputValue = (input: HTMLInputElement, value: string): void => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
};

const isSubmitButton = (element: Element): element is HTMLButtonElement | HTMLInputElement => {
  if (element instanceof HTMLButtonElement) return element.type !== 'reset';
  return element instanceof HTMLInputElement && ['submit', 'button'].includes(element.type);
};

const clickBestSubmit = (input: HTMLInputElement): boolean => {
  const form = input.form;
  const candidates = Array.from((form ?? document).querySelectorAll('button, input[type="submit"]'))
    .filter(isSubmitButton)
    .filter(element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return !element.disabled
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    });
  const preferred = candidates.find(element => /sign.?in|log.?in|continue|next|submit|登录|继续|下一步|确认/i.test(
    element instanceof HTMLInputElement
      ? element.value
      : `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''}`,
  ));
  const button = preferred ?? candidates[0];
  if (button) {
    button.click();
    return true;
  }
  if (form) {
    form.requestSubmit();
    return true;
  }
  return false;
};

const fillAndSubmit = (username: string, password: string): BrowserCredentialGuestResultKind => {
  if (hasCaptcha()) return BrowserCredentialGuestResultKind.Captcha;
  const inputs = allInputs();
  const passwordInput = findPasswordInput(inputs);
  const usernameInput = findUsernameInput(inputs);

  if (passwordInput) {
    if (usernameInput) setInputValue(usernameInput, username);
    setInputValue(passwordInput, password);
    passwordInput.focus();
    return clickBestSubmit(passwordInput)
      ? BrowserCredentialGuestResultKind.SubmittedPassword
      : BrowserCredentialGuestResultKind.Failed;
  }
  if (hasMfaInput(inputs)) return BrowserCredentialGuestResultKind.MfaForm;
  if (usernameInput) {
    setInputValue(usernameInput, username);
    usernameInput.focus();
    return clickBestSubmit(usernameInput)
      ? BrowserCredentialGuestResultKind.SubmittedUsername
      : BrowserCredentialGuestResultKind.Failed;
  }
  return BrowserCredentialGuestResultKind.NoLoginForm;
};

const clearPasswordFields = (): void => {
  for (const input of allInputs()) {
    if (input.type.toLowerCase() === 'password') setInputValue(input, '');
  }
};

ipcRenderer.on(
  BrowserCredentialGuestChannel.Command,
  (_event, command: BrowserCredentialGuestCommand) => {
    let result: BrowserCredentialGuestResult;
    try {
      let kind: BrowserCredentialGuestResultKind;
      if (command.type === BrowserCredentialGuestCommandType.Inspect) {
        kind = inspect();
      } else if (command.type === BrowserCredentialGuestCommandType.FillAndSubmit) {
        kind = fillAndSubmit(command.username ?? '', command.password ?? '');
      } else {
        clearPasswordFields();
        kind = BrowserCredentialGuestResultKind.Cleared;
      }
      result = { requestId: command.requestId, kind, url: location.href };
    } catch (error) {
      result = {
        requestId: command.requestId,
        kind: BrowserCredentialGuestResultKind.Failed,
        url: location.href,
        message: error instanceof Error ? error.message : 'Failed to inspect the login page.',
      };
    }
    ipcRenderer.send(BrowserCredentialGuestChannel.Result, result);
  },
);
