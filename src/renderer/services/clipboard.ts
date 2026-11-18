const copyTextFallback = (text: string): boolean => {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  return copied;
};

export const copyTextToClipboard = async (text: string): Promise<boolean> => {
  const electronClipboard = window.electron?.clipboard;
  if (electronClipboard?.writeText) {
    try {
      const result = await electronClipboard.writeText(text);
      if (result.success) return true;
      console.warn('[Clipboard] text clipboard IPC failed:', result.error ?? 'Unknown error');
    } catch (error) {
      console.warn('[Clipboard] text clipboard IPC failed:', error);
    }
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      console.warn('[Clipboard] navigator clipboard write failed:', error);
    }
  }

  try {
    return copyTextFallback(text);
  } catch (error) {
    console.error('[Clipboard] fallback clipboard copy failed:', error);
    return false;
  }
};

/**
 * Writes plain text alongside HTML, so rich editors (and LobsterAI's own input)
 * can pick up content such as images that plain text cannot carry. Falls back
 * to copying the text alone.
 */
export const copyTextAndHtmlToClipboard = async (content: { text: string; html: string }): Promise<boolean> => {
  const electronClipboard = window.electron?.clipboard;
  if (electronClipboard?.writeTextAndHtml) {
    try {
      const result = await electronClipboard.writeTextAndHtml(content);
      if (result.success) return true;
      console.warn('[Clipboard] text and HTML clipboard IPC failed:', result.error ?? 'Unknown error');
    } catch (error) {
      console.warn('[Clipboard] text and HTML clipboard IPC failed:', error);
    }
  }

  if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([content.text], { type: 'text/plain' }),
          'text/html': new Blob([content.html], { type: 'text/html' }),
        }),
      ]);
      return true;
    } catch (error) {
      console.warn('[Clipboard] navigator clipboard HTML write failed:', error);
    }
  }

  console.warn('[Clipboard] falling back to a text-only copy.');
  return copyTextToClipboard(content.text);
};
