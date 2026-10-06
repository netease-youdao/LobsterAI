export interface LatestAsyncRequestGate {
  current: number;
}

export const beginLatestAsyncRequest = (gate: LatestAsyncRequestGate): number => {
  gate.current += 1;
  return gate.current;
};

export const isLatestAsyncRequest = (
  gate: LatestAsyncRequestGate,
  requestId: number,
): boolean => gate.current === requestId;

export const invalidateLatestAsyncRequest = (gate: LatestAsyncRequestGate): void => {
  gate.current += 1;
};
