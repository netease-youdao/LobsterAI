import { useState, useCallback, useEffect, useMemo } from 'react';
import { commandRegistry, CommandGroupId } from '@/services/commandRegistry';
import { i18nService } from '@/services/i18n';
import { themeService } from '@/services/theme';
import { configService } from '@/services/config';
import type { Command } from '@/services/commandRegistry';

interface UseCommandPaletteOptions {
  onNavigateCowork: () => void;
  onNavigateSkills: () => void;
  onNavigateScheduledTasks: () => void;
  onNavigateMcp: () => void;
  onNavigateAgents: () => void;
  onNewChat: () => void;
  onShowSettings: () => void;
}

export function useCommandPalette(options: UseCommandPaletteOptions) {
  const {
    onNavigateCowork,
    onNavigateSkills,
    onNavigateScheduledTasks,
    onNavigateMcp,
    onNavigateAgents,
    onNewChat,
    onShowSettings,
  } = options;

  const [isRegistered, setIsRegistered] = useState(false);

  const t = useCallback((key: string) => i18nService.t(key), []);

  useEffect(() => {
    commandRegistry.registerGroup({
      id: CommandGroupId.Navigation,
      label: t('commandPaletteGroupNavigation'),
      priority: 10,
    });
    commandRegistry.registerGroup({
      id: CommandGroupId.Session,
      label: t('commandPaletteGroupSession'),
      priority: 20,
    });
    commandRegistry.registerGroup({
      id: CommandGroupId.Settings,
      label: t('commandPaletteGroupSettings'),
      priority: 30,
    });
    commandRegistry.registerGroup({
      id: CommandGroupId.Tools,
      label: t('commandPaletteGroupTools'),
      priority: 40,
    });

    const ids = commandRegistry.register([
      {
        id: 'navigation:cowork',
        label: t('commandNavigationCowork'),
        keywords: ['cowork', '切换', '对话', 'chat', 'home', '首页'],
        group: CommandGroupId.Navigation,
        action: onNavigateCowork,
      },
      {
        id: 'navigation:skills',
        label: t('commandNavigationSkills'),
        keywords: ['skills', '技能', 'skill', '能力'],
        group: CommandGroupId.Navigation,
        action: onNavigateSkills,
      },
      {
        id: 'navigation:scheduled-tasks',
        label: t('commandNavigationScheduledTasks'),
        keywords: ['scheduled', 'tasks', '定时', '计划', '任务', 'cron', 'timer'],
        group: CommandGroupId.Navigation,
        action: onNavigateScheduledTasks,
      },
      {
        id: 'navigation:mcp',
        label: t('commandNavigationMcp'),
        keywords: ['mcp', '工具', 'tools', 'server', '服务'],
        group: CommandGroupId.Navigation,
        action: onNavigateMcp,
      },
      {
        id: 'navigation:agents',
        label: t('commandNavigationAgents'),
        keywords: ['agents', 'agent', '智能体', '助理'],
        group: CommandGroupId.Navigation,
        action: onNavigateAgents,
      },
      {
        id: 'settings:toggle-theme',
        label: t('commandSettingsToggleTheme'),
        keywords: ['theme', 'dark', 'light', '主题', '暗色', '深色', '亮色', '浅色', 'color', '颜色'],
        group: CommandGroupId.Settings,
        action: () => {
          const current = themeService.getEffectiveTheme();
          const next = current === 'dark' ? 'light' : 'dark';
          themeService.setTheme(next);
          const config = configService.getConfig();
          void configService.updateConfig({ ...config, theme: next });
        },
      },
      {
        id: 'settings:toggle-language',
        label: t('commandSettingsToggleLanguage'),
        keywords: ['language', '语言', '中文', 'english', 'chinese', '切换语言'],
        group: CommandGroupId.Settings,
        action: () => {
          const current = i18nService.getLanguage();
          i18nService.setLanguage(current === 'zh' ? 'en' : 'zh');
        },
      },
      {
        id: 'settings:open-settings',
        label: t('commandSettingsOpenSettings'),
        keywords: ['settings', '设置', '配置', 'preferences', 'config'],
        group: CommandGroupId.Settings,
        shortcut: '⌘,',
        action: onShowSettings,
      },
      {
        id: 'session:new-session',
        label: t('commandSessionNewSession'),
        keywords: ['new', 'session', '新建', '会话', 'chat', '对话', 'create'],
        group: CommandGroupId.Session,
        shortcut: '⌘N',
        action: onNewChat,
      },
    ]);

    setIsRegistered(true);

    return () => {
      commandRegistry.unregister(ids);
      setIsRegistered(false);
    };
  }, [
    t, onNavigateCowork, onNavigateSkills, onNavigateScheduledTasks,
    onNavigateMcp, onNavigateAgents, onNewChat, onShowSettings,
  ]);

  const commands = useMemo(() => {
    if (!isRegistered) return [];
    return commandRegistry.getAll();
  }, [isRegistered]);

  const groups = useMemo(() => {
    if (!isRegistered) return [];
    return commandRegistry.getGroups();
  }, [isRegistered]);

  const getCommandsByGroup = useCallback((groupId: string): Command[] => {
    return commandRegistry.getAll().filter(cmd => cmd.group === groupId);
  }, []);

  return { commands, groups, getCommandsByGroup };
}
