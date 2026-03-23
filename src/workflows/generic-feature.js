import { config } from '../config.js';
import { suggestGuidedActions } from '../llm.js';

function featureStepStatus(progressed) {
  return progressed ? 'completed' : 'partial';
}

export async function runGenericFeatureWorkflow({
  page,
  action,
  beforeUrl,
  beforeTitle,
  runId,
  featureGroup,
  helpers,
}) {
  const {
    clickVisibleActionable,
    captureWorkflowScreenshot,
    dismissTransientUi,
    sleep,
  } = helpers;

  const step = {
    featureGroup,
    name: action.text,
    status: 'failed',
    stateType: 'no_progress',
    screenshots: [],
    attempts: [],
  };

  const clicked = await clickVisibleActionable(page, action.text);
  if (!clicked) {
    step.error = `No visible actionable element matched: ${action.text}`;
    step.llmGuidance = await suggestGuidedActions({
      workflow: featureGroup,
      attempts: [],
      currentUrl: page.url(),
      title: await page.title().catch(() => beforeTitle),
      maxSuggestedActions: config.llmMaxGuidedSteps,
    });
    return {
      ok: false,
      action,
      beforeUrl,
      afterUrl: page.url(),
      afterTitle: await page.title().catch(() => beforeTitle),
      error: step.error,
      mode: 'workflow',
      workflow: {
        name: `${featureGroup.toLowerCase().replace(/\s+/g, '-')}-workflow`,
        featureGroup,
        steps: [step],
      },
      driver: 'workflow',
    };
  }

  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(1000);
  step.screenshots.push(await captureWorkflowScreenshot(page, runId, `workflow-${featureGroup}-${action.text}`));

  const progressed = page.url() !== beforeUrl || (await page.title().catch(() => beforeTitle)) !== beforeTitle;
  step.status = featureStepStatus(progressed);
  step.stateType = progressed ? 'panel_change' : 'no_progress';
  step.attempts.push({
    candidate: action.text,
    clicked: true,
    screenshot: step.screenshots[0] || '',
  });

  if (!progressed) {
    await dismissTransientUi(page).catch(() => []);
    step.error = `No meaningful progress after opening ${action.text}`;
    step.llmGuidance = await suggestGuidedActions({
      workflow: featureGroup,
      attempts: step.attempts,
      currentUrl: page.url(),
      title: await page.title().catch(() => beforeTitle),
      maxSuggestedActions: config.llmMaxGuidedSteps,
    });
  }

  return {
    ok: progressed,
    action,
    beforeUrl,
    afterUrl: page.url(),
    afterTitle: await page.title().catch(() => beforeTitle),
    error: step.error || '',
    mode: 'workflow',
    workflow: {
      name: `${featureGroup.toLowerCase().replace(/\s+/g, '-')}-workflow`,
      featureGroup,
      steps: [step],
    },
    driver: 'workflow',
  };
}
