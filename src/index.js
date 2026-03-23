import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { createBrowserSession, closeBrowserSession, login } from './browser.js';
import { buildDiff } from './diff.js';
import { exploreApp } from './explorer.js';
import { buildMarkdownReport } from './report.js';
import { normalizeFeatureRecords, summarizeCoverage } from './run-model.js';
import {
  ensureDataDirs,
  loadBaseline,
  removePath,
  reportFile,
  runFile,
  saveBaseline,
  saveReport,
  saveRun,
  screenshotDir,
} from './storage.js';
import { nowIso, slugify, withTimeout } from './utils.js';

function makeRunId(mode) {
  return `${mode}-${slugify(config.baselineName)}-latest`;
}

function latestRunId() {
  const runsDir = path.join(config.dataDir, 'runs');
  if (!fs.existsSync(runsDir)) return null;

  const latest = fs
    .readdirSync(runsDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const absolutePath = path.join(runsDir, file);
      const stat = fs.statSync(absolutePath);
      return {
        runId: file.replace(/\.json$/u, ''),
        mtimeMs: stat.mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];

  return latest?.runId || null;
}

function loadRun(runId) {
  if (!runId) return null;

  try {
    return JSON.parse(fs.readFileSync(runFile(runId), 'utf8'));
  } catch {
    return null;
  }
}

function buildRunRecord({ runId, mode, loginResult = null, exploration = null, status = 'completed', partial = false, error = '' }) {
  const pages = exploration?.pages || [];
  const errors = [
    ...(exploration?.errors || []),
    ...(error ? [{ url: config.appUrl, error }] : []),
  ];

  const run = {
    runId,
    mode,
    appName: config.appName,
    appUrl: config.appUrl,
    loginResult,
    status,
    partial,
    startedAt: exploration?.startedAt || nowIso(),
    finishedAt: nowIso(),
    pageCount: exploration?.pageCount || pages.length,
    pages,
    errors,
    globalVersionHints: exploration?.globalVersionHints || [],
    globalFeatures: exploration?.globalFeatures || [],
    featureTiers: exploration?.featureTiers || { main: [], secondary: [], unclassified: [] },
    featureGroups: exploration?.featureGroups || {},
    globalFingerprint: exploration?.globalFingerprint || '',
  };

  run.featureRecords = normalizeFeatureRecords(run);
  run.coverage = summarizeCoverage(run);
  return run;
}

function saveRunArtifacts(run) {
  saveRun(run.runId, run);
  saveReport(run.runId, buildMarkdownReport(run));
}

function latestRun(mode = null) {
  const runsDir = path.join(config.dataDir, 'runs');
  if (!fs.existsSync(runsDir)) return null;

  const candidates = fs.readdirSync(runsDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => loadRun(file.replace(/\.json$/u, '')))
    .filter(Boolean)
    .filter((run) => !mode || run.mode === mode)
    .sort((a, b) => new Date(b.finishedAt || b.startedAt || 0) - new Date(a.finishedAt || a.startedAt || 0));

  return candidates[0] || null;
}

function mergeApprovedRun({ baseline, current, approvedFeatureGroups }) {
  if (!baseline || approvedFeatureGroups.includes('all')) {
    return {
      ...current,
      approval: {
        sourceRunId: current.runId,
        approvedFeatureGroups,
        approvedAt: nowIso(),
      },
    };
  }

  const approvedSet = new Set(approvedFeatureGroups.map((item) => String(item).trim()));
  const mergedFeatureRecords = [
    ...(baseline.featureRecords || []).filter((item) => !approvedSet.has(item.featureGroup)),
    ...(current.featureRecords || []).filter((item) => approvedSet.has(item.featureGroup)),
  ];

  const merged = {
    ...baseline,
    runId: `approved-${slugify(config.baselineName)}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    finishedAt: nowIso(),
    status: 'completed',
    partial: false,
    featureRecords: mergedFeatureRecords,
    approval: {
      sourceRunId: current.runId,
      approvedFeatureGroups,
      approvedAt: nowIso(),
    },
  };
  merged.coverage = summarizeCoverage(merged);
  return merged;
}

function printLatestReport() {
  ensureDataDirs();

  const runId = latestRunId();
  if (!runId) {
    throw new Error(`No runs found in ${path.join(config.dataDir, 'runs')}`);
  }

  const run = loadRun(runId);
  if (!run) {
    throw new Error(`Failed to load latest run: ${runId}`);
  }

  const markdown = buildMarkdownReport(run);
  saveReport(runId, markdown);

  console.log(`# Latest report: ${reportFile(runId)}`);
  console.log('');
  console.log(markdown);
}

async function performRun(mode) {
  ensureDataDirs();
  const runId = makeRunId(mode);
  removePath(runFile(runId));
  removePath(reportFile(runId));
  removePath(screenshotDir(runId));
  const session = await createBrowserSession(runId);
  let loginResult = null;
  let latestExploration = null;
  const effectiveRunTimeoutMs = config.focusedWorkflow === 'dataset-explorer-bvt'
    ? Math.max(config.runTimeoutMs, 1_800_000)
    : config.runTimeoutMs;
  const runControl = {
    deadlineAt: Date.now() + effectiveRunTimeoutMs,
    timedOut: false,
    timeoutError: '',
  };
  const timeoutId = setTimeout(async () => {
    runControl.timedOut = true;
    runControl.timeoutError = `run timed out after ${effectiveRunTimeoutMs}ms`;
    await closeBrowserSession(session).catch(() => {});
  }, effectiveRunTimeoutMs);

  try {
    loginResult = await withTimeout(
      () => login(session.page),
      Math.min(
        effectiveRunTimeoutMs,
        Math.max(180_000, config.requestTimeoutMs + config.navigationTimeoutMs + 10_000),
      ),
      'login',
    );
    const exploration = await exploreApp({
      page: session.page,
      runId,
      mode,
      runControl,
      onProgress: async (partialExploration) => {
        latestExploration = partialExploration;
        const partialRun = buildRunRecord({
          runId,
          mode,
          loginResult,
          exploration: partialExploration,
          status: runControl.timedOut ? 'timed_out' : 'running',
          partial: true,
          error: runControl.timeoutError,
        });
        saveRunArtifacts(partialRun);
      },
    });
    const baseline = mode === 'regression' ? loadBaseline(config.baselineName) : null;
    const run = buildRunRecord({
      runId,
      mode,
      loginResult,
      exploration,
      status: runControl.timedOut ? 'timed_out' : 'completed',
      partial: (exploration.errors || []).length > 0 || (exploration.pages || []).some((page) =>
        (page.actionResults || []).some((action) => action.error || action.workflow?.steps?.some((step) => step.error))),
      error: runControl.timeoutError,
    });

    if (mode === 'regression') {
      run.diff = await buildDiff({ baseline, current: run });
    }

    saveRunArtifacts(run);

    if (mode === 'baseline') {
      saveBaseline(config.baselineName, run);
    }

    return run;
  } catch (error) {
    const failedRun = buildRunRecord({
      runId,
      mode,
      loginResult,
      exploration: latestExploration,
      status: runControl.timedOut || (error instanceof Error && error.message.includes('timed out')) ? 'timed_out' : 'failed',
      partial: true,
      error: runControl.timeoutError || (error instanceof Error ? error.message : String(error)),
    });
    saveRunArtifacts(failedRun);
    throw error;
  } finally {
    clearTimeout(timeoutId);
    await closeBrowserSession(session).catch(() => {});
  }
}

function approveLatestRun() {
  ensureDataDirs();
  const current = latestRun('regression') || latestRun('baseline');
  if (!current) {
    throw new Error('No completed run found to approve');
  }

  const baseline = loadBaseline(config.baselineName);
  const selectors = process.argv.slice(3);
  const approvedFeatureGroups = selectors.length ? selectors : ['all'];
  const merged = mergeApprovedRun({ baseline, current, approvedFeatureGroups });

  saveBaseline(config.baselineName, merged);
  saveRunArtifacts(merged);

  console.log(JSON.stringify({
    approvedRunId: current.runId,
    baselineName: config.baselineName,
    approvedFeatureGroups,
    baselineFile: path.join(config.dataDir, 'baselines', `${config.baselineName}.json`),
  }, null, 2));
}

async function main() {
  const mode = process.argv[2] || 'baseline';

  if (!['baseline', 'regression', 'report-latest', 'approve-latest'].includes(mode)) {
    throw new Error(`Unsupported mode: ${mode}`);
  }

  if (mode === 'report-latest') {
    printLatestReport();
    return;
  }

  if (mode === 'approve-latest') {
    approveLatestRun();
    return;
  }

  const run = await performRun(mode);
  const summary = {
    runId: run.runId,
    mode: run.mode,
    pageCount: run.pageCount,
    errors: run.errors.length,
    diffSummary: run.diff
      ? {
          addedPages: run.diff.addedPages.length,
          removedPages: run.diff.removedPages.length,
          changedPages: run.diff.changedPages.length,
          summary: run.diff.llmReview?.summary || '',
        }
      : null,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
