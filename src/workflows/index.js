import { classifyFeatureGroup, matchesFeatureGroup } from '../policy.js';
import { runDatasetExplorerWorkflow } from './dataset-explorer.js';
import { runGenericFeatureWorkflow } from './generic-feature.js';
import { runSpatialAnalysisWorkflow } from './spatial-analysis.js';

export async function runFeatureWorkflow(context) {
  const actionText = context.action?.text || '';

  if (matchesFeatureGroup(actionText, 'Dataset Explorer')) {
    return runDatasetExplorerWorkflow(context);
  }

  if (matchesFeatureGroup(actionText, 'Spatial Analysis')) {
    return runSpatialAnalysisWorkflow(context);
  }

  const featureGroup = classifyFeatureGroup({ name: actionText });
  if (['Project Management', 'Dataset Management'].includes(featureGroup)) {
    return runGenericFeatureWorkflow({
      ...context,
      featureGroup,
    });
  }

  return null;
}
