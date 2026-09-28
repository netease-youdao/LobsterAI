import { SLIDES_EDITOR } from '../../../shared/office/editors';
import { SLIDES_PACKAGE_LIMITS, type SlidesPackageInfo } from '../../../shared/office/slides/slidesFile';
import type { MainOfficeFormat } from '../officeEditing';
import { inspectSlidesPackage } from './slidesPackage';

export const SLIDES_FORMAT: MainOfficeFormat<SlidesPackageInfo> = {
  spec: SLIDES_EDITOR,
  limits: SLIDES_PACKAGE_LIMITS,
  inspect: inspectSlidesPackage,
  fileLogTag: '[SlidesFiles]',
  agentLogTag: '[SlidesAgent]',
};
