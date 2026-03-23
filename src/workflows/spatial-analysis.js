import { config } from '../config.js';
import { suggestGuidedActions } from '../llm.js';

function logWorkflow(runId, stage, extra = '') {
  const suffix = extra ? ` ${extra}` : '';
  console.log(`[${new Date().toISOString()}] [${runId}] [spatial-analysis] ${stage}${suffix}`);
}

function buildStep(name, stateType = 'panel_change') {
  return {
    name,
    status: 'failed',
    stateType,
    screenshots: [],
    attempts: [],
  };
}

function spatialAnalysisMatrixContext() {
  return {
    matrixDimensions: {
      defineBy: ['Administrative Area', 'Catchment', 'Polygon'],
      outputMode: ['Grid', 'Profiling'],
      outputType: ['Geohash', 'H3'],
    },
    stableQueueFields: ['datasetCount', 'defineBy', 'outputMode'],
    unstableQueueFields: ['jobId', 'timestamp', 'statusText'],
  };
}

function normalizeQueueDefineBy(value) {
  if (/administrative area/i.test(String(value || ''))) return 'Adm Area';
  if (/catchment/i.test(String(value || ''))) return 'Catchment';
  if (/polygon/i.test(String(value || ''))) return 'Polygon';
  return String(value || '').trim();
}

function buildSpatialAnalysisCasePlans() {
  return [
    { defineBy: 'Administrative Area', outputMode: 'Grid', outputType: 'H3', resolution: '7' },
    { defineBy: 'Administrative Area', outputMode: 'Grid', outputType: 'Geohash', resolution: '7' },
    { defineBy: 'Catchment', outputMode: 'Grid', outputType: 'H3', resolution: '7' },
    { defineBy: 'Catchment', outputMode: 'Grid', outputType: 'Geohash', resolution: '7' },
    { defineBy: 'Administrative Area', outputMode: 'Profiling' },
    { defineBy: 'Catchment', outputMode: 'Profiling' },
  ];
}

function combinationKey(combo) {
  return [
    combo.defineBy || '-',
    combo.outputMode || '-',
    combo.outputType || '-',
    combo.resolution || '-',
  ].join('::');
}

function describeCombination(combo) {
  return [
    combo.defineBy || '-',
    combo.outputMode || '-',
    combo.outputType || 'n/a',
    combo.resolution ? `res ${combo.resolution}` : 'no resolution',
  ].join(' / ');
}

function combinationScreenshotLabel(combo) {
  return [
    combo.defineBy || 'none',
    combo.outputMode || 'none',
    combo.outputType || 'none',
    combo.resolution ? `res-${combo.resolution}` : 'no-resolution',
  ]
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function findMatchingQueueCard(cards, combo) {
  const expectedDefineBy = normalizeQueueDefineBy(combo.defineBy);
  const expectedOutputMode = String(combo.outputMode || '').trim().toLowerCase();
  return (cards || []).find((card) => {
    const defineBy = String(card.defineBy || '').trim();
    const outputMode = String(card.outputMode || '').trim().toLowerCase();
    const datasetCount = String(card.datasetCount || '').trim().toLowerCase();
    return defineBy === expectedDefineBy
      && outputMode === expectedOutputMode
      && datasetCount.includes('1 dataset');
  }) || null;
}

async function attachGuidance(step, page, workflow, runId, extra = {}) {
  step.llmGuidance = await suggestGuidedActions({
    workflow,
    currentUrl: page.url(),
    title: await page.title().catch(() => ''),
    maxSuggestedActions: config.llmMaxGuidedSteps,
    ...spatialAnalysisMatrixContext(),
    ...extra,
  });

  if (!config.printLlmReasoning || !step.llmGuidance) return;
  if (step.llmGuidance.summary) {
    logWorkflow(runId, 'llm-guidance:summary', `${nameOrStep(step)} ${step.llmGuidance.summary}`);
  }
  if (step.llmGuidance.progress_assessment) {
    logWorkflow(runId, 'llm-guidance:progress', `${nameOrStep(step)} ${step.llmGuidance.progress_assessment}`);
  }
  if (step.llmGuidance.suspected_issue) {
    logWorkflow(runId, 'llm-guidance:issue', `${nameOrStep(step)} ${step.llmGuidance.suspected_issue}`);
  }
}

function nameOrStep(step) {
  return step.name || 'step';
}

export async function runSpatialAnalysisWorkflow({
  page,
  action,
  beforeUrl,
  beforeTitle,
  runId,
  helpers,
}) {
  const {
    openAnalysisBase,
    returnToAnalysisInput,
    readAnalysisResultState,
    waitForAnalysisResultState,
    readVisibleAnalysisSections,
    setGlobalFilterArea,
    expandSpatialSettings,
    chooseDefineByOption,
    readSpatialAnalysisConfigState,
    chooseCatchmentInputSource,
    chooseAdministrativeAreaInput,
    chooseOutputAnalysisOption,
    chooseOutputAnalysisType,
    chooseResolutionOption,
    clickGenerateResults,
    searchDatasetExplorer,
    selectAggregation,
    clickDatasetCardByTitle,
    chooseProvince,
    applyRandomAttributeFilter,
    addDatasetFromExplorer,
    readLoadedDatasetTitles,
    hasAnalysisDatasetLoaded,
    openAnalysisAddDataset,
    dismissTransientUi,
    captureWorkflowScreenshot,
    sleep,
  } = helpers;

  const workflowBaseUrl = beforeUrl;
  const steps = [];
  const matrixPlans = buildSpatialAnalysisCasePlans();

  await openAnalysisBase(page, workflowBaseUrl);
  logWorkflow(runId, 'open:done', page.url());

  const structureStep = buildStep('Analysis panel structure');
  structureStep.sections = await readVisibleAnalysisSections(page);
  structureStep.contextScreenshot = await captureWorkflowScreenshot(page, runId, 'workflow-spatial-analysis-structure');
  structureStep.screenshots.push(structureStep.contextScreenshot);
  structureStep.status = ['Filter Area', 'Data Selection', 'Spatial Settings', 'Generate Results']
    .every((section) => structureStep.sections.includes(section))
    ? 'completed'
    : 'partial';
  structureStep.notes = `Visible sections: ${(structureStep.sections || []).join(' | ') || '-'}`;
  if (structureStep.status !== 'completed') {
    structureStep.error = 'Not all expected Analysis sections were visible.';
    await attachGuidance(structureStep, page, 'spatial-analysis-structure', runId, {
      attempts: [{ sections: structureStep.sections }],
      coveredCombinations: [],
    });
  }
  steps.push(structureStep);
  logWorkflow(runId, 'step:structure', structureStep.notes);

  await openAnalysisBase(page, workflowBaseUrl);
  const filterAreaStep = buildStep('Set global filter area', 'form_change');
  const filterAreaResult = await setGlobalFilterArea(page);
  filterAreaStep.contextScreenshot = await captureWorkflowScreenshot(page, runId, 'workflow-spatial-analysis-filter-area');
  filterAreaStep.screenshots.push(filterAreaStep.contextScreenshot);
  filterAreaStep.attempts.push(filterAreaResult);
  filterAreaStep.status = filterAreaResult.saved ? 'completed' : (filterAreaResult.opened ? 'partial' : 'failed');
  filterAreaStep.notes = filterAreaResult.saved
    ? 'Configured global filter area to Indonesia / DKI Jakarta.'
    : filterAreaResult.reason || 'Failed to configure global filter area.';
  if (!filterAreaResult.saved) {
    filterAreaStep.error = filterAreaStep.notes;
    await attachGuidance(filterAreaStep, page, 'spatial-analysis-filter-area', runId, {
      attempts: [filterAreaResult],
      currentStep: 'filter-area',
      coveredCombinations: [],
    });
  }
  steps.push(filterAreaStep);
  logWorkflow(runId, 'step:filter-area', `saved=${filterAreaResult.saved}`);

  if (!filterAreaResult.saved) {
    const succeeded = steps.some((step) => step.status === 'completed');
    return {
      ok: succeeded,
      action,
      beforeUrl,
      afterUrl: page.url(),
      afterTitle: await page.title().catch(() => beforeTitle),
      mode: 'workflow',
      workflow: {
        name: 'spatial-analysis-workflow',
        featureGroup: 'Spatial Analysis',
        steps,
      },
      driver: 'workflow',
      error: filterAreaStep.error || filterAreaStep.notes || 'Spatial Analysis workflow stopped because Filter Area was not saved',
    };
  }

  const datasetEntryStep = buildStep('Data Selection entry point');
  await openAnalysisBase(page, workflowBaseUrl);
  const datasetEntryResult = await openAnalysisAddDataset(page);
  datasetEntryStep.contextScreenshot = await captureWorkflowScreenshot(page, runId, 'workflow-spatial-analysis-add-dataset');
  datasetEntryStep.screenshots.push(datasetEntryStep.contextScreenshot);
  datasetEntryStep.attempts.push(datasetEntryResult);
  datasetEntryStep.status = datasetEntryResult.opened ? 'completed' : 'failed';
  datasetEntryStep.notes = datasetEntryResult.opened
    ? 'Opened Dataset Explorer from the Analysis Data Selection section.'
    : datasetEntryResult.reason || 'Failed to open Dataset Explorer from Analysis.';
  if (!datasetEntryResult.opened) {
    datasetEntryStep.error = datasetEntryStep.notes;
    await attachGuidance(datasetEntryStep, page, 'spatial-analysis-data-selection', runId, {
      attempts: [datasetEntryResult],
      currentStep: 'data-selection',
      coveredCombinations: [],
    });
  } else {
    await sleep(400);
  }
  steps.push(datasetEntryStep);
  logWorkflow(runId, 'step:data-selection', `opened=${datasetEntryResult.opened}`);

  const datasetLoadStep = buildStep('Load analysis dataset', 'panel_change');
  if (datasetEntryResult.opened) {
    const loadAttempt = {
      dataset: 'Bank and Financial 2025',
      aggregation: 'Point',
      searched: false,
      clicked: false,
      provinceSelected: false,
      attributeFilterApplied: false,
      added: false,
      loadedTitles: [],
      reason: '',
    };
    loadAttempt.searched = await searchDatasetExplorer(page, 'Bank and Financial 2025');
    await selectAggregation(page, 'Point');
    loadAttempt.clicked = await clickDatasetCardByTitle(page, 'Point', 'Bank and Financial 2025');
    if (loadAttempt.clicked) {
      loadAttempt.provinceSelected = await chooseProvince(page);
      const attributeResult = await applyRandomAttributeFilter(page, 'Point');
      loadAttempt.attributeFilterApplied = Boolean(attributeResult?.applied);
      const addResult = await addDatasetFromExplorer(page, 'Bank and Financial 2025');
      loadAttempt.added = Boolean(addResult?.added);
      loadAttempt.loadedTitles = addResult?.loadedTitles || await readLoadedDatasetTitles(page);
      loadAttempt.reason = addResult?.reason || '';
    } else {
      loadAttempt.reason = 'Failed to click dataset card';
    }

    datasetLoadStep.attempts.push(loadAttempt);
    datasetLoadStep.contextScreenshot = await captureWorkflowScreenshot(page, runId, 'workflow-spatial-analysis-load-dataset');
    datasetLoadStep.screenshots.push(datasetLoadStep.contextScreenshot);
    datasetLoadStep.loadedTitles = loadAttempt.loadedTitles || [];
    datasetLoadStep.status = loadAttempt.added ? 'completed' : (loadAttempt.clicked ? 'partial' : 'failed');
    datasetLoadStep.notes = loadAttempt.added
      ? `Loaded dataset into Analysis Data Selection: ${(loadAttempt.loadedTitles || []).join(' | ') || loadAttempt.dataset}`
      : loadAttempt.reason || 'Dataset did not load into Analysis Data Selection.';
    if (!loadAttempt.added) {
      datasetLoadStep.error = datasetLoadStep.notes;
      await attachGuidance(datasetLoadStep, page, 'spatial-analysis-data-selection', runId, {
        attempts: [loadAttempt],
        currentStep: 'load-analysis-dataset',
        coveredCombinations: [],
      });
    }
  } else {
    datasetLoadStep.status = 'failed';
    datasetLoadStep.error = 'Dataset Explorer was not open, so no dataset could be loaded.';
    datasetLoadStep.notes = datasetLoadStep.error;
  }
  steps.push(datasetLoadStep);
  logWorkflow(runId, 'step:load-dataset', `${datasetLoadStep.status} ${datasetLoadStep.notes}`);

  const settingsStep = buildStep('Inspect spatial settings', 'precondition_check');
  const settingsResult = await expandSpatialSettings(page);
  settingsStep.contextScreenshot = await captureWorkflowScreenshot(page, runId, 'workflow-spatial-analysis-spatial-settings');
  settingsStep.screenshots.push(settingsStep.contextScreenshot);
  settingsStep.attempts.push(settingsResult);
  settingsStep.visibleItems = settingsResult.visibleItems || [];
  settingsStep.defineBy = {
    current: settingsResult.currentDefineBy || '',
    options: settingsResult.defineByOptions || [],
  };
  settingsStep.outputAnalysis = settingsResult.outputAnalysis || { options: [], descriptions: {}, helperText: '' };
  settingsStep.status = settingsResult.expanded ? 'completed' : 'failed';
  settingsStep.notes = settingsResult.expanded
    ? `Expanded Spatial Settings and found: ${(settingsResult.visibleItems || []).join(' | ') || '-'}${settingsResult.currentDefineBy ? ` | defineBy=${settingsResult.currentDefineBy}` : ''}${settingsResult.defineByOptions?.length ? ` | defineByOptions=${settingsResult.defineByOptions.join(' / ')}` : ''}${settingsResult.outputAnalysis?.options?.length ? ` | outputAnalysis=${settingsResult.outputAnalysis.options.join(' / ')}` : ''}${settingsResult.outputAnalysis?.helperText ? ` | ${settingsResult.outputAnalysis.helperText}` : ''}${settingsResult.polygonMissingPrompt ? ' | polygon still required before Generate Results' : ''}${settingsResult.generateEnabled ? '' : ' | Generate Results still gated'}`
    : settingsResult.reason || 'Failed to expand Spatial Settings.';
  if (!settingsResult.expanded) {
    settingsStep.error = settingsStep.notes;
    await attachGuidance(settingsStep, page, 'spatial-analysis-settings', runId, {
      attempts: [settingsResult],
      currentStep: 'spatial-settings',
      visibleItems: settingsResult.visibleItems || [],
      defineBy: settingsStep.defineBy,
      outputAnalysis: settingsStep.outputAnalysis,
      generateEnabled: settingsResult.generateEnabled,
      polygonMissingPrompt: settingsResult.polygonMissingPrompt,
      coveredCombinations: [],
    });
  }
  steps.push(settingsStep);
  logWorkflow(
    runId,
    'step:spatial-settings',
    `expanded=${settingsResult.expanded} defineBy=${settingsResult.currentDefineBy || '-'} options=${(settingsResult.defineByOptions || []).join('/') || '-'} output=${(settingsResult.outputAnalysis?.options || []).join('/') || '-'} generateEnabled=${settingsResult.generateEnabled} polygonPrompt=${settingsResult.polygonMissingPrompt}`,
  );

  await expandSpatialSettings(page).catch(() => ({ expanded: false }));
  const analysisConfigStep = buildStep('Configure analysis settings', 'form_change');
  const defineByResult = await chooseDefineByOption(page, 'Administrative Area');
  const administrativeAreaResult = defineByResult.selected
    ? await chooseAdministrativeAreaInput(page)
    : { selected: false, reason: 'Administrative Area input was not selectable because Define by did not persist' };
  const outputModeResult = await chooseOutputAnalysisOption(page, 'Grid');
  const outputTypeResult = await chooseOutputAnalysisType(page, 'H3');
  const resolutionResult = await chooseResolutionOption(page, '7');
  const configState = await readSpatialAnalysisConfigState(page);
  const administrativeAreaReady = administrativeAreaResult.selected
    || (String(configState.defineByValue || '').toLowerCase() === 'administrative area' && !configState.hasAreaError);
  const currentCombination = {
    defineBy: defineByResult.option,
    outputMode: outputModeResult.option,
    outputType: outputTypeResult.option,
    resolution: resolutionResult.option,
    datasetCount: 1,
  };
  analysisConfigStep.attempts.push({ defineByResult, administrativeAreaResult, outputModeResult, outputTypeResult, resolutionResult, configState });
  analysisConfigStep.contextScreenshot = await captureWorkflowScreenshot(page, runId, 'workflow-spatial-analysis-configure-settings');
  analysisConfigStep.screenshots.push(analysisConfigStep.contextScreenshot);
  const baseReady = String(configState.defineByValue || '').toLowerCase() === 'administrative area'
    && !configState.hasAreaError
    && outputTypeResult.selected
    && !configState.hasResolutionError;
  analysisConfigStep.status = defineByResult.selected && administrativeAreaReady && outputModeResult.selected && outputTypeResult.selected && baseReady
    ? 'completed'
    : 'partial';
  analysisConfigStep.notes = [
    `defineBy=${defineByResult.option} selected=${defineByResult.selected}`,
    `administrativeArea=${administrativeAreaReady}`,
    `outputMode=${outputModeResult.option} selected=${outputModeResult.selected}`,
    `outputType=${outputTypeResult.option} selected=${outputTypeResult.selected}`,
    `resolution=${resolutionResult.option} selected=${resolutionResult.selected}`,
    `readbackDefineBy=${configState.defineByValue || '-'}`,
    `readbackOutputType=${configState.selectedOutputType || '-'}`,
    `areaError=${configState.hasAreaError}`,
    `resolutionError=${configState.hasResolutionError}`,
  ].join(' | ');
  if (analysisConfigStep.status !== 'completed') {
    analysisConfigStep.error = [
      defineByResult.reason || '',
      (administrativeAreaReady ? '' : administrativeAreaResult.reason || ''),
      outputModeResult.reason || '',
      outputTypeResult.reason || '',
      (configState.hasResolutionError ? resolutionResult.reason || '' : ''),
    ].join(' ').trim() || 'Failed to select full analysis configuration';
    await attachGuidance(analysisConfigStep, page, 'spatial-analysis-settings', runId, {
      attempts: [{ defineByResult, outputModeResult, outputTypeResult, resolutionResult }],
      currentStep: 'configure-analysis-settings',
      coveredCombinations: [currentCombination],
      currentCombination,
    });
  }
  steps.push(analysisConfigStep);
  logWorkflow(runId, 'step:configure-analysis', analysisConfigStep.notes);

  const submitStep = buildStep('Submit analysis', 'job_submission');
  const generateResult = analysisConfigStep.status === 'completed'
    ? await clickGenerateResults(page)
    : { enabled: false, clicked: false, reason: 'Analysis configuration not visibly complete' };
  submitStep.attempts.push(generateResult);
  submitStep.contextScreenshot = await captureWorkflowScreenshot(page, runId, 'workflow-spatial-analysis-submit');
  submitStep.screenshots.push(submitStep.contextScreenshot);
  submitStep.status = generateResult.clicked ? 'completed' : 'failed';
  submitStep.notes = generateResult.clicked
    ? `Generate Results clicked${generateResult.toastText ? ` | ${generateResult.toastText}` : ''}`
    : generateResult.reason || 'Generate Results was not clicked.';
  if (!generateResult.clicked) {
    submitStep.error = submitStep.notes;
    await attachGuidance(submitStep, page, 'spatial-analysis-submit', runId, {
      attempts: [generateResult],
      currentStep: 'submit-analysis',
      coveredCombinations: [currentCombination],
      currentCombination,
    });
  }
  steps.push(submitStep);
  logWorkflow(runId, 'step:submit', submitStep.notes);

  const resultStep = buildStep('Inspect analysis result cards', 'result_change');
  const resultState = await waitForAnalysisResultState(page, 'Bank and Financial 2025');
  resultStep.attempts.push(resultState);
  resultStep.contextScreenshot = await captureWorkflowScreenshot(page, runId, 'workflow-spatial-analysis-result-cards');
  resultStep.screenshots.push(resultStep.contextScreenshot);
  resultStep.status = resultState.hasSpatialAnalysisResultCard && resultState.hasDatasetCard ? 'completed' : 'failed';
  resultStep.notes = `resultPanel=${resultState.hasAnalysisResult} | spatialResultCard=${resultState.hasSpatialAnalysisResultCard} | datasetCard=${resultState.hasDatasetCard}`;
  if (resultStep.status !== 'completed') {
    resultStep.error = 'Analysis result surface did not show the expected cards';
  }
  steps.push(resultStep);
  logWorkflow(runId, 'step:result-cards', resultStep.notes);

  const matrixStep = buildStep('Spatial analysis matrix coverage', 'matrix_coverage');
  const executedCases = [];
  const baseCaseResult = {
    combination: currentCombination,
    label: describeCombination(currentCombination),
    status: submitStep.status === 'completed' && resultStep.status === 'completed' ? 'passed' : 'partial',
    screenshot: resultStep.contextScreenshot || submitStep.contextScreenshot || analysisConfigStep.contextScreenshot || '',
    resultMatch: {
      hasAnalysisResult: resultState.hasAnalysisResult,
      hasSpatialAnalysisResultCard: resultState.hasSpatialAnalysisResultCard,
      hasDatasetCard: resultState.hasDatasetCard,
    },
    reason: submitStep.status === 'completed' && resultStep.status === 'completed'
      ? 'Submitted and verified on analysis result cards'
      : (submitStep.status === 'completed'
        ? 'Submitted but analysis result cards were not both visible'
        : submitStep.error || submitStep.notes),
  };
  executedCases.push(baseCaseResult);

  async function runCase(combo) {
    const result = {
      combination: combo,
      label: describeCombination(combo),
      status: 'blocked',
      queueMatch: null,
      screenshot: '',
      reason: '',
    };

    const restored = await returnToAnalysisInput(page, workflowBaseUrl, 'Bank and Financial 2025');
    result.returnToInput = {
      method: restored.method || '',
      verification: restored.verification || null,
    };
    if (!restored.restored) {
      const verification = restored.verification || {};
      const verificationSummary = [
        verification.hasAnalysisResult === false ? 'Analysis Result missing' : '',
        verification.hasSpatialAnalysisResultCard === false ? 'spatial analysis result card missing' : '',
        verification.hasDatasetCard === false ? 'dataset card missing' : '',
        verification.hasEditInput === false ? 'Edit Input missing' : '',
      ].filter(Boolean).join(' | ');
      result.reason = [restored.reason || 'Could not return to Analysis input state', verificationSummary]
        .filter(Boolean)
        .join(' | ');
      result.screenshot = await captureWorkflowScreenshot(page, runId, `workflow-spatial-analysis-case-${combinationScreenshotLabel(combo)}-restore-failed`);
      return result;
    }

    const loadedTitles = await readLoadedDatasetTitles(page).catch(() => []);
    const hasDataset = await hasAnalysisDatasetLoaded(page, 'Bank and Financial 2025').catch(() => false)
      || (loadedTitles || []).some((title) => /bank and financial 2025/i.test(String(title || '')));

    if (!hasDataset) {
      const filterResult = await setGlobalFilterArea(page);
      if (!filterResult.saved) {
        result.reason = filterResult.reason || 'Filter area could not be configured';
        result.screenshot = await captureWorkflowScreenshot(page, runId, `workflow-spatial-analysis-case-${combinationScreenshotLabel(combo)}-filter-failed`);
        return result;
      }

      const entryResult = await openAnalysisAddDataset(page);
      if (!entryResult.opened) {
        result.reason = entryResult.reason || 'Dataset Explorer did not open';
        result.screenshot = await captureWorkflowScreenshot(page, runId, `workflow-spatial-analysis-case-${combinationScreenshotLabel(combo)}-dataset-entry-failed`);
        return result;
      }

      const loadAttempt = {
        searched: await searchDatasetExplorer(page, 'Bank and Financial 2025'),
        clicked: false,
        provinceSelected: false,
        attributeFilterApplied: false,
        added: false,
        reason: '',
      };
      await selectAggregation(page, 'Point');
      loadAttempt.clicked = await clickDatasetCardByTitle(page, 'Point', 'Bank and Financial 2025');
      if (!loadAttempt.clicked) {
        result.reason = 'Failed to click dataset card';
        result.screenshot = await captureWorkflowScreenshot(page, runId, `workflow-spatial-analysis-case-${combinationScreenshotLabel(combo)}-dataset-click-failed`);
        return result;
      }

      loadAttempt.provinceSelected = await chooseProvince(page);
      const attributeResult = await applyRandomAttributeFilter(page, 'Point');
      loadAttempt.attributeFilterApplied = Boolean(attributeResult?.applied);
      const addResult = await addDatasetFromExplorer(page, 'Bank and Financial 2025');
      loadAttempt.added = Boolean(addResult?.added);
      if (!loadAttempt.added) {
        result.reason = addResult?.reason || 'Dataset did not attach to Analysis';
        result.screenshot = await captureWorkflowScreenshot(page, runId, `workflow-spatial-analysis-case-${combinationScreenshotLabel(combo)}-dataset-add-failed`);
        return result;
      }
    }

    await expandSpatialSettings(page).catch(() => ({ expanded: false }));
    const defineResult = await chooseDefineByOption(page, combo.defineBy);
    const administrativeAreaResult = /administrative area/i.test(combo.defineBy)
      ? await chooseAdministrativeAreaInput(page)
      : { selected: true, option: '', reason: '' };
    const catchmentInputResult = /catchment/i.test(combo.defineBy)
      ? await chooseCatchmentInputSource(page, 'Location')
      : { selected: true, option: '', reason: '' };
    const modeResult = await chooseOutputAnalysisOption(page, combo.outputMode);
    const typeResult = combo.outputType
      ? await chooseOutputAnalysisType(page, combo.outputType)
      : { selected: true, option: '', reason: '' };
    const resolutionResult = combo.resolution
      ? await chooseResolutionOption(page, combo.resolution)
      : { selected: true, option: '', reason: '' };
    const configState = await readSpatialAnalysisConfigState(page);
    const administrativeAreaReady = /administrative area/i.test(combo.defineBy)
      ? (administrativeAreaResult.selected
        || (String(configState.defineByValue || '').toLowerCase() === 'administrative area' && !configState.hasAreaError))
      : true;

    const comboReady = (() => {
      const defineByMatches = String(configState.defineByValue || '').toLowerCase() === String(combo.defineBy || '').toLowerCase();
      const outputTypeMatches = combo.outputType ? typeResult.selected : true;
      const resolutionReady = combo.resolution ? !configState.hasResolutionError : true;
      const areaReady = /catchment/i.test(combo.defineBy)
        ? (catchmentInputResult.selected || configState.hasCatchmentSummary)
        : !configState.hasAreaError;
      return defineByMatches && outputTypeMatches && resolutionReady && areaReady;
    })();

    if (!defineResult.selected || !administrativeAreaReady || !catchmentInputResult.selected || !modeResult.selected || !typeResult.selected || !comboReady) {
      result.status = 'blocked';
      result.reason = [
        defineResult.reason || '',
        (administrativeAreaReady ? '' : administrativeAreaResult.reason || ''),
        catchmentInputResult.reason || '',
        modeResult.reason || '',
        typeResult.reason || '',
        (configState.hasResolutionError ? resolutionResult.reason || '' : ''),
        comboReady ? '' : `readback mismatch: defineBy=${configState.defineByValue || '-'} outputType=${configState.selectedOutputType || '-'} areaError=${configState.hasAreaError} catchmentSummary=${configState.hasCatchmentSummary} resolutionError=${configState.hasResolutionError}`,
      ].join(' ').trim() || 'Configuration inputs were not fully selectable';
      result.screenshot = await captureWorkflowScreenshot(page, runId, `workflow-spatial-analysis-case-${combinationScreenshotLabel(combo)}-config-failed`);
      return result;
    }

    const submitResult = await clickGenerateResults(page);
    if (!submitResult.clicked) {
      result.status = 'blocked';
      result.reason = submitResult.reason || 'Generate Results did not submit';
      result.screenshot = await captureWorkflowScreenshot(page, runId, `workflow-spatial-analysis-case-${combinationScreenshotLabel(combo)}-submit-failed`);
      return result;
    }

    const resultStateAfterSubmit = await waitForAnalysisResultState(page, 'Bank and Financial 2025');
    result.screenshot = await captureWorkflowScreenshot(page, runId, `workflow-spatial-analysis-case-${combinationScreenshotLabel(combo)}-result`);
    result.resultMatch = {
      hasAnalysisResult: resultStateAfterSubmit.hasAnalysisResult,
      hasSpatialAnalysisResultCard: resultStateAfterSubmit.hasSpatialAnalysisResultCard,
      hasDatasetCard: resultStateAfterSubmit.hasDatasetCard,
    };
    result.status = resultStateAfterSubmit.hasSpatialAnalysisResultCard && resultStateAfterSubmit.hasDatasetCard ? 'passed' : 'partial';
    result.reason = result.status === 'passed'
      ? 'Submitted and verified on analysis result cards'
      : 'Submitted but analysis result cards were not both visible';
    return result;
  }

  const remainingPlans = matrixPlans
    .filter((combo) => combinationKey(combo) !== combinationKey(currentCombination))
    .slice(0, Math.max(0, config.spatialAnalysisCaseLimit - 1));

  for (const combo of remainingPlans) {
    const caseResult = await runCase(combo);
    executedCases.push(caseResult);
    logWorkflow(runId, 'case', `${caseResult.label} -> ${caseResult.status}${caseResult.reason ? ` | ${caseResult.reason}` : ''}`);
  }

  matrixStep.attempts = executedCases;
  matrixStep.contextScreenshot = await captureWorkflowScreenshot(page, runId, 'workflow-spatial-analysis-matrix');
  matrixStep.screenshots.push(matrixStep.contextScreenshot);
  const passedCount = executedCases.filter((item) => item.status === 'passed').length;
  const blockedCount = executedCases.filter((item) => item.status === 'blocked').length;
  const partialCount = executedCases.filter((item) => item.status === 'partial').length;
  matrixStep.status = passedCount ? 'completed' : (partialCount ? 'partial' : 'failed');
  matrixStep.notes = `cases=${executedCases.length} | passed=${passedCount} | partial=${partialCount} | blocked=${blockedCount}`;
  steps.push(matrixStep);
  logWorkflow(runId, 'step:matrix', matrixStep.notes);

  const succeeded = steps.some((step) => step.status === 'completed');

  return {
    ok: succeeded,
    action,
    beforeUrl,
    afterUrl: page.url(),
    afterTitle: await page.title().catch(() => beforeTitle),
    mode: 'workflow',
    workflow: {
      name: 'spatial-analysis-workflow',
      featureGroup: 'Spatial Analysis',
      steps,
    },
    driver: 'workflow',
    error: succeeded ? '' : 'Spatial Analysis workflow did not complete any major step',
  };
}
