import { classifyFeatureGroup, classifyFeatureTier } from './policy.js';
import { uniqueBy } from './utils.js';

function workflowStateType(step) {
  if (step?.stateType) return step.stateType;
  if (step?.addDataset?.added) return 'panel_change';
  if (step?.attributeFilter?.applied) return 'table_change';
  if (step?.provinceSelected) return 'panel_change';
  return 'no_progress';
}

function workflowStatus(step) {
  if (step?.status) return step.status;
  if (step?.addDataset?.added || step?.attributeFilter?.applied) return 'completed';
  if (step?.selectedDataset || step?.provinceSelected) return 'partial';
  return 'failed';
}

function makeFeatureRecord(base) {
  return {
    key: '',
    name: '',
    featureGroup: 'Unclassified',
    tier: 'unclassified',
    entryAction: '',
    driver: 'workflow',
    stateType: 'no_progress',
    status: 'failed',
    partial: false,
    selectedCandidate: '',
    screenshots: [],
    notes: '',
    pageUrl: '',
    metadata: {},
    ...base,
  };
}

export function normalizeFeatureRecords(run) {
  const records = [];

  for (const page of run.pages || []) {
    for (const feature of page.llm?.likely_features || []) {
      const featureGroup = feature.featureGroup || classifyFeatureGroup(feature);
      const tier = feature.tier || classifyFeatureTier(feature);
      records.push(makeFeatureRecord({
        key: `page:${page.url}:${featureGroup}:${feature.name}`,
        name: feature.name,
        featureGroup,
        tier,
        entryAction: 'page-scan',
        driver: 'llm',
        stateType: 'panel_change',
        status: 'completed',
        partial: false,
        screenshots: page.screenshot ? [page.screenshot] : [],
        notes: feature.description || '',
        pageUrl: page.url,
        metadata: {
          confidence: feature.confidence,
          riskLevel: feature.risk_level,
          importantActions: feature.important_actions || [],
        },
      }));
    }

    for (const actionResult of page.actionResults || []) {
      const actionText = actionResult.action?.text || 'Unknown Action';
      const featureGroup = classifyFeatureGroup({ name: actionText });
      const tier = classifyFeatureTier({ name: actionText });

      if (actionResult.workflow?.steps?.length) {
        for (const step of actionResult.workflow.steps) {
          const screenshots = uniqueBy(
            [
              step.contextScreenshot,
              step.timeoutScreenshot,
              ...(step.attempts || []).map((attempt) => attempt.screenshot),
            ].filter(Boolean),
            (item) => item,
          );
          const status = workflowStatus(step);
          records.push(makeFeatureRecord({
            key: `workflow:${featureGroup}:${actionText}:${step.aggregation || step.selectedCandidate || step.title || 'step'}`,
            name: step.aggregation || actionText,
            featureGroup,
            tier,
            entryAction: actionText,
            driver: 'workflow',
            stateType: workflowStateType(step),
            status,
            partial: status !== 'completed',
            selectedCandidate: step.selectedCandidate || '',
            screenshots,
            notes: step.error || '',
            pageUrl: step.url || page.url,
            metadata: {
              workflow: actionResult.workflow.name,
              featureGroup: actionResult.workflow.featureGroup || featureGroup,
              attempts: step.attempts || [],
              addDataset: step.addDataset || null,
              attributeFilter: step.attributeFilter || null,
            },
          }));
        }
        continue;
      }

      records.push(makeFeatureRecord({
        key: `action:${page.url}:${actionText}`,
        name: actionText,
        featureGroup,
        tier,
        entryAction: actionText,
        driver: actionResult.driver || 'workflow',
        stateType: actionResult.ok ? 'url_change' : 'no_progress',
        status: actionResult.ok ? 'completed' : 'failed',
        partial: !actionResult.ok,
        screenshots: [page.screenshot, actionResult.followupScreenshot].filter(Boolean),
        notes: actionResult.error || '',
        pageUrl: actionResult.afterUrl || page.url,
        metadata: {
          recovery: actionResult.recovery || null,
          llmGuidance: actionResult.llmGuidance || null,
        },
      }));
    }
  }

  return uniqueBy(records, (item) => item.key);
}

export function summarizeCoverage(run) {
  const featureRecords = run.featureRecords || [];
  const mainRecords = featureRecords.filter((item) => item.tier === 'main');
  const secondaryRecords = featureRecords.filter((item) => item.tier === 'secondary');
  const completed = featureRecords.filter((item) => item.status === 'completed');
  const partial = featureRecords.filter((item) => item.partial);

  return {
    totalFeatures: featureRecords.length,
    completedFeatures: completed.length,
    partialFeatures: partial.length,
    mainFeaturesCovered: uniqueBy(mainRecords.map((item) => item.featureGroup), (item) => item).length,
    secondaryFeaturesCovered: uniqueBy(secondaryRecords.map((item) => item.featureGroup), (item) => item).length,
    workflowAttempts: featureRecords.reduce((total, item) => total + ((item.metadata?.attempts || []).length || 0), 0),
  };
}
