import { describe, expect, test } from 'vitest';

import { CoworkSessionStatusValue } from '../../../types/cowork';
import { parentDirectory } from '../companionTasks';
import { CompanionMood, companionMood, type CompanionMoodInput, moodNeedsAttention } from './companionMood';

const calm: CompanionMoodInput = {
  status: null,
  waiting: false,
  unseenResult: false,
  snoozed: false,
  fileDragActive: false,
  dropHover: false,
  dropStage: false,
  hintShowing: false,
  hovering: false,
};

describe('companion mood', () => {
  test('rests when nothing is going on and brightens on hover', () => {
    expect(companionMood(calm)).toBe(CompanionMood.Idle);
    expect(companionMood({ ...calm, hovering: true })).toBe(CompanionMood.Happy);
    expect(companionMood({ ...calm, hintShowing: true, hovering: true })).toBe(CompanionMood.Idea);
  });

  test('task news follows needs-input > failed > ready > running', () => {
    const running = { ...calm, status: CoworkSessionStatusValue.Running };
    expect(companionMood(running)).toBe(CompanionMood.Working);
    expect(companionMood({ ...running, unseenResult: true })).toBe(CompanionMood.Done);
    expect(companionMood({ ...calm, status: CoworkSessionStatusValue.Error, unseenResult: true })).toBe(CompanionMood.Error);
    expect(companionMood({ ...calm, status: CoworkSessionStatusValue.Error, waiting: true })).toBe(CompanionMood.Attention);
  });

  test('a file drag in progress outranks task news, and snoozing outranks everything', () => {
    const waiting = { ...calm, waiting: true };
    expect(companionMood({ ...waiting, fileDragActive: true })).toBe(CompanionMood.Curious);
    expect(companionMood({ ...waiting, dropHover: true })).toBe(CompanionMood.Catch);
    expect(companionMood({ ...waiting, dropHover: true, snoozed: true })).toBe(CompanionMood.Snooze);
  });

  test('only news keeps the character out of its edge', () => {
    expect([CompanionMood.Done, CompanionMood.Attention, CompanionMood.Error].every(moodNeedsAttention)).toBe(true);
    expect(moodNeedsAttention(CompanionMood.Working)).toBe(false);
  });
});

describe('task working folder', () => {
  test('falls back to the folder of the dropped file', () => {
    expect(parentDirectory('/Users/me/Documents/plan.docx')).toBe('/Users/me/Documents');
    expect(parentDirectory('C:\\Users\\me\\plan.docx')).toBe('C:\\Users\\me');
    expect(parentDirectory('C:\\plan.docx')).toBe('C:\\');
    expect(parentDirectory('/plan.docx')).toBe('/');
  });
});
