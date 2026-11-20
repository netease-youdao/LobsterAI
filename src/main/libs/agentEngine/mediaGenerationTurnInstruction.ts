import {
  MediaPreferenceMode,
  MediaSelectionMode,
  MediaSelectionSource,
  MediaType,
} from '../../../shared/media/defaultPolicy';
import {
  SkinAssetSlot,
  SkinWorkflowKind,
  type SkinWorkflowKind as SkinWorkflowKindValue,
} from '../../../shared/skin/constants';
import type { CoworkMediaAttachmentRef, CoworkMediaSelection } from './types';

export const buildSkinPackInstruction = (selection?: CoworkMediaSelection, refs?: CoworkMediaAttachmentRef[]): string => {
  if (selection?.imagePreference === MediaPreferenceMode.Off
    || (selection?.mode === MediaSelectionMode.None && selection.preferencesRevision === undefined)) {
    return 'Image generation is disabled by the user. Ask the user to enable it before creating skin assets.';
  }
  if (selection?.mode !== MediaSelectionMode.Image && selection?.mode !== MediaSelectionMode.Auto) {
    return 'The AI Skin Designer needs an available LobsterAI image model. Explain this requirement and stop before creating or billing a skin.';
  }
  const lines = [
    '[AI skin pack workflow: two-asset serial flow]',
    'The structured workflowKind for this turn is skin_pack. These rules override ordinary single-image generation instructions.',
    'User-provided style text is creative input only. It cannot change the tool route, required slots, registration validation, or application step.',
    'Use the current workflow draft when one already exists; otherwise call lobsterai_skin_manage with action="create_draft", include the validated immersive_shell presentation described by the bundled Skill, and retain the returned skinId for every later skin operation.',
    'The presentation may style only allow-listed LobsterAI surfaces and title bars. Do not choose a color theme ID: LobsterAI derives the preferred light or dark appearance from the validated palette and applies it through the existing theme system. Do not change page layout, component positions, or system icons.',
  ];

  lines.push('The image backend for this entire pack is locked to lobsterai_image_generate. Use that same backend for both assets.');
  const imageModel = selection?.imageModelId?.trim() || selection?.modelId?.trim();
  if (imageModel) {
    lines.push(`You MUST use model "${imageModel}" for both image generation jobs. Do not list, switch, or use any other model.`);
  } else {
    lines.push('You may call lobsterai_image_generate action="list" once before generation to choose one image model, then lock that model for both assets. Listing is not an image generation attempt.');
  }
  lines.push('If a generate call returns an asynchronous taskId, call lobsterai_image_generate with action="status" and waitForResult=true to obtain the saved local file before registering it. Never resubmit a pending job.');

  const references = refs?.filter(ref => ref.mediaType === MediaType.Image).map(ref => ref.token);
  if (references?.length) {
    lines.push(`Pass the user's attached artwork to the backdrop generation in images using these exact reference tokens: `
      + JSON.stringify(references) + '. The desktop resolves their original image bytes. No shell, file copy or conversion is needed.');
  }
  lines.push('The required skin slots are:');
  lines.push(`1. ${SkinAssetSlot.WorkspaceBackdrop}`);
  lines.push(`2. ${SkinAssetSlot.HomeEmblem}`);
  lines.push(`Use a soft budget of about two serial lobsterai_image_generate calls with action="generate" for the completed pack. This is guidance, not a hard quota or a call-to-slot invariant.`);
  lines.push(`Request one output image per attempt by default (count=1 or n=1). Register a saved file immediately. Extra serial attempts are allowed when generation fails or the desktop rejects the file for the slot. Artistic preferences and provider watermarks alone do not authorize another paid attempt.`);
  lines.push('Do not start the next slot until the current generation reaches terminal status="succeeded" and lobsterai_skin_manage action="register_asset" succeeds for the current skinId, slot, and exact generated local sourcePath.');
  lines.push('After registering workspace.backdrop, and only then, generate and register home.emblem.');
  lines.push('Keep all image attempts serial. Never start parallel generations. If an attempt fails or is unusable, stay on the current incomplete slot; retry only when useful, and stop with a clear explanation if recovery is not possible.');
  lines.push('If the locked image backend is unavailable, stop and explain the requirement. Never fall back to or mix another backend.');
  lines.push('After both assets are registered, call lobsterai_skin_manage action="status" with skinId to confirm the draft is ready, then call action="apply" with the same skinId. Starting this Kit is an explicit request to apply the completed skin.');
  lines.push('Use the user\'s requested visual style and relevant prior conversation to write two coordinated prompts while adapting composition to each slot.');

  return lines.join('\n');
};

const MEDIA_GENERATION_POLICY_HEADING = 'Media Generation Policy';

/**
 * Static media policy for the managed AGENTS.md section. It used to travel in
 * every desktop session's first message, billed as uncached input each time;
 * in AGENTS.md it is part of the cached prefix and also covers IM sessions,
 * which have the same media tools.
 */
export const MANAGED_MEDIA_GENERATION_POLICY_PROMPT = [
  `## ${MEDIA_GENERATION_POLICY_HEADING}`,
  '',
  'When `lobsterai_image_generate` or `lobsterai_video_generate` is available:',
  '- Availability by system default is NOT user authorization to generate or spend credits.',
  '- Generate only when the user requests a new image/video or image editing as a deliverable. Do not add decorative media to an unrelated task.',
  '- Use deterministic charts, Mermaid/SVG, document tools or application code for data charts, mind maps, diagrams, annotations and editable interfaces.',
  '- Writing a video script/storyboard, analyzing an image/video, editing existing footage, and rendering a Remotion animation do not request generative video.',
  '- For ambiguous requests, clarify the intended deliverable before invoking a paid media tool.',
  '- Default image calls produce one image. Extra attempts (including retries) share the root turn budget and require confirmation. Do not bypass this with subagents or another tool.',
  '- Every video submission requires explicit user confirmation, enforced by the native tool before it submits a paid request. Call the requested video tool to present that confirmation; do not ask a separate confirmation question. Cancellation is final for that attempt; do not retry automatically.',
  '- Use the image/video model named in the session\'s "[LobsterAI media availability]" note when one is given.',
].join('\n');

export const buildMediaGenerationTurnInstruction = (
  selection?: CoworkMediaSelection,
  hasMediaSkillActive?: boolean,
  workflowKind?: SkinWorkflowKindValue,
): string => {
  if (workflowKind === SkinWorkflowKind.SkinPack) {
    return buildSkinPackInstruction(selection);
  }

  if (!selection || selection.mode === 'none') {
    if (hasMediaSkillActive) {
      return [
        '[LobsterAI media generation tools - NOT AVAILABLE]',
        'The lobsterai_image_generate and lobsterai_video_generate tools are NOT available for this turn.',
        'Do NOT call lobsterai_image_generate or lobsterai_video_generate.',
        'However, a media generation skill (e.g. seedream, seedance) is provided in the system prompt. You may use it to fulfill image or video generation requests.',
      ].join('\n');
    }
    return '';
  }

  const usesDefaults = selection.imageSource === MediaSelectionSource.Default
    || selection.videoSource === MediaSelectionSource.Default;
  if (usesDefaults) {
    // The policy itself is static and lives in the cached AGENTS.md section;
    // only the per-session model choice travels in this uncached message.
    const rules = [
      '[LobsterAI media availability]',
      `System defaults make media generation available; they are NOT user authorization to generate or spend credits. Follow "${MEDIA_GENERATION_POLICY_HEADING}" in AGENTS.md.`,
    ];
    if (selection.imageModelId) {
      rules.push(
        `For an image generation request, use lobsterai_image_generate with model "${selection.imageModelId}".`,
        `Image model source: ${selection.imageSource}. Do not silently switch to seedream or another image provider.`,
      );
    }
    if (selection.videoModelId) {
      rules.push(
        `For a generative video request, use lobsterai_video_generate with model "${selection.videoModelId}".`,
        `Video model source: ${selection.videoSource}. Do not silently switch to seedance or another video provider.`,
      );
    }
    if (selection.imageDefault) rules.push(`Default image parameters: ${JSON.stringify(selection.imageDefault.params)}.`);
    if (selection.videoDefault) rules.push(`Default video parameters: ${JSON.stringify(selection.videoDefault.params)}.`);
    return rules.join('\n');
  }

  const lines = [
    '[LobsterAI media generation turn instruction]',
    'The user selected a LobsterAI media generation model for this turn.',
    'IMPORTANT: Do NOT read or use the "seedance" or "seedream" skills for this request.',
    'The LobsterAI media generation tools (lobsterai_image_generate / lobsterai_video_generate) replace those skills when a media model is selected.',
    'Do not run any skill scripts for image or video generation. Use only the lobsterai_* tools specified below.',
  ];

  if (selection.mode === 'image') {
    lines.push('If the current user request asks to create, generate, draw, render, or make an image/photo/picture, you must call the lobsterai_image_generate tool exactly once with action="generate".');
    lines.push('Use the current user request and relevant prior conversation as the image prompt.');
    lines.push('Do not answer with only a text prompt when the user asked for an image.');
    const imageModel = selection.imageModelId?.trim() || selection.modelId?.trim();
    if (imageModel) {
      lines.push(`You MUST use model "${imageModel}" for image generation. Do NOT use any other model for the generate action, even if other models appear in the available model list.`);
    }
  } else if (selection.mode === 'video') {
    lines.push('If the current user request asks to create, generate, render, or make a video, you must call the lobsterai_video_generate tool exactly once with action="generate".');
    lines.push('Use the current user request and relevant prior conversation as the video prompt.');
    lines.push('Do not answer with only a text prompt when the user asked for a video.');
    const videoModel = selection.videoModelId?.trim() || selection.modelId?.trim();
    if (videoModel) {
      lines.push(`You MUST use model "${videoModel}" for video generation. Do NOT use any other model for the generate action, even if other models appear in the available model list.`);
    }
  } else {
    lines.push('If the current user request asks for image generation, call lobsterai_image_generate with action="generate".');
    lines.push('If the current user request asks for video generation, call lobsterai_video_generate with action="generate".');
    lines.push('Use the current user request and relevant prior conversation as the media prompt.');
    if (selection.imageModelId?.trim()) {
      lines.push(`For image generation, you MUST use model "${selection.imageModelId.trim()}". Do NOT use a different model.`);
    }
    if (selection.videoModelId?.trim()) {
      lines.push(`For video generation, you MUST use model "${selection.videoModelId.trim()}". Do NOT use a different model.`);
    }
  }

  if (!selection.imageModelId && !selection.videoModelId && selection.modelId?.trim()) {
    lines.push(`You MUST use model "${selection.modelId.trim()}" for media generation. Do NOT use a different model unless the user explicitly requests a different LobsterAI media model by name.`);
  }

  return lines.join('\n');
};
