export type OllamaServerStatus =
  | 'unknown'
  | 'not-installed'
  | 'installing'
  | 'installed'
  | 'starting'
  | 'running'
  | 'stopped'
  | 'error';

export type OllamaStatusSnapshot = {
  status: OllamaServerStatus;
  version?: string;
  executablePath?: string;
  pid?: number;
  error?: string;
  checkedAt: string;
};

export type OllamaInstallProgressPhase =
  | 'detecting'
  | 'preset-found'
  | 'downloading'
  | 'downloading-progress'
  | 'installing'
  | 'done'
  | 'failed'
  | 'needs-manual';

export type OllamaInstallProgress = {
  phase: OllamaInstallProgressPhase;
  message?: string;
  percent?: number;
  installerPath?: string;
  downloadsDir?: string;
  officialUrl?: string;
  expectedFilenames?: string[];
  error?: string;
};

export type OllamaCancelPullResult = {
  success: true;
  cancelled: boolean;
};

export type OllamaModel = {
  name: string;
  model?: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: {
    parent_model?: string;
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
};

export type OllamaRunningModel = OllamaModel & {
  expires_at?: string;
  size_vram?: number;
  context_length?: number;
};

export type OllamaModelLaunchInput = {
  model: string;
  keep_alive?: string | number;
  options?: {
    num_ctx?: number;
    num_batch?: number;
    num_gpu?: number;
    main_gpu?: number;
    low_vram?: boolean;
    use_mmap?: boolean;
    use_mlock?: boolean;
    num_thread?: number;
  };
};

export type OllamaModelLaunchResult = {
  success: true;
  runningModels: OllamaRunningModel[];
};

export type OllamaChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
};

export type OllamaChatPayload = {
  model: string;
  messages: OllamaChatMessage[];
  stream?: boolean;
  keep_alive?: string | number;
  think?: boolean | 'high' | 'medium' | 'low';
  options?: Record<string, unknown>;
};

export type OllamaToolCall = {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
};

export type OllamaChatChunk = {
  model?: string;
  created_at?: string;
  message?: OllamaChatMessage;
  done?: boolean;
  done_reason?: string;
  error?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
};
