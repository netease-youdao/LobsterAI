import type {
  BrowserCredentialMediation,
  BrowserCredentialMethod,
  BrowserPasskeyEvent,
  BrowserPasskeyStatus,
} from '../../shared/browserWebAccess/passkeys';

// Serialized by contextBridge: keep all runtime dependencies inside this function
// or in its arguments. Credential options/results never cross the bridge.
export function installPasskeyObserver(
  constants: {
    status: typeof BrowserPasskeyStatus;
    method: typeof BrowserCredentialMethod;
    mediation: typeof BrowserCredentialMediation;
  },
  report: (event: BrowserPasskeyEvent) => void,
  onCancel: (cancel: (requestId: string) => void) => void,
): void {
  if (!globalThis.CredentialsContainer || !globalThis.PublicKeyCredential) return;
  const controllers = new Map<string, AbortController>();
  onCancel(requestId => controllers.get(requestId)?.abort());
  for (const method of Object.values(constants.method)) {
    const descriptor = Object.getOwnPropertyDescriptor(CredentialsContainer.prototype, method);
    const original = descriptor?.value;
    if (typeof original !== 'function' || !descriptor) continue;
    Object.defineProperty(CredentialsContainer.prototype, method, {
      ...descriptor,
      value: function (this: CredentialsContainer, options?: CredentialRequestOptions & CredentialCreationOptions) {
        // Conditional autofill may wait for the lifetime of the page. It must
        // remain silent and keep its original cancellation semantics.
        if (!options?.publicKey || options.mediation === constants.mediation.Conditional) {
          return original.call(this, options);
        }
        const requestId = crypto.randomUUID();
        const controller = new AbortController();
        const signal = options.signal
          ? AbortSignal.any([options.signal, controller.signal])
          : controller.signal;
        controllers.set(requestId, controller);
        const notify = (status: BrowserPasskeyEvent['status']) => {
          try { report({ requestId, status }); } catch { /* Navigation can destroy the bridge. */ }
        };
        notify(constants.status.Waiting);
        let result: Promise<Credential | null>;
        try {
          result = original.call(this, { ...options, signal });
        } catch (error) {
          controllers.delete(requestId);
          notify(constants.status.Failed);
          throw error;
        }
        return result.then(credential => {
          notify(credential ? constants.status.Succeeded : constants.status.Failed);
          return credential;
        }, error => {
          notify(signal.aborted ? constants.status.Cancelled : constants.status.Failed);
          throw error;
        }).finally(() => controllers.delete(requestId));
      },
    });
  }
}
