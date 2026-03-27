import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import { createSuggestionRenderer } from './suggestionPopup';
import type { SlashCommandItem } from './types';

const slashCommandSuggestionKey = new PluginKey('slashCommandSuggestion');

interface SlashCommandOptions {
  suggestion: Omit<SuggestionOptions<SlashCommandItem, SlashCommandItem>, 'editor'>;
  emptyText: string;
}

export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: 'slashCommand',

  addOptions() {
    return {
      suggestion: {
        char: '/',
      },
      emptyText: '',
    };
  },

  addProseMirrorPlugins() {
    const storage = this.editor.storage as unknown as Record<string, unknown>;
    return [
      Suggestion<SlashCommandItem, SlashCommandItem>({
        editor: this.editor,
        pluginKey: slashCommandSuggestionKey,
        ...this.options.suggestion,
        command: ({ editor, range, props }) => {
          storage.__composerSelectedIndex = 0;
          editor.chain().focus().deleteRange(range).run();
          this.options.suggestion.command?.({ editor, range, props });
        },
        render: () => createSuggestionRenderer({
          editor: this.editor,
          emptyText: this.options.emptyText,
          getItemView: (item) => ({
            title: item.label,
            subtitle: item.description || item.actionLabel,
            badge: item.actionLabel,
          }),
          onOpen: () => {
            storage.__composerTrigger = '/';
            storage.__composerSelectedIndex = 0;
          },
          onClose: () => {
            storage.__composerTrigger = null;
            storage.__composerSelectedIndex = 0;
          },
        }),
      }),
    ];
  },
});
