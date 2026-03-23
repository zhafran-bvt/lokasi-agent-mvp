import { reviewDiff } from './llm.js';
import { uniqueBy } from './utils.js';

function pageMap(run) {
  return new Map((run?.pages || []).map((page) => [page.url, page]));
}

function extractFeatureNames(page) {
  return (page?.llm?.likely_features || []).map((item) => item.name);
}

function diffArray(before = [], after = []) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((item) => !beforeSet.has(item)),
    removed: before.filter((item) => !afterSet.has(item)),
  };
}

function featureMap(run) {
  return new Map((run?.featureRecords || []).map((item) => [item.key, item]));
}

function diffFeatures(beforeRun, afterRun) {
  const before = featureMap(beforeRun);
  const after = featureMap(afterRun);
  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, current] of after.entries()) {
    const prior = before.get(key);
    if (!prior) {
      added.push({
        key,
        featureGroup: current.featureGroup,
        name: current.name,
        status: current.status,
      });
      continue;
    }

    if (
      prior.status !== current.status
      || prior.stateType !== current.stateType
      || prior.selectedCandidate !== current.selectedCandidate
      || prior.notes !== current.notes
    ) {
      changed.push({
        key,
        featureGroup: current.featureGroup,
        name: current.name,
        beforeStatus: prior.status,
        afterStatus: current.status,
        beforeStateType: prior.stateType,
        afterStateType: current.stateType,
        beforeCandidate: prior.selectedCandidate,
        afterCandidate: current.selectedCandidate,
      });
    }
  }

  for (const [key, prior] of before.entries()) {
    if (!after.has(key)) {
      removed.push({
        key,
        featureGroup: prior.featureGroup,
        name: prior.name,
        status: prior.status,
      });
    }
  }

  return { added, removed, changed };
}

export async function buildDiff({ baseline, current }) {
  if (!baseline) {
    return {
      baselineMissing: true,
      addedPages: (current.pages || []).map((page) => page.url),
      removedPages: [],
      changedPages: [],
      featureDiff: {
        added: (current.featureRecords || []).map((item) => ({
          key: item.key,
          featureGroup: item.featureGroup,
          name: item.name,
          status: item.status,
        })),
        removed: [],
        changed: [],
      },
      llmReview: {
        summary: 'No baseline found. Current run should be reviewed and accepted as initial baseline.',
        notable_changes: [],
        suspected_regressions: [],
        likely_intended_changes: [],
      },
    };
  }

  const before = pageMap(baseline);
  const after = pageMap(current);
  const featureDiff = diffFeatures(baseline, current);
  const addedPages = [];
  const removedPages = [];
  const changedPages = [];

  for (const [url, afterPage] of after.entries()) {
    const beforePage = before.get(url);
    if (!beforePage) {
      addedPages.push(url);
      continue;
    }

    const titleChanged = beforePage.title !== afterPage.title;
    const fingerprintChanged = beforePage.fingerprint !== afterPage.fingerprint;
    const featureDiff = diffArray(extractFeatureNames(beforePage), extractFeatureNames(afterPage));
    const actionBefore = (beforePage.actionResults || []).map((item) => `${item.action?.type}:${item.action?.text}`);
    const actionAfter = (afterPage.actionResults || []).map((item) => `${item.action?.type}:${item.action?.text}`);
    const actionDiff = diffArray(actionBefore, actionAfter);

    if (titleChanged || fingerprintChanged || featureDiff.added.length || featureDiff.removed.length || actionDiff.added.length || actionDiff.removed.length) {
      changedPages.push({
        url,
        titleChanged,
        fingerprintChanged,
        featureDiff,
        actionDiff,
        beforeTitle: beforePage.title,
        afterTitle: afterPage.title,
      });
    }
  }

  for (const [url] of before.entries()) {
    if (!after.has(url)) removedPages.push(url);
  }

  const diffPayload = {
    app: current.appName,
    baselineRunId: baseline.runId,
    currentRunId: current.runId,
    addedPages,
    removedPages,
    changedPages,
    featureDiff,
    incompleteFeatures: (current.featureRecords || []).filter((item) => item.partial).map((item) => ({
      key: item.key,
      featureGroup: item.featureGroup,
      name: item.name,
      status: item.status,
    })),
    baselineVersionHints: baseline.globalVersionHints || [],
    currentVersionHints: current.globalVersionHints || [],
    baselineFeatures: uniqueBy((baseline.globalFeatures || []).map((item) => item.name), (item) => item),
    currentFeatures: uniqueBy((current.globalFeatures || []).map((item) => item.name), (item) => item),
  };

  const llmReview = await reviewDiff(diffPayload);

  return {
    baselineMissing: false,
    addedPages,
    removedPages,
    changedPages,
    featureDiff,
    llmReview,
  };
}
