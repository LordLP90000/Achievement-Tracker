/**
 * Operations of openapi/openapi.yaml that are not implemented yet. The spec-coverage check fails if an operation is
 * neither exercised by a contract-validated test nor listed here, and also if a listed operation is exercised —
 * so this list can only shrink. Planned milestones: M2 auth/me/sessions/consents, M3 domain, M4 privacy.
 */
export const NOT_YET_IMPLEMENTED: ReadonlySet<string> = new Set([
  // M2 — accounts & sessions
  'listConsents',
  'grantConsent',
  'withdrawConsent',
  // M3 — core domain
  'getStats',
  'listAchievements',
  'createAchievement',
  'getAchievement',
  'updateAchievement',
  'deleteAchievement',
  'listQuests',
  'createQuest',
  'listGambles',
  'placeGamble',
  'getQuest',
  'updateQuest',
  'deleteQuest',
  'listCheckIns',
  'createCheckIn',
  'undoCheckIn',
  // M4 — privacy rights
  'exportData',
  'deleteAccount',
]);
