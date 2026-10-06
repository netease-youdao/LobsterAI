import { ChevronLeftIcon, ChevronRightIcon, MinusIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import type { CoworkPermissionRequest, CoworkPermissionResult } from '../../types/cowork';

interface CoworkQuestionWizardProps {
  permission: CoworkPermissionRequest;
  onRespond: (result: CoworkPermissionResult) => void;
  onMinimize?: () => void;
  /** Keep the wizard mounted (so in-progress answers survive) but visually hidden while minimized. */
  hidden?: boolean;
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

const AUTO_ADVANCE_DELAY_MS = 220;

const CoworkQuestionWizard: React.FC<CoworkQuestionWizardProps> = ({
  permission,
  onRespond,
  onMinimize,
  hidden = false,
}) => {
  const toolInput = useMemo(() => permission.toolInput ?? {}, [permission.toolInput]);

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

  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [otherInputs, setOtherInputs] = useState<Record<number, string>>({});
  const [skippedSteps, setSkippedSteps] = useState<Record<number, boolean>>({});
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
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
    setOtherInputs({});
    setSkippedSteps({});
    setCurrentStep(0);
  }, [permission.requestId, toolInput]);

  useEffect(() => () => {
    if (advanceTimerRef.current) {
      clearTimeout(advanceTimerRef.current);
    }
  }, []);

  if (questions.length === 0) {
    return null;
  }

  const totalSteps = questions.length;
  const stepIndex = Math.min(currentStep, totalSteps - 1);
  const currentQuestion = questions[stepIndex];
  const isFirstStep = stepIndex === 0;
  const isLastStep = stepIndex === totalSteps - 1;

  const clearPendingAdvance = () => {
    if (advanceTimerRef.current) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
  };

  const getSelectedValues = (question: QuestionItem): string[] => {
    const rawValue = answers[question.question] ?? '';
    if (!rawValue) return [];
    if (!question.multiSelect) return [rawValue];
    return rawValue
      .split('|||')
      .map((value) => value.trim())
      .filter(Boolean);
  };

  const hasAnswer = (index: number): boolean => {
    const question = questions[index];
    return Boolean(answers[question.question]?.trim()) || Boolean(otherInputs[index]?.trim());
  };

  const isStepResolved = (index: number): boolean => hasAnswer(index) || Boolean(skippedSteps[index]);

  const allResolved = questions.every((_, index) => isStepResolved(index));

  const goToStep = (index: number) => {
    clearPendingAdvance();
    setCurrentStep(Math.max(0, Math.min(index, totalSteps - 1)));
  };

  const handleSelectOption = (question: QuestionItem, optionLabel: string) => {
    setSkippedSteps((prev) => {
      if (!prev[stepIndex]) return prev;
      const next = { ...prev };
      delete next[stepIndex];
      return next;
    });

    if (!question.multiSelect) {
      setAnswers((prev) => ({
        ...prev,
        [question.question]: optionLabel,
      }));
      // 单选与「其他」互斥：选中选项时清空自定义输入
      setOtherInputs((prev) => {
        if (!prev[stepIndex]) return prev;
        const next = { ...prev };
        delete next[stepIndex];
        return next;
      });

      // 单选题选择后自动跳转到下一题（短暂停留以展示选中反馈）
      clearPendingAdvance();
      advanceTimerRef.current = setTimeout(() => {
        advanceTimerRef.current = null;
        setCurrentStep((prevStep) => {
          const nextStep = prevStep + 1;
          return nextStep < questions.length ? nextStep : prevStep;
        });
      }, AUTO_ADVANCE_DELAY_MS);
    } else {
      setAnswers((prev) => {
        const rawValue = prev[question.question] ?? '';

        if (!rawValue.trim()) {
          return {
            ...prev,
            [question.question]: optionLabel,
          };
        }

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

        if (current.size === 0) {
          const newAnswers = { ...prev };
          delete newAnswers[question.question];
          return newAnswers;
        }

        return {
          ...prev,
          [question.question]: Array.from(current).join('|||'),
        };
      });
    }
  };

  const handleOtherInputChange = (value: string) => {
    setOtherInputs((prev) => ({
      ...prev,
      [stepIndex]: value,
    }));
    if (value.trim()) {
      setSkippedSteps((prev) => {
        if (!prev[stepIndex]) return prev;
        const next = { ...prev };
        delete next[stepIndex];
        return next;
      });
      // 单选与「其他」互斥：输入自定义答案时取消已选选项
      if (!currentQuestion.multiSelect) {
        setAnswers((prev) => {
          if (!(currentQuestion.question in prev)) return prev;
          const next = { ...prev };
          delete next[currentQuestion.question];
          return next;
        });
      }
    }
  };

  const handlePrevious = () => {
    if (!isFirstStep) {
      goToStep(stepIndex - 1);
    }
  };

  const handleNext = () => {
    if (!isLastStep) {
      goToStep(stepIndex + 1);
    }
  };

  const handleSkip = () => {
    clearPendingAdvance();
    setAnswers((prev) => {
      const newAnswers = { ...prev };
      delete newAnswers[currentQuestion.question];
      return newAnswers;
    });
    setOtherInputs((prev) => {
      const newInputs = { ...prev };
      delete newInputs[stepIndex];
      return newInputs;
    });
    setSkippedSteps((prev) => ({
      ...prev,
      [stepIndex]: true,
    }));

    if (!isLastStep) {
      handleNext();
    }
  };

  const handleSubmit = () => {
    // Merge "Other" inputs into answers
    const finalAnswers = { ...answers };
    Object.entries(otherInputs).forEach(([index, otherValue]) => {
      const question = questions[Number(index)];
      if (question && otherValue.trim()) {
        if (question.multiSelect) {
          const existingAnswers = finalAnswers[question.question]?.split('|||').map(a => a.trim()).filter(Boolean) || [];
          finalAnswers[question.question] = [...existingAnswers, otherValue.trim()].join('|||');
        } else {
          finalAnswers[question.question] = otherValue.trim();
        }
      }
    });

    onRespond({
      behavior: 'allow',
      updatedInput: {
        ...(toolInput && typeof toolInput === 'object' ? toolInput : {}),
        answers: finalAnswers,
      },
    });
  };

  const handleDeny = () => {
    onRespond({
      behavior: 'deny',
      message: 'Permission denied',
    });
  };

  const selectedValues = getSelectedValues(currentQuestion);
  const otherValue = otherInputs[stepIndex] ?? '';
  const isOtherActive = Boolean(otherValue.trim());
  const isCurrentSkipped = Boolean(skippedSteps[stepIndex]) && !hasAnswer(stepIndex);

  const renderIndicator = (multiSelect: boolean, selected: boolean) => (
    multiSelect ? (
      <span
        className={`mt-0.5 flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-[5px] border-2 transition-colors ${
          selected ? 'border-primary bg-primary' : 'border-border'
        }`}
      >
        {selected && (
          <svg className="h-3 w-3 text-primary-foreground" viewBox="0 0 16 16" fill="none">
            <path d="M13 4L6 11L3 8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
    ) : (
      <span
        className={`mt-0.5 flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
          selected ? 'border-primary' : 'border-border'
        }`}
      >
        {selected && <span className="h-2 w-2 rounded-full bg-primary" />}
      </span>
    )
  );

  return (
    <div className={`fixed inset-0 z-50 items-center justify-center modal-backdrop ${hidden ? 'hidden' : 'flex'}`}>
      <div className="modal-content w-full max-w-xl mx-4 bg-surface rounded-2xl shadow-modal overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-1 px-6 pt-4">
          <h2 className="flex-1 text-sm font-medium text-secondary">
            {i18nService.t('coworkQuestionWizardTitle')}
          </h2>
          {totalSteps > 1 && (
            <span className="mr-2 text-xs font-medium text-secondary tabular-nums">
              {stepIndex + 1} / {totalSteps}
            </span>
          )}
          {onMinimize && (
            <button
              type="button"
              onClick={onMinimize}
              className="p-1.5 rounded-lg hover:bg-surface-raised text-secondary transition-colors"
              aria-label={i18nService.t('coworkPermissionMinimize')}
              title={i18nService.t('coworkPermissionMinimize')}
            >
              <MinusIcon className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            onClick={handleDeny}
            className="p-1.5 rounded-lg hover:bg-surface-raised text-secondary transition-colors"
            aria-label={i18nService.t('coworkPermissionCancel')}
            title={i18nService.t('coworkPermissionCancel')}
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Segmented progress (one segment per question, clickable) */}
        {totalSteps > 1 && (
          <div className="flex items-center gap-1.5 px-6 pt-3">
            {questions.map((question, index) => {
              const isActive = index === stepIndex;
              const answered = hasAnswer(index);
              const skipped = Boolean(skippedSteps[index]) && !answered;
              const segmentColor = isActive
                ? 'bg-primary'
                : answered
                ? 'bg-primary/40 group-hover:bg-primary/60'
                : skipped
                ? 'bg-muted/50 group-hover:bg-muted/70'
                : 'bg-border/70 group-hover:bg-border';

              return (
                <button
                  key={index}
                  type="button"
                  onClick={() => goToStep(index)}
                  className="group flex-1 py-1.5 focus:outline-none"
                  title={question.question}
                  aria-label={question.question}
                >
                  <span className={`block h-1 rounded-full transition-colors duration-300 ${segmentColor}`} />
                </button>
              );
            })}
          </div>
        )}

        {/* Content */}
        <div key={stepIndex} className="px-6 pt-5 pb-6 min-h-[300px] animate-fade-in-up">
          {(currentQuestion.header || currentQuestion.multiSelect || isCurrentSkipped) && (
            <div className="flex items-center gap-2 mb-2.5">
              {currentQuestion.header && (
                <span className="inline-block text-[11px] font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                  {currentQuestion.header}
                </span>
              )}
              {currentQuestion.multiSelect && (
                <span className="text-xs text-secondary">
                  {i18nService.t('coworkQuestionWizardMultiSelectHint')}
                </span>
              )}
              {isCurrentSkipped && (
                <span className="inline-block text-[11px] font-medium px-2 py-0.5 rounded-full bg-surface-raised text-secondary">
                  {i18nService.t('coworkQuestionWizardSkipped')}
                </span>
              )}
            </div>
          )}

          <h3 className="text-lg font-semibold text-foreground leading-snug mb-4">
            {currentQuestion.question}
          </h3>

          <div className="space-y-2">
            {currentQuestion.options.map((option) => {
              const isSelected = selectedValues.includes(option.label);
              return (
                <button
                  key={option.label}
                  type="button"
                  onClick={() => handleSelectOption(currentQuestion, option.label)}
                  className={`w-full text-left rounded-xl border px-4 py-3 transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                    isSelected
                      ? 'border-primary bg-primary/10'
                      : 'border-border hover:border-primary/40 hover:bg-surface-raised'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {renderIndicator(Boolean(currentQuestion.multiSelect), isSelected)}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground">{option.label}</div>
                      {option.description && (
                        <div className="text-xs mt-1 text-secondary">{option.description}</div>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}

            {/* "Other" as an option-style card with an embedded input */}
            <label
              className={`block cursor-text rounded-xl border px-4 py-3 transition-all duration-150 ${
                isOtherActive
                  ? 'border-primary bg-primary/10'
                  : 'border-border hover:border-primary/40 hover:bg-surface-raised'
              }`}
            >
              <div className="flex items-start gap-3">
                {renderIndicator(Boolean(currentQuestion.multiSelect), isOtherActive)}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground">
                    {i18nService.t('coworkQuestionWizardOther')}
                  </div>
                  <input
                    type="text"
                    value={otherValue}
                    onChange={(e) => handleOtherInputChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                      if (!isLastStep) {
                        handleNext();
                      } else if (allResolved) {
                        handleSubmit();
                      }
                    }}
                    placeholder={i18nService.t('coworkQuestionWizardOtherPlaceholder')}
                    className="mt-1 w-full bg-transparent text-sm text-foreground placeholder:text-secondary/70 focus:outline-none"
                  />
                </div>
              </div>
            </label>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-border-subtle">
          <button
            type="button"
            onClick={handleSkip}
            className="px-2 py-1.5 text-sm font-medium rounded-lg text-secondary hover:text-foreground hover:bg-surface-raised transition-colors"
          >
            {i18nService.t('coworkQuestionWizardSkip')}
          </button>

          <div className="flex items-center gap-2">
            {!isFirstStep && (
              <button
                type="button"
                onClick={handlePrevious}
                className="inline-flex items-center gap-1 pl-3 pr-4 py-2 text-sm font-medium rounded-lg border border-border text-foreground hover:bg-surface-raised transition-colors"
              >
                <ChevronLeftIcon className="h-4 w-4" />
                {i18nService.t('coworkQuestionWizardPrevious')}
              </button>
            )}
            {isLastStep ? (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!allResolved}
                className="px-5 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-primary"
                title={!allResolved ? i18nService.t('coworkQuestionWizardAnswerRequired') : undefined}
              >
                {i18nService.t('coworkQuestionWizardSubmit')}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleNext}
                className="inline-flex items-center gap-1 pl-4 pr-3 py-2 text-sm font-medium rounded-lg border border-border text-foreground hover:bg-surface-raised transition-colors"
              >
                {i18nService.t('coworkQuestionWizardNext')}
                <ChevronRightIcon className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default CoworkQuestionWizard;
