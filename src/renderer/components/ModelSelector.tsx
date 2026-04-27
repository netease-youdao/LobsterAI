import { CheckIcon,ChevronDownIcon } from '@heroicons/react/24/outline';
import React from 'react';
import { useDispatch,useSelector } from 'react-redux';

import { i18nService } from '../services/i18n';
import { RootState } from '../store';
import type { Model } from '../store/slices/modelSlice';
import { getModelIdentityKey,isSameModelIdentity, setSelectedModel } from '../store/slices/modelSlice';

interface ModelSelectorProps {
  dropdownDirection?: 'up' | 'down';
  /**
   * Controlled mode: the currently selected Model (or `null` for "default").
   * When provided, the component does NOT read/write Redux global state.
   */
  value?: Model | null;
  /** Controlled mode callback. `null` means the user picked "default". */
  onChange?: (model: Model | null) => void;
  /** Show a "default" option at the top of the dropdown (controlled mode only). */
  defaultLabel?: string;
}

const ModelSelector: React.FC<ModelSelectorProps> = ({
  dropdownDirection = 'down',
  value,
  onChange,
  defaultLabel,
}) => {
  const dispatch = useDispatch();
  const [isOpen, setIsOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const controlled = onChange !== undefined;
  const globalSelectedModel = useSelector((state: RootState) => state.model.selectedModel);
  const selectedModel = controlled ? value ?? null : globalSelectedModel;
  const availableModels = useSelector((state: RootState) => state.model.availableModels);

  // 点击外部区域关闭下拉框
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleModelSelect = (model: Model | null) => {
    if (controlled) {
      onChange(model);
    } else if (model) {
      dispatch(setSelectedModel(model));
    }
    setIsOpen(false);
  };

  // 如果没有可用模型，显示提示
  if (availableModels.length === 0) {
    return (
      <div className="px-3 py-1.5 rounded-xl bg-surface text-secondary text-sm">
        {i18nService.t('modelSelectorNoModels')}
      </div>
    );
  }

  const dropdownPositionClass = dropdownDirection === 'up'
    ? 'bottom-full mb-1'
    : 'top-full mt-1';

  const serverModels = availableModels.filter(m => m.isServerModel);
  const userModels = availableModels.filter(m => !m.isServerModel);
  const hasBothGroups = serverModels.length > 0 && userModels.length > 0;

  const isSelected = (model: Model): boolean => {
    if (!selectedModel) return false;
    return isSameModelIdentity(model, selectedModel);
  };

  const renderModelItem = (model: Model) => (
    <button
      type="button"
      key={getModelIdentityKey(model)}
      onClick={() => handleModelSelect(model)}
      className={`w-full px-4 py-2.5 text-left dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover flex items-center justify-between transition-colors ${
        isSelected(model) ? 'dark:bg-claude-darkSurfaceHover/50 bg-claude-surfaceHover/50' : ''
      }`}
    >
      <div className="flex flex-col">
        <div className="flex items-center gap-1.5">
          <span className="text-sm">{model.name}</span>
          {model.supportsImage && (
            <span className="text-[10px] leading-none px-1.5 py-0.5 rounded-md bg-primary/10 text-primary whitespace-nowrap">
              {i18nService.t('imageInput')}
            </span>
          )}
        </div>
        {model.provider && (
          <span className="text-xs text-secondary">{model.provider}</span>
        )}
      </div>
      {isSelected(model) && (
        <CheckIcon className="h-4 w-4 text-claude-accent" />
      )}
    </button>
  );

  const renderGroupHeader = (label: string) => (
    <div className="px-4 py-1.5 text-xs font-medium text-secondary uppercase tracking-wider">
      {label}
    </div>
  );

  return (
    <div ref={containerRef} className="relative cursor-pointer">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center space-x-2 px-3 py-1.5 rounded-xl hover:bg-surface-raised text-foreground transition-colors cursor-pointer ${isOpen ? 'bg-surface-raised' : ''}`}
      >
        <span className="font-medium text-sm">{selectedModel?.name ?? defaultLabel ?? ''}</span>
        <ChevronDownIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
      </button>

      {isOpen && (
        <div className={`absolute ${dropdownPositionClass} w-60 bg-surface rounded-xl popover-enter shadow-popover z-50 border-border border overflow-hidden`}>
          <div className="max-h-64 overflow-y-auto">
            {defaultLabel && (
              <button
                type="button"
                onClick={() => handleModelSelect(null)}
                className={`w-full px-4 py-2.5 text-left dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover flex items-center justify-between transition-colors ${
                  !selectedModel ? 'dark:bg-claude-darkSurfaceHover/50 bg-claude-surfaceHover/50' : ''
                }`}
              >
                <span className="text-sm">{defaultLabel}</span>
                {!selectedModel && <CheckIcon className="h-4 w-4 text-claude-accent" />}
              </button>
            )}
            {hasBothGroups ? (
              <>
                {renderGroupHeader(i18nService.t('modelGroupServer'))}
                {serverModels.map(renderModelItem)}
                <div className="my-1 border-t border-border" />
                {renderGroupHeader(i18nService.t('modelGroupUser'))}
                {userModels.map(renderModelItem)}
              </>
            ) : (
              availableModels.map(renderModelItem)
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ModelSelector;
