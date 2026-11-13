import { i18nService } from '../../services/i18n';
import {
  SidebarTaskStatusFilter,
  SidebarTaskTimeFilter,
} from './taskFilter';

const STATUS_LABEL_KEYS: Record<SidebarTaskStatusFilter, string> = {
  [SidebarTaskStatusFilter.All]: 'sidebarFilterStatusAll',
  [SidebarTaskStatusFilter.Running]: 'sidebarFilterStatusRunning',
  [SidebarTaskStatusFilter.PendingPermission]: 'sidebarFilterStatusPendingPermission',
  [SidebarTaskStatusFilter.CompletedUnread]: 'sidebarFilterStatusCompletedUnread',
  [SidebarTaskStatusFilter.Error]: 'sidebarFilterStatusError',
};

const TIME_LABEL_KEYS: Record<SidebarTaskTimeFilter, string> = {
  [SidebarTaskTimeFilter.All]: 'sidebarFilterTimeAll',
  [SidebarTaskTimeFilter.Today]: 'sidebarFilterTimeToday',
  [SidebarTaskTimeFilter.Last7Days]: 'sidebarFilterTimeLast7Days',
  [SidebarTaskTimeFilter.Last30Days]: 'sidebarFilterTimeLast30Days',
};

export const getSidebarTaskStatusFilterLabel = (status: SidebarTaskStatusFilter): string => (
  i18nService.t(STATUS_LABEL_KEYS[status])
);

export const getSidebarTaskTimeFilterLabel = (time: SidebarTaskTimeFilter): string => (
  i18nService.t(TIME_LABEL_KEYS[time])
);
