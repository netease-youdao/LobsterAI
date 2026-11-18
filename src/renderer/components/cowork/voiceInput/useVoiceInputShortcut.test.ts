import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { defaultConfig, ShortcutAction } from '../../../config';
import { configService } from '../../../services/config';
import { createVoiceInputShortcutHandler } from './useVoiceInputShortcut';

vi.mock('../../../services/config', () => ({ configService: { getConfig: vi.fn() } }));

class TestElement {
  isConnected = true;
  isContentEditable = false;
  hidden = false;
  shortcutRecorder = false;
  editor = false;
  getClientRects() { return this.hidden ? [] : [{}]; }
  closest() { return this.shortcutRecorder ? this : null; }
  matches() { return this.editor; }
}

const makeEvent = (overrides: Partial<KeyboardEvent> = {}) => ({
  key: 'v', code: 'KeyV', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false,
  repeat: false, isComposing: false, defaultPrevented: false,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  ...overrides,
}) as unknown as KeyboardEvent;

describe('voice input shortcut', () => {
  let textarea: TestElement;
  let documentState: { activeElement: TestElement; querySelector: ReturnType<typeof vi.fn> };
  const onToggle = vi.fn();
  const shortcuts = { ...defaultConfig.shortcuts! };
  const makeHandler = (overrides: Partial<Parameters<typeof createVoiceInputShortcutHandler>[0]> = {}) => (
    createVoiceInputShortcutHandler({
      textareaRef: { current: textarea as unknown as HTMLTextAreaElement },
      disabled: false, isRecording: false, isRecognizing: false, onToggle,
      ...overrides,
    })
  );

  beforeEach(() => {
    onToggle.mockClear();
    textarea = new TestElement();
    documentState = { activeElement: textarea, querySelector: vi.fn().mockReturnValue(null) };
    vi.stubGlobal('HTMLElement', TestElement);
    vi.stubGlobal('document', documentState);
    shortcuts[ShortcutAction.VoiceInput] = 'Ctrl+Shift+V';
    vi.mocked(configService.getConfig).mockReturnValue({ ...defaultConfig, shortcuts });
  });

  afterEach(() => vi.unstubAllGlobals());

  test('starts through the same toggle callback and consumes the key', () => {
    const event = makeEvent();
    makeHandler()(event);
    expect(onToggle).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  test('can stop recording after the textarea loses focus and becomes disabled', () => {
    documentState.activeElement = new TestElement();
    makeHandler({ disabled: true, isRecording: true })(makeEvent());
    expect(onToggle).toHaveBeenCalledOnce();
  });

  test('picks up rebinding and clearing without remounting the input', () => {
    const handler = makeHandler();
    shortcuts[ShortcutAction.VoiceInput] = 'Ctrl+Shift+R';
    handler(makeEvent());
    expect(onToggle).not.toHaveBeenCalled();
    handler(makeEvent({ key: 'r', code: 'KeyR' }));
    expect(onToggle).toHaveBeenCalledOnce();
    shortcuts[ShortcutAction.VoiceInput] = '';
    handler(makeEvent({ key: 'r', code: 'KeyR' }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  test.each([
    { repeat: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true },
  ])('ignores repeated, composing or handled events: %j', event => {
    makeHandler()(makeEvent(event));
    expect(onToggle).not.toHaveBeenCalled();
  });

  test.each([{ disabled: true }, { isRecognizing: true }])('ignores unavailable input: %j', options => {
    makeHandler(options)(makeEvent());
    expect(onToggle).not.toHaveBeenCalled();
  });

  test('does not record while settings or another modal is open', () => {
    documentState.querySelector.mockReturnValue({});
    makeHandler()(makeEvent());
    expect(onToggle).not.toHaveBeenCalled();
  });

  test('does not trigger from another editor or a shortcut recorder', () => {
    documentState.activeElement = new TestElement();
    documentState.activeElement.editor = true;
    makeHandler()(makeEvent());
    documentState.activeElement.editor = false;
    documentState.activeElement.shortcutRecorder = true;
    makeHandler()(makeEvent());
    expect(onToggle).not.toHaveBeenCalled();
  });

  test('does not trigger a hidden or unmounted prompt', () => {
    textarea.hidden = true;
    makeHandler()(makeEvent());
    textarea.hidden = false;
    textarea.isConnected = false;
    makeHandler()(makeEvent());
    expect(onToggle).not.toHaveBeenCalled();
  });

  test('supports macOS Option shortcuts even when key contains a symbol', () => {
    shortcuts[ShortcutAction.VoiceInput] = 'Option+V';
    makeHandler()(makeEvent({ key: '√', ctrlKey: false, shiftKey: false, altKey: true }));
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
