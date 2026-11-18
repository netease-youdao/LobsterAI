import { useMemo, useRef } from 'react';
import { useDispatch } from 'react-redux';

import { loadDetectedFileArtifact } from '../../services/artifactDetection';
import {
  findLocalServiceArtifactForUrl,
  LocalFileLinkTargetKind,
  resolveLocalFileLinkTarget,
} from '../../services/artifactLinkOpen';
import { addLinkedFileArtifact, openArtifactPreviewTab } from '../../store/slices/artifactSlice';
import { type Artifact, ArtifactTypeValue } from '../../types/artifact';
import { ArtifactPreviewActionSource, reportArtifactPreviewAction } from '../artifacts/artifactAnalytics';
import type { MarkdownLinkOpener } from '../markdownLinkOpener';

interface CoworkMarkdownLinkOpenerOptions {
  sessionId: string | null | undefined;
  cwd?: string;
  sessionArtifacts: Artifact[];
  onOpenHtmlFile: (artifact: Artifact) => void;
  onOpenLocalService: (artifact: Artifact) => void;
}

/**
 * Opens links in a session's messages the way its artifact cards open:
 * previewable files in the artifact panel, HTML files and local services in
 * the built-in browser. Every other link stays with the system.
 */
export const useCoworkMarkdownLinkOpener = ({
  sessionId,
  cwd,
  sessionArtifacts,
  onOpenHtmlFile,
  onOpenLocalService,
}: CoworkMarkdownLinkOpenerOptions): MarkdownLinkOpener | null => {
  const dispatch = useDispatch();
  // Read at click time, so the opener stays stable while artifacts stream in
  // instead of re-rendering every message that provides it.
  const latestRef = useRef({ cwd, sessionArtifacts, onOpenHtmlFile, onOpenLocalService });
  latestRef.current = { cwd, sessionArtifacts, onOpenHtmlFile, onOpenLocalService };

  return useMemo(() => {
    if (!sessionId) return null;

    const showArtifact = (artifact: Artifact) => {
      const isHtmlFile = artifact.type === ArtifactTypeValue.Html && Boolean(artifact.filePath);
      reportArtifactPreviewAction({
        actionType: 'link_open',
        source: ArtifactPreviewActionSource.ConversationMessageLink,
        artifact,
        params: {
          openTarget: isHtmlFile ? 'lobster_browser' : 'preview_panel',
        },
      });
      if (isHtmlFile) {
        latestRef.current.onOpenHtmlFile(artifact);
        return;
      }
      dispatch(openArtifactPreviewTab({ sessionId, artifactId: artifact.id }));
    };

    return {
      openLocalFile: async (filePath: string) => {
        const { cwd: sessionCwd, sessionArtifacts: artifacts } = latestRef.current;
        const target = resolveLocalFileLinkTarget(filePath, artifacts, { sessionId, cwd: sessionCwd });
        if (!target) return false;
        if (target.kind === LocalFileLinkTargetKind.Existing) {
          showArtifact(target.artifact);
          return true;
        }

        const targetPath = target.artifact.filePath;
        if (!targetPath) return false;
        const stat = await window.electron?.dialog?.statFile(targetPath);
        if (!stat?.success || !stat.isFile) return false;
        const loaded = await loadDetectedFileArtifact(target.artifact, sessionCwd);
        if (!loaded) return false;
        dispatch(addLinkedFileArtifact({ sessionId, artifact: loaded }));
        showArtifact(loaded);
        return true;
      },
      openWebLink: (url: string) => {
        const artifact = findLocalServiceArtifactForUrl(url, latestRef.current.sessionArtifacts);
        if (!artifact) return false;
        reportArtifactPreviewAction({
          actionType: 'link_open',
          source: ArtifactPreviewActionSource.ConversationMessageLink,
          artifact,
          params: {
            openTarget: 'lobster_browser',
          },
        });
        // Go to the address the link names; the card only lends its project context.
        latestRef.current.onOpenLocalService({ ...artifact, url, content: url });
        return true;
      },
    };
  }, [dispatch, sessionId]);
};
