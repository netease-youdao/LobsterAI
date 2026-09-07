import {
  ArrowPathIcon,
  DocumentIcon,
  GlobeAltIcon,
} from '@heroicons/react/24/outline';
import React, { useEffect, useRef, useState } from 'react';

import {
  LibraryCategory,
  LibraryItemKind,
} from '../../../shared/library/constants';
import {
  LibraryThumbnailRequestPriority,
  type LibraryThumbnailRequestPriorityType,
} from '../../../shared/library/thumbnail';
import type { LibraryItem } from '../../../shared/library/types';
import { i18nService } from '../../services/i18n';
import FileTypeIcon from '../icons/fileTypes/FileTypeIcon';
import {
  getLibraryDisplayFileName,
  isLibraryWebsiteItem,
} from './libraryItemPresentation';
import {
  cacheLibraryThumbnail,
  createLibraryThumbnailCacheKey,
  getCachedLibraryThumbnail,
} from './libraryThumbnailCache';
import {
  type LibraryThumbnailLoadState,
  LibraryThumbnailLoadStatus,
  libraryThumbnailScheduler,
  type LibraryThumbnailSubscription,
} from './libraryThumbnailScheduler';

const LoadingStatuses = new Set<LibraryThumbnailLoadState['status']>([
  LibraryThumbnailLoadStatus.Queued,
  LibraryThumbnailLoadStatus.Rendering,
  LibraryThumbnailLoadStatus.RetryWait,
]);

const LibraryThumbnailFallback: React.FC<{
  item: LibraryItem;
  state?: LibraryThumbnailLoadState;
  onRetry: () => void;
}> = ({ item, state, onRetry }) => {
  const isWebsite = isLibraryWebsiteItem(item);
  const loading = state ? LoadingStatuses.has(state.status) : false;
  const failed = state?.status === LibraryThumbnailLoadStatus.Failed;
  const unsupported = state?.status === LibraryThumbnailLoadStatus.Unsupported;
  return (
    <div className="relative flex h-full w-full items-center justify-center bg-surface-raised text-secondary">
      {isWebsite ? (
        <GlobeAltIcon className="h-6 w-6 text-primary" aria-hidden="true" />
      ) : item.category === LibraryCategory.Web ? (
        <FileTypeIcon
          fileName={getLibraryDisplayFileName(item)}
          className="h-6 w-6"
        />
      ) : (
        <DocumentIcon className="h-6 w-6" aria-hidden="true" />
      )}
      {loading && (
        <span
          aria-label={i18nService.t('loading')}
          role="status"
          className="absolute bottom-2 left-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-background/85 shadow-sm"
        >
          <ArrowPathIcon className="h-3 w-3 text-tertiary motion-safe:animate-spin" />
        </span>
      )}
      {failed && (
        <span
          role="button"
          tabIndex={0}
          className="absolute bottom-2 left-2 rounded-md bg-background/90 px-2 py-1 text-[11px] font-medium text-secondary shadow-sm hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
          onClick={event => {
            event.stopPropagation();
            onRetry();
          }}
          onKeyDown={event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            onRetry();
          }}
        >
          {i18nService.t('retry')}
        </span>
      )}
      {unsupported && (
        <span className="absolute bottom-2 left-2 rounded-md bg-background/90 px-2 py-1 text-[11px] text-tertiary shadow-sm">
          {i18nService.t('artifactNoPreview')}
        </span>
      )}
    </div>
  );
};

const LibraryThumbnail: React.FC<{ item: LibraryItem }> = ({ item }) => {
  const localItem = item.itemKind === LibraryItemKind.LocalArtifact
    && item.availability === 'available' ? item : undefined;
  const cacheKey = localItem
    ? createLibraryThumbnailCacheKey(
        localItem.filePath,
        localItem.fileMtimeMs,
        localItem.sizeBytes,
      )
    : undefined;
  const containerRef = useRef<HTMLDivElement>(null);
  const subscriptionRef = useRef<LibraryThumbnailSubscription>();
  const [isNearViewport, setIsNearViewport] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const isVisibleRef = useRef(isVisible);
  const [thumbnail, setThumbnail] = useState<{
    cacheKey: string;
    dataUrl: string;
  } | undefined>(() => {
    const cached = cacheKey ? getCachedLibraryThumbnail(cacheKey) : undefined;
    return cacheKey && cached ? { cacheKey, dataUrl: cached } : undefined;
  });
  const [loadState, setLoadState] = useState<LibraryThumbnailLoadState>();
  const dataUrl = cacheKey && thumbnail?.cacheKey === cacheKey
    ? thumbnail.dataUrl
    : undefined;

  useEffect(() => {
    const container = containerRef.current;
    setIsNearViewport(false);
    setIsVisible(false);
    if (!container) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setIsNearViewport(true);
      setIsVisible(true);
      return undefined;
    }

    const nearObserver = new IntersectionObserver(entries => {
      setIsNearViewport(entries.some(entry => entry.isIntersecting));
    }, { rootMargin: '320px 0px' });
    const visibleObserver = new IntersectionObserver(entries => {
      setIsVisible(entries.some(entry => entry.isIntersecting));
    });
    nearObserver.observe(container);
    visibleObserver.observe(container);
    return () => {
      nearObserver.disconnect();
      visibleObserver.disconnect();
    };
  }, [cacheKey]);

  useEffect(() => {
    const cached = cacheKey ? getCachedLibraryThumbnail(cacheKey) : undefined;
    setThumbnail(cacheKey && cached ? { cacheKey, dataUrl: cached } : undefined);
    setLoadState(undefined);
  }, [cacheKey]);

  useEffect(() => {
    // Sync the ref before the subscribe effect below runs (effects run in
    // declaration order) so a fresh subscription starts with the current
    // priority without re-subscribing on every visibility change, which
    // would cancel in-flight thumbnail renders.
    isVisibleRef.current = isVisible;
    const priority: LibraryThumbnailRequestPriorityType = isVisible
      ? LibraryThumbnailRequestPriority.Visible
      : LibraryThumbnailRequestPriority.NearViewport;
    subscriptionRef.current?.updatePriority(priority);
  }, [isVisible]);

  useEffect(() => {
    if (!localItem || !cacheKey || !isNearViewport || dataUrl) return undefined;
    const requestedCacheKey = cacheKey;
    const subscription = libraryThumbnailScheduler.subscribe({
      key: requestedCacheKey,
      priority: isVisibleRef.current
        ? LibraryThumbnailRequestPriority.Visible
        : LibraryThumbnailRequestPriority.NearViewport,
      load: (requestId, priority) => window.electron.dialog.generateThumbnail({
        filePath: localItem.filePath,
        requestId,
        priority,
      }),
      cancel: requestId => {
        void window.electron.dialog.cancelThumbnail(requestId);
      },
      onStateChange: state => {
        setLoadState(state);
        if (state.status !== LibraryThumbnailLoadStatus.Ready || !state.dataUrl) return;
        cacheLibraryThumbnail(requestedCacheKey, state.dataUrl);
        setThumbnail({ cacheKey: requestedCacheKey, dataUrl: state.dataUrl });
      },
    });
    subscriptionRef.current = subscription;
    return () => {
      subscription.unsubscribe();
      if (subscriptionRef.current === subscription) subscriptionRef.current = undefined;
    };
  }, [cacheKey, dataUrl, isNearViewport, localItem]);

  return (
    <div ref={containerRef} className="h-full w-full">
      {dataUrl ? (
        <img
          src={dataUrl}
          alt={item.title}
          className="h-full w-full bg-surface-raised object-contain"
        />
      ) : (
        <LibraryThumbnailFallback
          item={item}
          state={loadState}
          onRetry={() => subscriptionRef.current?.retry()}
        />
      )}
    </div>
  );
};

export default LibraryThumbnail;
