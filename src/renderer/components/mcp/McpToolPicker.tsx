import { ArrowPathIcon } from '@heroicons/react/20/solid';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  type McpDiscoveredTool,
  McpToolDiscoveryErrorCode,
  type McpToolDiscoveryRequest,
} from '../../../shared/mcp/toolDiscovery';
import { i18nService } from '../../services/i18n';
import { mcpService } from '../../services/mcp';
import {
  buildMcpPickerFilter,
  findUnmatchedMcpToolFilterEntries,
  isMcpToolAllowed,
  isPlainExcludeFilter,
  removeMcpToolFilterEntries,
} from '../../services/mcpToolFilter';
import type { McpToolFilter } from '../../types/mcp';
import { formatTokenCount } from '../../utils/tokenFormat';
import SearchIcon from '../icons/SearchIcon';
import { reportMcpAction } from './analytics';
import { describeMcpToolFilter } from './mcpToolFilterLabels';

interface McpToolPickerProps {
  /** Built from the form's connection fields; null while they are incomplete. */
  request: McpToolDiscoveryRequest | null;
  /** Shown instead of loading when the form cannot connect yet. */
  blockedReason?: string;
  filter: McpToolFilter | undefined;
  onChange: (filter: McpToolFilter | undefined) => void;
  labelClassName: string;
}

interface LoadFailure {
  message: string;
  detail?: string;
}

// The server name does not change which tools come back.
const getRequestKey = (request: McpToolDiscoveryRequest | null): string =>
  request ? JSON.stringify({ ...request, name: undefined }) : '';

const sumTokens = (tools: McpDiscoveredTool[]): number =>
  tools.reduce((total, tool) => total + tool.estimatedTokens, 0);

// After this long a stdio load is most likely an `npx` download, so say so.
const SLOW_LOAD_HINT_SECONDS = 8;

/**
 * Lists a server's tools so they can be switched on and off one by one. The
 * list comes from connecting with the form's current settings; the choice is
 * stored as exact names of the unchecked tools, which OpenClaw drops before
 * the model request is built.
 */
const McpToolPicker: React.FC<McpToolPickerProps> = ({
  request,
  blockedReason,
  filter,
  onChange,
  labelClassName,
}) => {
  const [tools, setTools] = useState<McpDiscoveredTool[] | null>(null);
  const [loadedKey, setLoadedKey] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [query, setQuery] = useState('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // Answers to a superseded load (or after unmount) are dropped.
  const loadSeqRef = useRef(0);

  useEffect(() => () => {
    loadSeqRef.current += 1;
  }, []);

  useEffect(() => {
    if (!isLoading) return undefined;
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [isLoading]);

  const handleLoad = async () => {
    if (!request || isLoading) return;
    const seq = ++loadSeqRef.current;
    const requestKey = getRequestKey(request);
    setIsLoading(true);
    setFailure(null);
    const result = await mcpService.listTools(request);
    if (seq !== loadSeqRef.current) return;
    setIsLoading(false);
    if (result.success) {
      setTools(result.tools);
      setLoadedKey(requestKey);
      setQuery('');
      reportMcpAction('tool_discovery_success', {
        source: 'mcp_form',
        transportType: request.transportType,
        toolCount: result.tools.length,
        durationMs: result.durationMs,
      });
      return;
    }
    setFailure(
      result.code === McpToolDiscoveryErrorCode.Timeout
        ? {
          message: i18nService.t('mcpToolsLoadTimeout')
            .replace('{seconds}', String(Math.round((result.timeoutMs ?? 0) / 1000))),
        }
        : { message: i18nService.t('mcpToolsLoadFailed'), detail: result.error },
    );
    reportMcpAction('tool_discovery_failed', {
      source: 'mcp_form',
      transportType: request.transportType,
      result: 'failed',
      errorCode: result.code,
    });
  };

  const toolNames = useMemo(() => tools?.map(tool => tool.name) ?? [], [tools]);
  const enabledNames = useMemo(
    () => new Set(toolNames.filter(name => isMcpToolAllowed(filter, name))),
    [filter, toolNames],
  );
  const visibleTools = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!tools || !needle) return tools ?? [];
    return tools.filter(tool => [tool.name, tool.title, tool.description]
      .some(text => text?.toLowerCase().includes(needle)));
  }, [tools, query]);
  const unmatchedEntries = useMemo(
    () => (tools ? findUnmatchedMcpToolFilterEntries(filter, toolNames) : []),
    [filter, toolNames, tools],
  );

  const applyEnabled = (next: Set<string>) => {
    onChange(buildMcpPickerFilter(filter, toolNames, next));
  };

  const toggleTool = (name: string) => {
    const next = new Set(enabledNames);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    applyEnabled(next);
  };

  // Bulk actions follow the search, so "issue" + select all picks the issue tools.
  const setVisibleEnabled = (enabled: boolean) => {
    const next = new Set(enabledNames);
    for (const tool of visibleTools) {
      if (enabled) next.add(tool.name);
      else next.delete(tool.name);
    }
    applyEnabled(next);
  };

  const enabledTools = tools?.filter(tool => enabledNames.has(tool.name)) ?? [];
  const enabledTokens = sumTokens(enabledTools);
  const savedTokens = sumTokens(tools ?? []) - enabledTokens;
  const summaryKey = savedTokens > 0 ? 'mcpToolsEnabledSummarySaved' : 'mcpToolsEnabledSummary';
  const summary = i18nService.t(summaryKey)
    .replace('{enabled}', String(enabledTools.length))
    .replace('{total}', String(tools?.length ?? 0))
    .replace('{tokens}', formatTokenCount(enabledTokens))
    .replace('{saved}', formatTokenCount(savedTokens));
  const isStale = tools !== null && getRequestKey(request) !== loadedKey;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <label className={labelClassName}>{i18nService.t('mcpTools')}</label>
        <button
          type="button"
          onClick={() => { void handleLoad(); }}
          disabled={!request || isLoading}
          title={!request ? blockedReason : undefined}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
        >
          <ArrowPathIcon className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          {i18nService.t(tools ? 'mcpToolsReload' : 'mcpToolsLoad')}
        </button>
      </div>
      <p className="text-xs leading-5 text-secondary">{i18nService.t('mcpToolsHint')}</p>

      {!tools && !isLoading && !failure && (
        <p className="text-xs text-foreground">
          {describeMcpToolFilter(filter)}
          {!request && blockedReason && (
            <span className="text-secondary"> · {blockedReason}</span>
          )}
        </p>
      )}

      {isLoading && !tools && (
        <div className="flex items-start gap-2 rounded-lg border border-border px-3 py-3 text-xs leading-5 text-secondary">
          <ArrowPathIcon className="mt-1 h-3.5 w-3.5 flex-shrink-0 animate-spin" />
          <span>
            {i18nService.t('mcpToolsLoading')}
            {request?.transportType === 'stdio' && elapsedSeconds >= SLOW_LOAD_HINT_SECONDS && (
              <span className="block">
                {i18nService.t('mcpToolsLoadingSlow').replace('{seconds}', String(elapsedSeconds))}
              </span>
            )}
          </span>
        </div>
      )}

      {failure && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2">
          <p className="text-xs font-medium text-red-600 dark:text-red-400">{failure.message}</p>
          {failure.detail && (
            <pre className="m-0 mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-none bg-transparent p-0 font-mono text-[11px] leading-4 text-red-600/80 dark:text-red-400/80">
              {failure.detail}
            </pre>
          )}
        </div>
      )}

      {tools && (
        <div className={`overflow-hidden rounded-xl border border-border ${isLoading ? 'opacity-60' : ''}`}>
          {isStale && (
            <p className="border-b border-border bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              {i18nService.t('mcpToolsStale')}
            </p>
          )}
          {!isPlainExcludeFilter(filter) && (
            <p className="border-b border-border bg-surface-raised px-3 py-2 text-xs leading-5 text-secondary">
              {i18nService.t('mcpToolsAdvancedRuleNote')}
            </p>
          )}

          {tools.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-secondary">{i18nService.t('mcpToolsEmpty')}</p>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <div className="relative min-w-0 flex-1">
                  <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-secondary" />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={i18nService.t('mcpToolsSearchPlaceholder')}
                    className="w-full rounded-lg border border-border bg-background py-1.5 pl-7 pr-2 text-xs text-foreground placeholder-secondary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setVisibleEnabled(true)}
                  disabled={visibleTools.length === 0}
                  className="flex-shrink-0 text-xs text-primary transition-colors hover:text-primary/80 disabled:opacity-50"
                >
                  {i18nService.t('mcpToolsSelectAll')}
                </button>
                <span className="text-xs text-secondary/50">·</span>
                <button
                  type="button"
                  onClick={() => setVisibleEnabled(false)}
                  disabled={visibleTools.length === 0}
                  className="flex-shrink-0 text-xs text-primary transition-colors hover:text-primary/80 disabled:opacity-50"
                >
                  {i18nService.t('mcpToolsSelectNone')}
                </button>
              </div>

              <div role="group" aria-label={i18nService.t('mcpTools')} className="max-h-72 overflow-y-auto">
                {visibleTools.length === 0 ? (
                  <p className="px-3 py-6 text-center text-xs text-secondary">{i18nService.t('mcpToolsNoMatch')}</p>
                ) : visibleTools.map((tool) => {
                  const isEnabled = enabledNames.has(tool.name);
                  const tokenLabel = i18nService.t('mcpToolsTokenCount')
                    .replace('{tokens}', formatTokenCount(tool.estimatedTokens));
                  return (
                    <label
                      key={tool.name}
                      className="flex cursor-pointer items-start gap-2.5 border-b border-border/60 px-3 py-2 transition-colors last:border-b-0 hover:bg-surface-raised"
                    >
                      <input
                        type="checkbox"
                        checked={isEnabled}
                        onChange={() => toggleTool(tool.name)}
                        className="mt-0.5 h-4 w-4 flex-shrink-0 cursor-pointer accent-primary"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-baseline gap-1.5">
                          <span className={`truncate font-mono text-xs ${isEnabled ? 'text-foreground' : 'text-secondary'}`}>
                            {tool.name}
                          </span>
                          {tool.title && (
                            <span className="truncate text-xs text-secondary">{tool.title}</span>
                          )}
                        </span>
                        {tool.description && (
                          <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-secondary" title={tool.description}>
                            {tool.description}
                          </span>
                        )}
                      </span>
                      <span className="flex-shrink-0 pt-px text-[11px] tabular-nums text-muted">{tokenLabel}</span>
                    </label>
                  );
                })}
              </div>

              <p className="border-t border-border px-3 py-2 text-xs text-secondary">{summary}</p>
            </>
          )}
        </div>
      )}

      {tools && tools.length > 0 && enabledNames.size === 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">{i18nService.t('mcpToolsAllDisabled')}</p>
      )}
      {unmatchedEntries.length > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {i18nService.t('mcpToolsUnmatched').replace('{names}', unmatchedEntries.join(', '))}
          <button
            type="button"
            onClick={() => onChange(removeMcpToolFilterEntries(filter, unmatchedEntries))}
            className="ml-2 font-medium text-primary transition-colors hover:text-primary/80"
          >
            {i18nService.t('mcpToolsRemoveUnmatched')}
          </button>
        </p>
      )}
    </div>
  );
};

export default McpToolPicker;
