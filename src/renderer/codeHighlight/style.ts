import { tagHighlighter,tags as t } from '@lezer/highlight';

/** Fixed classes shared by CodeMirror and the worker. Source text can never create CSS. */
export const codeHighlighter = tagHighlighter([
  { tag: [t.keyword, t.operatorKeyword], class: 'tok-keyword' },
  { tag: [t.name, t.definition(t.name), t.deleted, t.character, t.propertyName, t.macroName], class: 'tok-name' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], class: 'tok-function' },
  { tag: [t.color, t.constant(t.name), t.standard(t.name), t.atom, t.bool, t.number, t.special(t.variableName)], class: 'tok-constant' },
  { tag: [t.separator, t.punctuation], class: 'tok-punctuation' },
  { tag: [t.typeName, t.className, t.changed, t.annotation, t.modifier, t.self, t.namespace], class: 'tok-type' },
  { tag: [t.operator, t.url, t.escape, t.regexp], class: 'tok-operator' },
  { tag: [t.meta, t.comment], class: 'tok-comment' },
  { tag: t.strong, class: 'tok-strong' },
  { tag: t.emphasis, class: 'tok-emphasis' },
  { tag: t.strikethrough, class: 'tok-strikethrough' },
  { tag: t.link, class: 'tok-link' },
  { tag: t.heading, class: 'tok-heading' },
  { tag: [t.processingInstruction, t.string, t.special(t.string), t.inserted], class: 'tok-string' },
  { tag: t.invalid, class: 'tok-invalid' },
]);

export const TOKEN_CLASS_PATTERN = /^tok-(?:keyword|name|function|constant|punctuation|type|operator|comment|strong|emphasis|strikethrough|link|heading|string|invalid)(?: tok-(?:keyword|name|function|constant|punctuation|type|operator|comment|strong|emphasis|strikethrough|link|heading|string|invalid))*$/;
