export const ExpertTeamPresetPrefix = 'expert-team:';

export interface ExpertTeamInstallRequest {
  definitionId: string;
}

export interface ExpertTeamInstallResult {
  success: boolean;
  leadAgentId?: string;
  memberAgentIds?: string[];
  runtimeReady?: boolean;
  missingSkillIds?: string[];
  error?: string;
}
