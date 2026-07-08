import {
  BellAlertIcon,
  BriefcaseIcon,
  CalendarDaysIcon,
  ChartBarIcon,
  CodeBracketSquareIcon,
  NewspaperIcon,
} from '@heroicons/react/24/outline';
import type React from 'react';

import type { PlanType } from './utils';

export const ScheduledTaskTemplateId = {
  TechBriefing: 'tech_briefing',
  WorkdayWrap: 'workday_wrap',
  MeetingPrep: 'meeting_prep',
  WeeklyReport: 'weekly_report',
  ProjectHealth: 'project_health',
  MonthlyAdmin: 'monthly_admin',
} as const;
export type ScheduledTaskTemplateId =
  typeof ScheduledTaskTemplateId[keyof typeof ScheduledTaskTemplateId];

export const ScheduledTaskTemplateIcon = {
  Newspaper: 'newspaper',
  Briefcase: 'briefcase',
  Calendar: 'calendar',
  Report: 'report',
  Code: 'code',
  Reminder: 'reminder',
} as const;
export type ScheduledTaskTemplateIcon =
  typeof ScheduledTaskTemplateIcon[keyof typeof ScheduledTaskTemplateIcon];

export const templateIconComponents: Record<
  ScheduledTaskTemplateIcon,
  React.ElementType<{ className?: string }>
> = {
  [ScheduledTaskTemplateIcon.Newspaper]: NewspaperIcon,
  [ScheduledTaskTemplateIcon.Briefcase]: BriefcaseIcon,
  [ScheduledTaskTemplateIcon.Calendar]: CalendarDaysIcon,
  [ScheduledTaskTemplateIcon.Report]: ChartBarIcon,
  [ScheduledTaskTemplateIcon.Code]: CodeBracketSquareIcon,
  [ScheduledTaskTemplateIcon.Reminder]: BellAlertIcon,
};

export const ScheduledTaskTemplatePlanType = {
  Daily: 'daily',
  Weekly: 'weekly',
  Monthly: 'monthly',
} as const;

interface ScheduledTaskTemplateSchedule {
  planType: Extract<PlanType, 'daily' | 'weekly' | 'monthly'>;
  hour: number;
  minute: number;
  weekdays?: number[];
  monthDay?: number;
}

export interface ScheduledTaskTemplate {
  id: ScheduledTaskTemplateId;
  icon: ScheduledTaskTemplateIcon;
  titleKey: string;
  descriptionKey: string;
  scheduleLabelKey: string;
  promptKey: string;
  schedule: ScheduledTaskTemplateSchedule;
}

export const SCHEDULED_TASK_TEMPLATES: readonly ScheduledTaskTemplate[] = [
  {
    id: ScheduledTaskTemplateId.TechBriefing,
    icon: ScheduledTaskTemplateIcon.Newspaper,
    titleKey: 'scheduledTasksTemplateTechBriefingTitle',
    descriptionKey: 'scheduledTasksTemplateTechBriefingDesc',
    scheduleLabelKey: 'scheduledTasksTemplateTechBriefingSchedule',
    promptKey: 'scheduledTasksTemplateTechBriefingPrompt',
    schedule: {
      planType: ScheduledTaskTemplatePlanType.Weekly,
      hour: 8,
      minute: 30,
      weekdays: [1, 2, 3, 4, 5],
    },
  },
  {
    id: ScheduledTaskTemplateId.WorkdayWrap,
    icon: ScheduledTaskTemplateIcon.Briefcase,
    titleKey: 'scheduledTasksTemplateWorkdayWrapTitle',
    descriptionKey: 'scheduledTasksTemplateWorkdayWrapDesc',
    scheduleLabelKey: 'scheduledTasksTemplateWorkdayWrapSchedule',
    promptKey: 'scheduledTasksTemplateWorkdayWrapPrompt',
    schedule: {
      planType: ScheduledTaskTemplatePlanType.Weekly,
      hour: 18,
      minute: 0,
      weekdays: [1, 2, 3, 4, 5],
    },
  },
  {
    id: ScheduledTaskTemplateId.MeetingPrep,
    icon: ScheduledTaskTemplateIcon.Calendar,
    titleKey: 'scheduledTasksTemplateMeetingPrepTitle',
    descriptionKey: 'scheduledTasksTemplateMeetingPrepDesc',
    scheduleLabelKey: 'scheduledTasksTemplateMeetingPrepSchedule',
    promptKey: 'scheduledTasksTemplateMeetingPrepPrompt',
    schedule: {
      planType: ScheduledTaskTemplatePlanType.Weekly,
      hour: 8,
      minute: 45,
      weekdays: [1, 2, 3, 4, 5],
    },
  },
  {
    id: ScheduledTaskTemplateId.WeeklyReport,
    icon: ScheduledTaskTemplateIcon.Report,
    titleKey: 'scheduledTasksTemplateWeeklyReportTitle',
    descriptionKey: 'scheduledTasksTemplateWeeklyReportDesc',
    scheduleLabelKey: 'scheduledTasksTemplateWeeklyReportSchedule',
    promptKey: 'scheduledTasksTemplateWeeklyReportPrompt',
    schedule: {
      planType: ScheduledTaskTemplatePlanType.Weekly,
      hour: 17,
      minute: 30,
      weekdays: [5],
    },
  },
  {
    id: ScheduledTaskTemplateId.ProjectHealth,
    icon: ScheduledTaskTemplateIcon.Code,
    titleKey: 'scheduledTasksTemplateProjectHealthTitle',
    descriptionKey: 'scheduledTasksTemplateProjectHealthDesc',
    scheduleLabelKey: 'scheduledTasksTemplateProjectHealthSchedule',
    promptKey: 'scheduledTasksTemplateProjectHealthPrompt',
    schedule: {
      planType: ScheduledTaskTemplatePlanType.Daily,
      hour: 10,
      minute: 0,
    },
  },
  {
    id: ScheduledTaskTemplateId.MonthlyAdmin,
    icon: ScheduledTaskTemplateIcon.Reminder,
    titleKey: 'scheduledTasksTemplateMonthlyAdminTitle',
    descriptionKey: 'scheduledTasksTemplateMonthlyAdminDesc',
    scheduleLabelKey: 'scheduledTasksTemplateMonthlyAdminSchedule',
    promptKey: 'scheduledTasksTemplateMonthlyAdminPrompt',
    schedule: {
      planType: ScheduledTaskTemplatePlanType.Monthly,
      hour: 10,
      minute: 0,
      monthDay: 25,
    },
  },
];
