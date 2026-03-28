import type React from 'react';

/** 命令分组定义 */
export interface CommandGroup {
  /** 分组唯一标识符 */
  id: string;
  /** 展示给用户的分组名称（i18n 处理后） */
  label: string;
  /** 排序优先级，数值越小越靠前 */
  priority: number;
}

/** 单条命令定义 */
export interface Command {
  /** 全局唯一标识符，格式 'module:action'，如 'navigation:cowork' */
  id: string;
  /** 展示给用户的命令名称（i18n 处理后） */
  label: string;
  /**
   * 搜索关键词数组。
   * 覆盖中英文同义词、缩写和常见拼写变体。
   * cmdk 的 command-score 会同时搜索 label 和 keywords。
   */
  keywords: string[];
  /** 展示在命令前的图标（React 节点，可选） */
  icon?: React.ReactNode;
  /** 所属分组 ID，对应 CommandGroup.id */
  group: string;
  /** 执行此命令时调用的函数 */
  action: () => void;
  /**
   * 该命令右侧展示的快捷键提示（可选）。
   * 纯展示用，不影响实际快捷键绑定。
   */
  shortcut?: string;
  /**
   * 命令是否可用的谓词函数（可选）。
   * 返回 false 时该命令不展示在列表中。
   * 每次 getAll() 调用时求值，不缓存。
   */
  enabled?: () => boolean;
  /**
   * 执行命令后是否自动关闭面板（可选，默认 true）。
   */
  closeOnSelect?: boolean;
}

/** 内置分组 ID 常量 */
export const CommandGroupId = {
  Navigation: 'navigation',
  Session: 'session',
  Settings: 'settings',
  Tools: 'tools',
} as const;
export type CommandGroupId = typeof CommandGroupId[keyof typeof CommandGroupId];

class CommandRegistryImpl {
  private commands = new Map<string, Command>();
  private groups = new Map<string, CommandGroup>();

  /**
   * 注册分组定义。
   * 内置分组在初始化时注册；模块可注册自定义分组。
   */
  registerGroup(group: CommandGroup): void {
    this.groups.set(group.id, group);
  }

  /**
   * 注册一条或多条命令。
   * 同一 id 重复注册时，新命令覆盖旧命令。
   * 返回已注册命令的 id 数组，供 unregister 使用。
   */
  register(commands: Command | Command[]): string[] {
    const list = Array.isArray(commands) ? commands : [commands];
    const ids: string[] = [];
    for (const cmd of list) {
      this.commands.set(cmd.id, cmd);
      ids.push(cmd.id);
    }
    return ids;
  }

  /**
   * 注销指定 id 的命令。
   * 组件卸载时调用，防止过期命令残留。
   */
  unregister(ids: string | string[]): void {
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) {
      this.commands.delete(id);
    }
  }

  /**
   * 获取所有当前可用命令（已过滤掉 enabled() 返回 false 的命令）。
   * 按 group.priority 排序，同组内按注册顺序排列。
   */
  getAll(): Command[] {
    const result: Command[] = [];
    for (const cmd of this.commands.values()) {
      if (cmd.enabled && !cmd.enabled()) continue;
      result.push(cmd);
    }

    result.sort((a, b) => {
      const groupA = this.groups.get(a.group);
      const groupB = this.groups.get(b.group);
      const priorityA = groupA?.priority ?? 999;
      const priorityB = groupB?.priority ?? 999;
      return priorityA - priorityB;
    });

    return result;
  }

  /**
   * 获取所有已注册的分组定义，按 priority 升序排列。
   */
  getGroups(): CommandGroup[] {
    return Array.from(this.groups.values()).sort((a, b) => a.priority - b.priority);
  }

  /**
   * 清除所有已注册的命令和分组（主要用于测试）。
   */
  clear(): void {
    this.commands.clear();
    this.groups.clear();
  }
}

export const commandRegistry = new CommandRegistryImpl();
