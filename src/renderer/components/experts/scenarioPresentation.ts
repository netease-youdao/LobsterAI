import analyticsArtwork from '../../assets/expert-scenarios/industry/analytics.webp';
import careerArtwork from '../../assets/expert-scenarios/industry/career.webp';
import commerceArtwork from '../../assets/expert-scenarios/industry/commerce.webp';
import developmentArtwork from '../../assets/expert-scenarios/industry/development.webp';
import documentsArtwork from '../../assets/expert-scenarios/industry/documents.webp';
import educationArtwork from '../../assets/expert-scenarios/industry/education.webp';
import efficiencyArtwork from '../../assets/expert-scenarios/industry/efficiency.webp';
import gamesArtwork from '../../assets/expert-scenarios/industry/games.webp';
import legalArtwork from '../../assets/expert-scenarios/industry/legal.webp';
import mediaArtwork from '../../assets/expert-scenarios/industry/media.webp';

interface ScenarioPresentation {
  titleKey: string;
  artwork: string;
}

// Optional presentation for known catalog IDs. New scenarios retain their catalog title and accent.
export const SCENARIO_PRESENTATION: Partial<Record<string, ScenarioPresentation>> = {
  office: { titleKey: 'expertScenarioOffice', artwork: documentsArtwork },
  media: { titleKey: 'expertScenarioMedia', artwork: mediaArtwork },
  'everyday-efficiency': { titleKey: 'expertScenarioEfficiency', artwork: efficiencyArtwork },
  build: { titleKey: 'expertScenarioBuild', artwork: developmentArtwork },
  understand: { titleKey: 'expertScenarioData', artwork: analyticsArtwork },
  create: { titleKey: 'expertScenarioContent', artwork: mediaArtwork },
  commerce: { titleKey: 'expertScenarioCommerce', artwork: commerceArtwork },
  learning: { titleKey: 'expertScenarioLearning', artwork: educationArtwork },
  finance: { titleKey: 'expertScenarioFinance', artwork: analyticsArtwork },
  campus: { titleKey: 'expertScenarioCampus', artwork: educationArtwork },
  business: { titleKey: 'expertScenarioBusiness', artwork: commerceArtwork },
  legal: { titleKey: 'expertScenarioLegal', artwork: legalArtwork },
  career: { titleKey: 'expertScenarioCareer', artwork: careerArtwork },
  games: { titleKey: 'expertScenarioGames', artwork: gamesArtwork },
};
