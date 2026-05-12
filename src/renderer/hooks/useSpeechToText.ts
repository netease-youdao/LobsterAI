/**
 * Trigger the OS-level voice dictation.
 *
 * Windows: simulates Win+H via main-process IPC.
 * macOS: simulates Fn+Fn via main-process IPC.
 *
 * The system dictation UI appears and types recognized text
 * directly into the currently focused input element.
 *
 * Returns the result so callers can react to errors (e.g. permission_denied on macOS).
 */
export async function triggerSystemDictation(macDictationShortcut?: string): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await window.electron.voice.triggerDictation(macDictationShortcut);
    if (!result.success) {
      console.warn('[Voice] triggerDictation failed:', result.error);
    }
    return result;
  } catch (err) {
    console.warn('[Voice] triggerDictation error:', err);
    return { success: false, error: 'unknown' };
  }
}
