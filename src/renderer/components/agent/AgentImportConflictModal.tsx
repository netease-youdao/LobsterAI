import React, { useState } from 'react';
import { i18nService } from '../../services/i18n';
import { agentService } from '../../services/agent';

interface AgentConflict {
  id: string;
  name: string;
  existingAgentName: string;
  incomingAgentName: string;
}

interface AgentImportConflictModalProps {
  conflicts: AgentConflict[];
  onClose: () => void;
  onResolved: () => void;
}

const AgentImportConflictModal: React.FC<AgentImportConflictModalProps> = ({
  conflicts,
  onClose,
  onResolved,
}) => {
  const [resolutions, setResolutions] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const c of conflicts) {
      init[c.id] = c.id === 'main' ? 'skip' : 'overwrite';
    }
    return init;
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleConfirm = async () => {
    setIsSubmitting(true);
    try {
      const mapped = conflicts.map((c) => ({
        id: c.id,
        action: resolutions[c.id] || 'skip',
      }));
      await agentService.confirmImport(mapped);
      onResolved();
    } finally {
      setIsSubmitting(false);
    }
  };

  if (conflicts.length === 0) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background rounded-xl shadow-2xl border border-border w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">
            {i18nService.t('agentImportConflictTitle')}
          </h2>
          <p className="text-sm text-secondary mt-1">
            {i18nService.t('agentImportConflictDesc')}
          </p>
        </div>

        {/* Conflict List */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {conflicts.map((conflict) => (
            <div
              key={conflict.id}
              className="rounded-lg border border-border p-4"
            >
              <div className="flex items-center justify-between mb-3">
                <div>
                  <span className="text-sm font-medium text-foreground">
                    {conflict.incomingAgentName}
                  </span>
                  <span className="text-xs text-secondary ml-2">
                    (ID: {conflict.id})
                  </span>
                </div>
              </div>
              <div className="text-xs text-secondary mb-3">
                ← {conflict.existingAgentName}
              </div>
              <div className="flex gap-2 flex-wrap">
                <RadioOption
                  label={i18nService.t('agentImportConflictOverwrite')}
                  selected={resolutions[conflict.id] === 'overwrite'}
                  onClick={() =>
                    setResolutions((r) => ({ ...r, [conflict.id]: 'overwrite' }))
                  }
                />
                {conflict.id !== 'main' && (
                  <RadioOption
                    label={i18nService.t('agentImportConflictCreateNew')}
                    selected={resolutions[conflict.id] === 'createNew'}
                    onClick={() =>
                      setResolutions((r) => ({ ...r, [conflict.id]: 'createNew' }))
                    }
                  />
                )}
                <RadioOption
                  label={i18nService.t('agentImportConflictSkip')}
                  selected={resolutions[conflict.id] === 'skip'}
                  onClick={() =>
                    setResolutions((r) => ({ ...r, [conflict.id]: 'skip' }))
                  }
                />
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-border text-foreground hover:bg-surface-raised transition-colors disabled:opacity-50"
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isSubmitting}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors disabled:opacity-50"
          >
            {isSubmitting ? '...' : i18nService.t('confirm')}
          </button>
        </div>
      </div>
    </div>
  );
};

/* ── Radio-style Option Button ──────────────────────── */

const RadioOption: React.FC<{
  label: string;
  selected: boolean;
  onClick: () => void;
}> = ({ label, selected, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
      selected
        ? 'border-primary bg-primary/10 text-primary'
        : 'border-border text-secondary hover:bg-surface-raised'
    }`}
  >
    {label}
  </button>
);

export default AgentImportConflictModal;
