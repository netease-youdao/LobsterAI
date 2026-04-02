import type { ScheduledTask } from './types';

export function normalizeScheduledTaskName(name: string): string {
  return name.trim();
}

export function hasDuplicateScheduledTaskName(
  tasks: Array<Pick<ScheduledTask, 'id' | 'name'>>,
  name: string,
  excludeTaskId?: string,
): boolean {
  const normalizedName = normalizeScheduledTaskName(name);
  if (!normalizedName) {
    return false;
  }

  return tasks.some((task) =>
    task.id !== excludeTaskId && normalizeScheduledTaskName(task.name) === normalizedName
  );
}
