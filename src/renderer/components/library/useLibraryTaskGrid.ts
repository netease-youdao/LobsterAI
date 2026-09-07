import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';

import {
  LibraryTaskGridController,
  type LibraryTaskGridOptions,
} from './libraryTaskGridController';

/** Memory-only task expansion survives grid/list toggles, but not leaving LibraryView. */
export const useLibraryTaskGrid = (options: LibraryTaskGridOptions) => {
  const controllerRef = useRef<LibraryTaskGridController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new LibraryTaskGridController(() => window.electron?.library);
  }
  const controller = controllerRef.current;
  const mountedRef = useRef(false);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  useLayoutEffect(() => controller.configure(options));

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // React StrictMode rehearses an effect cleanup/setup without unmounting.
      queueMicrotask(() => {
        if (!mountedRef.current) controller.dispose();
      });
    };
  }, [controller]);

  return {
    ...snapshot,
    invalidate: controller.invalidate,
    refresh: controller.refresh,
    loadMoreTasks: controller.loadMoreTasks,
    expand: controller.expand,
    loadMoreItems: controller.loadMoreItems,
    collapse: controller.collapse,
  };
};
