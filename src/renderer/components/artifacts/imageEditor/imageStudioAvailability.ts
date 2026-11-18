let mountedHosts = 0;

/** Registers a mounted studio host; the returned function unregisters it. */
export function registerImageStudioHost(): () => void {
  mountedHosts += 1;
  return () => { mountedHosts -= 1; };
}

/** Turn views outside a session page (scheduled runs, the library) have no studio to open images into. */
export const isImageStudioAvailable = (): boolean => mountedHosts > 0;
