// The OpenClaw gateway hard-rejects chat.send messages containing U+0000
// ("message must not contain null bytes"), and NUL persisted in session
// history re-enters later outbound prompts through the continuity capsule
// and retrieved-evidence bridges. Strip it at ingestion and outbound
// boundaries; other control characters are stripped by the gateway itself.
export const stripNullChars = (value: string): string => (
  value.includes('\u0000') ? value.replace(/\u0000/g, '') : value
);
