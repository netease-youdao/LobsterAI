import { ipcRenderer } from 'electron';

import { AppQuitDialogIpc } from '../shared/dialog/appQuitConfirmation';

window.addEventListener('DOMContentLoaded', () => {
  const dialog = document.getElementById('quit-dialog');
  if (!dialog) return;

  const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button[data-response]'));
  for (const button of buttons) {
    button.addEventListener('click', () => {
      for (const item of buttons) item.disabled = true;
      ipcRenderer.send(AppQuitDialogIpc.Respond, Number(button.dataset.response));
    });
  }
  dialog.querySelector<HTMLButtonElement>('button[autofocus]')?.focus();

  void document.fonts.ready.then(() => {
    const { width, height } = dialog.getBoundingClientRect();
    ipcRenderer.send(AppQuitDialogIpc.Ready, { width: Math.ceil(width), height: Math.ceil(height) });
  });
});
