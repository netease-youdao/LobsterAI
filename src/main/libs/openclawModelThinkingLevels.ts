import {
  OpenClawProviderId,
  parseModelThinkingLevel,
  resolveOpenClawThinkingLevel,
} from '../../shared/providers';
import { getServerModelMetadata } from './claudeSettings';

const LOBSTERAI_SERVER_MODEL_PREFIX = `${OpenClawProviderId.LobsteraiServer}/`;

export const resolveOpenClawThinkingLevelForModel = (
  modelRef: string,
  productLevel: string,
): string => {
  const normalizedModelRef = modelRef.trim();
  const normalizedProductLevel = parseModelThinkingLevel(productLevel);
  if (
    !normalizedProductLevel
    || !normalizedModelRef.startsWith(LOBSTERAI_SERVER_MODEL_PREFIX)
  ) {
    return productLevel;
  }

  const modelId = normalizedModelRef.slice(LOBSTERAI_SERVER_MODEL_PREFIX.length);
  const thinkingConfig = getServerModelMetadata(modelId)?.thinkingConfig;
  if (!thinkingConfig) return productLevel;

  // Server capability metadata can change between app launches. A persisted
  // product level that the model no longer advertises must follow the latest
  // server default; forwarding the stale value can make sessions.patch fail
  // while the renderer already displays the new default.
  const supportedProductLevel = thinkingConfig.options.some(
    option => option.level === normalizedProductLevel,
  )
    ? normalizedProductLevel
    : thinkingConfig.defaultLevel;
  return resolveOpenClawThinkingLevel(thinkingConfig, supportedProductLevel)
    ?? productLevel;
};
