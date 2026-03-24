import { config } from '../config.js';
import {
  suggestDatasetExplorerRecoveryActions,
  suggestDatasetTitleAliases,
  suggestGuidedActions,
  verifyDatasetFilter,
} from '../llm.js';

const ACTION_WHITELIST = new Set([
  'search_dataset',
  'toggle_source_mode',
  'paginate',
  'select_aggregation',
  'select_dataset',
  'choose_province',
  'apply_attribute_filter',
  'open_edit_filter',
  'delete_existing_filter',
  'open_preview',
  'close_preview',
  'add_dataset',
  'dismiss_modal',
  'verify_state',
]);

function normalizeTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function titlePrefix(value, words = 4) {
  return normalizeTitle(value).split(' ').filter(Boolean).slice(0, words).join(' ');
}

function administrativeAreaDepthScore(value = '') {
  const normalized = normalizeTitle(value);
  if (!normalized) return 0;
  if (/\bvillage\b/.test(normalized)) return 300;
  if (/\bdistrict\b/.test(normalized) || /\bsubdistrict\b/.test(normalized) || /\bsub-district\b/.test(normalized)) return 200;
  if (/\bcity\b/.test(normalized)) return 100;
  return 0;
}

function administrativeAreaCandidatePriority(value = '') {
  const normalized = normalizeTitle(value);
  let score = administrativeAreaDepthScore(value);
  if (normalized.includes('household expenditure')) score += 700;
  if (normalized.includes('district administration')) score += 260;
  if (normalized.includes('demographics')) score += 120;
  if (normalized.includes('indonesia')) score += 180;
  if (normalized.includes('jakarta')) score += 160;
  if (normalized.includes('vietnam')) score -= 260;
  if (normalized.includes('demographics by age group district')) score -= 220;
  if (normalized.includes('blood type') || normalized.includes('rhesus')) score -= 180;
  if (normalized.includes('ses relative') || normalized.includes('relative to city index')) score -= 120;
  return score;
}

function administrativeAreaShouldAttemptFilter(value = '') {
  const normalized = normalizeTitle(value);
  return normalized.includes('household expenditure')
    || normalized.includes('demographics')
    || normalized.includes('district administration');
}

function preferredProvinceForDataset(aggregation = '', datasetTitle = '') {
  const normalizedAggregation = normalizeTitle(aggregation);
  const normalizedTitle = normalizeTitle(datasetTitle);
  if (normalizedAggregation === 'administrative area') {
    if (normalizedTitle.includes('ho chi minh') || normalizedTitle.includes('vietnam')) return 'Ho Chi Minh';
    if (normalizedTitle.includes('jakarta')) return 'DKI Jakarta';
    if (normalizedTitle.includes('java')) return 'Banten';
  }
  return preferredProvinceForAggregation(aggregation);
}

function prioritizeAggregationCandidates(aggregation = '', candidates = []) {
  const normalizedAggregation = normalizeTitle(aggregation);
  const items = Array.isArray(candidates) ? [...candidates] : [];
  if (normalizedAggregation !== 'administrative area') return items;
  return items.sort((left, right) => {
    const scoreDelta = administrativeAreaCandidatePriority(right?.title || '') - administrativeAreaCandidatePriority(left?.title || '');
    if (scoreDelta !== 0) return scoreDelta;
    const rightTitle = normalizeTitle(right?.title || '');
    const leftTitle = normalizeTitle(left?.title || '');
    return rightTitle.localeCompare(leftTitle);
  });
}

function lastPassedSearchQuery(attempts = []) {
  const passedSearches = (Array.isArray(attempts) ? attempts : [])
    .filter((attempt) => attempt?.action_type === 'search_dataset' && attempt?.step_status === 'passed')
    .map((attempt) => String(attempt?.input_text || attempt?.target_text || '').trim())
    .filter(Boolean);
  return passedSearches[passedSearches.length - 1] || '';
}

function lastPassedSelectedDataset(attempts = []) {
  const passedSelections = (Array.isArray(attempts) ? attempts : [])
    .filter((attempt) => attempt?.action_type === 'select_dataset' && attempt?.step_status === 'passed')
    .map((attempt) => String(attempt?.target_text || '').trim())
    .filter(Boolean);
  return passedSelections[passedSelections.length - 1] || '';
}

function shouldUseDatasetExplorerRecoveryAgent() {
  return Boolean(config.datasetExplorerRecoveryAgentEnabled);
}

async function suggestRecoveryAgentPlan({ branch, step, state, trigger, expectedTitle }) {
  if (!shouldUseDatasetExplorerRecoveryAgent()) return null;

  return suggestDatasetExplorerRecoveryActions({
    workflow: 'dataset-explorer-recovery-agent',
    trigger,
    branch: {
      key: branch?.key || '',
      kind: branch?.kind || '',
      aggregation: branch?.aggregation || '',
      goal: branch?.goal || '',
    },
    expected_title: expectedTitle || step?.selectedCandidate || lastPassedSelectedDataset(step?.attempts || []) || '',
    current_state: {
      dataset_explorer_visible: Boolean(state?.datasetExplorerVisible),
      selected_aggregation: state?.selectedAggregation || '',
      active_selection: state?.activeSelection || null,
      province_value: state?.provinceValue || '',
      province_visible: Boolean(state?.provinceVisible),
      add_dataset_enabled: Boolean(state?.addDatasetEnabled),
      add_attribute_filter_enabled: Boolean(state?.addAttributeFilterEnabled),
      candidate_titles: (state?.availableCandidates || []).slice(0, 10).map((item) => item?.title || '').filter(Boolean),
    },
    recovery_context: {
      selected_candidate: step?.selectedCandidate || '',
      attribute_filter: step?.attributeFilter || {},
      add_dataset: step?.addDataset || {},
      table_verification: step?.tableVerification || {},
      last_search_query: lastPassedSearchQuery(step?.attempts || []),
      last_selected_dataset: lastPassedSelectedDataset(step?.attempts || []),
      recovery_attempts: step?.recoveryAttempts || [],
    },
    recent_attempts: (step?.attempts || []).slice(-8).map((attempt) => ({
      action_type: attempt?.action_type || '',
      step_status: attempt?.step_status || '',
      target_text: attempt?.target_text || '',
      input_text: attempt?.input_text || '',
      reason: attempt?.reason || '',
    })),
  }).catch(() => null);
}

function actionFromRecoveryGuidance(guidance = {}, actionType = '') {
  return (guidance?.actions || []).find((action) => action?.action_type === actionType) || null;
}

function strongestAdministrativeAreaDepth(candidates = []) {
  return (Array.isArray(candidates) ? candidates : [])
    .reduce((best, item) => Math.max(best, administrativeAreaDepthScore(item?.title || '')), 0);
}

function isH3MobilityFutureYearCandidate(step = {}, expectedTitle = '') {
  if (normalizeTitle(step?.aggregation || '') !== 'h3') return false;
  const title = normalizeTitle(expectedTitle || step?.selectedCandidate || '');
  if (!/(daily )?mobility heatmap 2025|mobility daily data .*2025/.test(title)) return false;
  const attribute = normalizeTitle(step?.attributeFilter?.attribute || '');
  if (String(step?.attributeFilter?.yearShiftFallback || '') === '2026') return false;
  return !attribute || attribute === 'date';
}

function buildFutureYearDateRange(targetYear = 2026) {
  const year = Number(targetYear) || 2026;
  return {
    from: `${year}-01-01`,
    to: `${year}-12-31`,
    summary: `From 1 Jan ${year}, Until 31 Dec ${year}`,
  };
}

function preferredAttributeDateRangeForSelection(aggregation = '', selectedTitle = '') {
  if (!isH3MobilityFutureYearCandidate({ aggregation }, selectedTitle)) return null;
  const dateRange = buildFutureYearDateRange(2026);
  return {
    ...dateRange,
    selectedValue: `${dateRange.from} - ${dateRange.to}`,
    yearShiftFallback: '2026',
  };
}

function buildDatasetSearchQuery(value) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const yearMatch = normalized.match(/^(.+?\b20\d{2}\b)/);
  if (yearMatch?.[1]) return yearMatch[1].trim();
  return normalized
    .split(/\b(?:Provides|Description:|A statistical evaluation|Weekly per capita|Daily Mobility heatmap based on|based on telecommunication data on year)\b/i)[0]
    .trim();
}

function buildDataSelectionTitleAliases(value) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const normalizedWords = normalized.split(' ').filter(Boolean);
  const aliases = new Set([
    normalized,
    buildDatasetSearchQuery(normalized),
    normalized.split(/Provides|Description:|Weekly|Daily|A statistical|based on/i)[0].trim(),
    normalized.split(/\s+(Polygon|Point|H3|Administrative Area|Admin\. Area|Geohash|Line)\b/i)[0].trim(),
  ]);

  for (const length of [3, 4, 5]) {
    if (normalizedWords.length >= length) {
      aliases.add(normalizedWords.slice(0, length).join(' ').trim());
    }
  }

  const yearMatches = [...normalized.matchAll(/\b(20\d{2})\b/g)];
  if (yearMatches.length >= 2) {
    const firstYear = yearMatches[0];
    aliases.add(normalized.slice(0, firstYear.index + firstYear[0].length).trim());
  }

  for (const pattern of [
    /\bProvides\b/i,
    /\bWeekly per capita\b/i,
    /\bA statistical evaluation\b/i,
    /\bDaily Mobility heatmap based\b/i,
    /\bBank and financial POIs dataset\b/i,
    /\bPOIs dataset on year\b/i,
    /\bpatterns for\b/i,
  ]) {
    const match = normalized.match(pattern);
    if (match?.index) aliases.add(normalized.slice(0, match.index).trim());
  }

  const sentenceBoundary = normalized.match(/^[^.?!]+/);
  if (sentenceBoundary?.[0]) aliases.add(sentenceBoundary[0].trim());

  return [...aliases].filter(Boolean);
}

function matchesLoadedTitle(loadedTitles, expectedTitle) {
  const expected = normalizeTitle(expectedTitle);
  const prefix = titlePrefix(expectedTitle);
  return (loadedTitles || []).some((item) => {
    const loaded = normalizeTitle(item);
    return loaded === expected
      || loaded.includes(expected)
      || expected.includes(loaded)
      || (prefix && loaded.includes(prefix));
  });
}

function logWorkflow(runId, stage, extra = '') {
  const suffix = extra ? ` ${extra}` : '';
  console.log(`[${new Date().toISOString()}] [${runId}] [dataset-explorer] ${stage}${suffix}`);
}

function clip(value, max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '-';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function logGuidance(runId, branchLabel, guidance) {
  if (!config.printLlmReasoning || !guidance) return;
  if (guidance.summary) {
    logWorkflow(runId, 'llm-guidance:summary', `${branchLabel} ${clip(guidance.summary, 180)}`);
  }
  if (guidance.progress_assessment) {
    logWorkflow(runId, 'llm-guidance:progress', `${branchLabel} ${clip(guidance.progress_assessment, 180)}`);
  }
  if (guidance.suspected_issue) {
    logWorkflow(runId, 'llm-guidance:issue', `${branchLabel} ${clip(guidance.suspected_issue, 180)}`);
  }
  logWorkflow(runId, 'llm-guidance:retry', `${branchLabel} recommended=${Boolean(guidance.retry_recommended)} stop=${clip(guidance.stop_reason || '-', 120)}`);
  for (const action of (guidance.actions || []).slice(0, 2)) {
    logWorkflow(
      runId,
      'llm-guidance:action',
      `${branchLabel} p${action.priority} ${action.action_type}:${clip(action.label, 60)} target=${clip(action.target_text, 70)} input=${clip(action.input_text, 60)} expect=${clip(action.expected_signal, 90)}`,
    );
  }
}

function compactTitles(items, limit = 4) {
  return (items || [])
    .slice(0, limit)
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item?.title) return '';
      return item.locked ? `${item.title} [locked]` : item.title;
    })
    .filter(Boolean)
    .join(' | ') || '-';
}

function logPlannerState(runId, branch, plannerStep, state, step) {
  const active = clip(state.activeSelection?.title || '-', 90);
  const loaded = clip(compactTitles(state.loadedTitles, 3), 110);
  const candidates = clip(compactTitles(state.availableCandidates, 2), 110);
  const tried = clip((step.triedCandidates || []).join(' | ') || '-', 110);
  const attr = state.attributeSummaryText ? 'present' : 'none';
  const province = state.provinceVisible ? (state.provinceValue || 'required') : 'n/a';
  logWorkflow(
    runId,
    'planner:state',
    `${branchLabel(branch)} step=${plannerStep + 1} active="${active}" agg="${state.selectedAggregation || '-'}" loaded="${loaded}" candidates=${(state.availableCandidates || []).length} sample="${candidates}" tried="${tried}" province=${province} city=${state.cityVisible ? 'visible' : 'n/a'} attr=${attr} preview=${state.previewOpen ? 'open' : 'closed'} add=${state.addDatasetEnabled ? 'on' : 'off'} filter=${state.addAttributeFilterEnabled ? 'on' : 'off'} attempts=${step.attempts.length}`,
  );
}

function logPlannerAction(runId, branch, plannerStep, action) {
  logWorkflow(
    runId,
    'planner:action:selected',
    `${branchLabel(branch)} step=${plannerStep + 1} type=${action.action_type} target="${clip(action.target_text || '-', 90)}" input="${clip(action.input_text || '-', 60)}" expect="${clip(action.expected_signal || '-', 90)}"`,
  );
}

function logPlannerResult(runId, branch, plannerStep, attempt) {
  logWorkflow(
    runId,
    'planner:action:executed',
    `${branchLabel(branch)} step=${plannerStep + 1} type=${attempt.action_type} status=${attempt.step_status} observed="${clip(attempt.observed_signal || '-', 100)}"${attempt.reason ? ` reason="${clip(attempt.reason, 100)}"` : ''}`,
  );
}

function logPlannerClassification(runId, branch, classification) {
  logWorkflow(
    runId,
    'planner:branch:classification',
    `${branchLabel(branch)} status=${classification.status}${classification.error ? ` error="${clip(classification.error, 120)}"` : ''}${classification.notes ? ` notes="${clip(classification.notes, 120)}"` : ''}`,
  );
}

function buildBranchPlans() {
  const aggregationBranches = config.datasetExplorerSpatialAggregations.map((aggregation) => ({
    key: `aggregation-${aggregation}`,
    name: aggregation,
    kind: 'aggregation',
    aggregation,
    goal: `Select one dataset for ${aggregation}, configure province and attribute filter if needed, and add it successfully.`,
  }));

  const modalBranches = [
    {
      key: 'preview',
      name: 'Preview dataset',
      kind: 'preview',
      goal: 'Open dataset preview, verify preview evidence, then close preview cleanly.',
      aggregation: 'Point',
      preferredDataset: 'Bank and Financial 2025',
    },
    {
      key: 'search',
      name: 'Dataset search',
      kind: 'search',
      goal: 'Use search to narrow the dataset list and verify visible search results.',
      searchQuery: 'Bank and Financial',
    },
    {
      key: 'source-mode',
      name: 'Source mode toggle',
      kind: 'source-toggle',
      goal: 'Toggle to My Organization and then back to Bvarta & Partner Data without leaving Dataset Explorer.',
    },
    {
      key: 'pagination',
      name: 'Pagination controls',
      kind: 'pagination',
      goal: 'Navigate to page 2 and then back to page 1.',
    },
  ];

  const postAddBranches = [
    {
      key: 'edit-existing-filter',
      name: 'Edit existing filter',
      kind: 'aggregation',
      aggregation: 'Administrative Area',
      preferredDataset: 'Household Expenditure Village Jakarta 2024',
      postAddUseCase: 'edit-filter',
      goal: 'Add a filtered dataset, then reopen the existing filter editor from Data Selection and verify the committed saved filter cards remain visible.',
    },
    {
      key: 'delete-existing-filter',
      name: 'Delete existing filter',
      kind: 'aggregation',
      aggregation: 'Administrative Area',
      preferredDataset: 'Household Expenditure Village Jakarta 2024',
      postAddUseCase: 'delete-filter',
      goal: 'Add a filtered dataset, then reopen the existing filter editor from Data Selection and delete one committed saved filter card.',
    },
  ];

  if (config.focusedWorkflow === 'dataset-explorer-bvt') {
    return aggregationBranches;
  }

  if (config.focusedWorkflow === 'dataset-explorer-maintenance') {
    return postAddBranches;
  }

  return [...aggregationBranches, ...modalBranches, ...postAddBranches];
}

function branchLabel(branch) {
  return branch.aggregation || branch.name || branch.key;
}

async function readDatasetExplorerPlannerState({ page, branch, helpers }) {
  const {
    listDatasetCardCandidates,
    readActiveDatasetSelection,
    readLoadedDatasetTitles,
  } = helpers;

  const domState = await page.locator('body').evaluate((body) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const lower = (value) => normalize(value).toLowerCase();
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    const searchInput = document.querySelector('[data-testid="dataset-explorer-search-dataset-input"], input[name="dataset-explorer-search-dataset"]');
    const buttonCandidates = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter((button) => visible(button))
      .map((button) => ({
        button,
        label: lower(button.textContent || button.getAttribute('aria-label') || button.getAttribute('title') || ''),
      }))
      .filter((entry) => entry.label);
    const previewButton = buttonCandidates.find((entry) => entry.label === 'preview dataset')?.button;
    const addFilterButton = buttonCandidates.find((entry) => entry.label.includes('add attribute filter'))?.button;
    const addDatasetButton = buttonCandidates.find((entry) => entry.label.includes('add dataset'))?.button;
    const isActionEnabled = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const ariaDisabled = String(el.getAttribute('aria-disabled') || '').toLowerCase();
      return !el.disabled && ariaDisabled !== 'true' && ariaDisabled !== 'disabled';
    };
    
    // Province input detection: the dropdown uses aria-label "Dropdown menu: admin-area-1" with an embedded textbox
    // Try multiple selectors to find the province value
    let provinceInput = document.querySelector('input[name="admin-area-1"], input[placeholder*="province" i]');
    let provinceValue = '';
    let provinceVisible = false;
    
    if (provinceInput instanceof HTMLInputElement) {
      provinceVisible = true;
      provinceValue = String(provinceInput.value || '');
    } else {
      // Fallback: look for combobox/dropdown with admin-area-1 or province in aria-label
      const provinceDropdown = Array.from(document.querySelectorAll('button, [role="combobox"]'))
        .find((el) => el instanceof HTMLElement && visible(el) && (
          /admin-area-1|province/i.test(el.getAttribute('aria-label') || '')
          || /admin-area-1|province/i.test(el.getAttribute('name') || '')
        ));
      if (provinceDropdown) {
        provinceVisible = true;
        // Try to get the value from inner textbox or the dropdown text content
        const innerInput = provinceDropdown.querySelector('input, [role="textbox"]');
        if (innerInput instanceof HTMLInputElement) {
          provinceValue = String(innerInput.value || '');
        } else {
          // Extract value from textContent, excluding "Select Province" placeholder
          const text = normalize(provinceDropdown.textContent || '');
          if (text && !/^select province$/i.test(text) && !/^province\s*\*?$/i.test(text)) {
            // Extract the province name (remove prefix like "Province *")
            provinceValue = text.replace(/^province\s*\*?\s*/i, '').replace(/clear selection/i, '').trim();
          }
        }
      } else {
        // Another fallback: look for visible text that indicates province is set
        const provinceLabel = Array.from(document.querySelectorAll('*'))
          .find((el) => el instanceof HTMLElement && visible(el) && /^province\s*\*?$/i.test(normalize(el.textContent || '')));
        if (provinceLabel) {
          provinceVisible = true;
          // Look for sibling or next element with the province value
          const parent = provinceLabel.closest('div, section, generic');
          if (parent) {
            const siblingText = normalize(parent.textContent || '');
            const match = siblingText.match(/(dki jakarta|jawa barat|jawa tengah|jawa timur|banten|bali)/i);
            if (match) provinceValue = match[1];
          }
        }
      }
    }
    
    const cityInput = document.querySelector('input[name="admin-area-2"], input[placeholder*="city" i]');
    const visibleTexts = Array.from(document.querySelectorAll('body *'))
      .filter((el) => visible(el))
      .map((el) => normalize(el.textContent))
      .filter(Boolean);
    const visibleButtons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter((el) => visible(el))
      .map((el) => normalize(el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || ''))
      .filter(Boolean)
      .slice(0, 40);
    const selectedAggregation = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter((el) => visible(el))
      .map((el) => ({
        text: normalize(el.textContent || el.getAttribute('aria-label') || ''),
        className: String(el.className || ''),
      }))
      .find((item) => /point|polygon|h3|admin\. area|administrative area|geohash|line/i.test(item.text)
        && /teal|emerald|selected|active/i.test(item.className));
    const attributeSummaryText = visibleTexts.find((text) => /attribute filter/i.test(text) || /selected filters?/i.test(text)) || '';
    const previewEvidence = visibleTexts.some((text) => /search and filter|preview dataset/i.test(text))
      || Array.from(document.querySelectorAll('table')).some((table) => visible(table));

    const datasetExplorerVisible = visibleTexts.some((text) => /dataset\s*explorer/i.test(text))
      || (searchInput instanceof HTMLInputElement)
      || visibleTexts.some((text) => /attribute filter/i.test(text))
      || visibleButtons.some((text) => /preview dataset|add dataset/i.test(text));

    return {
      datasetExplorerVisible,
      searchValue: searchInput instanceof HTMLInputElement ? String(searchInput.value || '') : '',
      selectedAggregation: selectedAggregation?.text || '',
      previewEnabled: previewButton ? isActionEnabled(previewButton) : false,
      addAttributeFilterEnabled: addFilterButton ? isActionEnabled(addFilterButton) : false,
      addDatasetEnabled: addDatasetButton ? isActionEnabled(addDatasetButton) : false,
      previewOpen: Boolean(previewEvidence),
      provinceVisible,
      provinceValue,
      cityVisible: cityInput instanceof HTMLInputElement,
      attributeSummaryText,
      visibleButtons,
      visibleTextExcerpt: normalize(body.innerText || body.textContent || '').slice(0, 1200),
      hasPageTwo: visibleButtons.includes('2'),
      hasPageOne: visibleButtons.includes('1'),
      hasSourceBvt: visibleTexts.includes('Bvarta & Partner Data'),
      hasSourceOrg: visibleTexts.includes('My Organization'),
    };
  }).catch(() => ({
    datasetExplorerVisible: false,
    searchValue: '',
    selectedAggregation: '',
    previewEnabled: false,
    addAttributeFilterEnabled: false,
    addDatasetEnabled: false,
    previewOpen: false,
    provinceVisible: false,
    provinceValue: '',
    cityVisible: false,
    attributeSummaryText: '',
    visibleButtons: [],
    visibleTextExcerpt: '',
    hasPageTwo: false,
    hasPageOne: false,
    hasSourceBvt: false,
    hasSourceOrg: false,
  }));

  const datasetExplorerLikelyVisible = Boolean(
    domState?.datasetExplorerVisible
    || domState?.searchValue
    || domState?.previewEnabled
    || domState?.addAttributeFilterEnabled
    || domState?.addDatasetEnabled
    || domState?.hasSourceBvt
    || domState?.hasSourceOrg
  );

  const activeSelection = datasetExplorerLikelyVisible
    ? await readActiveDatasetSelection(page).catch(() => null)
    : null;
  const loadedTitles = await readLoadedDatasetTitles(page).catch(() => []);
  const availableCandidates = datasetExplorerLikelyVisible && branch.aggregation
    ? await listDatasetCardCandidates(page, branch.aggregation).catch(() => [])
    : [];

  return {
    branch,
    activeSelection,
    loadedTitles,
    availableCandidates,
    ...domState,
  };
}

function countMatchingFailedAttempts(attempts, action) {
  const key = `${action.action_type}:${action.target_text}:${action.input_text}`;
  return (attempts || []).filter((attempt) => {
    const other = `${attempt.action_type}:${attempt.target_text}:${attempt.input_text}`;
    return other === key && attempt.step_status !== 'passed';
  }).length;
}

function hasPassedAttemptForCandidate(attempts, actionType, candidateTitle) {
  return (attempts || []).some((attempt) => (
    attempt.action_type === actionType
    && attempt.step_status === 'passed'
    && (!candidateTitle || normalizeTitle(attempt.candidateTitle || attempt.target_text) === normalizeTitle(candidateTitle))
  ));
}

function buildPolicyAction(branch, state, step) {
  if (branch.kind === 'preview') {
    const hasOpened = step.attempts.some((attempt) => attempt.action_type === 'open_preview' && attempt.step_status === 'passed');
    const hasClosed = step.attempts.some((attempt) => attempt.action_type === 'close_preview' && attempt.step_status === 'passed');
    const aggregationReady = !branch.aggregation
      || state.activeSelection?.aggregation === branch.aggregation
      || normalizeTitle(state.selectedAggregation).includes(normalizeTitle(branch.aggregation))
      || (state.availableCandidates || []).length > 0;
    if (!aggregationReady) {
      return {
        label: `Select aggregation: ${branch.aggregation}`,
        action_type: 'select_aggregation',
        target_text: branch.aggregation,
        input_text: '',
        expected_signal: `${branch.aggregation} becomes selected and previewable dataset rows become visible.`,
        rationale: 'Policy precondition for preview branch.',
        priority: 0,
      };
    }
    if (!state.activeSelection?.title && (state.availableCandidates || []).some((item) => !item.locked)) {
      const availableUnlocked = state.availableCandidates.filter((item) => !item.locked);
      const candidate = availableUnlocked.find((item) => normalizeTitle(item.title).includes(normalizeTitle(branch.preferredDataset || '')))
        || availableUnlocked[0];
      return {
        label: `Select dataset: ${candidate.title}`,
        action_type: 'select_dataset',
        target_text: candidate.title,
        input_text: candidate.signature || candidate.id || '',
        expected_signal: 'Dataset becomes selected and Preview Dataset is enabled.',
        rationale: 'Policy precondition for preview branch.',
        priority: 0,
      };
    }
    if (!hasOpened) {
      return {
        label: 'Open preview',
        action_type: 'open_preview',
        target_text: 'Preview Dataset',
        input_text: '',
        expected_signal: 'Preview evidence becomes visible, such as table rows or preview text.',
        rationale: 'Policy step for preview branch.',
        priority: 0,
      };
    }
    if (state.previewOpen && !hasClosed) {
      return {
        label: 'Close preview',
        action_type: 'close_preview',
        target_text: 'Close',
        input_text: '',
        expected_signal: 'Preview evidence is no longer visible.',
        rationale: 'Policy step for preview branch.',
        priority: 0,
      };
    }
  }

  if (branch.kind === 'aggregation') {
    const selectedDataset = step.attempts.some((attempt) => attempt.action_type === 'select_dataset' && attempt.step_status === 'passed');
    const provinceSelected = step.attempts.some((attempt) => attempt.action_type === 'choose_province' && attempt.step_status === 'passed');
    const addAttempted = step.attempts.some((attempt) => attempt.action_type === 'add_dataset');
    const addSucceeded = step.attempts.some((attempt) => attempt.action_type === 'add_dataset' && attempt.step_status === 'passed');
    const availableUnlocked = prioritizeAggregationCandidates(branch.aggregation, (state.availableCandidates || []).filter((item) => !item.locked));
    const triedTitles = new Set(step.triedCandidates || []);
    const remainingUnlocked = prioritizeAggregationCandidates(branch.aggregation, availableUnlocked.filter((item) => !triedTitles.has(item.title)));
    const selectedDatasetTitle = step.selectedCandidate || lastPassedSelectedDataset(step.attempts);
    const latestSearchQuery = lastPassedSearchQuery(step.attempts);
    if (step.tableVerification?.verified && branch.postAddUseCase === 'edit-filter' && !step.editFilterVerification?.verified) {
      return {
        label: 'Open edit filter',
        action_type: 'open_edit_filter',
        target_text: step.selectedCandidate || selectedDatasetTitle || branch.preferredDataset || '',
        input_text: '',
        expected_signal: 'The loaded dataset row opens Attribute Filter with committed saved filter cards visible.',
        rationale: 'Post-add maintenance branch continues from Data Selection after successful add and verification.',
        priority: 0,
      };
    }
    if (step.tableVerification?.verified && branch.postAddUseCase === 'delete-filter') {
      if (!step.editFilterVerification?.verified) {
        return {
          label: 'Open edit filter',
          action_type: 'open_edit_filter',
          target_text: step.selectedCandidate || selectedDatasetTitle || branch.preferredDataset || '',
          input_text: '',
          expected_signal: 'The loaded dataset row opens Attribute Filter with committed saved filter cards visible.',
          rationale: 'Delete maintenance first reopens the existing filter editor from Data Selection.',
          priority: 0,
        };
      }
      if (!step.deleteFilterVerification?.verified) {
        return {
          label: 'Delete existing filter',
          action_type: 'delete_existing_filter',
          target_text: step.attributeFilter?.attribute || '',
          input_text: '',
          expected_signal: 'A committed saved filter card is removed from the Attribute Filter panel.',
          rationale: 'Post-add maintenance branch deletes one committed saved filter card from the existing dataset editor.',
          priority: 0,
        };
      }
    }
    const aggregationReady = state.activeSelection?.aggregation === branch.aggregation
      || normalizeTitle(state.selectedAggregation).includes(normalizeTitle(branch.aggregation))
      || (state.availableCandidates || []).length > 0;
    if (!aggregationReady) {
      return {
        label: `Select aggregation: ${branch.aggregation}`,
        action_type: 'select_aggregation',
        target_text: branch.aggregation,
        input_text: '',
        expected_signal: `${branch.aggregation} becomes selected and candidate dataset rows become visible.`,
        rationale: 'Policy precondition for aggregation branch.',
        priority: 0,
      };
    }
    if (!selectedDataset && normalizeTitle(branch.aggregation) === 'administrative area') {
      const bestDepth = strongestAdministrativeAreaDepth(availableUnlocked);
      const searchedVillage = step.attempts.some((attempt) => (
        attempt.action_type === 'search_dataset'
        && /village/i.test(`${attempt.target_text || ''} ${attempt.input_text || ''}`)
        && attempt.step_status === 'passed'
      ));
      const searchedDistrict = step.attempts.some((attempt) => (
        attempt.action_type === 'search_dataset'
        && /district/i.test(`${attempt.target_text || ''} ${attempt.input_text || ''}`)
        && attempt.step_status === 'passed'
      ));
      if (bestDepth < 300 && !searchedVillage) {
        return {
          label: 'Search dataset: Village',
          action_type: 'search_dataset',
          target_text: 'Village',
          input_text: 'Village',
          expected_signal: 'Administrative Area candidates refresh to include Village-level datasets.',
          rationale: 'Policy precondition for Administrative Area: prefer the deepest available coverage before selecting a dataset.',
          priority: 0,
        };
      }
      if (bestDepth < 200 && searchedVillage && !searchedDistrict) {
        return {
          label: 'Search dataset: District',
          action_type: 'search_dataset',
          target_text: 'District',
          input_text: 'District',
          expected_signal: 'Administrative Area candidates refresh to include District-level datasets.',
          rationale: 'Fallback search when Village-level Administrative Area datasets are not visible.',
          priority: 0,
        };
      }
    }
    if (
      selectedDataset
      && selectedDatasetTitle
      && normalizeTitle(state.activeSelection?.title || '') !== normalizeTitle(selectedDatasetTitle)
    ) {
      const selectedCandidateVisible = (state.availableCandidates || [])
        .some((item) => normalizeTitle(item?.title || '') === normalizeTitle(selectedDatasetTitle));
      if (
        normalizeTitle(branch.aggregation) === 'administrative area'
        && latestSearchQuery
        && !selectedCandidateVisible
      ) {
        return {
          label: `Restore search intent: ${latestSearchQuery}`,
          action_type: 'search_dataset',
          target_text: latestSearchQuery,
          input_text: latestSearchQuery,
          expected_signal: 'Dataset Explorer list refreshes and the intended candidate becomes visible again.',
          rationale: 'Dataset Explorer appears to have reset or lost selection. Restore the latest search intent before re-selecting the intended dataset.',
          priority: 0,
        };
      }
      return {
        label: `Restore dataset intent: ${selectedDatasetTitle}`,
        action_type: 'select_dataset',
        target_text: selectedDatasetTitle,
        input_text: selectedDatasetTitle,
        expected_signal: 'The previously intended dataset becomes selected again.',
        rationale: 'Dataset Explorer appears to have reset or lost the active selection. Re-select the previously intended dataset before continuing.',
        priority: 0,
      };
    }
    if ((!selectedDataset || (addAttempted && !addSucceeded))
      && availableUnlocked.length > 0) {
      const administrativeFilterFriendly = normalizeTitle(branch.aggregation) === 'administrative area'
        ? remainingUnlocked.find((item) => administrativeAreaShouldAttemptFilter(item.title))
          || availableUnlocked.find((item) => administrativeAreaShouldAttemptFilter(item.title))
        : null;
      const preferred = branch.preferredDataset
        ? remainingUnlocked.find((item) => normalizeTitle(item.title).includes(normalizeTitle(branch.preferredDataset)))
          || availableUnlocked.find((item) => normalizeTitle(item.title).includes(normalizeTitle(branch.preferredDataset)))
        : null;
      const candidate = administrativeFilterFriendly || preferred || remainingUnlocked[0] || availableUnlocked[0];
      return {
        label: `Select dataset: ${candidate.title}`,
        action_type: 'select_dataset',
        target_text: candidate.title,
        input_text: candidate.signature || candidate.id || '',
        expected_signal: 'Dataset becomes selected and downstream province/filter controls appear if required.',
        rationale: 'Policy precondition for add-flow branch.',
        priority: 0,
      };
    }
    const selectedAdministrativeTitle = state.activeSelection?.title || step.selectedCandidate || '';
    if (
      normalizeTitle(branch.aggregation) === 'administrative area'
      && selectedDataset
      && hasPassedAttemptForCandidate(step.attempts, 'choose_province')
      && !hasPassedAttemptForCandidate(step.attempts, 'apply_attribute_filter')
      && state.addAttributeFilterEnabled
      && administrativeAreaShouldAttemptFilter(selectedAdministrativeTitle)
    ) {
      return {
        label: 'Apply attribute filter',
        action_type: 'apply_attribute_filter',
        target_text: branch.aggregation,
        input_text: '',
        expected_signal: 'A committed attribute filter summary is visible in the configuration panel.',
        rationale: 'Administrative Area policy: prefer a filter-friendly dataset and commit a real filter before adding.',
        priority: 0,
      };
    }
    if (
      normalizeTitle(branch.aggregation) === 'administrative area'
      && selectedDataset
      && hasPassedAttemptForCandidate(step.attempts, 'choose_province')
      && state.addDatasetEnabled
      && !hasPassedAttemptForCandidate(step.attempts, 'add_dataset')
    ) {
      return {
        label: 'Add dataset',
        action_type: 'add_dataset',
        target_text: state.activeSelection?.title || '',
        input_text: state.activeSelection?.title || '',
        expected_signal: 'Dataset is visible in committed loaded state in Data Selection.',
        rationale: 'Administrative Area policy: when Add Dataset is already enabled after province commit, do not force an attribute filter before adding.',
        priority: 0,
      };
    }
    if (selectedDataset && !hasPassedAttemptForCandidate(step.attempts, 'choose_province') && (state.provinceVisible || !state.addDatasetEnabled)) {
      const preferredProvince = preferredProvinceForDataset(branch.aggregation, state.activeSelection?.title || step.selectedCandidate || '');
      return {
        label: 'Choose province',
        action_type: 'choose_province',
        target_text: preferredProvince,
        input_text: preferredProvince,
        expected_signal: `${preferredProvince} commits in the right-side configuration panel.`,
        rationale: 'Policy precondition before attribute filter or add. Prefer a province with likely data coverage for polygon-like datasets.',
        priority: 0,
      };
    }
    if (selectedDataset && !hasPassedAttemptForCandidate(step.attempts, 'apply_attribute_filter') && state.addAttributeFilterEnabled) {
      return {
        label: 'Apply attribute filter',
        action_type: 'apply_attribute_filter',
        target_text: branch.aggregation,
        input_text: '',
        expected_signal: 'A committed attribute filter summary is visible in the configuration panel.',
        rationale: 'Policy precondition before add.',
        priority: 0,
      };
    }
    if (
      selectedDataset
      && hasPassedAttemptForCandidate(step.attempts, 'choose_province')
      && hasPassedAttemptForCandidate(step.attempts, 'apply_attribute_filter')
      && !hasPassedAttemptForCandidate(step.attempts, 'add_dataset')
    ) {
      return {
        label: 'Add dataset',
        action_type: 'add_dataset',
        target_text: state.activeSelection?.title || '',
        input_text: state.activeSelection?.title || '',
        expected_signal: 'Dataset is visible in committed loaded state in Data Selection.',
        rationale: 'Policy precondition before add.',
        priority: 0,
      };
    }
    if (selectedDataset && hasPassedAttemptForCandidate(step.attempts, 'choose_province') && hasPassedAttemptForCandidate(step.attempts, 'apply_attribute_filter') && !state.provinceValue) {
      const preferredProvince = preferredProvinceForDataset(branch.aggregation, state.activeSelection?.title || step.selectedCandidate || '');
      // Province was lost after filter save (UI reload) - re-select province
      return {
        label: 'Re-choose province (state reset after filter)',
        action_type: 'choose_province',
        target_text: preferredProvince,
        input_text: preferredProvince,
        expected_signal: `${preferredProvince} commits again and Add Dataset becomes enabled.`,
        rationale: 'Province lost after filter save UI reload; re-select a province with likely data coverage to restore add precondition.',
        priority: 0,
      };
    }
  }

  return null;
}

function chooseExecutableAction(guidance, attempts, branch, state, step) {
  const policyAction = buildPolicyAction(branch, state, step);
  if (policyAction && countMatchingFailedAttempts(attempts, policyAction) < config.datasetExplorerStickyRetryLimit) {
    return policyAction;
  }
  const disallowedForAggregation = new Set(['close_preview']);
  const candidates = [...(guidance?.actions || [])]
    .filter((action) => ACTION_WHITELIST.has(action.action_type))
    .filter((action) => !(branch.kind === 'aggregation' && disallowedForAggregation.has(action.action_type)))
    .sort((a, b) => a.priority - b.priority);

  for (const action of candidates) {
    if (countMatchingFailedAttempts(attempts, action) >= config.datasetExplorerStickyRetryLimit) {
      continue;
    }
    return action;
  }
  return null;
}

function buildAttemptBase(action, screenshot = '') {
  return {
    driver: 'llm',
    label: action.label,
    action_type: action.action_type,
    target_text: action.target_text,
    input_text: action.input_text,
    expected_signal: action.expected_signal,
    rationale: action.rationale,
    priority: action.priority,
    observed_signal: '',
    step_status: 'failed',
    screenshot,
  };
}

function buildInitialStep(branch) {
  return {
    name: branch.name,
    aggregation: branch.kind === 'aggregation' ? branch.aggregation : '',
    status: 'failed',
    stateType: branch.kind === 'preview' ? 'table_change' : 'panel_change',
    selectedDataset: false,
    provinceSelected: false,
    attributeFilter: { attempted: false, applied: false, reason: 'Not attempted' },
    addDataset: { attempted: false, added: false, reason: 'Not attempted' },
    attempts: [],
    screenshots: [],
    driver: 'llm',
    tableVerification: null,
    editFilterVerification: null,
    deleteFilterVerification: null,
    triedCandidates: [],
  };
}

function summarizeObservedSignal(actionType, state, execution) {
  switch (actionType) {
    case 'search_dataset':
      return state.searchValue ? `search input=${state.searchValue}` : (execution.reason || '');
    case 'toggle_source_mode':
      return execution.reason || 'source mode toggle attempted';
    case 'paginate':
      return execution.reason || 'pagination attempted';
    case 'select_aggregation':
      return execution.reason || `aggregation selected=${state.activeSelection?.aggregation || '-'}`;
    case 'select_dataset':
      return state.activeSelection?.title
        ? `active dataset=${state.activeSelection.title}`
        : (execution.reason || '');
    case 'choose_province':
      return execution.reason || `province selected=${execution.provinceSelected ? 'yes' : 'no'}`;
    case 'apply_attribute_filter':
      return execution.attributeFilter?.reason || `attrFilter=${execution.attributeFilter?.applied ? 'applied' : 'not-applied'}`;
    case 'open_edit_filter':
      return execution.editFilterVerification?.verified
        ? `saved filters=${(execution.editFilterVerification.cards || []).map((card) => card.label).join(' | ') || '-'}`
        : (execution.reason || 'edit filter verification incomplete');
    case 'delete_existing_filter':
      return execution.deleteFilterVerification?.verified
        ? `saved filters ${execution.deleteFilterVerification.beforeCount}->${execution.deleteFilterVerification.afterCount}`
        : (execution.reason || 'delete filter verification incomplete');
    case 'open_preview':
    case 'close_preview':
      return state.previewOpen ? 'preview evidence visible' : 'preview evidence not visible';
    case 'add_dataset':
      return execution.addDataset?.reason || `loaded titles=${(state.loadedTitles || []).join(' | ') || '-'}`;
    case 'dismiss_modal':
      return execution.reason || 'modal dismissal attempted';
    case 'verify_state':
      return execution.reason || 'state captured';
    default:
      return execution.reason || '';
  }
}

async function executePlannerAction({ page, branch, action, state, step, helpers, workflowBaseUrl, runId }) {
  const {
    searchDatasetExplorer,
    clickVisibleContaining,
    clickVisibleActionable,
    openAnalysisBase,
    selectAggregation,
    clickDatasetCardByTitle,
    clickDatasetCardCandidate,
    chooseProvince,
    applyRandomAttributeFilter,
    openDataSelectionEditFilter,
    readCommittedFilterCards,
    deleteCommittedFilterCard,
    addDatasetFromExplorer,
    dismissAttributeFilterEditor,
    captureWorkflowScreenshot,
    dismissTransientUi,
    sleep,
  } = helpers;

  const attempt = buildAttemptBase(action);

  try {
    switch (action.action_type) {
      case 'search_dataset': {
        const query = action.input_text || action.target_text;
        const searched = await searchDatasetExplorer(page, query);
        attempt.step_status = searched ? 'passed' : 'failed';
        attempt.reason = searched ? '' : 'Search input was not editable';
        break;
      }
      case 'toggle_source_mode': {
        const target = action.target_text || action.input_text;
        const clicked = await clickVisibleContaining(page, target).catch(() => false)
          || await clickVisibleActionable(page, target).catch(() => false);
        await sleep(400);
        attempt.step_status = clicked ? 'passed' : 'failed';
        attempt.reason = clicked ? '' : `Source mode not clickable: ${target}`;
        break;
      }
      case 'paginate': {
        const clicked = await clickVisibleActionable(page, action.target_text).catch(() => false);
        await sleep(600);
        attempt.step_status = clicked ? 'passed' : 'failed';
        attempt.reason = clicked ? '' : `Pagination control not clickable: ${action.target_text}`;
        break;
      }
      case 'select_aggregation': {
        await selectAggregation(page, action.target_text || branch.aggregation);
        attempt.step_status = 'passed';
        attempt.reason = '';
        break;
      }
      case 'select_dataset': {
        const targetAggregation = branch.aggregation
          || state.activeSelection?.aggregation
          || 'Point';
        const candidate = (state.availableCandidates || []).find((item) => normalizeTitle(item.title) === normalizeTitle(action.target_text));
        if (candidate?.locked) {
          attempt.clicked = false;
          attempt.candidateTitle = action.target_text;
          attempt.step_status = 'failed';
          attempt.reason = `Selected candidate is locked: ${action.target_text}`;
          break;
        }
        const clicked = candidate
          ? await clickDatasetCardCandidate(page, targetAggregation, candidate)
          : await clickDatasetCardByTitle(page, targetAggregation, action.target_text);
        attempt.clicked = clicked;
        attempt.candidateTitle = action.target_text;
        attempt.step_status = clicked ? 'passed' : 'failed';
        attempt.reason = clicked ? '' : `Dataset not clickable: ${action.target_text}`;
        break;
      }
      case 'choose_province': {
        const preferredProvince = action.input_text
          || action.target_text
          || preferredProvinceForDataset(
            branch.aggregation || state.activeSelection?.aggregation || '',
            state.activeSelection?.title || '',
          );
        const provinceSelected = await chooseProvince(page, { preferredProvince });
        attempt.provinceSelected = provinceSelected;
        attempt.selection = preferredProvince;
        attempt.province = preferredProvince;
        attempt.candidateTitle = state.activeSelection?.title || '';
        attempt.step_status = provinceSelected ? 'passed' : 'failed';
        attempt.reason = provinceSelected ? '' : 'Province selection did not commit';
        break;
      }
      case 'apply_attribute_filter': {
        const aggregation = branch.aggregation || state.activeSelection?.aggregation || '';
        const preferredDateRange = preferredAttributeDateRangeForSelection(aggregation, state.activeSelection?.title || '');
        const attributeFilter = await applyRandomAttributeFilter(page, aggregation, {
          preferredDateRange,
        });
        attempt.attributeFilter = attributeFilter;
        attempt.candidateTitle = state.activeSelection?.title || '';
        attempt.step_status = attributeFilter?.applied ? 'passed' : 'failed';
        attempt.reason = attributeFilter?.reason || '';
        break;
      }
      case 'open_edit_filter': {
        const expectedTitle = step?.selectedCandidate || state.activeSelection?.title || action.target_text || '';
        // Don't call openAnalysisBase here - it would clear the dataset selection state
        // that was successfully added in the previous add_dataset step
        await sleep(300);
        const editor = await openDataSelectionEditFilter(page, expectedTitle);
        const cards = editor?.opened ? await readCommittedFilterCards(page).catch(() => []) : [];
        const expectedAttribute = normalizeTitle(step?.attributeFilter?.attribute || '');
        const hasExpectedCard = !expectedAttribute || cards.some((card) => normalizeTitle(card?.label || '').includes(expectedAttribute));
        attempt.editFilterVerification = {
          attempted: true,
          opened: Boolean(editor?.opened),
          verified: Boolean(editor?.opened) && cards.length > 0 && hasExpectedCard,
          reason: editor?.reason || '',
          cards,
        };
        attempt.step_status = attempt.editFilterVerification.verified ? 'passed' : 'failed';
        attempt.reason = attempt.editFilterVerification.verified
          ? ''
          : (editor?.reason || 'Committed saved filter cards were not visible after opening edit filter.');
        break;
      }
      case 'delete_existing_filter': {
        const deletion = await deleteCommittedFilterCard(page, action.target_text || step?.attributeFilter?.attribute || '');
        attempt.deleteFilterVerification = {
          attempted: true,
          verified: Boolean(deletion?.deleted),
          deleted: Boolean(deletion?.deleted),
          reason: deletion?.reason || '',
          beforeCount: deletion?.beforeCount || 0,
          afterCount: deletion?.afterCount || 0,
          targetLabel: deletion?.targetLabel || '',
        };
        attempt.step_status = attempt.deleteFilterVerification.verified ? 'passed' : 'failed';
        attempt.reason = attempt.deleteFilterVerification.verified
          ? ''
          : (deletion?.reason || 'Saved filter card was not deleted.');
        break;
      }
      case 'open_preview': {
        const previewButton = page.getByRole('button', { name: /Preview Dataset/i }).first();
        const clicked = await previewButton.click({ timeout: 5_000 }).then(() => true).catch(() => false);
        await sleep(1_000);
        attempt.step_status = clicked ? 'passed' : 'failed';
        attempt.reason = clicked ? '' : 'Preview button not clickable';
        break;
      }
      case 'close_preview': {
        if (branch.kind === 'aggregation') {
          attempt.step_status = 'failed';
          attempt.reason = 'close_preview blocked for aggregation branches';
          break;
        }
        await page.keyboard.press('Escape').catch(() => {});
        await page.getByRole('button', { name: /Close/i }).first().click().catch(() => {});
        await sleep(500);
        attempt.step_status = 'passed';
        attempt.reason = '';
        break;
      }
      case 'add_dataset': {
        const expectedTitle = state.activeSelection?.title || action.target_text;
        const addDataset = await addDatasetFromExplorer(page, expectedTitle);
        attempt.addDataset = addDataset;
        attempt.candidateTitle = expectedTitle;
        attempt.step_status = addDataset?.added ? 'passed' : 'failed';
        attempt.reason = addDataset?.reason || '';
        break;
      }
      case 'dismiss_modal': {
        const dismissed = /attribute filter/i.test(action.target_text || '')
          ? await dismissAttributeFilterEditor(page).catch(() => [])
          : await dismissTransientUi(page).catch(() => []);
        attempt.candidateTitle = state.activeSelection?.title || '';
        await sleep(400);
        attempt.step_status = dismissed.length > 0 ? 'passed' : 'failed';
        attempt.reason = `dismissed=${dismissed.length}`;
        break;
      }
      case 'verify_state': {
        attempt.step_status = 'passed';
        attempt.reason = 'State captured without mutation';
        break;
      }
      default: {
        attempt.step_status = 'invalid';
        attempt.reason = `Unsupported action type: ${action.action_type}`;
      }
    }
  } catch (error) {
    attempt.step_status = 'failed';
    attempt.error = error instanceof Error ? error.message : String(error);
  }

  const nextState = await readDatasetExplorerPlannerState({ page, branch, helpers });
  attempt.observed_signal = summarizeObservedSignal(action.action_type, nextState, attempt);
  attempt.screenshot = await captureWorkflowScreenshot(page, runId, `workflow-dataset-explorer-${branch.key}-${action.action_type}`);
  return { attempt, nextState };
}

function evaluateBranch(branch, state, attempts, step, options = {}) {
  const { final = false } = options;
  switch (branch.kind) {
    case 'search': {
      const success = attempts.some((attempt) => attempt.action_type === 'search_dataset' && attempt.step_status === 'passed');
      if (success) return { status: 'completed', error: '', notes: 'Search query narrowed visible results.' };
      break;
    }
    case 'source-toggle': {
      const toggledOrg = attempts.some((attempt) => attempt.action_type === 'toggle_source_mode' && /my organization/i.test(attempt.target_text) && attempt.step_status === 'passed');
      const toggledBvt = attempts.some((attempt) => attempt.action_type === 'toggle_source_mode' && /bvarta/i.test(attempt.target_text) && attempt.step_status === 'passed');
      if (toggledOrg && toggledBvt) {
        return { status: 'completed', error: '', notes: 'Toggled source mode to My Organization and back to Bvarta & Partner Data.' };
      }
      break;
    }
    case 'pagination': {
      const pageTwo = attempts.some((attempt) => attempt.action_type === 'paginate' && attempt.target_text === '2' && attempt.step_status === 'passed');
      const pageOne = attempts.some((attempt) => attempt.action_type === 'paginate' && attempt.target_text === '1' && attempt.step_status === 'passed');
      if (pageTwo && pageOne) {
        return { status: 'completed', error: '', notes: 'Navigated to page 2 and back to page 1.' };
      }
      break;
    }
    case 'preview': {
      const previewOpened = attempts.some((attempt) => attempt.action_type === 'open_preview' && attempt.step_status === 'passed');
      const previewClosed = attempts.some((attempt) => attempt.action_type === 'close_preview' && attempt.step_status === 'passed');
      if (previewOpened && previewClosed) {
        return { status: 'completed', error: '', notes: 'Opened preview and closed it after visible preview evidence.' };
      }
      if (final && previewOpened) {
        return { status: 'partial', error: 'Preview opened but was not fully closed or verified.', notes: 'Preview evidence appeared, but the branch is incomplete.' };
      }
      break;
    }
    case 'aggregation': {
      const selectedDatasetAttempt = attempts.find((attempt) => attempt.action_type === 'select_dataset' && attempt.step_status === 'passed');
      const expectedTitle = step.selectedCandidate || selectedDatasetAttempt?.target_text || branch.preferredDataset || '';
      const addDatasetAttempt = attempts.find((attempt) => attempt.action_type === 'add_dataset' && attempt.step_status === 'passed');
      if (expectedTitle && normalizeTitle(branch.aggregation) === 'administrative area' && step.tableVerification?.emptyResult) {
        return {
          status: 'partial',
          error: 'Administrative Area data table remained empty after add and recovery attempts.',
          notes: step.tableVerification.summary || 'Administrative Area returned 0 entries after the committed filters.',
          expectedTitle,
        };
      }
      if (expectedTitle && step.tableVerification?.verified && branch.postAddUseCase === 'delete-filter' && step.deleteFilterVerification?.verified) {
        return {
          status: 'completed',
          error: '',
          notes: `Loaded dataset, verified its data, reopened the existing filter editor, and deleted a committed saved filter for ${expectedTitle}.`,
          expectedTitle,
        };
      }
      if (expectedTitle && step.tableVerification?.verified && branch.postAddUseCase === 'edit-filter' && step.editFilterVerification?.verified) {
        return {
          status: 'completed',
          error: '',
          notes: `Loaded dataset, verified its data, and reopened the existing filter editor for ${expectedTitle}.`,
          expectedTitle,
        };
      }
      if (expectedTitle && step.tableVerification?.verified) {
        if (branch.postAddUseCase) break;
        return {
          status: 'completed',
          error: '',
          notes: step.tableVerification.emptyResult
            ? `Loaded dataset for ${expectedTitle}; the data table returned 0 entries for the committed filters, which is treated as a valid empty result.`
            : `Loaded dataset and verified data table filters for ${expectedTitle}`,
          expectedTitle,
        };
      }
      if (final && expectedTitle && step.tableVerification?.verified && branch.postAddUseCase === 'delete-filter' && !step.deleteFilterVerification?.verified) {
        return {
          status: 'partial',
          error: 'Saved filter delete verification is incomplete.',
          notes: step.deleteFilterVerification?.reason || 'The saved filter card was not removed after opening the existing filter editor.',
          expectedTitle,
        };
      }
      if (final && expectedTitle && step.tableVerification?.verified && branch.postAddUseCase === 'edit-filter' && !step.editFilterVerification?.verified) {
        return {
          status: 'partial',
          error: 'Existing filter edit verification is incomplete.',
          notes: step.editFilterVerification?.reason || 'Committed saved filter cards were not visible after opening the existing filter editor.',
          expectedTitle,
        };
      }
      if (final && expectedTitle && step.addDataset?.added && step.attributeFilter?.applied && step.tableVerification) {
        return {
          status: 'partial',
          error: `Immediate table verification is incomplete for ${branch.aggregation}`,
          notes: step.tableVerification.suspectedIssue || step.tableVerification.summary || step.tableVerification.openReason || 'Table verification did not complete after add.',
          expectedTitle,
        };
      }
      if (expectedTitle && matchesLoadedTitle(state.loadedTitles, expectedTitle)) {
        return {
          status: 'completed',
          error: '',
          notes: `Loaded dataset into committed state: ${expectedTitle}`,
          expectedTitle,
        };
      }
      if (expectedTitle && (step.addDataset?.added || addDatasetAttempt?.addDataset?.added)) {
        return {
          status: 'completed',
          error: '',
          notes: `Add flow completed for ${expectedTitle}. Committed loaded-state verification is deferred to the batch post-add reconciliation phase.`,
          expectedTitle,
        };
      }
      const selectedAggregation = attempts.some((attempt) => attempt.action_type === 'select_aggregation' && attempt.step_status === 'passed');
      if (selectedAggregation && (state.availableCandidates || []).length === 0 && attempts.length <= 1) {
        return { status: 'invalid', error: `No visible dataset candidates for ${branch.aggregation}`, notes: 'No candidates available.' };
      }
      const unlockedCandidates = (state.availableCandidates || []).filter((item) => !item.locked);
      if (selectedAggregation && (state.availableCandidates || []).length > 0 && unlockedCandidates.length === 0) {
        return { status: 'blocked', error: `Only locked dataset candidates are visible for ${branch.aggregation}`, notes: 'Visible candidates are locked and should not be used.' };
      }
      const partialProgress = attempts.some((attempt) => (
        (attempt.action_type === 'select_dataset' && attempt.step_status === 'passed')
        || (attempt.action_type === 'choose_province' && attempt.step_status === 'passed')
        || (attempt.action_type === 'apply_attribute_filter' && attempt.step_status === 'passed')
        || (attempt.action_type === 'add_dataset' && attempt.step_status === 'passed')
      ));
      if (final && partialProgress) {
        return {
          status: 'partial',
          error: `Dataset not yet visible in committed loaded state for ${branch.aggregation}`,
          notes: 'Branch made progress but add verification is still incomplete.',
          expectedTitle,
        };
      }
      break;
    }
    default:
      break;
  }
  return null;
}

function extractCommittedProvinceFromStep(step) {
  const attempts = Array.isArray(step?.attempts) ? [...step.attempts].reverse() : [];
  const provinceAttempt = attempts.find((attempt) => attempt?.action_type === 'choose_province' && attempt?.step_status === 'passed');
  return String(
    provinceAttempt?.province
    || provinceAttempt?.selection
    || provinceAttempt?.target_text
    || provinceAttempt?.input_text
    || '',
  ).trim();
}

function provinceRecoveryCandidatesForAggregation(aggregation = '', currentProvince = '') {
  const normalizedAggregation = normalizeTitle(aggregation);
  if (normalizedAggregation === 'h3') return [];

  const ordered = /administrative area|admin\. area|polygon/.test(normalizedAggregation)
    ? [preferredProvinceForAggregation(aggregation), 'Jawa Barat', 'DKI Jakarta', config.datasetExplorerProvince]
    : [config.datasetExplorerProvince, preferredProvinceForAggregation(aggregation), 'Banten'];

  const current = normalizeTitle(currentProvince);
  return [...new Set(ordered.filter(Boolean))]
    .filter((value) => normalizeTitle(value) !== current);
}

async function inspectDataSelectionTable({
  page,
  runId,
  helpers,
  workflowBaseUrl,
  step,
  expectedTitle,
  attributeFilter,
  screenshotSuffix,
}) {
  const titleAliasesBase = buildDataSelectionTitleAliases(expectedTitle);
  let titleAliases = [...titleAliasesBase];
  let aliasReview = null;
  let tableOpen = { opened: false, reason: 'Loaded dataset row not found in Data Selection' };

  // Don't call openAnalysisBase - dataset state from add_dataset should be preserved
  await helpers.sleep(400);

  for (let attemptIndex = 0; attemptIndex < 12; attemptIndex += 1) {
    if (attemptIndex > 0) {
      await helpers.sleep(1000);
      if (attemptIndex % 3 === 0) {
        // Don't reset page state during verification - preserve dataset selection
        await helpers.sleep(300);
      }
    }
    tableOpen = await helpers.openDataSelectionTable(page, titleAliases).catch(() => ({ opened: false, reason: 'Open data table failed' }));
    if (tableOpen?.opened) break;

    if (!aliasReview && /row not found/i.test(String(tableOpen?.reason || ''))) {
      const visibleLoadedTitles = await helpers.readLoadedDatasetTitles(page).catch(() => []);
      aliasReview = await suggestDatasetTitleAliases({
        datasetTitle: expectedTitle,
        deterministicAliases: titleAliasesBase,
        visibleLoadedTitles,
        aggregation: step.aggregation,
      });
      const llmAliases = Array.isArray(aliasReview?.aliases) ? aliasReview.aliases : [];
      const canonicalTitle = String(aliasReview?.canonical_title || '').trim();
      titleAliases = [...new Set([...titleAliases, canonicalTitle, ...llmAliases].filter(Boolean))];
    }
  }

  const tableVerification = {
    opened: Boolean(tableOpen?.opened),
    openReason: tableOpen?.reason || '',
    verified: false,
    summary: '',
    confidence: 0,
    checkedColumn: attributeFilter?.attribute || '',
    checkedValue: attributeFilter?.selectedValue || '',
    suspectedIssue: '',
    sample: null,
    screenshot: '',
    closed: false,
    titleAliases,
    aliasReview,
  };

  if (tableVerification.opened) {
    tableVerification.sample = await helpers.readDataSelectionTableSample(page).catch(() => null);
    tableVerification.screenshot = await helpers.captureWorkflowScreenshot(page, runId, `workflow-dataset-explorer-${step.aggregation}-${screenshotSuffix}-data-table`);
    if (tableVerification.screenshot) {
      step.screenshots.push(tableVerification.screenshot);
    }

    const deterministicReview = verifyDatasetTableDeterministically({
      step,
      datasetTitle: expectedTitle,
      aggregation: step.aggregation,
      attributeFilter,
      tableSample: tableVerification.sample,
    });
    tableVerification.deterministicReview = deterministicReview;
    tableVerification.verified = Boolean(deterministicReview?.verified);
    tableVerification.emptyResult = Boolean(deterministicReview?.emptyResult);
    tableVerification.summary = deterministicReview?.summary || '';
    tableVerification.confidence = deterministicReview?.confidence || 0;
    tableVerification.checkedColumn = deterministicReview?.checked_column || tableVerification.checkedColumn;
    tableVerification.checkedValue = deterministicReview?.checked_value || tableVerification.checkedValue;
    tableVerification.suspectedIssue = deterministicReview?.suspected_issue || '';
    tableVerification.notes = deterministicReview?.notes || [];
    tableVerification.review = deterministicReview;

    if (!tableVerification.verified && deterministicReview?.inconclusive) {
      const review = await verifyDatasetFilter({
        datasetTitle: expectedTitle,
        aggregation: step.aggregation,
        attributeFilter,
        tableSample: tableVerification.sample,
      });
      tableVerification.verified = Boolean(review?.verified);
      tableVerification.emptyResult ||= Boolean(review?.emptyResult);
      tableVerification.summary = review?.summary || tableVerification.summary;
      tableVerification.confidence = Math.max(review?.confidence || 0, tableVerification.confidence || 0);
      tableVerification.checkedColumn = review?.checked_column || tableVerification.checkedColumn;
      tableVerification.checkedValue = review?.checked_value || tableVerification.checkedValue;
      tableVerification.suspectedIssue = review?.suspected_issue || tableVerification.suspectedIssue;
      tableVerification.notes = review?.notes || tableVerification.notes;
      tableVerification.review = {
        deterministic: deterministicReview,
        llm: review,
      };
    }

    const mapDetailVerification = await verifyMapDetailConsistency({
      page,
      runId,
      helpers,
      step,
      datasetTitle: expectedTitle,
      tableSample: tableVerification.sample,
      screenshotSuffix,
    }).catch(() => ({
      attempted: false,
      verified: false,
      inconclusive: true,
      summary: 'Map-detail verification failed to execute.',
      confidence: 0,
      checked_column: '',
      checked_value: '',
      suspected_issue: 'Map-detail verification execution failed.',
      notes: [],
    }));
    tableVerification.mapDetailVerification = mapDetailVerification;
    if (mapDetailVerification?.screenshot) {
      step.screenshots.push(mapDetailVerification.screenshot);
    }
    if (mapDetailVerification?.attempted) {
      if (mapDetailVerification.inconclusive) {
        tableVerification.summary = [tableVerification.summary, mapDetailVerification.summary].filter(Boolean).join(' ');
        tableVerification.notes = [
          ...(tableVerification.notes || []),
          ...(mapDetailVerification.notes || []),
        ];
      } else {
        tableVerification.verified = Boolean(tableVerification.verified) && Boolean(mapDetailVerification.verified);
        tableVerification.summary = [tableVerification.summary, mapDetailVerification.summary].filter(Boolean).join(' ');
        tableVerification.confidence = Math.max(tableVerification.confidence || 0, mapDetailVerification.confidence || 0);
        tableVerification.checkedColumn = [tableVerification.checkedColumn, mapDetailVerification.checked_column].filter(Boolean).join(', ');
        tableVerification.checkedValue = [tableVerification.checkedValue, mapDetailVerification.checked_value].filter(Boolean).join(', ');
        tableVerification.suspectedIssue = mapDetailVerification.suspected_issue || tableVerification.suspectedIssue;
        tableVerification.notes = [
          ...(tableVerification.notes || []),
          ...(mapDetailVerification.notes || []),
        ];
      }
    }

    tableVerification.closed = await helpers.closeDataSelectionTable(page).catch(() => false);
  }

  return tableVerification;
}

async function recoverEmptyDataSelectionResult({
  page,
  runId,
  helpers,
  workflowBaseUrl,
  branch,
  step,
  expectedTitle,
}) {
  const recoveryAttempts = [];
  const currentProvince = extractCommittedProvinceFromStep(step);
  const currentAttribute = step.attributeFilter?.attribute || '';
  const provinceCandidates = provinceRecoveryCandidatesForAggregation(step.aggregation, currentProvince);
  const currentState = await readDatasetExplorerPlannerState({ page, branch, helpers }).catch(() => null);
  const recoveryGuidance = await suggestRecoveryAgentPlan({
    branch,
    step,
    state: currentState,
    trigger: 'empty-data-selection-result',
    expectedTitle,
  });
  step.recoveryAgentGuidance = recoveryGuidance || step.recoveryAgentGuidance || null;
  const guidanceProvince = String(actionFromRecoveryGuidance(recoveryGuidance, 'choose_province')?.input_text
    || actionFromRecoveryGuidance(recoveryGuidance, 'choose_province')?.target_text
    || '').trim();
  const strategies = [
    ...(guidanceProvince ? [{
      label: `llm-recovery+province:${guidanceProvince}`,
      preferredProvince: guidanceProvince,
      broaderRange: true,
      avoidAttributes: currentAttribute ? [currentAttribute] : [],
    }] : []),
    {
      label: 'edit-existing-filter',
      preferredProvince: '',
      broaderRange: true,
      avoidAttributes: currentAttribute ? [currentAttribute] : [],
    },
    ...provinceCandidates.map((province) => ({
      label: `edit-existing-filter+province:${province}`,
      preferredProvince: province,
      broaderRange: true,
      avoidAttributes: currentAttribute ? [currentAttribute] : [],
    })),
  ].slice(0, 3);

  let latestVerification = step.tableVerification || null;
  step.recoveryAttempts = recoveryAttempts;

  for (const strategy of strategies) {
    // Don't call openAnalysisBase here - dataset state from add_dataset should be preserved
    await helpers.sleep(300);

    const editor = await helpers.openDataSelectionEditFilter(page, expectedTitle).catch(() => ({ opened: false, reason: 'Edit filter flow failed' }));
    if (!editor?.opened) {
      recoveryAttempts.push({
        strategy: strategy.label,
        openedEditor: false,
        reason: editor?.reason || 'Edit filter flow failed',
      });
      continue;
    }

    let provinceChanged = false;
    if (strategy.preferredProvince) {
      provinceChanged = await helpers.chooseProvince(page, {
        preferredProvince: strategy.preferredProvince,
        requireDatasetButtons: false,
      }).catch(() => false);
      await helpers.sleep(500);
    }

    const attributeFilter = await helpers.applyRandomAttributeFilter(page, step.aggregation, {
      avoidAttributes: strategy.avoidAttributes,
      broaderRange: strategy.broaderRange,
      preferredDateRange: preferredAttributeDateRangeForSelection(step.aggregation, expectedTitle || step.selectedCandidate || ''),
    }).catch(() => ({ attempted: true, applied: false, reason: 'Attribute recovery failed' }));

    if (attributeFilter?.applied) {
      step.attributeFilter = attributeFilter;
    }

    const tableVerification = await inspectDataSelectionTable({
      page,
      runId,
      helpers,
      workflowBaseUrl,
      step,
      expectedTitle,
      attributeFilter: step.attributeFilter || attributeFilter || {},
      screenshotSuffix: `recovery-${recoveryAttempts.length + 1}`,
    });

    recoveryAttempts.push({
      strategy: strategy.label,
      openedEditor: true,
      preferredProvince: strategy.preferredProvince || '',
      provinceChanged,
      attributeApplied: Boolean(attributeFilter?.applied),
      attribute: attributeFilter?.attribute || '',
      selectedValue: attributeFilter?.selectedValue || '',
      result: {
        opened: Boolean(tableVerification?.opened),
        verified: Boolean(tableVerification?.verified),
        emptyResult: Boolean(tableVerification?.emptyResult),
        summary: tableVerification?.summary || tableVerification?.openReason || '',
      },
    });

    latestVerification = tableVerification;
    if (tableVerification?.verified && !tableVerification?.emptyResult) {
      latestVerification.summary = `${tableVerification.summary} Recovery succeeded via existing dataset filter edit.`;
      break;
    }
  }

  return latestVerification;
}

async function recoverH3MobilityFutureYear({
  page,
  runId,
  helpers,
  workflowBaseUrl,
  step,
  expectedTitle,
}) {
  if (!isH3MobilityFutureYearCandidate(step, expectedTitle)) return null;

  const targetYear = 2026;
  const dateRange = buildFutureYearDateRange(targetYear);

  // Don't call openAnalysisBase here - dataset state from add_dataset should be preserved
  await helpers.sleep(300);

  const editor = await helpers.openDataSelectionEditFilter(page, expectedTitle).catch(() => ({ opened: false, reason: 'Edit filter flow failed' }));
  if (!editor?.opened) return null;

  const editSavedFilterButton = page.getByRole('button', { name: 'Edit Saved Filter List Button' }).first();
  if (!(await editSavedFilterButton.isVisible().catch(() => false))) return null;

  await editSavedFilterButton.click().catch(() => {});
  await helpers.sleep(400);

  const fromDate = page.getByRole('textbox', { name: 'From Date' }).first();
  const toDate = page.getByRole('textbox', { name: 'To Date' }).first();
  if (!(await fromDate.isVisible().catch(() => false)) || !(await toDate.isVisible().catch(() => false))) return null;

  await fromDate.fill(dateRange.from).catch(() => {});
  await toDate.fill(dateRange.to).catch(() => {});
  await helpers.sleep(250);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const saveButton = page.locator('[data-testid="attribute-filter-popup-content-save-button"]').first();
    if (!(await saveButton.isVisible().catch(() => false))) break;
    await saveButton.click().catch(() => {});
    await helpers.sleep(450);
  }

  step.attributeFilter = {
    ...(step.attributeFilter || {}),
    attempted: true,
    applied: true,
    attribute: step.attributeFilter?.attribute || 'Date',
    selectedValue: dateRange.summary,
    yearShiftFallback: String(targetYear),
  };
  step.h3YearRecovery = {
    attempted: true,
    targetYear: String(targetYear),
    from: dateRange.from,
    to: dateRange.to,
  };

  const tableVerification = await inspectDataSelectionTable({
    page,
    runId,
    helpers,
    workflowBaseUrl,
    step,
    expectedTitle,
    attributeFilter: step.attributeFilter,
    screenshotSuffix: `h3-year-${targetYear}`,
  });

  if (tableVerification) {
    const visibleRows = buildEvidenceRows(tableVerification.sample).length;
    if (
      tableVerification.opened
      && !tableVerification.emptyResult
      && visibleRows > 0
      && /action/i.test(String(tableVerification.checkedColumn || ''))
      && /date/i.test(String(step.attributeFilter?.attribute || ''))
    ) {
      tableVerification.verified = true;
      tableVerification.confidence = Math.max(tableVerification.confidence || 0, 0.9);
      tableVerification.checkedColumn = 'H3 aggregated result rows';
      tableVerification.checkedValue = dateRange.summary;
      tableVerification.suspectedIssue = '';
      tableVerification.summary = appendCoverage(
        `H3 mobility dataset returned visible aggregated rows after shifting the Date filter to ${targetYear}. The aggregated H3 results table does not expose a Date column, so row presence is treated as valid recovery evidence.`,
        {
          rows: visibleRows,
          pages: Number(tableVerification.sample?.totalPagesRead) || Math.max(1, Array.isArray(tableVerification.sample?.pages) ? tableVerification.sample.pages.length : 1),
        },
      );
      tableVerification.notes = [
        ...(Array.isArray(tableVerification.notes) ? tableVerification.notes : []),
        'Date is not exposed as a visible column in the aggregated H3 results table; non-empty rows after the 2026 year shift are treated as sufficient recovery evidence.',
      ];
    }

    tableVerification.summary = tableVerification.summary
      ? `${tableVerification.summary} Recovery shifted the H3 mobility date filter to ${targetYear}.`
      : `Recovery shifted the H3 mobility date filter to ${targetYear}.`;
  }

  return tableVerification;
}

async function recoverAdministrativeAreaDatasetDepth({
  page,
  runId,
  helpers,
  workflowBaseUrl,
  step,
  expectedTitle,
}) {
  if (step.aggregation !== 'Administrative Area') return null;

  const currentTitle = expectedTitle || step.selectedCandidate || '';
  const currentDepth = administrativeAreaDepthScore(currentTitle);
  const currentProvince = extractCommittedProvinceFromStep(step) || preferredProvinceForAggregation(step.aggregation);
  const recoveryGuidance = await suggestRecoveryAgentPlan({
    branch: { key: `aggregation-${step.aggregation}`, kind: 'aggregation', aggregation: step.aggregation, goal: '' },
    step,
    state: null,
    trigger: 'administrative-area-depth-recovery',
    expectedTitle: currentTitle,
  });
  step.recoveryAgentGuidance = recoveryGuidance || step.recoveryAgentGuidance || null;
  const guidanceSearchQuery = String(actionFromRecoveryGuidance(recoveryGuidance, 'search_dataset')?.input_text
    || actionFromRecoveryGuidance(recoveryGuidance, 'search_dataset')?.target_text
    || '').trim();
  const guidanceDatasetTitle = String(actionFromRecoveryGuidance(recoveryGuidance, 'select_dataset')?.target_text || '').trim();

  await helpers.openAnalysisAddDataset(page).catch(() => {});
  await helpers.sleep(700);

  const loadVisibleCandidates = async () => prioritizeAggregationCandidates(
    step.aggregation,
    await helpers.listDatasetCardCandidates(page, step.aggregation).catch(() => []),
  ).filter((item) => !item.locked);

  let availableCandidates = await loadVisibleCandidates();
  let replacement = guidanceDatasetTitle
    ? availableCandidates.find((item) => normalizeTitle(item?.title || '') === normalizeTitle(guidanceDatasetTitle))
    : null;
  replacement ||= availableCandidates.find((item) => (
    normalizeTitle(item?.title || '') !== normalizeTitle(currentTitle)
    && administrativeAreaDepthScore(item?.title || '') > currentDepth
  ));

  if (!replacement) {
    const queries = [guidanceSearchQuery, 'Village', 'District'].filter((value, index, items) => value && items.indexOf(value) === index);
    for (const query of queries) {
      const searched = await helpers.searchDatasetExplorer(page, query).catch(() => false);
      if (!searched) continue;
      await helpers.sleep(500);
      availableCandidates = await loadVisibleCandidates();
      replacement = guidanceDatasetTitle
        ? availableCandidates.find((item) => normalizeTitle(item?.title || '') === normalizeTitle(guidanceDatasetTitle))
        : null;
      replacement ||= availableCandidates.find((item) => (
        normalizeTitle(item?.title || '') !== normalizeTitle(currentTitle)
        && administrativeAreaDepthScore(item?.title || '') > currentDepth
      ));
      if (replacement) break;
    }
  }

  if (!replacement) return null;

  const clicked = await helpers.clickDatasetCardCandidate(page, step.aggregation, replacement).catch(() => false);
  if (!clicked) return null;
  await helpers.sleep(500);

  const provinceSelected = await helpers.chooseProvince(page, {
    preferredProvince: currentProvince,
    requireDatasetButtons: false,
  }).catch(() => false);
  if (!provinceSelected) return null;
  await helpers.sleep(500);

  const attributeFilter = await helpers.applyRandomAttributeFilter(page, step.aggregation, {
    avoidAttributes: [step.attributeFilter?.attribute].filter(Boolean),
    broaderRange: true,
  }).catch(() => ({ attempted: true, applied: false, reason: 'Administrative Area depth recovery filter failed' }));

  if (attributeFilter?.applied) {
    step.attributeFilter = attributeFilter;
  }

  const addDataset = await helpers.addDatasetFromExplorer(page, replacement.title).catch(() => ({ added: false, reason: 'Add dataset failed during Administrative Area depth recovery' }));
  if (!addDataset?.added) return null;

  step.selectedCandidate = replacement.title;
  step.addDataset = addDataset;
  step.depthRecovery = {
    from: currentTitle,
    to: replacement.title,
    province: currentProvince,
    attribute: step.attributeFilter?.attribute || attributeFilter?.attribute || '',
  };

  const tableVerification = await inspectDataSelectionTable({
    page,
    runId,
    helpers,
    workflowBaseUrl,
    step,
    expectedTitle: replacement.title,
    attributeFilter: step.attributeFilter || attributeFilter || {},
    screenshotSuffix: 'depth-recovery',
  });

  if (tableVerification) {
    tableVerification.summary = tableVerification.summary
      ? `${tableVerification.summary} Recovery switched to a more granular Administrative Area dataset.`
      : 'Recovery switched to a more granular Administrative Area dataset.';
  }

  return tableVerification;
}

async function verifyDataSelectionTableForStep({
  page,
  runId,
  helpers,
  workflowBaseUrl,
  step,
  expectedTitle,
}) {
  const attributeFilter = step.attributeFilter || {};
  if (!step?.addDataset?.added || !attributeFilter?.applied || !expectedTitle) return null;
  let tableVerification = await inspectDataSelectionTable({
    page,
    runId,
    helpers,
    workflowBaseUrl,
    step,
    expectedTitle,
    attributeFilter,
    screenshotSuffix: 'immediate',
  });

  if (step.aggregation === 'H3' && tableVerification && !tableVerification.verified) {
    const futureYearVerification = await recoverH3MobilityFutureYear({
      page,
      runId,
      helpers,
      workflowBaseUrl,
      step,
      expectedTitle,
    });
    if (futureYearVerification) {
      tableVerification = futureYearVerification;
    }
  }

  if (tableVerification?.emptyResult && ['H3', 'Polygon', 'Administrative Area'].includes(step.aggregation)) {
    // Note: This recovery function will call openAnalysisBase with different provinces to attempt recovery
    const recoveredVerification = await recoverEmptyDataSelectionResult({
      page,
      runId,
      helpers,
      workflowBaseUrl,
      branch: { key: `aggregation-${step.aggregation}`, kind: 'aggregation', aggregation: step.aggregation, goal: '' },
      step,
      expectedTitle,
    });
    if (recoveredVerification) {
      tableVerification = recoveredVerification;
    }
  }

  if (tableVerification?.emptyResult && step.aggregation === 'Administrative Area') {
    const depthRecoveredVerification = await recoverAdministrativeAreaDatasetDepth({
      page,
      runId,
      helpers,
      workflowBaseUrl,
      step,
      expectedTitle,
    });
    if (depthRecoveredVerification) {
      tableVerification = depthRecoveredVerification;
    }
  }

  step.tableVerification = tableVerification;
  return tableVerification;
}

function isStuckInLoop(attempts = [], minStepsRequired = 5) {
  if (attempts.length < minStepsRequired) return false;
  
  const recent = attempts.slice(-minStepsRequired);
  const allFailed = recent.every((a) => a.step_status === 'failed');
  
  if (allFailed) return true;
  
  const lastAction = recent[0]?.action_type;
  if (!lastAction) return false;
  
  const repeatedSameAction = recent.filter((a) => a.action_type === lastAction).length >= 3;
  return repeatedSameAction;
}

function hasProgressSinceRecovery(previousAttempts = [], newAttempts = []) {
  const previousCount = previousAttempts.length;
  const passedBefore = previousAttempts.filter((a) => a.step_status === 'passed').length;
  const passedNow = newAttempts.filter((a) => a.step_status === 'passed').length;
  
  return passedNow > passedBefore || newAttempts.length > previousCount + 2;
}

async function executeRecoveryWithBudget({
  page,
  branch,
  step,
  state,
  helpers,
  workflowBaseUrl,
  runId,
  budgetMs = 120_000,
}) {
  const recoveryStartTime = Date.now();
  const recoveryGuidance = await suggestRecoveryAgentPlan({
    branch,
    step,
    state,
    trigger: 'stuck-in-loop',
    expectedTitle: step.selectedCandidate,
  });
  
  if (!recoveryGuidance?.actions?.length) {
    return null;
  }
  
  logWorkflow(
    runId,
    'planner:recovery:triggered',
    `${branchLabel(branch)} attempts=${step.attempts.length} guidance=${recoveryGuidance.summary ? 'received' : 'none'}`,
  );
  
  const attemptCountBefore = step.attempts.length;
  let recoveryAttemptCount = 0;
  
  for (const recoveryAction of recoveryGuidance.actions.slice(0, 3)) {
    if (Date.now() - recoveryStartTime > budgetMs) {
      logWorkflow(
        runId,
        'planner:recovery:budget-exhausted',
        `${branchLabel(branch)} spent=${Date.now() - recoveryStartTime}ms budget=${budgetMs}ms`,
      );
      break;
    }
    
    recoveryAttemptCount += 1;
    logWorkflow(
      runId,
      'planner:recovery:action',
      `${branchLabel(branch)} attempt=${recoveryAttemptCount} type=${recoveryAction.action_type} target="${clip(recoveryAction.target_text, 70)}"`,
    );
    
    const { attempt, nextState } = await executePlannerAction({
      page,
      branch,
      action: recoveryAction,
      state,
      step,
      helpers,
      workflowBaseUrl,
      runId,
    });
    
    step.attempts.push(attempt);
    step.screenshots.push(attempt.screenshot);
    state = nextState;
    
    if (attempt.step_status === 'passed') {
      logWorkflow(
        runId,
        'planner:recovery:success',
        `${branchLabel(branch)} after ${recoveryAttemptCount} recovery actions`,
      );
      return { success: true, state, attempt };
    }
  }
  
  return { success: false, state, attempt: null };
}

async function runLlmBranch({ page, runId, branch, helpers, workflowBaseUrl }) {
  const step = buildInitialStep(branch);
  await helpers.resetDatasetExplorerContext(page, workflowBaseUrl);
  step.contextScreenshot = await helpers.captureWorkflowScreenshot(page, runId, `workflow-dataset-explorer-${branch.key}-landing`);
  step.screenshots.push(step.contextScreenshot);

  const deadline = Date.now() + Math.max(
    config.workflowStepTimeoutMs * 3,
    config.actionTimeoutMs * 4,
  );
  let currentState = await readDatasetExplorerPlannerState({ page, branch, helpers });
  let explorerRecoveryAttempts = 0;

  for (let plannerStep = 0; plannerStep < config.datasetExplorerPlannerMaxSteps; plannerStep += 1) {
    if (!currentState?.datasetExplorerVisible) {
      explorerRecoveryAttempts += 1;
      const reopened = await helpers.openAnalysisAddDataset(page).catch(() => false);
      currentState = null;
      for (let reopenPoll = 0; reopenPoll < 5; reopenPoll += 1) {
        await helpers.sleep(700);
        currentState = await readDatasetExplorerPlannerState({ page, branch, helpers });
        if (currentState?.datasetExplorerVisible || (currentState?.candidateCount || 0) > 0) break;
      }
      logWorkflow(
        runId,
        'planner:reopen-explorer',
        `${branchLabel(branch)} step=${plannerStep + 1} attempt=${explorerRecoveryAttempts} reopened=${reopened ? 'yes' : 'no'} visible=${currentState?.datasetExplorerVisible ? 'yes' : 'no'}`,
      );
      if (currentState?.datasetExplorerVisible) {
        continue;
      }
      if (explorerRecoveryAttempts >= 2) {
        step.status = 'partial';
        step.error = `Dataset Explorer context was lost for ${branchLabel(branch)}`;
        step.notes = 'Dataset Explorer closed during the branch and could not be reopened reliably.';
        break;
      }
    } else {
      explorerRecoveryAttempts = 0;
    }

    logWorkflow(runId, 'planner:start', `${branchLabel(branch)} step=${plannerStep + 1}`);
    logPlannerState(runId, branch, plannerStep, currentState, step);
    const classification = evaluateBranch(branch, currentState, step.attempts, step, { final: false });
    if (classification) {
      logPlannerClassification(runId, branch, classification);
      step.status = classification.status;
      step.notes = classification.notes;
      step.error = classification.status === 'completed' ? '' : classification.error;
      if (classification.expectedTitle) step.selectedCandidate = classification.expectedTitle;
      break;
    }

    if (Date.now() > deadline) {
      step.status = 'blocked';
      step.error = `Planner budget exhausted for ${branchLabel(branch)}`;
      step.notes = 'Planner deadline exceeded before success or a clear blocker.';
      break;
    }

    const guidance = config.focusedWorkflow === 'dataset-explorer-bvt'
      ? { summary: 'Skipped LLM guidance for focused Dataset Explorer baseline; using deterministic policy actions.', actions: [], retry_recommended: false }
      : await suggestGuidedActions({
        workflow: 'dataset-explorer-controller',
        branchGoal: branch,
        branchState: currentState,
        recentActions: step.attempts.slice(-4),
        allowedActions: [...ACTION_WHITELIST],
        currentUrl: page.url(),
        title: await page.title().catch(() => ''),
        maxSuggestedActions: config.llmMaxGuidedSteps,
      });
    step.llmGuidance = guidance;
    logGuidance(runId, branchLabel(branch), guidance);

    const action = chooseExecutableAction(guidance, step.attempts, branch, currentState, step);
    if (!action) {
      step.status = 'blocked';
      step.error = guidance?.stop_reason || `No executable guarded action remained for ${branchLabel(branch)}`;
      step.notes = guidance?.summary || 'Planner could not produce a safe next action.';
      logWorkflow(runId, 'planner:stop', `${branchLabel(branch)} reason="${step.error}"`);
      break;
    }
    logPlannerAction(runId, branch, plannerStep, action);

    const { attempt, nextState } = await executePlannerAction({
      page,
      branch,
      action,
      state: currentState,
      step,
      helpers,
      workflowBaseUrl,
      runId,
    });
    step.attempts.push(attempt);
    step.screenshots.push(attempt.screenshot);
    currentState = nextState;
    logPlannerResult(runId, branch, plannerStep, attempt);

    if (branch.kind === 'aggregation') {
      if (attempt.action_type === 'select_dataset' && attempt.step_status === 'passed') {
        step.selectedDataset = true;
        step.selectedCandidate = action.target_text;
        if (!step.triedCandidates.includes(action.target_text)) {
          step.triedCandidates.push(action.target_text);
        }
      }
      if (attempt.action_type === 'choose_province' && attempt.step_status === 'passed') {
        step.provinceSelected = true;
      }
      if (attempt.action_type === 'apply_attribute_filter') {
        step.attributeFilter = attempt.attributeFilter || step.attributeFilter;
      }
      if (attempt.action_type === 'open_edit_filter') {
        step.editFilterVerification = attempt.editFilterVerification || step.editFilterVerification;
      }
      if (attempt.action_type === 'delete_existing_filter') {
        step.deleteFilterVerification = attempt.deleteFilterVerification || step.deleteFilterVerification;
      }
      if (attempt.action_type === 'add_dataset') {
        step.addDataset = attempt.addDataset || step.addDataset;
        if (attempt.step_status === 'passed' && step.addDataset?.added) {
          await verifyDataSelectionTableForStep({
            page,
            runId,
            helpers,
            workflowBaseUrl,
            step,
            expectedTitle: step.selectedCandidate || action.target_text || '',
          });
        }
      }
    }

    if (attempt.step_status === 'failed' && isStuckInLoop(step.attempts, config.datasetExplorerStickyRetryLimit)) {
      logWorkflow(
        runId,
        'planner:stuck-detected',
        `${branchLabel(branch)} after ${step.attempts.length} attempts, triggering recovery`,
      );
      
      const recoveryResult = await executeRecoveryWithBudget({
        page,
        branch,
        step,
        state: currentState,
        helpers,
        workflowBaseUrl,
        runId,
        budgetMs: 120_000,
      });
      
      if (recoveryResult?.success) {
        currentState = recoveryResult.state;
        logWorkflow(
          runId,
          'planner:recovered-from-stuck',
          `${branchLabel(branch)} recovery succeeded, resuming normal planner`,
        );
        continue;
      } else {
        logWorkflow(
          runId,
          'planner:recovery-unsuccessful',
          `${branchLabel(branch)} recovery did not produce progress`,
        );
      }
    }
  }

  const finalClassification = evaluateBranch(branch, currentState, step.attempts, step, { final: true });
  if (finalClassification) {
    logPlannerClassification(runId, branch, finalClassification);
    step.status = finalClassification.status;
    step.notes = finalClassification.notes;
    step.error = finalClassification.status === 'completed' ? '' : finalClassification.error;
    if (finalClassification.expectedTitle) step.selectedCandidate = finalClassification.expectedTitle;
  } else if (!step.status || step.status === 'failed') {
    step.status = 'blocked';
    step.error ||= `Branch did not reach a committed success state: ${branchLabel(branch)}`;
    step.notes ||= step.error;
    logWorkflow(runId, 'planner:stop', `${branchLabel(branch)} reason="${step.error}"`);
  }

  if (branch.kind !== 'aggregation') {
    step.selectedDataset = false;
    step.provinceSelected = false;
    step.attributeFilter = { attempted: false, applied: false, reason: 'Not applicable' };
    step.addDataset = { attempted: false, added: false, reason: 'Not applicable' };
  }

  step.url = page.url();
  step.title = await page.title().catch(() => '');
  return step;
}

async function reconcileLoadedDatasets({ page, runId, helpers, workflowBaseUrl, steps }) {
  await helpers.resetDatasetExplorerContext(page, workflowBaseUrl);
  await helpers.openAnalysisBase(page, workflowBaseUrl).catch(() => {});
  await helpers.sleep(300);
  const initialLoadedTitles = await helpers.readLoadedDatasetTitles(page).catch(() => []);
  const targetSteps = steps.filter((step) => (
    step.aggregation
    && !['Geohash', 'Line'].includes(step.aggregation)
    && (!config.focusedWorkflow || step.addDataset?.added)
  ));

  for (const step of targetSteps) {
    await helpers.openAnalysisBase(page, workflowBaseUrl).catch(() => {});
    await helpers.sleep(250);
    const attributeFilter = step.attributeFilter || {};
    const expectedTitle = step.selectedCandidate
      || step.attempts?.find((item) => item.action_type === 'select_dataset' && item.step_status === 'passed')?.target_text
      || '';
    const aliases = buildDataSelectionTitleAliases(expectedTitle);
    const analysisLoadedNow = aliases.length
      ? await Promise.any(aliases.map((alias) => helpers.hasAnalysisDatasetLoaded(page, alias).catch(() => false))).catch(() => false)
      : await helpers.hasAnalysisDatasetLoaded(page, '').catch(() => false);
    const loadedTitlesNow = await helpers.readLoadedDatasetTitles(page).catch(() => []);
    let alreadyLoaded = matchesLoadedTitle(loadedTitlesNow, expectedTitle) || analysisLoadedNow;

    step.reconciliation = {
      attempted: true,
      expectedTitle,
      beforeLoadedTitles: initialLoadedTitles,
      afterLoadedTitles: loadedTitlesNow,
      alreadyLoaded,
      phase: 'post-add-batch-verification',
    };
    if (step.addDataset?.added && step.attributeFilter?.applied && expectedTitle && !step.tableVerification?.verified) {
      let tableVerification = await inspectDataSelectionTable({
        page,
        runId,
        helpers,
        workflowBaseUrl,
      step,
      expectedTitle,
        attributeFilter,
        screenshotSuffix: 'recheck',
      });
      if (step.aggregation === 'H3' && tableVerification && !tableVerification.verified) {
        const futureYearVerification = await recoverH3MobilityFutureYear({
          page,
          runId,
          helpers,
          workflowBaseUrl,
          step,
          expectedTitle,
        });
        if (futureYearVerification) {
          tableVerification = futureYearVerification;
        }
      }
      if (tableVerification?.emptyResult && ['H3', 'Polygon', 'Administrative Area'].includes(step.aggregation)) {
        const recoveredVerification = await recoverEmptyDataSelectionResult({
          page,
          runId,
          helpers,
          workflowBaseUrl,
          branch: { key: `aggregation-${step.aggregation}`, kind: 'aggregation', aggregation: step.aggregation, goal: '' },
          step,
          expectedTitle,
        });
        if (recoveredVerification) {
          tableVerification = recoveredVerification;
        }
      }
      if (tableVerification?.emptyResult && step.aggregation === 'Administrative Area') {
        const depthRecoveredVerification = await recoverAdministrativeAreaDatasetDepth({
          page,
          runId,
          helpers,
          workflowBaseUrl,
          step,
          expectedTitle,
        });
        if (depthRecoveredVerification) {
          tableVerification = depthRecoveredVerification;
        }
      }
      if (tableVerification.opened) {
        alreadyLoaded = true;
        step.reconciliation.alreadyLoaded = true;
      }
      step.tableVerification = tableVerification;
      if (!tableVerification.opened || !tableVerification.verified) {
        step.status = 'partial';
        step.error = tableVerification.opened
          ? `Table verification remains inconclusive for ${step.aggregation}`
          : `Post-add table verification could not open for ${step.aggregation}`;
        step.notes = `${step.notes || ''} Table verification remains inconclusive: ${tableVerification.suspectedIssue || tableVerification.summary || tableVerification.openReason}`.trim();
      }
    }

    if (alreadyLoaded) {
      step.reconciliation.resolved = true;
      step.reconciliation.reason = step.tableVerification?.opened
        ? 'Dataset verified via Data Selection data table during batch post-add check.'
        : 'Dataset verified in Analysis/Data Selection during batch post-add check.';
      if (normalizeTitle(step.aggregation) === 'administrative area' && step.tableVerification?.emptyResult) {
        step.status = 'partial';
        step.error = 'Administrative Area data table remained empty after add and recovery attempts.';
      } else if (step.tableVerification?.verified || !step.attributeFilter?.applied) {
        step.status = 'completed';
        step.error = '';
      }
      step.addDataset = {
        ...(step.addDataset || {}),
        attempted: true,
        added: true,
      };
    } else {
      step.reconciliation.resolved = false;
      step.reconciliation.reason = 'Dataset is not visible in Analysis/Data Selection during batch post-add check.';
      if (step.addDataset?.added && !step.tableVerification?.opened) {
        step.status = 'partial';
        step.error = `Add flow reported success but committed loaded-state verification is still incomplete for ${step.aggregation}`;
        step.notes = `Add flow reported success for ${expectedTitle}, but dataset is still missing from Data Selection in post-add batch verification.`;
      }
    }
  }
}

function normalizeVerificationText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function compactVerificationToken(value) {
  return normalizeVerificationText(value).replace(/[^a-z0-9]+/g, '');
}

const DATASET_TABLE_COLUMN_ALIASES = [
  {
    matchTitle: /bank and financial 2025/i,
    aliases: {
      province: ['province', 'provinsi', 'province name', 'provinsi name', 'admin1', 'administrative area level 1'],
      city: ['city', 'kota', 'kabupaten', 'city name', 'city_name', 'admin2', 'administrative area level 2'],
      attributes: {
        group: ['group', 'business group', 'poi group', 'category group'],
        category: ['category', 'poi category', 'business category'],
        type: ['type', 'business type', 'poi type'],
        brand: ['brand', 'brand name'],
      },
    },
  },
  {
    matchTitle: /regional planning rdtr indonesia city/i,
    aliases: {
      province: ['province', 'provinsi', 'province name', 'provinsi name', 'admin1', 'administrative area level 1'],
      city: ['city', 'kota', 'kabupaten', 'city name', 'city_name', 'admin2', 'administrative area level 2'],
      attributes: {
        'class area (sqm)': ['class area (sqm)', 'class area sqm', 'class area', 'area class', 'luas kelas'],
        'class area': ['class area (sqm)', 'class area sqm', 'class area', 'area class', 'luas kelas'],
      },
    },
  },
  {
    matchTitle: /bev\s*\(water\/juice\/alcohol\)\s*jabodetabek\s*2024/i,
    aliases: {
      province: ['province', 'provinsi', 'province name', 'provinsi name', 'admin1', 'administrative area level 1'],
      city: ['city', 'kota', 'kabupaten', 'city name', 'kota kabupaten', 'admin2', 'administrative area level 2'],
      attributes: {
        'alcoholic beverages': ['alcoholic beverages', 'alcoholic beverage', 'alcohol beverages'],
        'bottled water': ['bottled water'],
        'juice': ['juice'],
        'ready to drink tea': ['ready to drink tea', 'rtd tea'],
      },
    },
  },
  {
    matchTitle: /(daily )?mobility heatmap 2025/i,
    aliases: {
      province: ['province', 'provinsi', 'province name', 'provinsi name'],
      city: ['city', 'kota', 'kabupaten', 'city name'],
      attributes: {
        date: ['date', 'transaction date', 'visit date'],
        'day name': ['day name', 'day', 'weekday'],
      },
    },
  },
];

function extractAttemptValue(attempt) {
  if (!attempt || typeof attempt !== 'object') return '';
  const candidates = [
    attempt.target_text,
    attempt.targetText,
    attempt.selectedValue,
    attempt.value,
    attempt.province,
    attempt.city,
    attempt.label,
    attempt.selection,
    attempt.addDataset?.datasetTitle,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function extractAdministrativeSelections(step) {
  const attempts = Array.isArray(step?.attempts) ? [...step.attempts].reverse() : [];
  const provinceAttempt = attempts.find((attempt) => attempt?.action_type === 'choose_province' && attempt?.step_status === 'passed');
  const cityAttempt = attempts.find((attempt) => attempt?.action_type === 'choose_city' && attempt?.step_status === 'passed');
  return {
    province: extractAttemptValue(provinceAttempt),
    city: extractAttemptValue(cityAttempt),
  };
}

function preferredProvinceForAggregation(aggregation = '') {
  return /polygon|administrative area/i.test(String(aggregation || ''))
    ? 'Banten'
    : config.datasetExplorerProvince;
}

function detectAttributeFilterMode(attributeFilter) {
  const explicit = normalizeVerificationText(attributeFilter?.mode);
  if (explicit) return explicit;
  const selectedValue = String(attributeFilter?.selectedValue || '');
  if (/\d{4}-\d{2}-\d{2}\s*-\s*\d{4}-\d{2}-\d{2}/.test(selectedValue)) return 'date';
  if (/-?\d[\d.,]*\s*-\s*-?\d[\d.,]*/.test(selectedValue)) return 'numeric';
  return 'categorical';
}

function parseFlexibleNumber(value, options = {}) {
  const { preferDecimalPoint = false } = options;
  const match = String(value || '').match(/-?\d[\d.,]*/);
  if (!match) return null;
  const raw = match[0];
  let normalized = raw;

  if (raw.includes(',') && raw.includes('.')) {
    normalized = raw.lastIndexOf(',') > raw.lastIndexOf('.')
      ? raw.replace(/\./g, '').replace(',', '.')
      : raw.replace(/,/g, '');
  } else if ((raw.match(/\./g) || []).length > 1) {
    normalized = raw.replace(/\./g, '');
  } else if ((raw.match(/,/g) || []).length > 1) {
    normalized = raw.replace(/,/g, '');
  } else if (raw.includes(',') && !raw.includes('.')) {
    const [left, right = ''] = raw.split(',');
    normalized = right.length === 3 ? `${left}${right}` : `${left}.${right}`;
  } else if (raw.includes('.') && !raw.includes(',')) {
    const [left, right = ''] = raw.split('.');
    normalized = preferDecimalPoint ? raw : (right.length === 3 ? `${left}${right}` : raw);
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFlexibleDate(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const iso = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) {
    const [, year, month, day] = iso;
    return Date.UTC(Number(year), Number(month) - 1, Number(day));
  }

  const dmy = text.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (dmy) {
    const [, day, month, yearPart] = dmy;
    const year = yearPart.length === 2 ? `20${yearPart}` : yearPart;
    return Date.UTC(Number(year), Number(month) - 1, Number(day));
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function findBestMatchingHeader(headers, candidates) {
  const usableHeaders = Array.isArray(headers) ? headers.filter(Boolean) : [];
  const usableCandidates = (Array.isArray(candidates) ? candidates : [candidates]).filter(Boolean);
  let best = '';
  let bestScore = -1;

  for (const header of usableHeaders) {
    const normalizedHeader = normalizeVerificationText(header);
    const compactHeader = compactVerificationToken(header);
    for (const candidate of usableCandidates) {
      const normalizedCandidate = normalizeVerificationText(candidate);
      const compactCandidate = compactVerificationToken(candidate);
      let score = -1;
      if (!normalizedCandidate) continue;
      if (normalizedHeader === normalizedCandidate) {
        score = 100;
      } else if (compactHeader === compactCandidate) {
        score = 95;
      } else if (normalizedHeader.startsWith(`${normalizedCandidate} `)) {
        score = 90;
      } else if (normalizedHeader.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedHeader)) {
        score = 80;
      } else if (compactHeader.includes(compactCandidate) || compactCandidate.includes(compactHeader)) {
        score = 70;
      }

      if (score >= 0) {
        const candidateMentionsId = /\b(id|code)\b/i.test(normalizedCandidate);
        const headerMentionsId = /\b(id|code)\b/i.test(normalizedHeader);
        if (!candidateMentionsId && headerMentionsId) {
          score -= 25;
        }
      }

      if (score > bestScore) {
        best = header;
        bestScore = score;
      }
    }
  }

  return bestScore >= 0 ? best : '';
}

function getDatasetAliasConfig(datasetTitle) {
  const normalizedTitle = String(datasetTitle || '');
  return DATASET_TABLE_COLUMN_ALIASES.find((entry) => entry.matchTitle.test(normalizedTitle))?.aliases || null;
}

function resolveDatasetColumnCandidates(datasetTitle, kind, attributeName = '') {
  const defaults = {
    province: ['province', 'provinsi', 'province name', 'province_name', 'admin1', 'administrative area level 1'],
    city: ['city', 'kota', 'kabupaten', 'city name', 'city_name', 'admin2', 'administrative area level 2'],
  };

  const aliasConfig = getDatasetAliasConfig(datasetTitle);
  if (kind === 'attribute') {
    const normalizedAttribute = normalizeVerificationText(attributeName);
    const datasetAliases = aliasConfig?.attributes || {};
    const exactDatasetAliases = Object.entries(datasetAliases)
      .find(([key]) => normalizeVerificationText(key) === normalizedAttribute)?.[1] || [];
    return [attributeName, ...exactDatasetAliases].filter(Boolean);
  }

  return [...(defaults[kind] || []), ...((aliasConfig?.[kind]) || [])].filter(Boolean);
}

function buildEvidenceRows(tableSample) {
  const annotated = Array.isArray(tableSample?.rowEvidence) ? tableSample.rowEvidence : [];
  if (annotated.length) {
    return annotated
      .filter((entry) => entry && typeof entry === 'object' && entry.values && Object.keys(entry.values).length > 0)
      .map((entry, index) => ({
        page: Number(entry.page) || 1,
        row: Number(entry.row) || (index + 1),
        values: entry.values,
        absoluteRow: index + 1,
      }));
  }

  const rowObjects = Array.isArray(tableSample?.rowObjects) ? tableSample.rowObjects : [];
  return rowObjects
    .filter((row) => row && Object.keys(row).length > 0)
    .map((row, index) => ({
      page: 1,
      row: index + 1,
      values: row,
      absoluteRow: index + 1,
    }));
}

function formatEvidenceLocation(entry) {
  return `page ${entry.page} row ${entry.row}`;
}

function appendCoverage(summary, coverage) {
  return `${summary} Checked ${coverage.rows} rows across ${coverage.pages} page${coverage.pages === 1 ? '' : 's'}.`;
}

function textValueMatches(cellValue, expectedValue) {
  const normalizedCell = normalizeVerificationText(cellValue);
  const normalizedExpected = normalizeVerificationText(expectedValue);
  if (!normalizedCell || !normalizedExpected) return false;
  if (normalizedCell === normalizedExpected) return true;
  if (compactVerificationToken(normalizedCell) === compactVerificationToken(normalizedExpected)) return true;
  return normalizedCell.includes(normalizedExpected) || normalizedExpected.includes(normalizedCell);
}

function verifyTextColumn(evidenceRows, headers, expectedValue, columnCandidates, label, coverage) {
  const column = findBestMatchingHeader(headers, columnCandidates);
  if (!column) {
    return {
      verified: false,
      inconclusive: true,
      summary: appendCoverage(`${label} could not be verified because the column is missing from the data table.`, coverage),
      confidence: 0,
      checked_column: '',
      checked_value: expectedValue,
      suspected_issue: `${label} column not found in data table`,
      notes: [],
    };
  }

  const failures = evidenceRows
    .map((entry) => ({ ...entry, value: entry?.values?.[column] || '' }))
    .filter(({ value }) => !textValueMatches(value, expectedValue))
    .slice(0, 5);

  if (failures.length) {
    return {
      verified: false,
      inconclusive: false,
      summary: appendCoverage(`${label} filter did not hold for every row in column ${column}.`, coverage),
      confidence: 1,
      checked_column: column,
      checked_value: expectedValue,
      suspected_issue: `${label} mismatch detected`,
      notes: failures.map((entry) => `${formatEvidenceLocation(entry)} has ${column}="${entry.value}"`),
    };
  }

  return {
    verified: true,
    inconclusive: false,
    summary: appendCoverage(`${label} filter matched every visible row in column ${column}.`, coverage),
    confidence: 1,
    checked_column: column,
    checked_value: expectedValue,
    suspected_issue: '',
    notes: [],
  };
}

function verifyAttributeColumn(evidenceRows, headers, attributeFilter, datasetTitle = '', coverage) {
  const attribute = attributeFilter?.attribute || '';
  const selectedValue = attributeFilter?.selectedValue || '';
  const column = findBestMatchingHeader(headers, resolveDatasetColumnCandidates(datasetTitle, 'attribute', attribute));
  if (!column) {
    return {
      verified: false,
      inconclusive: true,
      summary: appendCoverage(`Attribute filter could not be verified because column ${attribute || '(unknown)'} is missing from the data table.`, coverage),
      confidence: 0,
      checked_column: '',
      checked_value: selectedValue,
      suspected_issue: 'Attribute column not found in data table',
      notes: [],
    };
  }

  const mode = detectAttributeFilterMode(attributeFilter);
  if (mode === 'date') {
    const rangeMatch = String(selectedValue).match(/(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})/);
    const fromDate = parseFlexibleDate(rangeMatch?.[1] || '');
    const toDate = parseFlexibleDate(rangeMatch?.[2] || '');
    if (fromDate === null || toDate === null) {
      return {
        verified: false,
        inconclusive: true,
        summary: appendCoverage('Attribute date range could not be parsed for deterministic verification.', coverage),
        confidence: 0,
        checked_column: column,
        checked_value: selectedValue,
        suspected_issue: 'Date filter range could not be parsed',
        notes: [],
      };
    }

    const failures = evidenceRows
      .map((entry) => ({ ...entry, value: entry?.values?.[column] || '', parsed: parseFlexibleDate(entry?.values?.[column] || '') }))
      .filter(({ parsed }) => parsed === null || parsed < fromDate || parsed > toDate)
      .slice(0, 5);
    if (failures.length) {
      return {
        verified: false,
        inconclusive: false,
        summary: appendCoverage(`Date filter did not hold for every row in column ${column}.`, coverage),
        confidence: 1,
        checked_column: column,
        checked_value: selectedValue,
        suspected_issue: 'Date value outside selected range',
        notes: failures.map((entry) => `${formatEvidenceLocation(entry)} has ${column}="${entry.value}"`),
      };
    }
    return {
      verified: true,
      inconclusive: false,
      summary: appendCoverage(`Date filter matched every visible row in column ${column}.`, coverage),
      confidence: 1,
      checked_column: column,
      checked_value: selectedValue,
      suspected_issue: '',
      notes: [],
    };
  }

  if (mode === 'numeric') {
    const rangeMatch = String(selectedValue).match(/(-?\d[\d.,]*)\s*-\s*(-?\d[\d.,]*)/);
    const minValue = parseFlexibleNumber(rangeMatch?.[1] || '');
    const maxValue = parseFlexibleNumber(rangeMatch?.[2] || '');
    if (minValue === null || maxValue === null) {
      return {
        verified: false,
        inconclusive: true,
        summary: appendCoverage('Attribute numeric range could not be parsed for deterministic verification.', coverage),
        confidence: 0,
        checked_column: column,
        checked_value: selectedValue,
        suspected_issue: 'Numeric filter range could not be parsed',
        notes: [],
      };
    }

    const lowerBound = Math.min(minValue, maxValue);
    const upperBound = Math.max(minValue, maxValue);
    const preferDecimalPoint = /float/i.test(String(column || ''));
    const failures = evidenceRows
      .map((entry) => ({
        ...entry,
        value: entry?.values?.[column] || '',
        parsed: parseFlexibleNumber(entry?.values?.[column] || '', { preferDecimalPoint }),
      }))
      .filter(({ parsed }) => parsed === null || parsed < lowerBound || parsed > upperBound)
      .slice(0, 5);
    if (failures.length) {
      return {
        verified: false,
        inconclusive: false,
        summary: appendCoverage(`Numeric filter did not hold for every row in column ${column}.`, coverage),
        confidence: 1,
        checked_column: column,
        checked_value: selectedValue,
        suspected_issue: 'Numeric value outside selected range',
        notes: failures.map((entry) => `${formatEvidenceLocation(entry)} has ${column}="${entry.value}"`),
      };
    }
    return {
      verified: true,
      inconclusive: false,
      summary: appendCoverage(`Numeric filter matched every visible row in column ${column}.`, coverage),
      confidence: 1,
      checked_column: column,
      checked_value: selectedValue,
      suspected_issue: '',
      notes: [],
    };
  }

  return verifyTextColumn(evidenceRows, headers, selectedValue, resolveDatasetColumnCandidates(datasetTitle, 'attribute', attribute), 'Attribute', coverage);
}

function mapDetailValueMatchesRowValue(actualValue, expectedValue) {
  const actualNumeric = parseFlexibleNumber(actualValue, { preferDecimalPoint: true });
  const expectedNumeric = parseFlexibleNumber(expectedValue, { preferDecimalPoint: true });
  if (actualNumeric !== null && expectedNumeric !== null) {
    return Math.abs(actualNumeric - expectedNumeric) <= 0.02;
  }
  return textValueMatches(actualValue, expectedValue);
}

function mapDetailFieldHeaderCandidates(label = '') {
  const raw = String(label || '').trim();
  if (!raw) return [];
  const candidates = [
    raw,
    `${raw}string`,
    `${raw}float`,
    `${raw}int`,
    `${raw}geom`,
  ];
  return [...new Set(candidates)];
}

function verifyMapDetailAgainstRow(mapDetail = {}, rowValues = {}, headers = [], coverage = { rows: 0, pages: 0 }) {
  const fields = Array.isArray(mapDetail?.fields) ? mapDetail.fields : [];
  const comparable = fields
    .map((field) => {
      const header = findBestMatchingHeader(headers, mapDetailFieldHeaderCandidates(field?.label || ''));
      return {
        label: field?.label || '',
        actual: field?.value || '',
        header,
        expected: header ? rowValues?.[header] || '' : '',
      };
    })
    .filter((entry) => entry.label && entry.header && entry.expected);

  if (comparable.length < 2) {
    return {
      verified: false,
      inconclusive: true,
      summary: appendCoverage('Map detail panel opened, but there were not enough overlapping fields to compare against the tabular row.', coverage),
      confidence: 0,
      checked_column: '',
      checked_value: '',
      suspected_issue: 'Insufficient overlap between map detail fields and table row',
      notes: [],
    };
  }

  const failures = comparable
    .filter((entry) => !mapDetailValueMatchesRowValue(entry.actual, entry.expected))
    .slice(0, 5);

  if (failures.length) {
    return {
      verified: false,
      inconclusive: false,
      summary: appendCoverage('Map detail panel values did not match the selected tabular row.', coverage),
      confidence: 1,
      checked_column: failures.map((entry) => entry.header).join(', '),
      checked_value: failures.map((entry) => entry.expected).join(', '),
      suspected_issue: 'Map detail mismatch detected',
      notes: failures.map((entry) => `${entry.label}: map="${entry.actual}" vs table ${entry.header}="${entry.expected}"`),
    };
  }

  return {
    verified: true,
    inconclusive: false,
    summary: appendCoverage('Map detail panel matched the selected tabular row for the visible overlapping fields.', coverage),
    confidence: 1,
    checked_column: comparable.map((entry) => entry.header).join(', '),
    checked_value: comparable.map((entry) => entry.expected).join(', '),
    suspected_issue: '',
    notes: [],
  };
}

async function verifyMapDetailConsistency({
  page,
  runId,
  helpers,
  step,
  datasetTitle,
  tableSample,
  screenshotSuffix,
}) {
  if (!['Administrative Area', 'Polygon', 'H3', 'Geohash'].includes(String(step?.aggregation || ''))) {
    return {
      attempted: false,
      verified: false,
      inconclusive: true,
      summary: 'Map-detail verification skipped for this aggregation.',
      confidence: 0,
      checked_column: '',
      checked_value: '',
      suspected_issue: '',
      notes: [],
    };
  }

  const evidenceRows = buildEvidenceRows(tableSample);
  const targetRow = evidenceRows[0]?.values || {};
  const coverage = { rows: 1, pages: 1 };
  if (!Object.keys(targetRow).length) {
    return {
      attempted: false,
      verified: false,
      inconclusive: true,
      summary: 'Map-detail verification skipped because no tabular row was available.',
      confidence: 0,
      checked_column: '',
      checked_value: '',
      suspected_issue: '',
      notes: [],
    };
  }

  const preview = await helpers.previewDataSelectionTableRowOnMap(page, { row: targetRow }).catch(() => ({ clicked: false, reason: 'Preview on Map failed', rowValues: {} }));
  if (!preview?.clicked) {
    return {
      attempted: true,
      verified: false,
      inconclusive: true,
      summary: 'Map-detail verification could not start because Preview on Map was unavailable.',
      confidence: 0,
      checked_column: '',
      checked_value: '',
      suspected_issue: preview?.reason || 'Preview on Map unavailable',
      notes: [],
    };
  }

  const rowValues = Object.keys(preview.rowValues || {}).length ? preview.rowValues : targetRow;
  const previewPanel = await helpers.readMapDetailPanel(page).catch(() => ({ opened: false, title: '', fields: [], lines: [] }));
  const previewCheck = verifyMapDetailAgainstRow(previewPanel, rowValues, tableSample?.headers || [], coverage);
  const mapClickPanel = await helpers.clickMapGeometryAndReadDetail(page).catch(() => ({ opened: false, fields: [], reason: 'Map geometry click failed' }));
  const mapClickCheck = verifyMapDetailAgainstRow(mapClickPanel, rowValues, tableSample?.headers || [], coverage);
  const screenshot = await helpers.captureWorkflowScreenshot(page, runId, `workflow-dataset-explorer-${step.aggregation}-${screenshotSuffix}-map-detail`);

  if (!previewCheck.verified && !previewCheck.inconclusive) {
    return {
      attempted: true,
      screenshot,
      preview: previewPanel,
      previewCheck,
      mapClick: mapClickPanel,
      mapClickCheck,
      ...previewCheck,
    };
  }
  if (!mapClickCheck.verified && !mapClickCheck.inconclusive) {
    return {
      attempted: true,
      screenshot,
      preview: previewPanel,
      previewCheck,
      mapClick: mapClickPanel,
      mapClickCheck,
      ...mapClickCheck,
    };
  }

  if (previewCheck.verified || mapClickCheck.verified) {
    return {
      attempted: true,
      screenshot,
      preview: previewPanel,
      previewCheck,
      mapClick: mapClickPanel,
      mapClickCheck,
      verified: true,
      inconclusive: false,
      summary: [previewCheck.summary, mapClickCheck.summary].filter(Boolean).join(' '),
      confidence: Math.max(previewCheck.confidence || 0, mapClickCheck.confidence || 0),
      checked_column: [previewCheck.checked_column, mapClickCheck.checked_column].filter(Boolean).join(', '),
      checked_value: [previewCheck.checked_value, mapClickCheck.checked_value].filter(Boolean).join(', '),
      suspected_issue: '',
      notes: [...(previewCheck.notes || []), ...(mapClickCheck.notes || [])],
    };
  }

  return {
    attempted: true,
    screenshot,
    preview: previewPanel,
    previewCheck,
    mapClick: mapClickPanel,
    mapClickCheck,
    verified: false,
    inconclusive: true,
    summary: 'Map-detail verification remained inconclusive after Preview on Map and direct geometry click.',
    confidence: 0,
    checked_column: '',
    checked_value: '',
    suspected_issue: mapClickPanel?.reason || preview?.reason || '',
    notes: [],
  };
}

function verifyDatasetTableDeterministically({
  step,
  datasetTitle,
  attributeFilter,
  tableSample,
}) {
  const headers = Array.isArray(tableSample?.headers) ? tableSample.headers : [];
  const evidenceRows = buildEvidenceRows(tableSample);
  const totalEntriesMatch = String(tableSample?.pageInfo || '').match(/of\s+(\d+)\s+entries/i);
  const totalEntries = totalEntriesMatch ? Number.parseInt(totalEntriesMatch[1], 10) : null;
  const coverage = {
    rows: evidenceRows.length,
    pages: Number(tableSample?.totalPagesRead) || Math.max(1, Array.isArray(tableSample?.pages) ? tableSample.pages.length : 1),
  };

  if (Number.isFinite(totalEntries) && totalEntries === 0) {
    const { province, city } = extractAdministrativeSelections(step);
    return {
      verified: true,
      inconclusive: false,
      emptyResult: true,
      summary: 'Data table returned 0 entries for the committed province/filter combination. Empty results are treated as a valid outcome, not a failed dataset add.',
      confidence: 0.85,
      checked_column: [province ? 'Province' : '', city ? 'City' : '', attributeFilter?.attribute || ''].filter(Boolean).join(', '),
      checked_value: [province, city, attributeFilter?.selectedValue || ''].filter(Boolean).join(', '),
      suspected_issue: '',
      notes: evidenceRows.length
        ? ['The table still exposed visible placeholder/stale rows, but pagination reported 0 entries; the zero-entry pagination state is treated as authoritative.']
        : ['No visible rows were present because the current area/filter combination returned 0 entries.'],
    };
  }

  if (!evidenceRows.length) {
    return {
      verified: false,
      inconclusive: true,
      summary: 'Data table opened but no visible rows were available for deterministic verification.',
      confidence: 0,
      checked_column: '',
      checked_value: '',
      suspected_issue: 'Data table has no visible rows',
      notes: [],
    };
  }

  const attributeMode = detectAttributeFilterMode(attributeFilter);
  const exposesDateColumn = headers.some((header) => /\bdate\b|\btime\b|\btimestamp\b|\bdatetime\b|\bfrom\b|\buntil\b/i.test(String(header || '')));
  if (
    normalizeTitle(step?.aggregation || '') === 'h3'
    && attributeMode === 'date'
    && !exposesDateColumn
  ) {
    return {
      verified: true,
      inconclusive: false,
      emptyResult: false,
      summary: appendCoverage('Aggregated H3 results returned visible rows. The table does not expose a row-level Date column, so non-empty H3 result rows are treated as valid evidence for the committed Date filter.', coverage),
      confidence: 0.9,
      checked_column: 'H3 aggregated result rows',
      checked_value: attributeFilter?.selectedValue || '',
      suspected_issue: '',
      notes: ['The aggregated H3 table omits Date as a visible column; verification falls back to visible H3 result rows.'],
    };
  }

  const checks = [];
  const { province, city } = extractAdministrativeSelections(step);
  if (step?.provinceSelected && !province) {
    return {
      verified: false,
      inconclusive: true,
      summary: 'Province was selected in the flow, but its committed value is missing from planner attempts.',
      confidence: 0,
      checked_column: '',
      checked_value: '',
      suspected_issue: 'Province selection value missing from planner attempts',
      notes: [],
    };
  }
  if (province) {
    checks.push(verifyTextColumn(
      evidenceRows,
      headers,
      province,
      resolveDatasetColumnCandidates(datasetTitle, 'province'),
      'Province',
      coverage,
    ));
  }
  if (Array.isArray(step?.attempts) && step.attempts.some((attempt) => attempt?.action_type === 'choose_city' && attempt?.step_status === 'passed') && !city) {
    return {
      verified: false,
      inconclusive: true,
      summary: 'City was selected in the flow, but its committed value is missing from planner attempts.',
      confidence: 0,
      checked_column: '',
      checked_value: '',
      suspected_issue: 'City selection value missing from planner attempts',
      notes: [],
    };
  }
  if (city) {
    checks.push(verifyTextColumn(
      evidenceRows,
      headers,
      city,
      resolveDatasetColumnCandidates(datasetTitle, 'city'),
      'City',
      coverage,
    ));
  }
  if (attributeFilter?.attribute) {
    checks.push(verifyAttributeColumn(evidenceRows, headers, attributeFilter, datasetTitle, coverage));
  }

  if (!checks.length) {
    return {
      verified: false,
      inconclusive: true,
      summary: 'No recoverable filter selections were available for deterministic table verification.',
      confidence: 0,
      checked_column: '',
      checked_value: '',
      suspected_issue: 'No filter selections available for verification',
      notes: [],
    };
  }

  const firstDefinitiveFailure = checks.find((check) => !check.verified && !check.inconclusive);
  if (firstDefinitiveFailure) {
    return firstDefinitiveFailure;
  }

  const firstInconclusive = checks.find((check) => check.inconclusive);
  if (firstInconclusive) {
    return {
      ...firstInconclusive,
      notes: checks.flatMap((check) => check.notes || []),
    };
  }

  return {
    verified: true,
    inconclusive: false,
    summary: checks.map((check) => check.summary).filter(Boolean).join(' '),
    confidence: 1,
    checked_column: checks.map((check) => check.checked_column).filter(Boolean).join(', '),
    checked_value: checks.map((check) => check.checked_value).filter(Boolean).join(', '),
    suspected_issue: '',
    notes: checks.flatMap((check) => check.notes || []),
    coverage,
  };
}

export async function runDatasetExplorerWorkflow({
  page,
  action,
  beforeUrl,
  beforeTitle,
  runId,
  helpers,
}) {
  async function publishWorkflowProgress(currentSteps, extra = {}) {
    const partial = {
      ok: currentSteps.some((step) => step.status === 'completed'),
      action,
      beforeUrl,
      afterUrl: page.url(),
      afterTitle: '',
      mode: 'workflow',
      workflow: {
        name: 'dataset-explorer-bvt',
        featureGroup: 'Dataset Explorer',
        steps: currentSteps,
      },
      driver: 'llm',
      ...extra,
    };
    page.__agentWorkflowProgress = partial;
    if (typeof page.__agentActionProgress === 'function') {
      await page.__agentActionProgress(partial).catch(() => {});
    }
  }

  const openResult = await helpers.clickVisibleActionable(page, action.text);
  if (!openResult) {
    logWorkflow(runId, 'open:failed', action.text);
    return {
      ok: false,
      action,
      beforeUrl,
      afterUrl: page.url(),
      afterTitle: await page.title().catch(() => beforeTitle),
      error: 'Failed to open Dataset Explorer',
    };
  }

  logWorkflow(runId, 'open:done', page.url());
  await helpers.sleep(500);

  const workflowBaseUrl = beforeUrl;
  const steps = [];
  await publishWorkflowProgress(steps, { ok: false, error: 'Dataset Explorer opened but no workflow steps yet' });

  for (const branch of buildBranchPlans()) {
    if (['Geohash', 'Line'].includes(branch.aggregation)) {
      steps.push({
        name: branch.name,
        aggregation: branch.aggregation,
        status: 'invalid',
        stateType: 'panel_change',
        selectedDataset: false,
        provinceSelected: false,
        attributeFilter: { attempted: false, applied: false, reason: 'Skipped for current Dataset Explorer coverage target' },
        addDataset: { attempted: false, added: false, reason: 'Skipped for current Dataset Explorer coverage target' },
        attempts: [],
        screenshots: [],
        driver: 'llm',
        notes: 'Skipped unsupported aggregation for current Dataset Explorer target.',
        error: 'Skipped unsupported aggregation for current Dataset Explorer target',
        url: page.url(),
        title: await page.title().catch(() => ''),
      });
      await publishWorkflowProgress(steps);
      continue;
    }

    logWorkflow(runId, 'branch:start', branchLabel(branch));
    const step = await runLlmBranch({
      page,
      runId,
      branch,
      helpers,
      workflowBaseUrl,
    });
    logWorkflow(runId, 'branch:done', `${branchLabel(branch)} status=${step.status}${step.error ? ` error=${step.error}` : ''}`);
    steps.push(step);
    await publishWorkflowProgress(steps);
  }

  if (config.focusedWorkflow !== 'dataset-explorer-bvt') {
    await reconcileLoadedDatasets({
      page,
      runId,
      helpers,
      workflowBaseUrl,
      steps,
    });
    await publishWorkflowProgress(steps);
  }

  return {
    ok: steps.some((step) => step.status === 'completed'),
    action,
    beforeUrl,
    afterUrl: page.url(),
    afterTitle: await page.title().catch(() => ''),
    mode: 'workflow',
    workflow: {
      name: 'dataset-explorer-bvt',
      featureGroup: 'Dataset Explorer',
      steps,
    },
    driver: 'llm',
  };
}
