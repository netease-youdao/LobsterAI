import type { ShareDeploymentProjectCandidate } from '../shareDeployment/constants';

export const LocalWebServicesIpc = {
  List: 'localWebServices:list',
} as const;
export type LocalWebServicesIpc = typeof LocalWebServicesIpc[keyof typeof LocalWebServicesIpc];

export interface LocalWebService {
  id: string;
  title: string;
  url: string;
  host: string;
  port: number;
  online: boolean;
  projectDirectory?: string;
  projectCandidates?: ShareDeploymentProjectCandidate[];
}

export interface ListLocalWebServicesOptions {
  preferredPorts?: number[];
}
