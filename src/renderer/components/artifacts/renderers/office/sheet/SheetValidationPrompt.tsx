import React from 'react';

import type { ValidationPromptProps } from '@/services/office/sheet/sheetValidationPrompt';

/** A rule's input message beside the selected cell, like Excel's yellow note. */
export function SheetValidationPrompt({ popup }: { popup: { extraProps?: ValidationPromptProps } }): React.ReactElement | null {
  const { title, message } = popup.extraProps ?? {};
  if (!title?.trim() && !message?.trim()) return null;
  return (
    <div className="lobster-sheet-validation-prompt" role="tooltip">
      {title?.trim() && <strong>{title}</strong>}
      {message?.trim() && <span>{message}</span>}
    </div>
  );
}
