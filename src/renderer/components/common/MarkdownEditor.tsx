import '@uiw/react-md-editor/markdown-editor.css';

import MDEditor, { commands } from '@uiw/react-md-editor';
import React, { useEffect, useRef, useState } from 'react';

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  height?: number;
}

const headingIcon = (label: string) => (
  <span style={{ fontSize: 11, fontWeight: 700, lineHeight: 1, letterSpacing: '-0.02em' }}>
    {label}
  </span>
);

const h1Command = { ...commands.title1, icon: headingIcon('H1') };
const h2Command = { ...commands.title2, icon: headingIcon('H2') };
const h3Command = { ...commands.title3, icon: headingIcon('H3') };

/**
 * Thin wrapper around @uiw/react-md-editor that:
 * - Keeps the color-mode in sync with the app's dark/light theme
 * - Strips non-relevant toolbar actions (fullscreen, link, image, etc.)
 * - Provides sensible defaults for use inside Settings panels
 */
const MarkdownEditor: React.FC<MarkdownEditorProps> = ({
  value,
  onChange,
  placeholder,
  height = 220,
}) => {
  const [colorMode, setColorMode] = useState<'light' | 'dark'>('light');
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Mirror the `dark` class on <html> set by ThemeManager
  useEffect(() => {
    const update = () => {
      setColorMode(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);

  /**
   * Clicking the empty space below text in the editor content area does not
   * naturally focus the textarea because the textarea only covers the height
   * of the actual text, not the full editor height (a known issue with the
   * textarea-overlay approach used by @uiw/react-md-editor).
   *
   * Fix: intercept clicks that land inside the content area but outside the
   * textarea itself, and programmatically forward focus to the textarea.
   */
  const handleContentClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as Element;
    // Let normal clicks on interactive elements pass through untouched
    if (
      target.tagName === 'TEXTAREA' ||
      target.closest('.w-md-editor-toolbar') ||
      target.closest('button')
    ) {
      return;
    }
    // Only act on clicks inside the text editing area
    if (!target.closest('.w-md-editor-content')) return;

    const textarea =
      wrapperRef.current?.querySelector<HTMLTextAreaElement>('.w-md-editor-text-input');
    if (textarea) {
      textarea.focus();
      // Place cursor at end so the user can start typing immediately
      const len = textarea.value.length;
      textarea.setSelectionRange(len, len);
    }
  };

  return (
    <div
      ref={wrapperRef}
      data-color-mode={colorMode}
      className="md-editor-wrapper rounded-lg overflow-hidden border border-border"
      onClick={handleContentClick}
    >
      <MDEditor
        value={value}
        onChange={val => onChange(val ?? '')}
        height={height}
        preview="edit"
        data-color-mode={colorMode}
        textareaProps={{ placeholder }}
        commands={[
          commands.bold,
          commands.italic,
          commands.strikethrough,
          commands.divider,
          h1Command,
          h2Command,
          h3Command,
          commands.divider,
          commands.unorderedListCommand,
          commands.orderedListCommand,
          commands.divider,
          commands.quote,
          commands.code,
          commands.codeBlock,
        ]}
        extraCommands={[
          commands.codeEdit,
          commands.codeLive,
          commands.codePreview,
          commands.divider,
          commands.fullscreen,
        ]}
      />
    </div>
  );
};

export default MarkdownEditor;
