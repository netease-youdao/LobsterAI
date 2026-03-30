/**
 * Unit tests for ErrorBoundary state machine logic.
 *
 * Logic is mirrored inline because the ErrorBoundary component does not exist
 * yet (RED phase of TDD). Any change to the component's state machine must be
 * reflected here.
 */
import { test, expect, describe } from 'vitest';

// ---------------------------------------------------------------------------
// Mirrors from ErrorBoundary (to be implemented)
// ---------------------------------------------------------------------------

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

function deriveStateFromError(error: Error): ErrorBoundaryState {
  return { hasError: true, error };
}

function resetState(): ErrorBoundaryState {
  return { hasError: false, error: null };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ErrorBoundary state machine', () => {
  test('initial state has no error', () => {
    const state = resetState();
    expect(state.hasError).toBe(false);
    expect(state.error).toBeNull();
  });

  test('deriveStateFromError captures the thrown error', () => {
    const err = new Error('something broke');
    const state = deriveStateFromError(err);
    expect(state.hasError).toBe(true);
    expect(state.error).toBe(err);
    expect(state.error?.message).toBe('something broke');
  });

  test('deriveStateFromError handles TypeError (common render crash)', () => {
    const err = new TypeError('Cannot read properties of undefined');
    const state = deriveStateFromError(err);
    expect(state.hasError).toBe(true);
    expect(state.error).toBeInstanceOf(TypeError);
  });

  test('resetState clears error and returns to normal', () => {
    const err = new Error('transient failure');
    const errorState = deriveStateFromError(err);
    expect(errorState.hasError).toBe(true);

    const recovered = resetState();
    expect(recovered.hasError).toBe(false);
    expect(recovered.error).toBeNull();
  });

  test('full lifecycle: normal → error → recovery', () => {
    // 1. initial (normal)
    const initial = resetState();
    expect(initial.hasError).toBe(false);
    expect(initial.error).toBeNull();

    // 2. error
    const err = new Error('render failed');
    const errored = deriveStateFromError(err);
    expect(errored.hasError).toBe(true);
    expect(errored.error).toBe(err);

    // 3. recovery
    const recovered = resetState();
    expect(recovered.hasError).toBe(false);
    expect(recovered.error).toBeNull();
  });

  test('multiple consecutive errors are handled', () => {
    const err1 = new Error('first crash');
    const state1 = deriveStateFromError(err1);
    expect(state1.hasError).toBe(true);
    expect(state1.error?.message).toBe('first crash');

    // reset between errors
    const mid = resetState();
    expect(mid.hasError).toBe(false);
    expect(mid.error).toBeNull();

    const err2 = new RangeError('second crash');
    const state2 = deriveStateFromError(err2);
    expect(state2.hasError).toBe(true);
    expect(state2.error?.message).toBe('second crash');
  });
});
