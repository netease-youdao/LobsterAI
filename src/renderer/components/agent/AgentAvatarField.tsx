import { AgentAvatarAllowedExtensions } from '@shared/agentAvatar/constants';
import React, { useEffect, useId, useMemo, useState } from 'react';

import { i18nService } from '../../services/i18n';
import TrashIcon from '../icons/TrashIcon';
import UploadIcon from '../icons/UploadIcon';
import AgentAvatar from './AgentAvatar';
import EmojiPicker from './EmojiPicker';

interface AgentAvatarFieldProps {
  icon: string;
  avatarPath?: string;
  avatarPreviewSrc?: string;
  removeAvatar?: boolean;
  fallbackIcon?: string;
  name?: string;
  onIconChange: (value: string) => void;
  onAvatarSelected: (payload: { sourcePath: string; previewSrc: string }) => void;
  onAvatarRemoved: () => void;
}

const AgentAvatarField: React.FC<AgentAvatarFieldProps> = ({
  icon,
  avatarPath,
  avatarPreviewSrc,
  removeAvatar = false,
  fallbackIcon = '🤖',
  name,
  onIconChange,
  onAvatarSelected,
  onAvatarRemoved,
}) => {
  const effectiveAvatarPath = removeAvatar ? '' : (avatarPath ?? '');
  const hasImage = useMemo(() => {
    return Boolean((avatarPreviewSrc && avatarPreviewSrc.trim()) || (effectiveAvatarPath && effectiveAvatarPath.trim()));
  }, [avatarPreviewSrc, effectiveAvatarPath]);
  const [showImageEditor, setShowImageEditor] = useState(hasImage);
  const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);
  const tabGroupId = useId();
  const imagePanelId = `${tabGroupId}-image-panel`;
  const emojiPanelId = `${tabGroupId}-emoji-panel`;
  const previewUsesImageAction = hasImage || showImageEditor;
  const previewActionLabel = hasImage
    ? (i18nService.t('agentAvatarPreviewActionImage') || 'Click to replace image')
    : showImageEditor
      ? (i18nService.t('agentAvatarPreviewActionUploadImage') || 'Click to upload image')
      : (i18nService.t('agentAvatarPreviewActionEmoji') || 'Click to choose emoji');

  useEffect(() => {
    setShowImageEditor(hasImage);
  }, [hasImage]);

  useEffect(() => {
    if (showImageEditor) {
      setIsEmojiPickerOpen(false);
    }
  }, [showImageEditor]);

  const showToast = (message: string) => {
    window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
  };

  const handleSelectImage = async () => {
    const selection = await window.electron.dialog.selectFile({
      title: i18nService.t('agentAvatarUploadTitle') || 'Select avatar image',
      filters: [
        {
          name: i18nService.t('agentAvatarImageFiles') || 'Image files',
          extensions: [...AgentAvatarAllowedExtensions],
        },
      ],
    });

    if (!selection.success || !selection.path) {
      return;
    }

    const preview = await window.electron.dialog.readFileAsDataUrl(selection.path);
    if (!preview.success || !preview.dataUrl) {
      showToast(i18nService.t('agentAvatarReadFailed'));
      return;
    }

    onAvatarSelected({
      sourcePath: selection.path,
      previewSrc: preview.dataUrl,
    });
  };

  const handleRemoveImage = () => {
    onAvatarRemoved();
    setShowImageEditor(false);
  };

  const handlePreviewClick = async () => {
    if (previewUsesImageAction) {
      setShowImageEditor(true);
      await handleSelectImage();
      return;
    }
    setShowImageEditor(false);
    setIsEmojiPickerOpen(true);
  };

  return (
    <div className="rounded-2xl border border-border bg-surface-raised/30 p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <button
          type="button"
          onClick={handlePreviewClick}
          className="group flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-2xl p-2 -m-2 text-left transition-colors hover:bg-background/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          title={previewActionLabel}
          aria-label={previewActionLabel}
        >
          <AgentAvatar
            icon={icon}
            avatarPath={effectiveAvatarPath}
            avatarPreviewSrc={avatarPreviewSrc}
            fallbackIcon={fallbackIcon}
            name={name}
            className="h-16 w-16 shadow-sm transition-transform group-hover:scale-[1.02]"
            emojiClassName="text-2xl leading-none"
          />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">
              {hasImage
                ? (i18nService.t('agentAvatarCurrentImage') || 'Image avatar is active')
                : (i18nService.t('agentAvatarCurrentEmoji') || 'Emoji avatar is active')}
            </div>
            <p className="mt-1 max-w-[32rem] text-xs leading-5 text-secondary/80">
              {hasImage
                ? (i18nService.t('agentAvatarCurrentImageHint') || 'Your uploaded image is shown first. If you remove it, the emoji will be used automatically.')
                : (i18nService.t('agentAvatarCurrentEmojiHint') || 'Without an uploaded image, the selected emoji will be shown as the avatar.')}
            </p>
          </div>
        </button>

        <div
          role="tablist"
          aria-label={i18nService.t('agentAvatar') || 'Avatar'}
          className="inline-flex w-full rounded-xl border border-border bg-background/80 p-1 sm:w-auto"
        >
          <button
            type="button"
            onClick={() => setShowImageEditor(true)}
            role="tab"
            id={`${tabGroupId}-image-tab`}
            aria-selected={showImageEditor}
            aria-controls={imagePanelId}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors sm:flex-none ${
              showImageEditor
                ? 'bg-surface-raised text-foreground shadow-sm'
                : 'text-secondary hover:text-foreground'
            }`}
          >
            {i18nService.t('agentAvatarTabImage') || 'Image'}
          </button>
          <button
            type="button"
            onClick={() => setShowImageEditor(false)}
            role="tab"
            id={`${tabGroupId}-emoji-tab`}
            aria-selected={!showImageEditor}
            aria-controls={emojiPanelId}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors sm:flex-none ${
              showImageEditor
                ? 'text-secondary hover:text-foreground'
                : 'bg-surface-raised text-foreground shadow-sm'
            }`}
          >
            {i18nService.t('agentAvatarTabEmoji') || 'Emoji'}
          </button>
        </div>
      </div>

      <div
        role="tabpanel"
        id={showImageEditor ? imagePanelId : emojiPanelId}
        aria-labelledby={showImageEditor ? `${tabGroupId}-image-tab` : `${tabGroupId}-emoji-tab`}
        className="mt-4 rounded-xl border border-border/80 bg-background/70 p-3"
      >
        {showImageEditor ? (
          <>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleSelectImage}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-raised"
              >
                <UploadIcon className="h-4 w-4" />
                {hasImage
                  ? (i18nService.t('agentAvatarReplace') || 'Replace image')
                  : (i18nService.t('agentAvatarUpload') || 'Upload image')}
              </button>
              {hasImage && (
                <button
                  type="button"
                  onClick={handleRemoveImage}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-red-500 transition-colors hover:bg-red-50 dark:hover:bg-red-900/20"
                >
                  <TrashIcon className="h-4 w-4" />
                  {i18nService.t('agentAvatarRemoveImage') || 'Remove image'}
                </button>
              )}
            </div>
            <p className="mt-3 max-w-[34rem] text-xs leading-5 text-secondary/80">
              {i18nService.t('agentAvatarImageHint') || 'Use an uploaded image when you want a more personalized agent portrait.'}
            </p>
          </>
        ) : (
          <div className="flex items-start gap-3">
            <div className="shrink-0">
              <EmojiPicker
                value={icon}
                onChange={onIconChange}
                isOpen={isEmojiPickerOpen}
                onOpenChange={setIsEmojiPickerOpen}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-foreground">
                {i18nService.t('agentAvatarFallbackEmoji') || 'Emoji avatar'}
              </div>
              <p className="mt-1 max-w-[34rem] text-xs leading-5 text-secondary/80">
                {hasImage
                  ? (i18nService.t('agentAvatarEmojiHintWithImage') || 'You can still adjust the emoji here. It will be shown automatically if the image is removed or unavailable.')
                  : (i18nService.t('agentAvatarEmojiHintWithoutImage') || 'Pick an emoji for a quick avatar that is easy to recognize in lists and sidebars.')}
              </p>
              {hasImage && (
                <button
                  type="button"
                  onClick={handleRemoveImage}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-raised"
                >
                  <TrashIcon className="h-4 w-4" />
                  {i18nService.t('agentAvatarUseEmojiInstead') || 'Remove image and use emoji'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default AgentAvatarField;
