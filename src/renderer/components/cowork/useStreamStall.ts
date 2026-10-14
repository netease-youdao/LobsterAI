import { useEffect, useState } from 'react';

/**
 * True once a streaming text has stopped growing for `quietMs`.
 *
 * `streamSignature` identifies the text and its current length (null when
 * nothing is streaming); every change restarts the quiet period. The
 * runtime keeps a thought or reply segment open until the next tool starts,
 * and a tool call's arguments do not stream to the UI, so a quiet stream
 * means the model has moved on rather than that it is still writing it.
 */
export const useStreamStall = (streamSignature: string | null, quietMs: number): boolean => {
  const [stalledSignature, setStalledSignature] = useState<string | null>(null);

  useEffect(() => {
    if (!streamSignature) return undefined;
    const timeoutId = window.setTimeout(() => setStalledSignature(streamSignature), quietMs);
    return () => window.clearTimeout(timeoutId);
  }, [streamSignature, quietMs]);

  return streamSignature !== null && stalledSignature === streamSignature;
};
