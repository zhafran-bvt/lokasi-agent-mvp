import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config();

function must(name, fallback = '') {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid integer for ${name}: ${raw}`);
  }
  return parsed;
}

function csv(name, fallback = []) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  appName: must('APP_NAME', 'Target App'),
  appUrl: must('APP_URL'),
  appEmail: must('APP_EMAIL'),
  appPassword: must('APP_PASSWORD'),
  openAIApiKey: process.env.OPENAI_API_KEY || '',
  model: must('MODEL', 'gpt-5-mini'),
  headless: bool('HEADLESS', true),
  allowDestructive: bool('ALLOW_DESTRUCTIVE', false),
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  baselineName: must('BASELINE_NAME', 'default'),
  maxPages: int('MAX_PAGES', 20),
  maxNavLinksPerPage: int('MAX_NAV_LINKS_PER_PAGE', 20),
  maxActionsPerPage: int('MAX_ACTIONS_PER_PAGE', 6),
  requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 20_000),
  navigationTimeoutMs: int('NAVIGATION_TIMEOUT_MS', 30_000),
  llmTimeoutMs: int('LLM_TIMEOUT_MS', 60_000),
  printLlmReasoning: bool('PRINT_LLM_REASONING', true),
  workflowStepTimeoutMs: int('WORKFLOW_STEP_TIMEOUT_MS', 45_000),
  actionTimeoutMs: int('ACTION_TIMEOUT_MS', 90_000),
  runTimeoutMs: int('RUN_TIMEOUT_MS', 300_000),
  workflowCandidateLimit: int('WORKFLOW_CANDIDATE_LIMIT', 4),
  llmMaxGuidedSteps: int('LLM_MAX_GUIDED_STEPS', 3),
  datasetExplorerPlannerMaxSteps: int('DATASET_EXPLORER_PLANNER_MAX_STEPS', 16),
  datasetExplorerStickyRetryLimit: int('DATASET_EXPLORER_STICKY_RETRY_LIMIT', 2),
  datasetExplorerRecoveryAgentEnabled: bool('DATASET_EXPLORER_RECOVERY_AGENT_ENABLED', false),
  spatialAnalysisCaseLimit: int('SPATIAL_ANALYSIS_CASE_LIMIT', 6),
  spatialAnalysisCatchmentLocationQuery: process.env.SPATIAL_ANALYSIS_CATCHMENT_LOCATION_QUERY || 'Monas, Jakarta',
  spatialAnalysisCatchmentRadiusMeters: process.env.SPATIAL_ANALYSIS_CATCHMENT_RADIUS_METERS || '100',
  spatialAnalysisCatchmentLatitude: process.env.SPATIAL_ANALYSIS_CATCHMENT_LATITUDE || '-6.17254319',
  spatialAnalysisCatchmentLongitude: process.env.SPATIAL_ANALYSIS_CATCHMENT_LONGITUDE || '106.82316816',
  focusedWorkflow: process.env.FOCUSED_WORKFLOW || '',
  datasetExplorerProvince: process.env.DATASET_EXPLORER_PROVINCE || 'DKI Jakarta',
  datasetExplorerSpatialAggregations: csv(
    'DATASET_EXPLORER_SPATIAL_AGGREGATIONS',
    ['Point', 'Polygon', 'H3', 'Administrative Area', 'Geohash', 'Line'],
  ),
  mainFeatures: csv('MAIN_FEATURES', []),
  secondaryFeatures: csv('SECONDARY_FEATURES', []),
  loginSelectors: {
    email: process.env.LOGIN_EMAIL_SELECTOR || '',
    password: process.env.LOGIN_PASSWORD_SELECTOR || '',
    submit: process.env.LOGIN_SUBMIT_SELECTOR || '',
  },
};
