import React, { useState, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../../store';
import { SparklesIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { PREDEFINED_SKILLS } from './workflowTypes';
import { updateCustomSkill } from '../../store/slices/workflowSlice';

interface SkillConfigPanelProps {
    skillId: string;
    onClose: () => void;
}

const SkillConfigPanel: React.FC<SkillConfigPanelProps> = ({ skillId, onClose }) => {
    const dispatch = useDispatch();

    // Find the skill object from custom definitions or predefined ones
    const customSkills = useSelector((state: RootState) => state.workflow.skills);
    const getSkill = () => {
        return customSkills.find(s => s.id === skillId) || PREDEFINED_SKILLS.find(s => s.id === skillId) || null;
    };

    const skill = getSkill();

    const [prompt, setPrompt] = useState(skill?.prompt || '');
    const [isSaving, setIsSaving] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState(false);

    useEffect(() => {
        if (skill) {
            setPrompt(skill.prompt || '');
        }
    }, [skill]);

    if (!skillId || !skill) return null;

    const handleSave = () => {
        if (!skill) return;
        setIsSaving(true);
        try {
            // Save prompt mapping to local workflow storage by dispatching action
            dispatch(updateCustomSkill({ ...skill, prompt: prompt.trim() }));
            setSaveSuccess(true);
            setTimeout(() => {
                setSaveSuccess(false);
                onClose();
            }, 1500);
        } catch (e) {
            console.error('Failed to save skill prompt', e);
        } finally {
            setIsSaving(false);
        }
    };

    const getTranslatedName = () => i18nService.t(`skill.${skill.id}`) || skill.name;

    return (
        <div className="absolute right-0 top-0 h-full w-96 z-50 bg-claude-surface dark:bg-claude-darkSurface border-l dark:border-claude-darkBorder border-claude-border shadow-2xl flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b dark:border-claude-darkBorder border-claude-border">
                <div className="flex items-center gap-2 max-w-[80%]">
                    <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-white shrink-0"
                        style={{ backgroundColor: skill.color }}
                    >
                        <SparklesIcon className="w-4 h-4" />
                    </div>
                    <h2 className="text-lg font-semibold text-claude-text dark:text-claude-darkText truncate">
                        {getTranslatedName()}
                    </h2>
                </div>
                <button
                    onClick={onClose}
                    className="p-1 px-[10px] py-[6px] text-xs font-semibold rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-[#252528] text-gray-700 dark:text-gray-200 shadow-sm hover:bg-gray-50 dark:hover:bg-[#303033] hover:text-gray-900 dark:hover:text-white transition-all transform active:scale-95"
                    title={i18nService.t('close')}
                >
                    {i18nService.t('cmd_esc')}
                </button>
            </div>

            <div className="flex-1 overflow-y-auto w-full">
                {/* Name block */}
                <div className="p-4 space-y-2">
                    <h3 className="text-sm font-medium text-claude-textSecondary dark:text-claude-darkTextSecondary">
                        {i18nService.t('name')}
                    </h3>
                    <div className="p-3 bg-claude-bg dark:bg-claude-darkBg rounded-lg border border-claude-border dark:border-claude-darkBorder">
                        <span className="text-sm font-medium text-claude-text dark:text-claude-darkText">
                            {getTranslatedName()}
                        </span>
                    </div>
                </div>
                {/* Soul MD block */}
                <div className="px-4 pb-4 space-y-2 h-full">
                    <h3 className="text-sm font-medium text-claude-textSecondary dark:text-claude-darkTextSecondary">
                        {'Soul MD (System Prompt)'}
                    </h3>
                    <textarea
                        className="w-full h-[calc(100vh-280px)] p-3 text-sm bg-claude-bg dark:bg-claude-darkBg border border-claude-border dark:border-claude-darkBorder rounded-lg focus:outline-none focus:ring-2 focus:ring-claude-primary dark:text-white dark:placeholder-gray-400 font-mono resize-none"
                        placeholder={i18nService.t('enterSystemPrompt') || "Enter the custom system prompt for this skill..."}
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                    />
                </div>
            </div>

            {/* Footer */}
            <div className="p-4 border-t dark:border-claude-darkBorder border-claude-border flex justify-between items-center bg-claude-bg dark:bg-claude-darkBg">
                <button
                    onClick={onClose}
                    disabled={isSaving}
                    className="px-4 py-2 text-sm text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-text dark:hover:text-claude-darkText transition-colors"
                >
                    {i18nService.t('cancel') || 'Cancel'}
                </button>
                <div className="flex items-center gap-3">
                    {saveSuccess && (
                        <span className="text-sm text-green-600 dark:text-green-400 flex items-center gap-1 animate-fade-in-out">
                            <SparklesIcon className="w-4 h-4" />
                            Saved
                        </span>
                    )}
                    <button
                        onClick={handleSave}
                        disabled={isSaving || prompt.trim() === '' || prompt === skill.prompt}
                        className="flex items-center gap-2 px-4 py-2 bg-claude-accent hover:bg-claude-accentHover text-white text-sm font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                        {isSaving ? i18nService.t('saving') || 'Saving...' : i18nService.t('saveChanges') || 'Save Changes'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default SkillConfigPanel;
