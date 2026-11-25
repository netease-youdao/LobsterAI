import dataDecisionMatrix from '../../assets/home-showcase/data-decision-matrix.jpg';
import dataImageToExcel from '../../assets/home-showcase/data-image-to-excel.jpg';
import dataMultiMerge from '../../assets/home-showcase/data-multi-merge.jpg';
import dataPersonalBill from '../../assets/home-showcase/data-personal-bill.jpg';
import dataPortfolioCheck from '../../assets/home-showcase/data-portfolio-check.jpg';
import dataSocialCreator from '../../assets/home-showcase/data-social-creator.jpg';
import dataStoreSales from '../../assets/home-showcase/data-store-sales.jpg';
import dataStudentGrades from '../../assets/home-showcase/data-student-grades.jpg';
import docArticleWriter from '../../assets/home-showcase/doc-article-writer.jpg';
import docContractReview from '../../assets/home-showcase/doc-contract-review.jpg';
import docMeetingMinutes from '../../assets/home-showcase/doc-meeting-minutes.jpg';
import docPdfDigest from '../../assets/home-showcase/doc-pdf-digest.jpg';
import docPolishEmail from '../../assets/home-showcase/doc-polish-email.jpg';
import docProposal from '../../assets/home-showcase/doc-proposal.jpg';
import docResumePolish from '../../assets/home-showcase/doc-resume-polish.jpg';
import docWeeklyReport from '../../assets/home-showcase/doc-weekly-report.jpg';
import pptTplAcademic from '../../assets/home-showcase/ppt-tpl-academic.jpg';
import pptTplDarkKeynote from '../../assets/home-showcase/ppt-tpl-dark-keynote.jpg';
import pptTplEmeraldKpi from '../../assets/home-showcase/ppt-tpl-emerald-kpi.jpg';
import pptTplMakeover from '../../assets/home-showcase/ppt-tpl-makeover.jpg';
import pptTplMckinsey from '../../assets/home-showcase/ppt-tpl-mckinsey.jpg';
import pptTplPitchBold from '../../assets/home-showcase/ppt-tpl-pitch-bold.jpg';
import pptTplPlayfulEdu from '../../assets/home-showcase/ppt-tpl-playful-edu.jpg';
import pptTplWarmEditorial from '../../assets/home-showcase/ppt-tpl-warm-editorial.jpg';
import researchAcademicReview from '../../assets/home-showcase/research-academic-review.jpg';
import researchApplianceBuy from '../../assets/home-showcase/research-appliance-buy.jpg';
import researchCompanyInterview from '../../assets/home-showcase/research-company-interview.jpg';
import researchEvCompare from '../../assets/home-showcase/research-ev-compare.jpg';
import researchHybridLocal from '../../assets/home-showcase/research-hybrid-local.jpg';
import researchIndustryLandscape from '../../assets/home-showcase/research-industry-landscape.jpg';
import researchPolicyCheck from '../../assets/home-showcase/research-policy-check.jpg';
import researchTravelGuide from '../../assets/home-showcase/research-travel-guide.jpg';
import webAnnualGallery from '../../assets/home-showcase/web-annual-gallery.jpg';
import webEventInvite from '../../assets/home-showcase/web-event-invite.jpg';
import webFamilyTrip from '../../assets/home-showcase/web-family-trip.jpg';
import webInteractiveExplainer from '../../assets/home-showcase/web-interactive-explainer.jpg';
import webInteractiveResume from '../../assets/home-showcase/web-interactive-resume.jpg';
import webLifeCalculator from '../../assets/home-showcase/web-life-calculator.jpg';
import webLocalShop from '../../assets/home-showcase/web-local-shop.jpg';
import webProductLaunch from '../../assets/home-showcase/web-product-launch.jpg';

export const SHOWCASE_COVER_IMAGES: Record<string, string> = {
  // Data Analysis (8)
  'data-personal-bill': dataPersonalBill,
  'data-store-sales': dataStoreSales,
  'data-multi-merge': dataMultiMerge,
  'data-image-to-excel': dataImageToExcel,
  'data-decision-matrix': dataDecisionMatrix,
  'data-social-creator': dataSocialCreator,
  'data-student-grades': dataStudentGrades,
  'data-portfolio-check': dataPortfolioCheck,

  // Deep Research (8)
  'research-appliance-buy': researchApplianceBuy,
  'research-ev-compare': researchEvCompare,
  'research-company-interview': researchCompanyInterview,
  'research-travel-guide': researchTravelGuide,
  'research-hybrid-local': researchHybridLocal,
  'research-industry-landscape': researchIndustryLandscape,
  'research-policy-check': researchPolicyCheck,
  'research-academic-review': researchAcademicReview,

  // Website (8)
  'web-interactive-resume': webInteractiveResume,
  'web-family-trip': webFamilyTrip,
  'web-life-calculator': webLifeCalculator,
  'web-event-invite': webEventInvite,
  'web-local-shop': webLocalShop,
  'web-interactive-explainer': webInteractiveExplainer,
  'web-product-launch': webProductLaunch,
  'web-annual-gallery': webAnnualGallery,

  // Slides Templates (8)
  'ppt-tpl-mckinsey': pptTplMckinsey,
  'ppt-tpl-emerald-kpi': pptTplEmeraldKpi,
  'ppt-tpl-dark-keynote': pptTplDarkKeynote,
  'ppt-tpl-warm-editorial': pptTplWarmEditorial,
  'ppt-tpl-academic': pptTplAcademic,
  'ppt-tpl-playful-edu': pptTplPlayfulEdu,
  'ppt-tpl-pitch-bold': pptTplPitchBold,
  'ppt-tpl-makeover': pptTplMakeover,

  // Document Writing (8)
  'doc-meeting-minutes': docMeetingMinutes,
  'doc-contract-review': docContractReview,
  'doc-weekly-report': docWeeklyReport,
  'doc-resume-polish': docResumePolish,
  'doc-proposal': docProposal,
  'doc-pdf-digest': docPdfDigest,
  'doc-article-writer': docArticleWriter,
  'doc-polish-email': docPolishEmail,
};

export function getShowcaseCoverImage(exampleId: string): string | undefined {
  return SHOWCASE_COVER_IMAGES[exampleId];
}
