import { i18nService } from '../../services/i18n';
import { McpToolFilterSummaryKind, summarizeMcpToolFilter } from '../../services/mcpToolFilter';
import type { McpToolFilter } from '../../types/mcp';

/** One-line description of a server's tool filter, e.g. "3 hidden". */
export const describeMcpToolFilter = (filter: McpToolFilter | undefined): string => {
  const summary = summarizeMcpToolFilter(filter);
  switch (summary.kind) {
    case McpToolFilterSummaryKind.Hidden:
      return i18nService.t('mcpToolsSummaryHidden').replace('{count}', String(summary.count));
    case McpToolFilterSummaryKind.Only:
      return i18nService.t('mcpToolsSummaryOnly').replace('{count}', String(summary.count));
    case McpToolFilterSummaryKind.Custom:
      return i18nService.t('mcpToolsSummaryCustom');
    case McpToolFilterSummaryKind.All:
    default:
      return i18nService.t('mcpToolsSummaryAll');
  }
};
