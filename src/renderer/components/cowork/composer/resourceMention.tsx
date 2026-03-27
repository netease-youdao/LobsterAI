import { Node, mergeAttributes } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import { ReactNodeViewRenderer } from '@tiptap/react';
import ResourceMentionView from './ResourceMentionView';
import { createSuggestionRenderer } from './suggestionPopup';
import type { ComposerResourceItem, ResourceMentionAttrs } from './types';

const resourceMentionSuggestionKey = new PluginKey('resourceMentionSuggestion');

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    resourceMention: {
      insertResourceMention: (attrs: ResourceMentionAttrs) => ReturnType;
    };
  }
}

interface ResourceMentionOptions {
  suggestion: Omit<SuggestionOptions<ComposerResourceItem, ComposerResourceItem>, 'editor'>;
  emptyText: string;
}

export const ResourceMention = Node.create<ResourceMentionOptions>({
  name: 'resourceMention',
  inline: true,
  atom: true,
  group: 'inline',
  selectable: true,

  addOptions() {
    return {
      suggestion: {
        char: '@',
      },
      emptyText: '',
    };
  },

  addAttributes() {
    return {
      kind: { default: 'attachment' },
      resourceId: { default: '' },
      mentionToken: { default: '' },
      label: { default: '' },
      description: { default: '' },
      path: { default: '' },
      sourceKind: { default: '' },
      isImage: { default: false },
      dataUrl: { default: '' },
      isOfficial: { default: false },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-resource-mention]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-resource-mention': '' }), `@${HTMLAttributes.label ?? ''}`];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ResourceMentionView);
  },

  addCommands() {
    return {
      insertResourceMention: (attrs) => ({ commands }) => commands.insertContent([
        { type: this.name, attrs },
        { type: 'text', text: ' ' },
      ]),
    };
  },

  addProseMirrorPlugins() {
    const storage = this.editor.storage as unknown as Record<string, unknown>;
    return [
      Suggestion<ComposerResourceItem, ComposerResourceItem>({
        editor: this.editor,
        pluginKey: resourceMentionSuggestionKey,
        ...this.options.suggestion,
        command: ({ editor, range, props }) => {
          storage.__composerSelectedIndex = 0;
          editor.chain().focus().insertContentAt(range, [
            {
              type: this.name,
              attrs: {
                kind: props.kind,
                resourceId: props.kind === 'skill' ? props.skillId : props.mentionId,
                mentionToken: props.mentionToken,
                label: props.label,
                description: props.kind === 'skill' ? props.description ?? '' : '',
                path: props.kind === 'attachment' ? props.path : '',
                sourceKind: props.kind === 'attachment' ? props.sourceKind : '',
                isImage: props.kind === 'attachment' ? props.isImage : false,
                dataUrl: props.kind === 'attachment' ? props.dataUrl : '',
                isOfficial: props.kind === 'skill' ? props.isOfficial : false,
              } satisfies ResourceMentionAttrs,
            },
            { type: 'text', text: ' ' },
          ]).run();

          this.options.suggestion.command?.({ editor, range, props });
        },
        render: () => createSuggestionRenderer({
          editor: this.editor,
          emptyText: this.options.emptyText,
          getItemView: (item) => ({
            title: `@${item.mentionToken}`,
            subtitle: item.kind === 'skill'
              ? item.description || item.name
              : item.path.startsWith('inline:')
                ? item.label
                : item.path,
            badge: item.kind === 'skill' ? 'Skill' : 'File',
          }),
          onOpen: () => {
            storage.__composerTrigger = '@';
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
