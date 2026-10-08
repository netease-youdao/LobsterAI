import { ChatBubbleLeftRightIcon, MinusIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { useMemo, useRef, useState } from 'react';

import {
  type OpenClawQuestionAnswers,
  parseOpenClawQuestionAnswers,
  parseOpenClawQuestionRecord,
} from '../../../shared/cowork/openclawQuestion';
import { i18nService } from '../../services/i18n';
import type { CoworkPermissionRequest, CoworkPermissionResult } from '../../types/cowork';
import { stripQuestionRecommendation } from './questionOptionLabel';

interface CoworkNativeQuestionModalProps {
  permission: CoworkPermissionRequest;
  onRespond: (result: CoworkPermissionResult) => Promise<boolean | void> | boolean | void;
  onMinimize?: () => void;
  hidden?: boolean;
}

/** Native questions use questionId -> string[], without the legacy text keys or separators. */
export default function CoworkNativeQuestionModal({
  permission, onRespond, onMinimize, hidden = false,
}: CoworkNativeQuestionModalProps) {
  const record = useMemo(() => parseOpenClawQuestionRecord(permission.toolInput), [permission.toolInput]);
  const [selected, setSelected] = useState<OpenClawQuestionAnswers>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const submittingRef = useRef(false);
  const questions = record?.questions ?? [];
  const answers = Object.fromEntries(questions.map((question) => [
    question.questionId,
    [...(selected[question.questionId] ?? []), ...(other[question.questionId]?.trim() ? [other[question.questionId].trim()] : [])],
  ]));
  const complete = record !== null && parseOpenClawQuestionAnswers(questions, answers) !== null;
  const titleId = `${permission.requestId}-title`;
  const t = i18nService.t.bind(i18nService);

  const respond = async (result: CoworkPermissionResult) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setFailed(false);
    try {
      if (await onRespond(result) === false) setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };
  const cancel = () => void respond({ behavior: 'deny', message: t('cancel') });

  return (
    <div className={`fixed inset-0 z-50 items-center justify-center modal-backdrop ${hidden ? 'hidden' : 'flex'}`}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="modal-content w-full max-w-xl mx-4 bg-surface rounded-2xl shadow-modal overflow-hidden"
        onSubmit={(event) => {
          event.preventDefault();
          if (complete) void respond({ behavior: 'allow', updatedInput: { answers } });
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); cancel(); }
        }}
      >
        <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
          <ChatBubbleLeftRightIcon className="h-6 w-6 text-primary shrink-0" />
          <div className="flex-1">
            <h2 id={titleId} className="text-lg font-semibold text-foreground">{t('coworkSelectionRequired')}</h2>
            <p className="text-sm text-secondary">{t('coworkSelectionDescription')}</p>
          </div>
          {onMinimize && (
            <button type="button" onClick={onMinimize} aria-label={t('coworkPermissionMinimize')} className="p-2 text-secondary hover:bg-surface-raised rounded-lg">
              <MinusIcon className="h-5 w-5" />
            </button>
          )}
          <button type="button" onClick={cancel} disabled={submitting} aria-label={t('coworkPermissionCancel')} className="p-2 text-secondary hover:bg-surface-raised rounded-lg">
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <div className="px-6 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
          {questions.map((question) => (
            <fieldset key={question.questionId} disabled={submitting} className="border border-border rounded-xl p-4 space-y-3">
              <legend className="px-1 text-sm font-medium text-foreground">
                {question.header && <span className="text-xs text-secondary mr-2">{question.header}</span>}
                {question.question}
              </legend>
              {question.options.map((option) => (
                <label key={option.label} className="flex items-start gap-3 rounded-lg border border-border px-3 py-2 cursor-pointer hover:bg-surface-raised">
                  <input
                    type={question.multiSelect ? 'checkbox' : 'radio'}
                    name={question.questionId}
                    value={option.label}
                    checked={(selected[question.questionId] ?? []).includes(option.label)}
                    className="mt-1 accent-primary"
                    onChange={() => {
                      setSelected((previous) => {
                        const current = previous[question.questionId] ?? [];
                        const next = question.multiSelect
                          ? current.includes(option.label) ? current.filter((label) => label !== option.label) : [...current, option.label]
                          : [option.label];
                        return { ...previous, [question.questionId]: next };
                      });
                      if (!question.multiSelect) setOther((previous) => ({ ...previous, [question.questionId]: '' }));
                    }}
                  />
                  <span>
                    <span className="block text-sm font-medium text-foreground">{stripQuestionRecommendation(option.label)}</span>
                    {option.description && <span className="block text-xs text-secondary mt-1">{option.description}</span>}
                  </span>
                </label>
              ))}
              {(question.isOther || question.options.length === 0) && (
                <label className="block text-sm text-secondary">
                  {question.options.length > 0 ? t('coworkNativeQuestionOther') : t('coworkNativeQuestionAnswer')}
                  <textarea
                    value={other[question.questionId] ?? ''}
                    placeholder={t('coworkNativeQuestionAnswer')}
                    rows={2}
                    className="mt-2 w-full rounded-lg border border-border bg-background p-3 text-sm text-foreground focus:outline-none focus:border-primary"
                    onChange={(event) => {
                      setOther((previous) => ({ ...previous, [question.questionId]: event.target.value }));
                      if (!question.multiSelect) setSelected((previous) => ({ ...previous, [question.questionId]: [] }));
                    }}
                  />
                </label>
              )}
            </fieldset>
          ))}
          {(failed || !record) && <p role="alert" className="text-sm text-red-500">{t('coworkNativeQuestionSubmitFailed')}</p>}
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border">
          <button type="button" onClick={cancel} disabled={submitting} className="px-4 py-2 text-sm rounded-lg text-secondary hover:bg-surface-raised disabled:opacity-50">{t('cancel')}</button>
          <button type="submit" disabled={!complete || submitting} className="px-4 py-2 text-sm rounded-lg bg-primary hover:bg-primary-hover text-white disabled:opacity-50 disabled:cursor-not-allowed">{t('coworkConfirmSelection')}</button>
        </div>
      </form>
    </div>
  );
}
