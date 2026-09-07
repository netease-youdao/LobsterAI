const DemoView = Object.freeze({
  Public: 'public',
  Code: 'code',
  Closed: 'closed',
});

const validViews = new Set(Object.values(DemoView));
const body = document.body;
const video = document.querySelector('#shared-video');
const sizeLabel = document.querySelector('#video-size');
const accessForm = document.querySelector('#access-form');
const accessCode = document.querySelector('#access-code');
const accessError = document.querySelector('#access-error');
const stateButtons = Array.from(document.querySelectorAll('[data-state]'));
const toast = document.querySelector('#toast');

let toastTimer;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '大小未知';
  }
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('is-visible');
  toastTimer = window.setTimeout(() => {
    toast.classList.remove('is-visible');
  }, 2200);
}

function clearAccessError() {
  accessError.textContent = '';
  accessCode.removeAttribute('aria-invalid');
}

function setView(nextView, options = {}) {
  const view = validViews.has(nextView) ? nextView : DemoView.Public;
  body.dataset.view = view;

  stateButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.state === view));
  });

  if (view !== DemoView.Public) {
    video.pause();
  }

  clearAccessError();
  accessCode.value = '';

  if (view === DemoView.Code && options.focus !== false) {
    window.setTimeout(() => accessCode.focus(), 80);
  }

  const url = new URL(window.location.href);
  url.searchParams.set('state', view);
  window.history.replaceState({ view }, '', url);
}

stateButtons.forEach((button) => {
  button.addEventListener('click', () => {
    setView(button.dataset.state);
  });
});

accessCode.addEventListener('input', () => {
  accessCode.value = accessCode.value.toUpperCase().replace(/\s+/g, '');
  clearAccessError();
});

accessForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = accessCode.value.trim().toUpperCase();

  if (!value) {
    accessError.textContent = '请输入分享码。';
    accessCode.setAttribute('aria-invalid', 'true');
    accessCode.focus();
    return;
  }

  if (value !== 'LOBSTER') {
    accessError.textContent = '分享码错误，请重试。';
    accessCode.setAttribute('aria-invalid', 'true');
    accessCode.select();
    return;
  }

  setView(DemoView.Public, { focus: false });
  showToast('分享码验证成功');
});

document.querySelectorAll('[data-demo-link]').forEach((link) => {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    showToast('正式页面会打开 LobsterAI 官网');
  });
});

fetch('./demo-video.mp4', { method: 'HEAD' })
  .then((response) => {
    const contentLength = Number(response.headers.get('content-length'));
    sizeLabel.textContent = formatBytes(contentLength);
  })
  .catch(() => {
    sizeLabel.textContent = '本地 Demo';
  });

const initialView = new URL(window.location.href).searchParams.get('state');
setView(initialView, { focus: false });
