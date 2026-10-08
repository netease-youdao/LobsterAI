import { DataValidationErrorStyle } from '@univerjs/core';
import { Button } from '@univerjs/design';
import React from 'react';

import { i18nService } from '@/services/i18n';
import { ValidationAlertChoice } from '@/services/office/sheet/sheetValidation';

const t = (key: string) => i18nService.t(key);

const ICONS: Record<DataValidationErrorStyle, { symbol: string; kind: string }> = {
  [DataValidationErrorStyle.STOP]: { symbol: '✕', kind: 'stop' },
  [DataValidationErrorStyle.WARNING]: { symbol: '!', kind: 'warning' },
  [DataValidationErrorStyle.INFO]: { symbol: 'i', kind: 'information' },
};

/** Excel's error alert text: the rule's message, and for a warning the question to continue. */
export function SheetValidationAlertMessage({ errorStyle, message }: { errorStyle: DataValidationErrorStyle; message: string }): React.ReactElement {
  const icon = ICONS[errorStyle];
  return (
    <div className="lobster-sheet-alert">
      <span className={`lobster-sheet-alert-icon lobster-sheet-alert-${icon.kind}`} aria-hidden="true">{icon.symbol}</span>
      <div className="lobster-sheet-alert-text">
        <p>{message}</p>
        {errorStyle === DataValidationErrorStyle.WARNING && <p>{t('sheetValidationContinue')}</p>}
      </div>
    </div>
  );
}

/** Excel's buttons for each alert style; the default one has the focus, so Enter picks it. */
export function SheetValidationAlertButtons({ errorStyle, onChoose }: {
  errorStyle: DataValidationErrorStyle; onChoose: (choice: ValidationAlertChoice) => void;
}): React.ReactElement {
  const buttons: { choice: ValidationAlertChoice; label: string; preferred?: boolean }[] = errorStyle === DataValidationErrorStyle.WARNING
    ? [
      { choice: ValidationAlertChoice.Keep, label: 'sheetValidationYes' },
      { choice: ValidationAlertChoice.Retry, label: 'sheetValidationNo', preferred: true },
      { choice: ValidationAlertChoice.Discard, label: 'cancel' },
    ]
    : errorStyle === DataValidationErrorStyle.INFO
      ? [{ choice: ValidationAlertChoice.Keep, label: 'sheetValidationOk', preferred: true }, { choice: ValidationAlertChoice.Discard, label: 'cancel' }]
      : [{ choice: ValidationAlertChoice.Retry, label: 'sheetValidationRetry', preferred: true }, { choice: ValidationAlertChoice.Discard, label: 'cancel' }];
  return (
    <div className="lobster-sheet-alert-buttons">
      {buttons.map(button => (
        <Button key={button.choice} variant={button.preferred ? 'primary' : 'default'} autoFocus={button.preferred} onClick={() => onChoose(button.choice)}>
          {t(button.label)}
        </Button>
      ))}
    </div>
  );
}
