import React, { useEffect, useMemo, useState } from 'react';
import type { CoworkPermissionRequest, CoworkPermissionResult } from '../../types/cowork';
import { ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';

type DangerLevel = 'safe' | 'caution' | 'destructive';

const DANGER_REASON_I18N_MAP: Record<string, string> = {
  'recursive-delete': 'dangerReasonRecursiveDelete',
  'git-force-push': 'dangerReasonGitForcePush',
  'git-reset-hard': 'dangerReasonGitResetHard',
  'disk-overwrite': 'dangerReasonDiskOverwrite',
  'disk-format': 'dangerReasonDiskFormat',
  'file-delete': 'dangerReasonFileDelete',
  'git-push': 'dangerReasonGitPush',
  'process-kill': 'dangerReasonProcessKill',
  'permission-change': 'dangerReasonPermissionChange',
};

/** Fallback detection when dangerLevel is not provided by the adapter */
function detectDangerLevelFromCommand(command: string): DangerLevel {
  const destructivePatterns = [
    /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f?|--recursive)\b/i,
    /\bgit\s+push\s+.*--force\b/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\bdd\b/i,
    /\bmkfs\b/i,
  ];
  if (destructivePatterns.some(p => p.test(command))) return 'destructive';

  const cautionPatterns = [
    /\b(rm|rmdir|unlink|del|erase|remove-item|trash)\b/i,
    /\bgit\s+push\b/i,
    /\b(kill|killall|pkill)\b/i,
    /\b(chmod|chown)\b/i,
    /\bgit\s+clean\b/i,
    /\bsudo\b/i,
  ];
  if (cautionPatterns.some(p => p.test(command))) return 'caution';

  return 'safe';
}

interface CoworkPermissionModalProps {
  permission: CoworkPermissionRequest;
  onRespond: (result: CoworkPermissionResult) => void;
}

type QuestionOption = {
  label: string;
  description?: string;
};

type QuestionItem = {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
};

const CoworkPermissionModal: React.FC<CoworkPermissionModalProps> = ({
  permission,
  onRespond,
}) => {
  const toolInput = permission.toolInput ?? {};

  const questions = useMemo<QuestionItem[]>(() => {
    if (permission.toolName !== 'AskUserQuestion') return [];
    if (!toolInput || typeof toolInput !== 'object') return [];
    const rawQuestions = (toolInput as Record<string, unknown>).questions;
    if (!Array.isArray(rawQuestions)) return [];

    return rawQuestions
      .map((question) => {
        if (!question || typeof question !== 'object') return null;
        const record = question as Record<string, unknown>;
        const options = Array.isArray(record.options)
          ? record.options
              .map((option) => {
                if (!option || typeof option !== 'object') return null;
                const optionRecord = option as Record<string, unknown>;
                if (typeof optionRecord.label !== 'string') return null;
                return {
                  label: optionRecord.label,
                  description: typeof optionRecord.description === 'string'
                    ? optionRecord.description
                    : undefined,
                } as QuestionOption;
              })
              .filter(Boolean) as QuestionOption[]
          : [];

        if (typeof record.question !== 'string' || options.length === 0) {
          return null;
        }

        return {
          question: record.question,
          header: typeof record.header === 'string' ? record.header : undefined,
          options,
          multiSelect: Boolean(record.multiSelect),
        } as QuestionItem;
      })
      .filter(Boolean) as QuestionItem[];
  }, [permission.toolName, toolInput]);

  const isQuestionTool = questions.length > 0;

  // Detect simple confirm mode: 1 question with exactly 2 options (allow/deny pattern).
  // In this case, render as a simple confirm dialog (直接 允许/拒绝) instead of
  // requiring the user to select an option first then click submit.
  const isConfirmMode = isQuestionTool
    && questions.length === 1
    && questions[0].options.length === 2
    && !questions[0].multiSelect;

  const [answers, setAnswers] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!isQuestionTool) {
      setAnswers({});
      return;
    }

    const rawAnswers = (toolInput as Record<string, unknown>).answers;
    if (rawAnswers && typeof rawAnswers === 'object') {
      const initial: Record<string, string> = {};
      Object.entries(rawAnswers as Record<string, unknown>).forEach(([key, value]) => {
        if (typeof value === 'string') {
          initial[key] = value;
        }
      });
      setAnswers(initial);
    } else {
      setAnswers({});
    }
  }, [isQuestionTool, permission.requestId, toolInput]);

  const formatToolInput = (input: Record<string, unknown>): string => {
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
  };

  const { dangerLevel, dangerReasonText } = useMemo(() => {
    // AskUserQuestion in confirm mode (delete confirmation) → show caution warning
    if (permission.toolName === 'AskUserQuestion') {
      return { dangerLevel: 'caution' as DangerLevel, dangerReasonText: i18nService.t('dangerReasonFileDelete') };
    }
    if (permission.toolName !== 'Bash') {
      return { dangerLevel: 'safe' as DangerLevel, dangerReasonText: '' };
    }
    const input = permission.toolInput as Record<string, unknown>;
    const command = String(input?.command ?? '');

    // Prefer adapter-provided level, fall back to local detection
    const level = (typeof input?.dangerLevel === 'string' && ['safe', 'caution', 'destructive'].includes(input.dangerLevel))
      ? input.dangerLevel as DangerLevel
      : detectDangerLevelFromCommand(command);

    const reason = typeof input?.dangerReason === 'string' ? input.dangerReason : '';
    const i18nKey = DANGER_REASON_I18N_MAP[reason];
    const reasonText = i18nKey ? i18nService.t(i18nKey) : '';

    return { dangerLevel: level, dangerReasonText: reasonText };
  }, [permission.toolName, permission.toolInput]);

  const getSelectedValues = (question: QuestionItem): string[] => {
    const rawValue = answers[question.question] ?? '';
    if (!rawValue) return [];
    if (!question.multiSelect) return [rawValue];
    return rawValue
      .split('|||')
      .map((value) => value.trim())
      .filter(Boolean);
  };

  const handleSelectOption = (question: QuestionItem, optionLabel: string) => {
    setAnswers((prev) => {
      if (!question.multiSelect) {
        return { ...prev, [question.question]: optionLabel };
      }

      const rawValue = prev[question.question] ?? '';
      const current = new Set(
        rawValue
          .split('|||')
          .map((value) => value.trim())
          .filter(Boolean)
      );
      if (current.has(optionLabel)) {
        current.delete(optionLabel);
      } else {
        current.add(optionLabel);
      }

      return {
        ...prev,
        [question.question]: Array.from(current).join('|||'),
      };
    });
  };

  const isComplete = isQuestionTool && !isConfirmMode
    ? questions.every((question) => (answers[question.question] ?? '').trim())
    : true;

  const denyButtonLabel = isQuestionTool && !isConfirmMode
    ? i18nService.t('coworkDenyRequest')
    : i18nService.t('coworkDeny');
  const approveButtonLabel = isQuestionTool && !isConfirmMode
    ? i18nService.t('coworkConfirmSelection')
    : i18nService.t('coworkApprove');

  const handleApprove = () => {
    if (isConfirmMode) {
      // Confirm mode: auto-select the first option (allow) and respond
      const q = questions[0];
      onRespond({
        behavior: 'allow',
        updatedInput: {
          ...(toolInput && typeof toolInput === 'object' ? toolInput : {}),
          answers: { [q.question]: q.options[0].label },
        },
      });
      return;
    }

    if (isQuestionTool) {
      if (!isComplete) return;
      onRespond({
        behavior: 'allow',
        updatedInput: {
          ...(toolInput && typeof toolInput === 'object' ? toolInput : {}),
          answers,
        },
      });
      return;
    }

    onRespond({
      behavior: 'allow',
      updatedInput: toolInput && typeof toolInput === 'object' ? toolInput : {},
    });
  };

  const handleDeny = () => {
    onRespond({
      behavior: 'deny',
      message: 'Permission denied',
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop">
      <div className="modal-content w-full max-w-lg mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-modal overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b dark:border-claude-darkBorder border-claude-border">
          <div className={`p-2 rounded-full ${isQuestionTool && !isConfirmMode ? 'bg-blue-100 dark:bg-blue-900/30' : 'bg-yellow-100 dark:bg-yellow-900/30'}`}>
            <ExclamationTriangleIcon className={`h-6 w-6 ${isQuestionTool && !isConfirmMode ? 'text-blue-600 dark:text-blue-500' : 'text-yellow-600 dark:text-yellow-500'}`} />
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
              {isQuestionTool && !isConfirmMode
                ? i18nService.t('coworkSelectionRequired')
                : i18nService.t('coworkPermissionRequired')}
            </h2>
            <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {isQuestionTool && !isConfirmMode
                ? i18nService.t('coworkSelectionDescription')
                : i18nService.t('coworkPermissionDescription')}
            </p>
          </div>
          <button
            onClick={handleDeny}
            className="p-2 rounded-lg dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors"
            aria-label="Close"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
          {isConfirmMode ? (
            /* Simple confirm dialog — show question text + allow/deny buttons */
            <div className="px-3 py-2 rounded-lg dark:bg-claude-darkBg bg-claude-bg">
              <p className="text-sm dark:text-claude-darkText text-claude-text whitespace-pre-wrap">
                {questions[0].question}
              </p>
            </div>
          ) : isQuestionTool ? (
            <>
              {questions.map((question) => {
                const selectedValues = getSelectedValues(question);
                const ctx = (toolInput as Record<string, unknown>)?.context as Record<string, unknown> | undefined;
                const reqInput = ctx?.requestedToolInput as Record<string, unknown> | undefined;
                const command = typeof reqInput?.command === 'string' ? (reqInput.command as string).trim() : '';
                return (
                  <div
                    key={question.question}
                    className="rounded-xl border dark:border-claude-darkBorder border-claude-border p-4 space-y-3"
                  >
                    {/* 问题 */}
                    <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                      {question.header && (
                        <span className="inline-block text-[11px] uppercase tracking-wide px-2 py-0.5 mr-1.5 rounded-full bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary align-middle">
                          {question.header}
                        </span>
                      )}
                      {question.question}
                    </div>
                    {/* 命令详情 */}
                    {command && (
                      <div>
                        <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary uppercase tracking-wider mb-1">
                          {i18nService.t('coworkToolInput')}
                        </label>
                        <div className="px-3 py-2 rounded-lg dark:bg-claude-darkBg bg-claude-bg max-h-40 overflow-y-auto">
                          <pre className="text-xs dark:text-claude-darkText text-claude-text whitespace-pre-wrap break-words font-mono">
                            {command}
                          </pre>
                        </div>
                      </div>
                    )}
                    {/* 选项 */}
                    <div className="space-y-2">
                      {question.options.map((option) => {
                        const isSelected = selectedValues.includes(option.label);
                        return (
                          <button
                            key={option.label}
                            type="button"
                            onClick={() => handleSelectOption(question, option.label)}
                            className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                              isSelected
                                ? 'border-claude-accent bg-claude-accent/10 text-claude-text dark:text-claude-darkText'
                                : 'border-claude-border dark:border-claude-darkBorder dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                            }`}
                          >
                            <div className="text-sm font-medium">{option.label}</div>
                            {option.description && (
                              <div className="text-xs mt-1 opacity-80">{option.description}</div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </>
          ) : (
            <>
              {/* Tool name */}
              <div>
                <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary uppercase tracking-wider mb-1">
                  {i18nService.t('coworkToolName')}
                </label>
                <div className="px-3 py-2 rounded-lg dark:bg-claude-darkBg bg-claude-bg">
                  <code className="text-sm dark:text-claude-darkText text-claude-text">
                    {permission.toolName}
                  </code>
                </div>
              </div>

              {/* Tool input */}
              <div>
                <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary uppercase tracking-wider mb-1">
                  {i18nService.t('coworkToolInput')}
                </label>
                <div className="px-3 py-2 rounded-lg dark:bg-claude-darkBg bg-claude-bg">
                  <pre className="text-xs dark:text-claude-darkText text-claude-text whitespace-pre-wrap break-words font-mono">
                    {formatToolInput(permission.toolInput)}
                  </pre>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Warning for dangerous operations - 固定在滚动区域外，始终可见 */}
        {(!isQuestionTool || isConfirmMode) && dangerLevel === 'destructive' && (
          <div className="flex items-start gap-2 p-3 mx-6 my-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
            <ExclamationTriangleIcon className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-red-700 dark:text-red-400">
                {i18nService.t('coworkDestructiveOperation')}
              </p>
              {dangerReasonText && (
                <p className="text-xs text-red-600 dark:text-red-500 mt-0.5">{dangerReasonText}</p>
              )}
            </div>
          </div>
        )}
        {(!isQuestionTool || isConfirmMode) && dangerLevel === 'caution' && (
          <div className="flex items-start gap-2 p-3 mx-6 my-4 rounded-lg bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800">
            <ExclamationTriangleIcon className="h-5 w-5 text-yellow-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
                {i18nService.t('coworkCautionOperation')}
              </p>
              {dangerReasonText && (
                <p className="text-xs text-yellow-600 dark:text-yellow-500 mt-0.5">{dangerReasonText}</p>
              )}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t dark:border-claude-darkBorder border-claude-border">
          <button
            onClick={handleDeny}
            className="px-4 py-2 text-sm font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
          >
            {denyButtonLabel}
          </button>
          <button
            onClick={handleApprove}
            disabled={!isComplete}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-claude-accent hover:bg-claude-accentHover text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {approveButtonLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CoworkPermissionModal;
