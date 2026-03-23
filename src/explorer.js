import { analyzePage } from './llm.js';
import {
  buildCandidateActions,
  buildCandidateLinks,
  capturePageSnapshot,
  executeCandidateAction,
  restorePage,
} from './browser.js';
import { classifyFeatureGroup, classifyFeatureTier } from './policy.js';
import { config } from './config.js';
import { hash, nowIso, uniqueBy, withTimeout } from './utils.js';

function logStage(runId, message, extra = '') {
  const suffix = extra ? ` ${extra}` : '';
  console.log(`[${new Date().toISOString()}] [${runId}] ${message}${suffix}`);
}

function clip(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '-';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function logLlmReasoning(runId, llm) {
  if (!config.printLlmReasoning || !llm) return;
  if (llm.page_name) {
    logStage(runId, 'llm.page_name', clip(llm.page_name, 120));
  }
  if (llm.purpose) {
    logStage(runId, 'llm.purpose', clip(llm.purpose));
  }
  if (llm.capability_summary) {
    logStage(runId, 'llm.capability_summary', clip(llm.capability_summary));
  }
  if (llm.why_this_page) {
    logStage(runId, 'llm.why_this_page', clip(llm.why_this_page));
  }
  if (llm._llm_error) {
    logStage(runId, 'llm.error', clip(llm._llm_error, 140));
  }
  for (const feature of (llm.likely_features || []).slice(0, 4)) {
    logStage(
      runId,
      'llm.feature',
      `${clip(feature.name, 50)} risk=${feature.risk_level} confidence=${feature.confidence} ${clip(feature.description, 100)}`,
    );
    if (feature.why_this_feature) {
      logStage(runId, 'llm.feature_reason', `${clip(feature.name, 50)} -> ${clip(feature.why_this_feature, 120)}`);
    }
    for (const action of (feature.important_actions || []).slice(0, 2)) {
      logStage(runId, 'llm.feature_action', `${clip(feature.name, 50)} -> ${clip(action, 120)}`);
    }
  }
  for (const action of (llm.candidate_next_actions || []).slice(0, 3)) {
    logStage(runId, 'llm.next_action', clip(action.action || action, 130));
    if (action.why_this_action) {
      logStage(runId, 'llm.next_action_reason', `${clip(action.action, 50)} -> ${clip(action.why_this_action, 120)}`);
    }
  }
}

function ensureRunActive(page, runControl, stage) {
  if (runControl?.timedOut) {
    throw new Error(runControl.timeoutError || `${stage} aborted due to run timeout`);
  }
  if (page.isClosed()) {
    throw new Error(`${stage} aborted because page was closed`);
  }
  if (runControl?.deadlineAt && Date.now() > runControl.deadlineAt) {
    runControl.timedOut = true;
    runControl.timeoutError = `run timed out after ${config.runTimeoutMs}ms`;
    throw new Error(runControl.timeoutError);
  }
}

function actionBudgetMs(action, runControl) {
  if (['Dataset Explorer', 'Analysis'].includes(action?.text)) {
    const remaining = runControl?.deadlineAt ? Math.max(1_000, runControl.deadlineAt - Date.now()) : config.runTimeoutMs;
    return remaining;
  }
  return config.actionTimeoutMs;
}

function shouldUseExternalActionTimeout(action) {
  return !['Dataset Explorer', 'Analysis'].includes(action?.text);
}

export async function exploreApp({ page, runId, mode, runControl = null, onProgress = null }) {
  const queue = [config.appUrl];
  const visited = new Set();
  const pages = [];
  const errors = [];
  const globalVersionHints = new Set();
  const startedAt = nowIso();

  function snapshotProgress() {
    return {
      mode,
      startedAt,
      pageCount: pages.length,
      pages: [...pages],
      errors: [...errors],
      globalVersionHints: Array.from(globalVersionHints),
    };
  }

  while (queue.length && pages.length < config.maxPages) {
    const targetUrl = queue.shift();
    if (!targetUrl || visited.has(targetUrl)) continue;
    visited.add(targetUrl);

    try {
      ensureRunActive(page, runControl, 'before goto');
      logStage(runId, 'page.goto:start', targetUrl);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      ensureRunActive(page, runControl, 'after goto');
      logStage(runId, 'page.goto:done', targetUrl);
      const snapshot = await capturePageSnapshot(page, runId, `page-${pages.length + 1}`);
      ensureRunActive(page, runControl, 'after snapshot');
      logStage(runId, 'page.snapshot:done', snapshot.url);
      const llm = await analyzePage(snapshot);
      ensureRunActive(page, runControl, 'after llm');
      logStage(runId, 'page.llm:done', snapshot.title || snapshot.url);
      logLlmReasoning(runId, llm);
      const actions = buildCandidateActions(snapshot);
      logStage(runId, 'page.actions:built', String(actions.length));
      const actionResults = [];

      for (const hint of snapshot.versionHints || []) {
        globalVersionHints.add(hint);
      }
      for (const hint of llm.version_hints || []) {
        globalVersionHints.add(hint);
      }

      const classifiedFeatures = (llm.likely_features || []).map((feature) => ({
        ...feature,
        tier: classifyFeatureTier(feature),
        featureGroup: classifyFeatureGroup(feature),
      }));

      const pageRecord = {
        url: snapshot.url,
        pathname: snapshot.pathname,
        title: snapshot.title,
        pageKey: snapshot.pageKey,
        fingerprint: snapshot.fingerprint,
        screenshot: snapshot.screenshot,
        headings: snapshot.headings,
        buttons: snapshot.buttons,
        links: snapshot.links,
        inputs: snapshot.inputs,
        forms: snapshot.forms,
        tables: snapshot.tables,
        dialogs: snapshot.dialogs,
        versionHints: uniqueBy([...(snapshot.versionHints || []), ...(llm.version_hints || [])], (item) => item),
        llm: {
          ...llm,
          likely_features: classifiedFeatures,
        },
        actionResults,
      };

      pages.push(pageRecord);

      if (onProgress) {
        await onProgress(snapshotProgress());
      }

      for (const action of actions) {
        ensureRunActive(page, runControl, `before action ${action.text}`);
        logStage(runId, 'action:start', `${action.type}:${action.text}`);
        page.__agentWorkflowProgress = null;
        page.__agentActionProgress = null;
        actionResults.push({
          ok: false,
          action,
          beforeUrl: page.url(),
          afterUrl: page.url(),
          afterTitle: await page.title().catch(() => ''),
          error: '',
          driver: 'workflow',
          status: 'started',
          followupFingerprint: null,
          followupUrl: null,
          followupScreenshot: null,
        });
        pageRecord.actionResults = actionResults;
        if (onProgress) {
          await onProgress(snapshotProgress());
        }
        page.__agentActionProgress = async (partialActionResult) => {
          actionResults[actionResults.length - 1] = {
            ...actionResults[actionResults.length - 1],
            ...partialActionResult,
            status: partialActionResult?.status || 'running',
          };
          pageRecord.actionResults = actionResults;
          if (onProgress) {
            await onProgress(snapshotProgress());
          }
        };

        const actionExecution = shouldUseExternalActionTimeout(action)
          ? withTimeout(
            () => executeCandidateAction(page, action),
            actionBudgetMs(action, runControl),
            `action ${action.type}:${action.text}`,
          )
          : executeCandidateAction(page, action);

        const result = await actionExecution.catch(async (error) => {
          const partialWorkflow = page.__agentWorkflowProgress || null;
          return {
            ok: false,
            action,
            beforeUrl: page.url(),
            afterUrl: page.url(),
            afterTitle: await page.title().catch(() => ''),
            error: error instanceof Error ? error.message : String(error),
            driver: partialWorkflow?.driver || 'workflow',
            workflow: partialWorkflow?.workflow || null,
            mode: partialWorkflow?.mode || null,
          };
        });
        logStage(
          runId,
          result.ok ? 'action:done' : 'action:failed',
          `${action.type}:${action.text}${result.error ? ` error=${result.error}` : ''}`,
        );

        let followupSnapshot = null;
        if (result.ok) {
          ensureRunActive(page, runControl, `before followup ${action.text}`);
          logStage(runId, 'followup.snapshot:start', action.text);
          followupSnapshot = await withTimeout(
            () => capturePageSnapshot(page, runId, `action-${pages.length}-${action.text}`),
            config.actionTimeoutMs,
            `followup snapshot ${action.text}`,
          ).catch(() => null);
          logStage(runId, 'followup.snapshot:done', action.text);

          if (followupSnapshot) {
            for (const link of buildCandidateLinks(followupSnapshot)) {
              if (!visited.has(link.href) && queue.length + pages.length < config.maxPages * 3) {
                queue.push(link.href);
              }
            }
          }
        }

        actionResults[actionResults.length - 1] = {
          ...result,
          status: result.ok ? 'completed' : 'failed',
          followupFingerprint: followupSnapshot?.fingerprint || null,
          followupUrl: followupSnapshot?.url || null,
          followupScreenshot: followupSnapshot?.screenshot || null,
        };

        pageRecord.actionResults = actionResults;
        page.__agentActionProgress = null;

        if (onProgress) {
          await onProgress(snapshotProgress());
        }

        await withTimeout(
          () => restorePage(page, targetUrl),
          config.actionTimeoutMs,
          `restore page ${targetUrl}`,
        ).catch((error) => {
          logStage(runId, 'page.restore:failed', error instanceof Error ? error.message : String(error));
          errors.push({
            url: targetUrl,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        logStage(runId, 'page.restore:done', targetUrl);
      }

      for (const link of buildCandidateLinks(snapshot)) {
        if (!visited.has(link.href)) queue.push(link.href);
      }

      if (onProgress) {
        await onProgress(snapshotProgress());
      }
    } catch (error) {
      logStage(runId, 'page:error', error instanceof Error ? error.message : String(error));
      errors.push({
        url: targetUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      if (onProgress) {
        await onProgress(snapshotProgress());
      }
    }
  }

  const globalFeatures = uniqueBy(
    pages.flatMap((pageItem) => (pageItem.llm?.likely_features || []).map((feature) => ({ ...feature, page: pageItem.url }))),
    (item) => `${item.name}:${item.page}`,
  );

  return {
    mode,
    startedAt,
    pageCount: pages.length,
    pages,
    errors,
    globalVersionHints: Array.from(globalVersionHints),
    globalFeatures,
    featureTiers: {
      main: uniqueBy(globalFeatures.filter((item) => item.tier === 'main').map((item) => item.name), (item) => item),
      secondary: uniqueBy(globalFeatures.filter((item) => item.tier === 'secondary').map((item) => item.name), (item) => item),
      unclassified: uniqueBy(globalFeatures.filter((item) => item.tier === 'unclassified').map((item) => item.name), (item) => item),
    },
    featureGroups: Object.fromEntries(
      uniqueBy(globalFeatures.map((item) => item.featureGroup), (item) => item)
        .filter(Boolean)
        .map((group) => [
          group,
          uniqueBy(
            globalFeatures
              .filter((item) => item.featureGroup === group)
              .map((item) => item.name),
            (item) => item,
          ),
        ]),
    ),
    globalFingerprint: hash(JSON.stringify({
      versionHints: Array.from(globalVersionHints),
      pages: pages.map((item) => ({ url: item.url, fingerprint: item.fingerprint, features: item.llm?.likely_features || [] })),
    })),
  };
}
