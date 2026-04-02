import React, { useState } from 'react';
import { i18nService } from '../../services/i18n';
import { agentService } from '../../services/agent';

interface AgentItem {
  id: string;
  name: string;
  icon: string;
  description: string;
  source: string;
}

interface AgentExportSelectModalProps {
  agents: AgentItem[];
  onClose: () => void;
}

const AgentExportSelectModal: React.FC<AgentExportSelectModalProps> = ({
  agents,
  onClose,
}) => {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isExporting, setIsExporting] = useState(false);

  const exportableAgents = agents.filter((a) => a.id !== 'main');
  const allSelected = exportableAgents.length > 0 && selectedIds.size === exportableAgents.length;

  const handleToggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleToggleAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(exportableAgents.map((a) => a.id)));
    }
  };

  const handleExport = async () => {
    if (selectedIds.size === 0) return;
    setIsExporting(true);
    try {
      await agentService.exportAgents([...selectedIds]);
      onClose();
    } finally {
      setIsExporting(false);
    }
  };

  if (exportableAgents.length === 0) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background rounded-xl shadow-2xl border border-border w-full max-w-md mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">
            {i18nService.t('agentExport')}
          </h2>
          <p className="text-sm text-secondary mt-1">
            {i18nService.t('agentExportSelectHint')}
          </p>
        </div>

        {/* Select All */}
        <div className="px-6 py-2 border-b border-border flex items-center gap-3">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={handleToggleAll}
            className="h-4 w-4 rounded border-border text-primary focus:ring-primary cursor-pointer"
          />
          <span className="text-sm text-secondary">
            {i18nService.t('agentExportSelectAll')}
            {selectedIds.size > 0 && (
              <span className="ml-2 text-xs text-primary">
                ({selectedIds.size})
              </span>
            )}
          </span>
        </div>

        {/* Agent List */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {exportableAgents.map((agent) => (
            <label
              key={agent.id}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface-raised cursor-pointer transition-colors"
            >
              <input
                type="checkbox"
                checked={selectedIds.has(agent.id)}
                onChange={() => handleToggle(agent.id)}
                className="h-4 w-4 rounded border-border text-primary focus:ring-primary cursor-pointer"
              />
              <span className="text-xl shrink-0">{agent.icon || '🤖'}</span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground truncate">
                  {agent.name}
                </div>
                {agent.description && (
                  <div className="text-xs text-secondary truncate">
                    {agent.description}
                  </div>
                )}
              </div>
              <span className="text-xs text-secondary/50 shrink-0">
                {agent.source === 'preset' ? 'Preset' : 'Custom'}
              </span>
            </label>
          ))}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isExporting}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-border text-foreground hover:bg-surface-raised transition-colors disabled:opacity-50"
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={selectedIds.size === 0 || isExporting}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isExporting
              ? '...'
              : `${i18nService.t('agentExport')} (${selectedIds.size})`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AgentExportSelectModal;
