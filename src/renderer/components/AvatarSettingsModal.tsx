import { Camera, Trash2, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { avatarService } from '../services/avatar';
import { i18nService } from '../services/i18n';
import type { PresetAvatarId, UserAvatarConfig } from '../types/avatar';
import { PRESET_AVATAR_COMPONENTS } from './avatars/presets';

interface AvatarSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AvatarSettingsModal: React.FC<AvatarSettingsModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [savedConfig, setSavedConfig] = useState<UserAvatarConfig | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<PresetAvatarId | null>(null);
  const [customUrl, setCustomUrl] = useState<string | null>(null);
  const [isHoveringPreview, setIsHoveringPreview] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load current avatar config when modal opens
  useEffect(() => {
    if (isOpen) {
      loadCurrentConfig();
    }
  }, [isOpen]);

  const loadCurrentConfig = async () => {
    const config = await avatarService.getAvatarConfig();
    setSavedConfig(config);
    setSelectedPreset(config?.type === 'preset' ? config.presetId || null : null);
    setCustomUrl(config?.type === 'custom' ? config.customUrl || null : null);
    setUploadError(null);
    setIsHoveringPreview(false);
  };

  const handlePresetSelect = (presetId: PresetAvatarId) => {
    setSelectedPreset(presetId);
    setCustomUrl(null);
    setUploadError(null);
  };

  const handleFileSelect = async (file: File) => {
    setUploadError(null);

    const result = await avatarService.uploadImage(file);

    if (result.success && result.config) {
      setCustomUrl(result.config.customUrl || null);
      setSelectedPreset(null);
    } else if (result.error) {
      setUploadError(i18nService.t(result.error as keyof typeof i18nService.t));
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  };

  const handlePreviewClick = () => {
    fileInputRef.current?.click();
  };

  const handleSave = async () => {
    try {
      if (selectedPreset) {
        await avatarService.setPresetAvatar(selectedPreset);
      } else if (customUrl) {
        await avatarService.setCustomAvatar(customUrl);
      } else {
        await avatarService.removeAvatarConfig();
      }
      onClose();
    } catch (error) {
      console.error('Failed to save avatar:', error);
    }
  };

  const handleRemove = () => {
    setSelectedPreset(null);
    setCustomUrl(null);
    setUploadError(null);
  };

  const handleCancel = () => {
    onClose();
  };

  // Render preview content based on current selection
  const renderPreview = () => {
    if (customUrl) {
      return (
        <img
          src={customUrl}
          alt="Custom Avatar"
          className="w-full h-full object-cover"
        />
      );
    }

    if (selectedPreset) {
      const PresetComponent = PRESET_AVATAR_COMPONENTS[selectedPreset];
      if (PresetComponent) {
        return <PresetComponent className="w-full h-full" />;
      }
    }

    // Default empty state
    return (
      <div className="w-full h-full bg-muted flex items-center justify-center">
        <span className="text-4xl text-muted-foreground">?</span>
      </div>
    );
  };

  // Check if current selection differs from saved config
  const hasChanges = (() => {
    if (!savedConfig) {
      return selectedPreset !== null || customUrl !== null;
    }

    if (savedConfig.type === 'preset') {
      return selectedPreset !== savedConfig.presetId || customUrl !== null;
    }

    if (savedConfig.type === 'custom') {
      return selectedPreset !== null || customUrl !== savedConfig.customUrl;
    }

    return selectedPreset !== null || customUrl !== null;
  })();

  const hasSelection = selectedPreset !== null || customUrl !== null;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background rounded-xl shadow-2xl w-[420px] max-w-[90vw] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold">{i18nService.t('avatarSettings')}</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-muted transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="px-5 py-5">
          {/* Main Preview - Large with hover camera */}
          <div className="flex justify-center mb-5">
            <div
              className="relative w-28 h-28 rounded-full overflow-hidden ring-2 ring-border ring-offset-2 ring-offset-background cursor-pointer group"
              onMouseEnter={() => setIsHoveringPreview(true)}
              onMouseLeave={() => setIsHoveringPreview(false)}
              onClick={handlePreviewClick}
            >
              {renderPreview()}

              {/* Hover overlay with camera icon */}
              <div
                className={`absolute inset-0 bg-black/50 flex flex-col items-center justify-center transition-opacity duration-200 ${
                  isHoveringPreview ? 'opacity-100' : 'opacity-0'
                }`}
              >
                <Camera className="w-8 h-8 text-white mb-1" />
                <span className="text-xs text-white font-medium">
                  {i18nService.t('avatarChangePhoto')}
                </span>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                onChange={handleInputChange}
                className="hidden"
              />
            </div>
          </div>

          {/* Upload hint */}
          <p className="text-center text-xs text-muted-foreground mb-5">
            {i18nService.t('avatarUploadHint')}
          </p>

          {/* Error message */}
          {uploadError && (
            <p className="text-sm text-destructive text-center mb-4">{uploadError}</p>
          )}

          {/* Preset Avatars */}
          <div className="mb-4">
            <h3 className="text-sm font-medium mb-3 text-muted-foreground">
              {i18nService.t('avatarPreset')}
            </h3>
            <div className="grid grid-cols-6 gap-2">
              {(Object.keys(PRESET_AVATAR_COMPONENTS) as PresetAvatarId[]).map((presetId) => {
                const PresetComponent = PRESET_AVATAR_COMPONENTS[presetId];
                const isSelected = selectedPreset === presetId;
                const presetNameKey = `avatar${presetId.charAt(0).toUpperCase() + presetId.slice(1)}` as keyof typeof i18nService.t;
                return (
                  <button
                    key={presetId}
                    onClick={() => handlePresetSelect(presetId)}
                    className={`relative aspect-square rounded-xl overflow-hidden transition-all duration-200 ${
                      isSelected
                        ? 'ring-2 ring-primary ring-offset-2 scale-105'
                        : 'hover:scale-105 hover:opacity-90'
                    }`}
                    title={i18nService.t(presetNameKey)}
                  >
                    <PresetComponent className="w-full h-full" />
                  </button>
                );
              })}
            </div>
          </div>

          {/* Remove Button - only show if there's a selection */}
          {hasSelection && (
            <button
              onClick={handleRemove}
              className="w-full flex items-center justify-center gap-2 py-2.5 text-sm text-destructive hover:bg-destructive/5 rounded-lg transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              {i18nService.t('avatarRemove')}
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-border bg-muted/30">
          <button
            onClick={handleCancel}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-border hover:bg-background transition-colors"
          >
            {i18nService.t('avatarCancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={!hasChanges}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {i18nService.t('avatarSave')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AvatarSettingsModal;
