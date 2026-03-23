import { config } from './config.js';

const DANGEROUS_ACTION_KEYWORDS = [
  'delete', 'remove', 'archive', 'destroy', 'wipe', 'truncate', 'reset', 'drop',
  'hapus', 'buang', 'arsip', 'reset',
];

const FEATURE_ACTION_ALIASES = {
  'Spatial Analysis': [
    'spatial analysis',
    'analysis',
    'analysis runner',
    'analysis controls',
    'analysis panel',
    'analysis launcher',
    'aoi',
    'area of interest',
    'draw polygon',
    'drawing tools',
    'map canvas',
    'map controls',
    'map interaction',
    'recenter map',
    'basemap',
    'zoom',
  ],
  'Dataset Explorer': [
    'dataset explorer',
    'dataset browser',
    'dataset preview',
  ],
  'Dataset Management': [
    'dataset management',
    'upload dataset',
    'dataset lifecycle',
    'dataset admin',
  ],
  'Project Management': [
    'project management',
    'analysis job queue',
    'job queue',
    'job status',
    'job history',
    'queued jobs',
    'running jobs',
    'project',
  ],
  Search: [
    'search',
    'address lookup',
    'geocoding',
  ],
  Settings: [
    'settings',
    'preferences',
  ],
  Expand: [
    'expand',
    'layout controls',
  ],
  Collapse: [
    'collapse',
    'sidebar toggle',
    'toggle sidebar',
  ],
  'My Account': [
    'my account',
    'account',
    'profile',
    'sign out',
  ],
};

export const agentPolicy = {
  mission: 'Explore the app safely, prioritize main features, capture reusable memory, and support regression comparison.',
  priorities: {
    mainFeatures: config.mainFeatures,
    secondaryFeatures: config.secondaryFeatures,
    focusedWorkflow: config.focusedWorkflow,
  },
  safety: {
    allowDestructive: config.allowDestructive,
    dangerousActionKeywords: DANGEROUS_ACTION_KEYWORDS,
    maxPages: config.maxPages,
    maxActionsPerPage: config.maxActionsPerPage,
    retryOnTransientUi: true,
    maxRecoveryAttemptsPerAction: 1,
  },
  stopConditions: [
    'max pages reached',
    'max actions per page reached',
    'recovery attempt exhausted',
    'same state revisited without meaningful change',
  ],
};

export function normalizePolicyText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function keywordMatch(text, keywords) {
  const normalized = normalizePolicyText(text);
  return keywords.some((keyword) => normalized.includes(normalizePolicyText(keyword)));
}

export function isDangerousLabel(text) {
  return keywordMatch(text, DANGEROUS_ACTION_KEYWORDS);
}

export function aliasesForFeature(featureName) {
  return FEATURE_ACTION_ALIASES[String(featureName || '').trim()] || [];
}

export function matchesFeatureGroup(text, featureName) {
  const normalized = normalizePolicyText(text);
  const feature = String(featureName || '').trim();
  if (!normalized || !feature) return false;

  if (aliasesForFeature(feature).some((alias) => normalized.includes(normalizePolicyText(alias)))) {
    return true;
  }

  return normalized.includes(normalizePolicyText(feature));
}

export function actionPriority(text) {
  for (const feature of config.mainFeatures) {
    if (matchesFeatureGroup(text, feature)) return 0;
  }

  for (const feature of config.secondaryFeatures) {
    if (matchesFeatureGroup(text, feature)) return 1;
  }

  return 2;
}

export function classifyFeatureTier(feature) {
  const normalized = normalizePolicyText(feature?.name);

  if (aliasesForFeature('Project Management').some((alias) => normalized.includes(normalizePolicyText(alias)))) {
    return 'main';
  }

  for (const featureName of config.mainFeatures) {
    if (matchesFeatureGroup(normalized, featureName)) return 'main';
  }

  for (const featureName of config.secondaryFeatures) {
    if (matchesFeatureGroup(normalized, featureName)) return 'secondary';
  }

  return 'unclassified';
}

export function classifyFeatureGroup(feature) {
  const normalized = normalizePolicyText(feature?.name);

  if (aliasesForFeature('Project Management').some((alias) => normalized.includes(normalizePolicyText(alias)))) {
    return 'Project Management';
  }

  for (const featureName of config.mainFeatures) {
    if (matchesFeatureGroup(normalized, featureName)) return featureName;
  }

  for (const featureName of config.secondaryFeatures) {
    if (matchesFeatureGroup(normalized, featureName)) return featureName;
  }

  return 'Unclassified';
}
