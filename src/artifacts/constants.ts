export const IpcChannel = {
  TransformReact: 'artifact:transformReact',
} as const;

export type IpcChannel = typeof IpcChannel[keyof typeof IpcChannel];
