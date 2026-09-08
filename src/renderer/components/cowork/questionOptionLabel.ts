/** Recommendation suffixes are display metadata. Always submit the unchanged option label. */
export function stripQuestionRecommendation(label: string): string {
  const stripped = label.replace(/\s*[（(]\s*(?:recommended|推荐)\s*[）)]\s*$/i, '').trimEnd();
  return stripped.trim() ? stripped : label;
}
