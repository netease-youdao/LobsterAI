import { beforeEach, describe, expect, test, vi } from 'vitest';

import { getBuiltinShowcaseExamples } from '../../shared/homeShowcase/catalogs';
import {
  HOME_SHOWCASE_DRAFT_KEY,
  HomeShowcaseCategoryId,
  ShowcaseRemixMode,
} from '../../shared/homeShowcase/constants';
import { store } from '../store';
import {
  setDraftAttachments,
  setDraftCollaborationMode,
  setDraftPrompt,
  setDraftSkillIds,
} from '../store/slices/coworkSlice';
import { setActiveSkillIds, setSkills } from '../store/slices/skillSlice';
import { CoworkCollaborationMode } from '../types/cowork';
import {
  buildShowcaseRemixPrompt,
  prepareHomeShowcaseDraft,
  restoreHomeShowcaseDraft,
} from './homeShowcaseDraft';

describe('homeShowcaseDraft', () => {
  const saveInlineFile = vi.fn();

  beforeEach(() => {
    saveInlineFile.mockReset();
    saveInlineFile.mockImplementation(async ({ fileName }: { fileName: string }) => ({
      success: true,
      path: `/tmp/staged/${fileName}`,
    }));
    vi.stubGlobal('window', {
      electron: {
        dialog: { saveInlineFile },
      },
    });
    store.dispatch(setDraftPrompt({ sessionId: HOME_SHOWCASE_DRAFT_KEY, draft: 'Existing note' }));
    store.dispatch(setDraftAttachments({ draftKey: HOME_SHOWCASE_DRAFT_KEY, attachments: [] }));
    store.dispatch(setDraftCollaborationMode({ draftKey: HOME_SHOWCASE_DRAFT_KEY, mode: CoworkCollaborationMode.Default }));
    store.dispatch(setActiveSkillIds([]));
    store.dispatch(setDraftSkillIds({ draftKey: HOME_SHOWCASE_DRAFT_KEY, skillIds: [] }));
    store.dispatch(setSkills([
      { id: 'web-search', name: 'Web Search', description: '', enabled: true, isOfficial: true, isBuiltIn: true, updatedAt: 1, prompt: '', skillPath: '' },
      { id: 'docx', name: 'Word', description: '', enabled: true, isOfficial: true, isBuiltIn: true, updatedAt: 1, prompt: '', skillPath: '' },
      { id: 'xlsx', name: 'Excel', description: '', enabled: true, isOfficial: true, isBuiltIn: true, updatedAt: 1, prompt: '', skillPath: '' },
      { id: 'pptx', name: 'PPTX', description: '', enabled: true, isOfficial: true, isBuiltIn: true, updatedAt: 1, prompt: '', skillPath: '' },
    ]));
  });

  test('builds custom and demo remix prompts with selected option fragments', () => {
    const research = getBuiltinShowcaseExamples(HomeShowcaseCategoryId.DeepResearch)[0];
    const customPrompt = buildShowcaseRemixPrompt(research, {
      mode: ShowcaseRemixMode.Custom,
      language: 'zh',
      customInput: '3000元级空气净化器横评',
      selectedChoices: { deliverable: 'pptx', scope: 'hybrid' },
      userFiles: [],
    });
    expect(customPrompt).toContain('3000元级空气净化器横评');
    expect(customPrompt).toContain('.pptx');
    expect(customPrompt).toContain('本地');

    const demoPrompt = buildShowcaseRemixPrompt(research, {
      mode: ShowcaseRemixMode.Demo,
      language: 'en',
      customInput: '',
      selectedChoices: { deliverable: 'report', scope: 'web' },
      userFiles: [],
    });
    expect(demoPrompt).toContain('robot vacuums');
  });

  test('stages sample CSV files for demo data analysis and restores previous draft cleanly', async () => {
    const billExample = getBuiltinShowcaseExamples(HomeShowcaseCategoryId.DataAnalysis)[0];
    const prepared = await prepareHomeShowcaseDraft(
      billExample,
      {
        mode: ShowcaseRemixMode.Demo,
        language: 'zh',
        customInput: '',
        selectedChoices: { output: 'dashboard-excel' },
        userFiles: [],
        useSampleFiles: true,
      },
      () => true,
    );

    expect(prepared).not.toBeNull();
    expect(saveInlineFile).toHaveBeenCalledTimes(1);
    expect(saveInlineFile.mock.calls[0]?.[0]?.fileName).toBe('personal-spending-sample.csv');

    const state = store.getState();
    expect(state.cowork.draftAttachments[HOME_SHOWCASE_DRAFT_KEY]).toHaveLength(1);
    expect(state.skill.activeSkillIds).toEqual(['xlsx']);

    expect(restoreHomeShowcaseDraft(prepared!.backup)).toBe(true);
    expect(store.getState().cowork.draftPrompts[HOME_SHOWCASE_DRAFT_KEY]).toBe('Existing note');
    expect(store.getState().cowork.draftAttachments[HOME_SHOWCASE_DRAFT_KEY] ?? []).toEqual([]);
  });

  test('activates web-search plus deliverable skill and verification rules on research remix', async () => {
    const researchExample = getBuiltinShowcaseExamples(HomeShowcaseCategoryId.DeepResearch)[0];
    const prepared = await prepareHomeShowcaseDraft(
      researchExample,
      {
        mode: ShowcaseRemixMode.Custom,
        language: 'zh',
        customInput: '对比三款折叠屏手机',
        selectedChoices: { deliverable: 'docx', scope: 'hybrid' },
        userFiles: [],
        useSampleFiles: false,
      },
      () => true,
    );

    expect(prepared).not.toBeNull();
    expect(store.getState().skill.activeSkillIds).toEqual(['web-search', 'docx']);
    expect(prepared!.prompt).toContain('.docx');
    expect(prepared!.prompt).toContain('[1][2]');
    expect(prepared!.prompt).toContain('严禁编造数据');
  });

  test('enables Plan Mode when a PPT template chooses outline-first workflow', async () => {
    const pptTemplate = getBuiltinShowcaseExamples(HomeShowcaseCategoryId.Pptx)[0];
    const prepared = await prepareHomeShowcaseDraft(
      pptTemplate,
      {
        mode: ShowcaseRemixMode.Custom,
        language: 'zh',
        customInput: 'Q4 市场增长方案',
        selectedChoices: { slides: '10', workflow: 'outline' },
        userFiles: [],
        useSampleFiles: false,
      },
      () => true,
    );

    expect(prepared).not.toBeNull();
    expect(store.getState().cowork.draftCollaborationModes[HOME_SHOWCASE_DRAFT_KEY]).toBe(
      CoworkCollaborationMode.Plan,
    );
  });
});
