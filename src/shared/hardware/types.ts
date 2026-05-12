export type NvidiaGpuInfo = {
  index: number;
  name: string;
  memoryTotalMiB: number;
  memoryFreeMiB?: number;
};

export type NvidiaSmiSnapshot = {
  source: 'nvidia-smi';
  available: boolean;
  checkedAt: string;
  gpus: NvidiaGpuInfo[];
  error?: string;
};
