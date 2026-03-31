import React, { useState } from 'react';
import { agentService } from '../../services/agent';
import { i18nService } from '../../services/i18n';
import { ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import AgentSkillSelector from './AgentSkillSelector';
import { findDuplicateAgentByName } from './agentNameUtils';

interface AgentCreateModalProps {
  isOpen: boolean;
  agents: Array<{ id: string; name: string }>;
  onClose: () => void;
  onOpenExistingAgent: (agentId: string) => void;
}

const AgentCreateModal: React.FC<AgentCreateModalProps> = ({
  isOpen,
  agents,
  onClose,
  onOpenExistingAgent,
}) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [icon, setIcon] = useState('');
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [duplicateAgentId, setDuplicateAgentId] = useState<string | null>(null);

  if (!isOpen) return null;

  const resetForm = () => {
    setName('');
    setDescription('');
    setSystemPrompt('');
    setIcon('');
    setSkillIds([]);
  };

  const duplicateAgent = duplicateAgentId
    ? agents.find((agent) => agent.id === duplicateAgentId) ?? null
    : null;

  const handleCreate = async () => {
    if (!name.trim()) return;

    const existingAgent = findDuplicateAgentByName(agents, name);
    if (existingAgent) {
      setDuplicateAgentId(existingAgent.id);
      return;
    }

    setCreating(true);
    try {
      const agent = await agentService.createAgent({
        name: name.trim(),
        description: description.trim(),
        systemPrompt: systemPrompt.trim(),
        icon: icon.trim() || undefined,
        skillIds,
      });
      if (agent) {
        agentService.switchAgent(agent.id);
        onClose();
        resetForm();
      }
    } finally {
      setCreating(false);
    }
  };

  const handleOpenExistingAgent = () => {
    if (!duplicateAgentId) return;
    setDuplicateAgentId(null);
    onOpenExistingAgent(duplicateAgentId);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-md mx-4 rounded-xl shadow-xl bg-white dark:bg-claude-darkSurface border dark:border-claude-darkBorder border-claude-border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b dark:border-claude-darkBorder border-claude-border">
          <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
            {i18nService.t('createAgent') || 'Create Agent'}
          </h3>
          <button type="button" onClick={onClose} className="p-1 rounded-lg hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover">
            <XMarkIcon className="h-5 w-5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
              {i18nService.t('agentName') || 'Name'} *
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                placeholder="🤖"
                className="w-12 px-2 py-2 text-center rounded-lg border dark:border-claude-darkBorder border-claude-border bg-transparent dark:text-claude-darkText text-claude-text text-lg"
                maxLength={4}
              />
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={i18nService.t('agentNamePlaceholder') || 'Agent name'}
                className="flex-1 px-3 py-2 rounded-lg border dark:border-claude-darkBorder border-claude-border bg-transparent dark:text-claude-darkText text-claude-text text-sm"
                autoFocus
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
              {i18nService.t('agentDescription') || 'Description'}
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={i18nService.t('agentDescriptionPlaceholder') || 'Brief description'}
              className="w-full px-3 py-2 rounded-lg border dark:border-claude-darkBorder border-claude-border bg-transparent dark:text-claude-darkText text-claude-text text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
              {i18nService.t('systemPrompt') || 'System Prompt'}
            </label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={i18nService.t('systemPromptPlaceholder') || 'Describe the agent\'s role and behavior...'}
              rows={4}
              className="w-full px-3 py-2 rounded-lg border dark:border-claude-darkBorder border-claude-border bg-transparent dark:text-claude-darkText text-claude-text text-sm resize-none"
            />
          </div>
          <AgentSkillSelector selectedSkillIds={skillIds} onChange={setSkillIds} />
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t dark:border-claude-darkBorder border-claude-border">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            {i18nService.t('cancel') || 'Cancel'}
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={!name.trim() || creating}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-claude-accent text-white hover:bg-claude-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {creating ? (i18nService.t('creating') || 'Creating...') : (i18nService.t('create') || 'Create')}
          </button>
        </div>
      </div>
      {duplicateAgent && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center"
          onClick={(e) => {
            e.stopPropagation();
            setDuplicateAgentId(null);
          }}
        >
          <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />
          <div
            className="relative w-80 rounded-xl shadow-2xl dark:bg-claude-darkSurface bg-white border dark:border-claude-darkBorder border-claude-border p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col items-center text-center">
              <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mb-3">
                <ExclamationTriangleIcon className="w-5 h-5 text-amber-500" />
              </div>
              <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-5">
                {i18nService.t('duplicateAgentExists')}
              </h3>
              <div className="flex items-center gap-3 w-full">
                <button
                  type="button"
                  onClick={handleOpenExistingAgent}
                  className="flex-1 px-4 py-2 text-sm rounded-lg bg-claude-accent text-white hover:bg-claude-accent/90 transition-colors"
                >
                  {i18nService.t('viewExistingAgent')}
                </button>
                <button
                  type="button"
                  onClick={() => setDuplicateAgentId(null)}
                  className="flex-1 px-4 py-2 text-sm rounded-lg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                >
                  {i18nService.t('cancel')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AgentCreateModal;
