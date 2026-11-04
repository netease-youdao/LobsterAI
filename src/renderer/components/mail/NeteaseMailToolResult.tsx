import { useEffect, useState } from 'react';

import { NeteaseMailMessageMode, NeteaseMailView } from '../../../shared/neteaseMail/constants';
import type { NeteaseMailPresentation } from '../../../shared/neteaseMail/types';
import { neteaseMailService } from '../../services/neteaseMail';
import { getNeteaseMailPresentation } from '../../services/neteaseMailPresentation';
import type { ConsolidatedItem, ToolGroupItem } from '../cowork/messageDisplayUtils';
import NeteaseMailCard from './NeteaseMailCard';

export function buildNeteaseMailPresentations(items: ConsolidatedItem[]): Map<string, NeteaseMailPresentation> {
  const presentations = new Map<string, NeteaseMailPresentation>();
  for (const item of items) {
    if (item.type !== 'tool_group') continue;
    const { toolUse, toolResult } = item.group;
    if (!toolResult || toolResult.metadata?.isFinal === false || toolResult.metadata?.isStreaming) continue;
    const presentation = getNeteaseMailPresentation({
      toolName: toolUse.metadata?.toolName ?? '',
      details: toolResult.metadata?.toolResultDetails,
      text: toolResult.metadata?.toolResult ?? toolResult.content,
      isError: Boolean(toolResult.metadata?.isError || toolResult.metadata?.error),
    });
    if (presentation) presentations.set(toolUse.id, presentation);
  }
  return presentations;
}

export default function NeteaseMailToolResult({ group, presentation }: {
  group: ToolGroupItem; presentation: NeteaseMailPresentation;
}) {
  const [actionsAvailable, setActionsAvailable] = useState(false);
  const confirmation = presentation.kind === NeteaseMailView.Message && presentation.mode === NeteaseMailMessageMode.Confirmation;
  useEffect(() => {
    if (!confirmation) return;
    let active = true;
    void neteaseMailService.getAvailability().then(value => {
      if (active) setActionsAvailable(value.confirmation);
    }).catch(() => { if (active) setActionsAvailable(false); });
    return () => { active = false; };
  }, [confirmation]);
  return <NeteaseMailCard presentation={presentation} actionsAvailable={actionsAvailable} onAction={action => neteaseMailService.resolveConfirmation({
    messageId: group.toolUse.id,
    toolCallId: group.toolUse.metadata?.toolUseId ?? group.toolUse.id,
    action,
  })} />;
}
