import { CheckIcon, ChevronDownIcon, CubeIcon } from '@heroicons/react/24/outline';
import React from 'react';
import ReactDOM from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';

import { i18nService } from '../services/i18n';
import { RootState } from '../store';
import type { Model } from '../store/slices/modelSlice';
import { getModelIdentityKey, isSameModelIdentity, setSelectedModel } from '../store/slices/modelSlice';
import { getProviderIcon } from './providerIconMap';

interface ModelSelectorProps {
  dropdownDirection?: 'up' | 'down' | 'auto';
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

/** Max height of the dropdown panel in px (matches max-h-72 = 288px). */
const DROPDOWN_MAX_H = 288;
const GAP = 4;

const ModelSelector: React.FC<ModelSelectorProps> = ({
  dropdownDirection = 'auto',
  value,
  onChange,
  defaultLabel,
}) => {
  const dispatch = useDispatch();
  const [isOpen, setIsOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = React.useState<React.CSSProperties>({ position: 'fixed', visibility: 'hidden' });

  const controlled = onChange !== undefined;
  const globalSelectedModel = useSelector((state: RootState) => state.model.selectedModel);
  const selectedModel = controlled ? value ?? null : globalSelectedModel;
  const availableModels = useSelector((state: RootState) => state.model.availableModels);

  const computePosition = React.useCallback((): React.CSSProperties => {
    if (!buttonRef.current) return { position: 'fixed', visibility: 'hidden' };
    const rect = buttonRef.current.getBoundingClientRect();

    let dir = dropdownDirection;
    if (dir === 'auto') {
      const spaceBelow = window.innerHeight - rect.bottom - GAP;
      const spaceAbove = rect.top - GAP;
      dir = spaceBelow >= DROPDOWN_MAX_H || spaceBelow >= spaceAbove ? 'down' : 'up';
    }

    const style: React.CSSProperties = {
      position: 'fixed',
      zIndex: 9999,
      left: rect.left,
    };

    if (dir === 'up') {
      style.bottom = window.innerHeight - rect.top + GAP;
      style.maxHeight = rect.top - GAP;
    } else {
      style.top = rect.bottom + GAP;
      style.maxHeight = window.innerHeight - rect.bottom - GAP;
    }

    return style;
  }, [dropdownDirection]);

  // Reposition on scroll/resize while open
  React.useEffect(() => {
    if (!isOpen) return;

    const handleReposition = () => setDropdownStyle(computePosition());

    window.addEventListener('scroll', handleReposition, true);
    window.addEventListener('resize', handleReposition);
    return () => {
      window.removeEventListener('scroll', handleReposition, true);
      window.removeEventListener('resize', handleReposition);
    };
  }, [isOpen, computePosition]);

  // Close on click outside or Escape key
  React.useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const inContainer = containerRef.current?.contains(target) ?? false;
      const inDropdown = dropdownRef.current?.contains(target) ?? false;
      if (!inContainer && !inDropdown) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };

    // Use 'click' instead of 'mousedown' to avoid race with portal mount
    document.addEventListener('click', handleClickOutside, true);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('click', handleClickOutside, true);
      document.removeEventListener('keydown', handleKeyDown);
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

  if (availableModels.length === 0) {
    return (
      <div className="px-3 py-1.5 rounded-xl bg-surface text-secondary text-sm">
        {i18nService.t('modelSelectorNoModels')}
      </div>
    );
  }

  const serverModels = availableModels.filter(m => m.isServerModel);
  const userModels = availableModels.filter(m => !m.isServerModel);
  const hasBothGroups = serverModels.length > 0 && userModels.length > 0;

  const isSelected = (model: Model): boolean => {
    if (!selectedModel) return false;
    return isSameModelIdentity(model, selectedModel);
  };

  const renderProviderIcon = (model: Model, size = 'h-3.5 w-3.5') => {
    if (model.isServerModel) return <CubeIcon className={`${size} flex-shrink-0`} />;
    const IconComponent = getProviderIcon(model.providerKey);
    return <IconComponent className={`${size} flex-shrink-0`} />;
  };

  const renderModelItem = (model: Model) => (
    <button
      type="button"
      key={getModelIdentityKey(model)}
      onClick={() => handleModelSelect(model)}
      className={`w-full px-2.5 py-1 text-left hover:bg-surface-raised flex items-center gap-1.5 transition-colors ${
        isSelected(model) ? 'bg-surface-raised/60' : ''
      }`}
    >
      <span className="flex-shrink-0 text-secondary">
        {renderProviderIcon(model)}
      </span>
      <div className="flex items-center gap-1 min-w-0 flex-1">
        <span className="text-[13px] text-foreground truncate" title={model.name}>{model.name}</span>
        {model.supportsImage && (
          <span className="text-[10px] leading-none px-1 py-0.5 rounded bg-primary/10 text-primary whitespace-nowrap">
            {i18nService.t('imageInput')}
          </span>
        )}
      </div>
      {isSelected(model) && (
        <CheckIcon className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
      )}
    </button>
  );

  const renderGroupHeader = (label: string) => (
    <div className="px-2.5 py-1 text-[11px] font-medium text-secondary">
      {label}
    </div>
  );

  const dropdown = isOpen
    ? ReactDOM.createPortal(
        <div
          ref={dropdownRef}
          className="min-w-[180px] max-w-[280px] w-max bg-surface rounded-xl popover-enter shadow-popover border-border border flex flex-col overflow-hidden"
          style={dropdownStyle}
        >
          <div className="overflow-y-auto py-1">
            {defaultLabel && (
              <>
                <button
                  type="button"
                  onClick={() => handleModelSelect(null)}
                  className={`w-full px-2.5 py-1.5 text-left hover:bg-surface-raised flex items-center gap-1.5 transition-colors ${
                    !selectedModel ? 'bg-surface-raised/60' : ''
                  }`}
                >
                  <span className="flex-shrink-0 text-secondary">
                    <CubeIcon className="h-3.5 w-3.5 flex-shrink-0" />
                  </span>
                  <span className="text-[13px] text-foreground flex-1">{defaultLabel}</span>
                  {!selectedModel && <CheckIcon className="h-3.5 w-3.5 flex-shrink-0 text-primary" />}
                </button>
                <div className="my-0.5 border-t border-border" />
              </>
            )}
            {hasBothGroups ? (
              <>
                {renderGroupHeader(i18nService.t('modelGroupServer'))}
                {serverModels.map(renderModelItem)}
                <div className="my-0.5 border-t border-border" />
                {renderGroupHeader(i18nService.t('modelGroupUser'))}
                {userModels.map(renderModelItem)}
              </>
            ) : (
              availableModels.map(renderModelItem)
            )}
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <div ref={containerRef} className="relative cursor-pointer">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          if (!isOpen) {
            // Compute position synchronously before opening to prevent flicker
            setDropdownStyle(computePosition());
          }
          setIsOpen(!isOpen);
        }}
        className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg hover:bg-surface-raised text-foreground transition-colors cursor-pointer ${isOpen ? 'bg-surface-raised' : ''}`}
      >
        <span className="flex-shrink-0 text-secondary">
          {selectedModel
            ? renderProviderIcon(selectedModel)
            : <CubeIcon className="h-3.5 w-3.5 flex-shrink-0" />
          }
        </span>
        <span className="font-medium text-sm truncate max-w-[160px]" title={selectedModel?.name ?? defaultLabel ?? ''}>
          {selectedModel?.name ?? defaultLabel ?? ''}
        </span>
        {selectedModel?.supportsImage && (
          <span className="text-[10px] leading-none px-1 py-0.5 rounded bg-primary/10 text-primary whitespace-nowrap">
            {i18nService.t('imageInput')}
          </span>
        )}
        <ChevronDownIcon className={`h-3 w-3 flex-shrink-0 text-secondary transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {dropdown}
    </div>
  );
};

export default ModelSelector;