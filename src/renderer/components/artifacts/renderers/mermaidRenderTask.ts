interface RemovableRenderContainer {
  remove: () => void;
}

interface ExecuteMermaidRenderOptions<Container extends RemovableRenderContainer> {
  artifactId: string;
  content: string;
  signal: AbortSignal;
  createContainer: () => Container;
  render: (
    id: string,
    content: string,
    container: Container,
  ) => Promise<{ svg: string }>;
  onSuccess: (svg: string) => void;
  onError: (error: unknown) => void;
}

export function createMermaidRenderId(artifactId: string): string {
  const normalizedArtifactId = artifactId.replace(/[^a-zA-Z0-9]/g, '') || 'artifact';
  return `mermaid-${normalizedArtifactId}-${crypto.randomUUID()}`;
}

export async function executeMermaidRender<Container extends RemovableRenderContainer>({
  artifactId,
  content,
  signal,
  createContainer,
  render,
  onSuccess,
  onError,
}: ExecuteMermaidRenderOptions<Container>): Promise<void> {
  let renderContainer: Container | null = null;

  try {
    // Give effect cleanup a chance to cancel StrictMode's throwaway render.
    await Promise.resolve();
    if (signal.aborted) return;

    const renderId = createMermaidRenderId(artifactId);
    renderContainer = createContainer();
    const { svg } = await render(renderId, content, renderContainer);

    if (!signal.aborted) {
      onSuccess(svg);
    }
  } catch (error) {
    if (!signal.aborted) {
      onError(error);
    }
  } finally {
    renderContainer?.remove();
  }
}
