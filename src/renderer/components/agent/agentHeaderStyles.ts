// Agent name/description are ghost inputs: plain text at rest, a neutral pill on
// hover and a focus ring while editing. Inputs hug their text (field-sizing) so the
// pill stays tight; min-w-32 covers both placeholders so the first keystroke does
// not shrink the pill. -mx-2/-my-0.5 cancel the padding so text keeps its position,
// which is why the avatar gap is gap-4 and the fields column uses flex gap-1.
const AGENT_HEADER_INPUT_CLASS = 'block min-w-32 max-w-full -mx-2 -my-0.5 rounded-md bg-transparent px-2 py-0.5 [field-sizing:content] transition-colors hover:bg-surface-raised focus:bg-surface-raised focus:outline-none focus:ring-1 focus:ring-primary/40';

export const AGENT_HEADER_IDENTITY_CLASS = 'flex min-w-0 flex-1 items-start gap-4';

export const AGENT_HEADER_FIELDS_CLASS = 'flex min-w-0 flex-1 flex-col items-start gap-1 pt-0.5';

export const AGENT_NAME_INPUT_CLASS = `${AGENT_HEADER_INPUT_CLASS} h-7 text-lg font-semibold leading-6 text-foreground placeholder:text-secondary/40`;

export const AGENT_DESCRIPTION_INPUT_CLASS = `${AGENT_HEADER_INPUT_CLASS} h-6 text-sm leading-5 text-secondary placeholder:text-secondary/50`;
