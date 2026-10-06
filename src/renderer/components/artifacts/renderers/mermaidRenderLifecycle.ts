interface MermaidRenderApi {
  parse: (source: string) => Promise<unknown>;
  render: (id: string, source: string, container: HTMLDivElement) => Promise<{ svg: string }>;
}

interface MermaidRenderOptions {
  source: string;
  api: MermaidRenderApi;
  createContainer: () => HTMLDivElement;
  onSuccess: (svg: string) => void;
  onError: (error: unknown) => void;
}

export interface MermaidRenderTask {
  cancel: () => void;
  done: Promise<void>;
}

/** Each invocation owns its ID and container, including after React cancels it. */
export function startMermaidRender({
  source,
  api,
  createContainer,
  onSuccess,
  onError,
}: MermaidRenderOptions): MermaidRenderTask {
  let cancelled = false;
  const done = (async () => {
    let container: HTMLDivElement | undefined;
    try {
      // Parse without drawing Mermaid's error SVG into the application body.
      await api.parse(source);
      if (cancelled) return;

      const id = `mermaid-${crypto.randomUUID()}`;
      container = createContainer();
      const { svg } = await api.render(id, source, container);
      if (!cancelled) onSuccess(svg);
    } catch (error) {
      if (!cancelled) onError(error);
    } finally {
      // Mermaid's queue can still be using this DOM after cancellation. Never
      // remove it early, or clean up another render through global ID lookups.
      container?.remove();
    }
  })();

  return {
    cancel: () => { cancelled = true; },
    done,
  };
}
