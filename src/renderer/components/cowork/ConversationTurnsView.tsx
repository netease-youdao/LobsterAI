/**
 * ConversationTurnsView — reusable conversation rendering component.
 * Used by both CoworkSessionDetail (main session) and SubagentSessionDetail.
 */
import React, { useMemo } from 'react';

import type { Artifact } from '../../types/artifact';
import { PREVIEWABLE_ARTIFACT_TYPES } from '../../types/artifact';
import type { CoworkMessage } from '../../types/cowork';
import type { MarketplaceKit } from '../../types/kit';
import type { Skill } from '../../types/skill';
import AssistantTurnBlock from './AssistantTurnBlock';
import LazyRenderTurn from './LazyRenderTurn';
import {
  buildConversationTurns,
  buildDisplayItems,
  hasRenderableAssistantContent,
} from './messageDisplayUtils';
import UserMessageItem from './UserMessageItem';

export interface ConversationTurnsViewProps {
  messages: CoworkMessage[];
  isStreaming?: boolean;
  skills?: Skill[];
  marketplaceKits?: MarketplaceKit[];
  artifacts?: Artifact[];
  resolveLocalFilePath?: (href: string, text: string) => string | null;
  mapDisplayText?: (value: string) => string;
  localServiceDirectory?: string;
  onOpenLocalService?: (artifact: Artifact) => void;
  onReEdit?: (message: CoworkMessage) => void;
  /** When true, hides re-edit buttons and other interactive elements */
  readOnly?: boolean;
  className?: string;
  /** Optional render props for additional per-turn attributes (e.g., data-rail-index, data-export-role) */
  renderTurnWrapper?: (props: {
    turn: ReturnType<typeof buildConversationTurns>[number];
    index: number;
    isLastTurn: boolean;
    children: React.ReactNode;
  }) => React.ReactNode;
}

const EMPTY_SKILLS: Skill[] = [];
const EMPTY_KITS: MarketplaceKit[] = [];
const EMPTY_ARTIFACTS: Artifact[] = [];

const ConversationTurnsView: React.FC<ConversationTurnsViewProps> = ({
  messages,
  isStreaming = false,
  skills = EMPTY_SKILLS,
  marketplaceKits = EMPTY_KITS,
  artifacts = EMPTY_ARTIFACTS,
  resolveLocalFilePath,
  mapDisplayText,
  localServiceDirectory,
  onOpenLocalService,
  onReEdit,
  readOnly = false,
  className,
  renderTurnWrapper,
}) => {
  const displayItems = useMemo(() => buildDisplayItems(messages), [messages]);
  const turns = useMemo(() => buildConversationTurns(displayItems), [displayItems]);

  if (turns.length === 0) {
    if (!isStreaming) return null;
    return (
      <div className={className} data-export-role="assistant-block">
        <AssistantTurnBlock
          turn={{
            id: 'streaming-only',
            userMessage: null,
            assistantItems: [],
          }}
          resolveLocalFilePath={resolveLocalFilePath}
          showTypingIndicator
          showCopyButtons={false}
        />
      </div>
    );
  }

  return (
    <div className={className}>
      {turns.map((turn, index) => {
        const isLastTurn = index === turns.length - 1;
        const showTypingIndicator = isStreaming && isLastTurn && !hasRenderableAssistantContent(turn);
        const showAssistantBlock = turn.assistantItems.length > 0 || showTypingIndicator;
        const alwaysRender = index >= turns.length - 3;

        // Compute per-turn artifacts
        const turnMessageIds = new Set<string>();
        for (const item of turn.assistantItems) {
          if (item.type === 'assistant' || item.type === 'system' || item.type === 'tool_result') {
            turnMessageIds.add(item.message.id);
          } else if (item.type === 'tool_group') {
            turnMessageIds.add(item.group.toolUse.id);
            if (item.group.toolResult) {
              turnMessageIds.add(item.group.toolResult.id);
            }
          }
        }
        const turnArtifacts = artifacts.filter(
          a => turnMessageIds.has(a.messageId) && PREVIEWABLE_ARTIFACT_TYPES.has(a.type)
        );

        const turnContent = (
          <LazyRenderTurn key={turn.id} turnId={turn.id} alwaysRender={alwaysRender} data-turn-index={index}>
            {turn.userMessage && (
              <div data-export-role="user-message" className={isLastTurn ? 'animate-message-in' : undefined}>
                <UserMessageItem
                  message={turn.userMessage}
                  skills={skills}
                  marketplaceKits={marketplaceKits}
                  onReEdit={readOnly ? undefined : onReEdit}
                />
              </div>
            )}
            {showAssistantBlock && (
              <div data-export-role="assistant-block" className={isLastTurn ? 'animate-message-in' : undefined}>
                <AssistantTurnBlock
                  turn={turn}
                  artifacts={turnArtifacts}
                  resolveLocalFilePath={resolveLocalFilePath}
                  mapDisplayText={mapDisplayText}
                  localServiceDirectory={localServiceDirectory}
                  onOpenLocalService={onOpenLocalService}
                  showTypingIndicator={showTypingIndicator}
                  showCopyButtons={!isStreaming || !isLastTurn}
                />
              </div>
            )}
          </LazyRenderTurn>
        );

        if (renderTurnWrapper) {
          return renderTurnWrapper({ turn, index, isLastTurn, children: turnContent });
        }

        return turnContent;
      })}
    </div>
  );
};

export default ConversationTurnsView;
