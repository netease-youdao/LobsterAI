import React, { useEffect, useMemo, useState } from 'react';
import type { CoworkPermissionRequest, CoworkPermissionResult } from '../../types/cowork';
import { ChevronLeftIcon, ChevronRightIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';

interface CoworkQuestionWizardProps {
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

const CoworkQuestionWizard: React.FC<CoworkQuestionWizardProps> = ({
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

  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [otherInputs, setOtherInputs] = useState<Record<number, string>>({});

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
  }, [permission.requestId, toolInput]);

  if (questions.length === 0) {
    return null;
  }

  const currentQuestion = questions[currentStep];
  const totalSteps = questions.length;
  const isFirstStep = currentStep === 0;
  const isLastStep = currentStep === totalSteps - 1;

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
    if (!question.multiSelect) {
      setAnswers((prev) => ({
        ...prev,
        [question.question]: optionLabel,
      }));

      // 单选题选择后自动跳转到下一题（延迟执行以显示选中效果）
      setTimeout(() => {
        // 使用函数式更新获取最新的 currentStep
        setCurrentStep((prevStep) => {
          const nextStep = prevStep + 1;
          // 只有不是最后一题才跳转
          if (nextStep < questions.length) {
            return nextStep;
          }
          return prevStep;
        });
      }, 150);
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
      [currentStep]: value,
    }));
  };

  const handlePrevious = () => {
    if (!isFirstStep) {
      setCurrentStep((prev) => prev - 1);
    }
  };

  const handleNext = () => {
    if (!isLastStep) {
      setCurrentStep((prev) => prev + 1);
    }
  };

  const handleSkip = () => {
    // Clear the answer for the current question
    setAnswers((prev) => {
      const newAnswers = { ...prev };
      delete newAnswers[currentQuestion.question];
      return newAnswers;
    });
    setOtherInputs((prev) => {
      const newInputs = { ...prev };
      delete newInputs[currentStep];
      return newInputs;
    });

    if (!isLastStep) {
      handleNext();
    }
  };

  const handleSubmit = () => {
    // Merge "Other" inputs into answers
    const finalAnswers = { ...answers };
    Object.entries(otherInputs).forEach(([stepIndex, otherValue]) => {
      const question = questions[Number(stepIndex)];
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

  // Check whether every question has at least one answer (selected option or "other" input)
  const allAnswered = questions.every((q, idx) => {
    const hasSelection = Boolean(answers[q.question]?.trim());
    const hasOther = Boolean(otherInputs[idx]?.trim());
    return hasSelection || hasOther;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop">
      <div className="modal-content w-full max-w-2xl mx-4 bg-surface rounded-2xl shadow-modal overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-foreground">
              {i18nService.t('coworkQuestionWizardTitle')}
            </h2>
          </div>
          <button
            onClick={handleDeny}
            className="p-2 rounded-lg hover:bg-surface-raised text-secondary transition-colors"
            aria-label="Close"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Progress bar */}
        <div className="h-1 bg-surface-raised">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${((currentStep + 1) / totalSteps) * 100}%` }}
          />
        </div>

        {/* Content */}
        <div className="px-6 py-6 min-h-[300px] flex flex-col">
          <div className="flex-1">
            {/* Question header and navigation */}
            <div className="flex items-start justify-between gap-4 mb-4">
              <div className="flex-1">
                {currentQuestion.header && (
                  <span className="inline-block text-[11px] uppercase tracking-wide px-2 py-1 rounded-full bg-surface-raised text-secondary mb-3">
                    {currentQuestion.header}
                  </span>
                )}
                {/* Question text */}
                <h3 className="text-base font-medium text-foreground">
                  {currentQuestion.question}
                </h3>
              </div>

              {/* Step indicators and navigation */}
              <div className="flex items-center gap-2">
                {/* Previous button */}
                {!isFirstStep && (
                  <button
                    onClick={handlePrevious}
                    className="p-1.5 rounded-lg text-foreground hover:bg-surface-raised transition-colors"
                    title={i18nService.t('coworkQuestionWizardPrevious')}
                  >
                    <ChevronLeftIcon className="h-5 w-5" />
                  </button>
                )}

                {/* Step dots */}
                <div className="flex items-center gap-1.5">
                  {questions.map((question, index) => {
                    const isActive = index === currentStep;
                    const isAnswered = Boolean(answers[question.question]?.trim() || otherInputs[index]?.trim());

                    return (
                      <button
                        key={index}
                        type="button"
                        onClick={() => setCurrentStep(index)}
                        className={`relative flex items-center justify-center w-7 h-7 rounded-full text-xs font-medium transition-all ${
                          isActive
                            ? 'bg-primary text-white shadow-md'
                            : isAnswered
                            ? 'bg-green-500/20 dark:bg-green-600/20 text-green-700 dark:text-green-400 border border-green-500 dark:border-green-600 hover:scale-105'
                            : 'bg-surface-raised text-secondary hover:bg-primary/20 dark:hover:bg-primary/20 hover:scale-105'
                        }`}
                        title={question.question}
                      >
                        {isAnswered && !isActive ? (
                          <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none">
                            <path d="M13 4L6 11L3 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        ) : (
                          index + 1
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* Next button */}
                {!isLastStep && (
                  <button
                    onClick={handleNext}
                    className="p-1.5 rounded-lg text-foreground hover:bg-surface-raised transition-colors"
                    title={i18nService.t('coworkQuestionWizardNext')}
                  >
                    <ChevronRightIcon className="h-5 w-5" />
                  </button>
                )}
              </div>
            </div>

            {/* Options */}
            <div className="space-y-2">
              {currentQuestion.options.map((option) => {
                const isSelected = selectedValues.includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => handleSelectOption(currentQuestion, option.label)}
                    className={`w-full text-left rounded-lg border px-4 py-3 transition-all ${
                      isSelected
                        ? 'border-primary bg-primary/10 text-foreground shadow-sm'
                        : 'border-border text-secondary hover:bg-surface-raised hover:border-primary/50'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      {currentQuestion.multiSelect ? (
                        <div className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded border-2 transition-colors ${
                          isSelected
                            ? 'bg-primary border-primary'
                            : 'border-border'
                        }`}>
                          {isSelected && (
                            <svg className="w-full h-full text-white" viewBox="0 0 16 16" fill="none">
                              <path d="M13 4L6 11L3 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </div>
                      ) : (
                        <div className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded-full border-2 transition-colors ${
                          isSelected
                            ? 'border-primary'
                            : 'border-border'
                        }`}>
                          {isSelected && (
                            <div className="w-full h-full rounded-full bg-primary scale-50" />
                          )}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium">{option.label}</div>
                        {option.description && (
                          <div className="text-xs mt-1 opacity-80">{option.description}</div>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Other input and Skip button in same row */}
            <div className="mt-4 flex items-center gap-3">
              <input
                type="text"
                value={otherInputs[currentStep] || ''}
                onChange={(e) => handleOtherInputChange(e.target.value)}
                placeholder={i18nService.t('coworkQuestionWizardOther')}
                className="flex-1 px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-secondary dark:placeholder:text-foregroundSecondary focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
              />
              <button
                type="button"
                onClick={handleSkip}
                className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors whitespace-nowrap"
              >
                {i18nService.t('coworkQuestionWizardSkip')}
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-6 py-4 border-t border-border bg-surface-raised">
          <button
            onClick={handleSubmit}
            disabled={!allAnswered}
            className={`px-5 py-2 text-sm font-medium rounded-lg text-white transition-colors ${
              allAnswered
                ? 'bg-primary hover:bg-primary-hover'
                : 'bg-primary/50 cursor-not-allowed'
            }`}
            title={!allAnswered ? i18nService.t('coworkQuestionWizardAnswerRequired') : undefined}
          >
            {i18nService.t('coworkQuestionWizardSubmit')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CoworkQuestionWizard;
