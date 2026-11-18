export const CoworkMessageEditPhase = {
  Prepared: 'prepared',
  Rewound: 'rewound',
  Sending: 'sending',
  Committed: 'committed',
  Restoring: 'restoring',
  Restored: 'restored',
} as const;
export type CoworkMessageEditPhase = typeof CoworkMessageEditPhase[keyof typeof CoworkMessageEditPhase];

export interface CoworkMessageEditRequest {
  sessionId: string;
  messageId: string;
  prompt: string;
  removedImageIndexes?: number[];
}

export interface CoworkMessageEditPending {
  operationId: string;
  messageId: string;
  prompt: string;
  phase: CoworkMessageEditPhase;
  removedImageIndexes?: number[];
}

export interface CoworkMessageEditResult {
  success: boolean;
  error?: string;
  pending?: CoworkMessageEditPending;
  /** After a version switch: the message that heads the version now shown. */
  messageId?: string;
}

/** Where a user message sits among the versions an edit left at the same point; `index` is 1-based. */
export interface CoworkMessageVersionInfo {
  index: number;
  count: number;
}

export interface CoworkMessageVersionSwitchRequest {
  sessionId: string;
  messageId: string;
  /** 1-based position of the version to show. */
  targetIndex: number;
}

export const messageEditTranslations = {
  zh: {
    coworkEditSave: '发送',
    coworkEditSending: '发送中…',
    coworkEditCancel: '取消',
    coworkEditWorking: '正在更新对话…',
    coworkEditNotice: '重新发送将替换本条及之后的对话；文件和已执行操作不会撤销。',
    coworkEditBusy: '请等待当前任务结束后再修改。',
    coworkEditUnsupported: '此消息暂不支持安全修改，可以复制内容后发送新消息。',
    coworkEditChanged: '对话已发生变化，请重新打开修改。',
    coworkEditMissingAttachment: '原附件无法读取，请移除该附件后重试。对话尚未回滚。',
    coworkEditLegacyImageContext: '这条旧图片编辑消息的原编辑记录已无法找回。请移除原图片后发送文字，或在输入框中重新添加图片。',
    coworkEditImageTooLarge: '原图片过大且无法压缩，请移除该图片后重试。对话尚未回滚。',
    coworkEditEmpty: '请输入内容或保留至少一个附件。',
    coworkEditFailed: '修改未完成，编辑内容已保留。请重试。',
    coworkEditRecoveryNeeded: '上次修改尚未确认完成。请先检查并恢复，再继续发送。',
    coworkEditRecover: '检查并恢复对话',
    coworkEditRecoveryFailed: '暂时无法确认网关状态，恢复副本已保留。请稍后重试。',
    coworkEditRemoveAttachment: '移除附件',
    coworkEditContextKept: '原消息的技能、工具包和引用上下文会保留。',
    coworkEditLabel: '修改消息',
    coworkVersionPrevious: '上一个版本',
    coworkVersionNext: '下一个版本',
    coworkVersionSwitchFailed: '暂时无法切换到这个版本，对话未改变。请稍后重试。',
  },
  en: {
    coworkEditSave: 'Send',
    coworkEditSending: 'Sending…',
    coworkEditCancel: 'Cancel',
    coworkEditWorking: 'Updating conversation…',
    coworkEditNotice: 'Resending replaces this message and the conversation after it. Files and completed actions are not undone.',
    coworkEditBusy: 'Wait for the current task to finish before editing.',
    coworkEditUnsupported: 'This message cannot be safely edited yet. You can copy it and send a new message.',
    coworkEditChanged: 'The conversation has changed. Please open the editor again.',
    coworkEditMissingAttachment: 'An original attachment could not be read. Remove it and retry. The conversation has not been rewound.',
    coworkEditLegacyImageContext: 'The original editing record for this older image-edit message can no longer be found. Remove the original images to send text, or add the images again in the composer.',
    coworkEditImageTooLarge: 'An original image is too large and could not be compressed. Remove it and retry. The conversation has not been rewound.',
    coworkEditEmpty: 'Enter a message or keep at least one attachment.',
    coworkEditFailed: 'The edit did not finish. Your changes are preserved. Please retry.',
    coworkEditRecoveryNeeded: 'A previous edit has not been confirmed. Check and recover it before sending another message.',
    coworkEditRecover: 'Check and recover conversation',
    coworkEditRecoveryFailed: 'The gateway state could not be confirmed. Your recovery copy is preserved. Please retry later.',
    coworkEditRemoveAttachment: 'Remove attachment',
    coworkEditContextKept: 'Skills, kits, and referenced context from the original message are preserved.',
    coworkEditLabel: 'Edit message',
    coworkVersionPrevious: 'Previous version',
    coworkVersionNext: 'Next version',
    coworkVersionSwitchFailed: 'This version cannot be shown right now. The conversation is unchanged. Please retry later.',
  },
};
