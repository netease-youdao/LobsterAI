import type { ModelThinkingLevel } from '@shared/providers/modelThinking';
import { useCallback, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';

import { agentService } from '../../services/agent';
import { i18nService } from '../../services/i18n';
import type { Model } from '../../store/slices/modelSlice';
import { setDefaultSelectedModel, setSelectedModel } from '../../store/slices/modelSlice';
import { toOpenClawModelRef } from '../../utils/openclawModelRef';

const logAgentModelPersistence = (level: 'debug' | 'warn', message: string): void => {
  if (level === 'warn') {
    console.warn(`[AgentModelSelection] ${message}`);
  } else {
    console.debug(`[AgentModelSelection] ${message}`);
  }
  try {
    window.electron?.log?.fromRenderer?.(level, 'AgentModelSelection', message);
  } catch {
    // Persistence must not fail because diagnostic IPC is unavailable.
  }
};

export function usePersistAgentModelSelection({
  agentId,
  syncDefaultModel,
}: {
  agentId: string;
  syncDefaultModel: boolean;
}) {
  const dispatch = useDispatch();
  const [isPersistingAgentModel, setIsPersistingAgentModel] = useState(false);
  const requestIdRef = useRef(0);

  const persistAgentModelSelection = useCallback(async (
    model: Model,
    thinkingLevel: ModelThinkingLevel | '',
  ): Promise<boolean> => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const modelRef = toOpenClawModelRef(model);
    setIsPersistingAgentModel(true);
    logAgentModelPersistence(
      'debug',
      `saving agent ${agentId} model ${modelRef}; thinking level is ${thinkingLevel || 'default'}; server model is ${model.isServerModel === true}`,
    );

    try {
      const updatedAgent = await agentService.updateAgent(agentId, {
        model: modelRef,
        thinkingLevel,
      });
      if (requestId !== requestIdRef.current) {
        return false;
      }
      if (!updatedAgent) {
        logAgentModelPersistence('warn', `saving agent ${agentId} model ${modelRef} returned no agent`);
        window.dispatchEvent(new CustomEvent('app:showToast', {
          detail: i18nService.t('agentSaveFailed'),
        }));
        return false;
      }

      dispatch(setSelectedModel({ agentId, model }));
      if (syncDefaultModel) {
        dispatch(setDefaultSelectedModel(model));
      }
      logAgentModelPersistence(
        'debug',
        `saved agent ${agentId} model ${modelRef}; thinking level is ${thinkingLevel || 'default'}`,
      );
      return true;
    } finally {
      if (requestId === requestIdRef.current) {
        setIsPersistingAgentModel(false);
      }
    }
  }, [agentId, dispatch, syncDefaultModel]);

  return {
    isPersistingAgentModel,
    persistAgentModelSelection,
  };
}
