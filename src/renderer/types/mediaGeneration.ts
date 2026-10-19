import type { MediaSelection, MediaSelectionMode } from '../../shared/media/defaultPolicy';

export type MediaGenerationMode = MediaSelectionMode;

export interface MediaModel {
  modelId: string;
  displayName: string;
  provider: string;
  mediaType: 'image' | 'video';
  generationTimeout: number;
  pricing: Record<string, unknown>;
  pricingDescription?: string;
  capabilities?: string;
  description?: string;
  unitCredits?: number;
  unitLabel?: string;
}

export interface MediaQuotaStatus {
  subscribed: boolean;
  planName: string;
  planDisplayName: string;
  yearMonth: string;
  totalAvailableCredits: number;
}

export type MediaGenerationSelection = MediaSelection;

export interface MediaTaskStatus {
  taskId: number;
  model: string;
  type: 'image' | 'video';
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'timeout' | 'cancelled';
  progress: number;
  resultUrls: string[];
  metadata: Record<string, unknown>;
  quotaRemaining: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
}

export interface MediaAttachmentRef {
  token: string;
  mediaType: 'image' | 'video' | 'audio';
  index: number;
  fileId: string;
  fileName: string;
  mimeType: string;
  localPath?: string;
  remoteUrl?: string;
  dataUrl?: string;
  role?: 'first_frame' | 'last_frame' | 'reference_image' | 'reference_video' | 'reference_audio';
}
