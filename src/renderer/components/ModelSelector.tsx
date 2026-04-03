import React from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../store';
import { ChevronDownIcon, CheckIcon } from '@heroicons/react/24/outline';
import { setSelectedModel, isSameModelIdentity, getModelIdentityKey } from '../store/slices/modelSlice';
import type { Model } from '../store/slices/modelSlice';
import { i18nService } from '../services/i18n';

interface ModelSelectorProps {
  dropdownDirection?: 'up' | 'down';
}

const ModelSelector: React.FC<ModelSelectorProps> = ({ dropdownDirection = 'down' }) => {
  const dispatch = useDispatch();
  const [isOpen, setIsOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const selectedModel = useSelector((state: RootState) => state.model.selectedModel);
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

  const handleModelSelect = (model: Model) => {
    dispatch(setSelectedModel(model));
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

  const renderModelItem = (model: Model) => (
    <button
      key={getModelIdentityKey(model)}
      onClick={() => handleModelSelect(model)}
      className={`w-full px-4 py-2.5 text-left text-foreground hover:bg-surface-raised flex items-center justify-between transition-colors ${
        isSameModelIdentity(model, selectedModel) ? 'bg-surface-raised/50' : ''
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
      {isSameModelIdentity(model, selectedModel) && (
        <CheckIcon className="h-4 w-4 text-primary" />
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
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center space-x-2 px-3 py-1.5 rounded-xl hover:bg-surface-raised text-foreground transition-colors cursor-pointer ${isOpen ? 'bg-surface-raised' : ''}`}
      >
        <span className="font-medium text-sm">{selectedModel.name}</span>
        <ChevronDownIcon className="h-4 w-4 text-secondary" />
      </button>

      {isOpen && (
        <div className={`absolute ${dropdownPositionClass} w-60 bg-surface rounded-xl popover-enter shadow-popover z-50 border-border border overflow-hidden`}>
          <div className="max-h-64 overflow-y-auto">
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
