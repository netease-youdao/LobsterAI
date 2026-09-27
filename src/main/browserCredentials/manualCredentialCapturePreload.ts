import '../browserPasskeys/passkeyPreload';

import { ipcRenderer } from 'electron';

import {
  ManualCredentialCaptureChannel,
  ManualCredentialCaptureEventType,
  ManualCredentialFormKind,
  type ManualCredentialPageStateEvent,
  type ManualCredentialSubmittedEvent,
} from './manualCredentialCaptureProtocol';

const USERNAME_HINT_PATTERN = /(?:user(?:name)?|login|email|mail|account|identifier|userid|user-id)/i;
const RECENT_CAPTURE_WINDOW_MS = 1_500;
const PAGE_STATE_DEBOUNCE_MS = 150;

const recentForms = new WeakMap<HTMLFormElement, number>();
let pageStateTimer: ReturnType<typeof setTimeout> | undefined;
let lastPasswordFieldState: boolean | undefined;

const isTextLikeInput = (input: HTMLInputElement): boolean => {
  const type = input.type.toLowerCase();
  return type === 'text' || type === 'email' || type === 'tel' || type === '';
};

const findUsername = (
  form: HTMLFormElement,
  passwordInput: HTMLInputElement,
): string => {
  const candidates = Array.from(form.querySelectorAll<HTMLInputElement>('input'))
    .filter(input => !input.disabled && !input.readOnly && isTextLikeInput(input));
  const beforePassword = candidates.filter(input => (
    input.compareDocumentPosition(passwordInput) & Node.DOCUMENT_POSITION_FOLLOWING
  ) !== 0);
  const pool = beforePassword.length > 0 ? beforePassword : candidates;
  const preferred = pool.find(input => /(?:^|\s)(?:username|email)(?:\s|$)/i.test(input.autocomplete))
    ?? pool.find(input => input.type.toLowerCase() === 'email')
    ?? pool.find(input => USERNAME_HINT_PATTERN.test([
      input.name,
      input.id,
      input.placeholder,
      input.getAttribute('aria-label') ?? '',
    ].join(' ')))
    ?? pool.at(-1);
  return preferred?.value.trim() ?? '';
};

const captureForm = (form: HTMLFormElement | null): void => {
  if (!form) return;
  const now = Date.now();
  const lastCapturedAt = recentForms.get(form) ?? 0;
  if (now - lastCapturedAt < RECENT_CAPTURE_WINDOW_MS) return;

  const passwordInputs = Array.from(form.querySelectorAll<HTMLInputElement>('input[type="password"]'))
    .filter(input => !input.disabled && !input.readOnly && input.value.length > 0);
  if (passwordInputs.length === 0) return;

  const passwords = passwordInputs.map(input => input.value);
  const password = passwords[0];
  if (!password || (passwords.length > 1 && passwords.some(value => value !== password))) {
    return;
  }

  const username = findUsername(form, passwordInputs[0]);
  if (!username) return;

  recentForms.set(form, now);
  const event: ManualCredentialSubmittedEvent = {
    type: ManualCredentialCaptureEventType.Submitted,
    username,
    password,
    formKind: passwordInputs.length > 1
      ? ManualCredentialFormKind.Registration
      : ManualCredentialFormKind.Login,
  };
  ipcRenderer.send(ManualCredentialCaptureChannel.Event, event);
};

const isVisiblePasswordInput = (input: HTMLInputElement): boolean => {
  if (input.disabled || input.hidden || input.getAttribute('aria-hidden') === 'true') return false;
  const style = window.getComputedStyle(input);
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && style.opacity !== '0'
    && input.getClientRects().length > 0;
};

const hasPasswordField = (): boolean => Array.from(
  document.querySelectorAll<HTMLInputElement>('input[type="password"]'),
).some(isVisiblePasswordInput);

const emitPageState = (): void => {
  pageStateTimer = undefined;
  const current = hasPasswordField();
  if (current === lastPasswordFieldState) return;
  lastPasswordFieldState = current;
  const event: ManualCredentialPageStateEvent = {
    type: ManualCredentialCaptureEventType.PageState,
    hasPasswordField: current,
  };
  ipcRenderer.send(ManualCredentialCaptureChannel.Event, event);
};

const schedulePageState = (): void => {
  if (pageStateTimer) clearTimeout(pageStateTimer);
  pageStateTimer = setTimeout(emitPageState, PAGE_STATE_DEBOUNCE_MS);
};

window.addEventListener('submit', event => {
  captureForm(event.target instanceof HTMLFormElement ? event.target : null);
}, true);

window.addEventListener('click', event => {
  const target = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement | HTMLInputElement>('button, input')
    : null;
  if (!target) return;
  const type = target instanceof HTMLButtonElement
    ? (target.getAttribute('type') ?? 'submit').toLowerCase()
    : target.type.toLowerCase();
  if (type === 'submit' || type === 'image') captureForm(target.form);
}, true);

window.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  const target = event.target;
  captureForm(target instanceof HTMLInputElement ? target.form : null);
}, true);

const startPageStateObserver = (): void => {
  schedulePageState();
  const observer = new MutationObserver(schedulePageState);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['type', 'disabled', 'hidden', 'aria-hidden', 'class', 'style'],
  });
};

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', startPageStateObserver, { once: true });
} else {
  startPageStateObserver();
}
window.addEventListener('pageshow', schedulePageState);
