import OpenAI from 'openai';
import { config } from './config.js';
import {
  PAGE_ANALYSIS_SCHEMA,
  DIFF_REVIEW_SCHEMA,
  GUIDED_ACTIONS_SCHEMA,
  DATASET_FILTER_VERIFICATION_SCHEMA,
  DATASET_TITLE_ALIAS_SCHEMA,
} from './schemas.js';
import { safeJsonParse, withTimeout } from './utils.js';

let client = null;

function getClient() {
  if (!config.openAIApiKey) return null;
  if (!client) {
    client = new OpenAI({ apiKey: config.openAIApiKey });
  }
  return client;
}

async function callStructuredJson({ instructions, input, schema, fallback }) {
  const sdk = getClient();
  if (!sdk) return fallback;

  try {
    const response = await withTimeout(
      () => sdk.responses.create({
        model: config.model,
        instructions,
        input,
        text: {
          verbosity: 'low',
          format: {
            type: 'json_schema',
            name: schema.name,
            schema: schema.schema,
            strict: true,
          },
        },
        store: false,
      }),
      config.llmTimeoutMs,
      `LLM ${schema.name}`,
    );

    const parsed = safeJsonParse(response.output_text, null);
    return parsed || fallback;
  } catch (error) {
    return {
      ...fallback,
      _llm_error: error instanceof Error ? error.message : String(error),
    };
  }
}

function pageAnalysisInstructions() {
  return [
    'You are analyzing a web application page for QA regression memory.',
    'Your job is to infer what the visible page is for, what product features are exposed, and what future regression checks matter most.',
    'Use only visible evidence from the provided snapshot.',
    'Do not invent hidden APIs, permissions, or flows.',
    'Return concise operator-facing reasoning fields, not hidden chain-of-thought.',
    'Candidate actions should be concrete next checks an exploratory agent could perform from this page.',
    'Prioritize actions that validate the core business workflow over cosmetic controls.',
  ].join(' ');
}

function guidedActionInstructions(payload) {
  const workflow = String(payload?.workflow || '').toLowerCase();

  if (workflow.includes('dataset-explorer-recheck')) {
    return [
      'You are helping a QA agent reconcile expected datasets versus the datasets actually loaded into the Analysis > Data Selection panel.',
      'The agent has already tried to add a specific dataset and now needs to decide whether to retry, diagnose a false positive, or stop.',
      'Treat Analysis > Data Selection as the only source of truth for whether a dataset is really loaded.',
      'Do not use Dataset Explorer card visibility as proof that a dataset is loaded.',
      'If the expected dataset is missing from the loaded list, prefer retry guidance that reopens Dataset Explorer, searches for the exact dataset, re-selects province, reapplies attribute filter, and verifies the dataset appears in Data Selection.',
      'If the dataset is loaded into Data Selection but the data table reports 0 entries, treat that as a valid empty-result outcome first, not an add-flow failure.',
      'If a loaded dataset yields 0 entries and the UI exposes an edit control on the dataset card, prefer editing the existing filter from Data Selection before recommending a full reset.',
      'For Polygon or Administrative Area datasets, if one province/filter combination yields 0 entries or no visible geometry, prefer retry guidance that changes province to a plausible covered province such as Banten before declaring the dataset broken.',
      'If the dataset may have loaded under a shortened label, say so explicitly in suspected_issue.',
      'Recommend retry_recommended=true only when there is a reasonable safe retry path.',
      'Each action must be a safe visible UI action using the executable schema: action_type, target_text, input_text, expected_signal, rationale, and priority.',
      'Use only the Dataset Explorer action types from the whitelist in the payload.',
      'Do not suggest destructive actions.',
    ].join(' ');
  }

  if (workflow.includes('dataset-explorer')) {
    return [
      'You are the guarded planner for the Dataset Explorer workflow in Lokasi.',
      'Plan one small next UI action at a time for Dataset Explorer only. Do not drift into unrelated features.',
      'This controller must cover the visible Dataset Explorer surface: search, source-mode toggle, pagination, preview, aggregation selection, dataset selection, province selection, attribute filter, Add Dataset, and final loaded-state verification.',
      'Reason from the provided branch goal, recent action history, visible state, active dataset selection, loaded dataset titles, and visible blockers.',
      'Candidate datasets may include locked entries. Treat lock indicators and candidate.locked=true as source-of-truth that a card should not be used for add-flow coverage.',
      'If only locked datasets are visible for an aggregation, classify the branch as blocked instead of selecting them.',
      'Prefer unlocked candidates over locked ones whenever both are visible.',
      'Treat visible committed state as the source of truth. Do not assume a click means success.',
      'For add-flow branches in this phase, success means the dataset was selected, province/filter preconditions were handled, and add_dataset completed without an immediate UI failure.',
      'Do not loop on per-branch committed-state checks inside Dataset Explorer after add_dataset. Move on to the next aggregation branch and let the dedicated batch post-add verification validate Analysis/Data Selection later.',
      'For preview branches, success requires preview evidence such as a table, preview title, or search/filter UI, not just the button click.',
      'For filter branches, success requires visible filter state or an observable state change, not merely an enabled button.',
      'If Add Dataset is disabled, do not guess. Check prerequisites in order: dataset card selected, province committed (if shown), attribute filter value committed (if required), then Add Dataset enabled.',
      'Do not suggest add_dataset while attribute-filter input is still in-progress (e.g., filter form open, Save visible but disabled, value chips not committed).',
      'Treat "attribute chosen but value not committed" as incomplete. Continue filling/selecting filter value(s) first.',
      'For all aggregation branches, do not move to add_dataset until dataset selection is active and required area/filter prerequisites are visibly committed.',
      'Do not suggest close_preview as a recovery for disabled Add Dataset. Closing the modal can reset branch context; prefer fixing missing prerequisites in the current panel.',
      'When attribute filter save is disabled, keep working inside attribute-filter controls (choose value, checkbox, min/max if truly numeric) before switching aggregation/source or proposing unrelated recovery.',
      'If one chosen attribute has no selectable values (for example "Options Not Found" or selected options 0 of 0), the executor will automatically try the next available attribute in the dropdown. Do not suggest switching dataset just because one attribute failed.',
      'When all categorical attributes fail (no options or Save stays disabled), the executor will fall back to numeric attributes with min/max range inputs. This is expected behavior for H3, Polygon, and Administrative Area datasets.',
      'Province choice materially affects data availability for Polygon and Administrative Area datasets. Do not default blindly to Jakarta-like provinces when evidence suggests the dataset may be empty there.',
      'For Polygon and Administrative Area datasets, prefer a province with likely coverage. Banten is a good fallback when the default province yields empty results or no visible geometry.',
      'For H3 datasets, prefer adjusting the existing attribute filter before changing the entire flow or resetting the dataset.',
      'For H3 mobility datasets whose titles reference 2025, if a Date filter over 2025 yields 0 entries, retry the same Date filter with a 2026 range before abandoning the dataset.',
      'If an H3 mobility dataset becomes non-empty only after shifting the Date filter from 2025 to 2026, treat that as a valid recovery and continue from the edited dataset.',
      'For Administrative Area datasets, treat naming patterns like City, District, and Village as coverage depth signals. Village is typically denser than District, and District is denser than City.',
      'If an Administrative Area dataset at City level becomes empty or too thin after filtering, prefer switching to a more granular District or Village dataset before concluding the filters are invalid.',
      'When applying an attribute filter, prefer a real semantic filter such as Type, Brand, Category, Group, Service Level, Day Name, City, Province, or another categorical business field.',
      'If categorical attributes are exhausted, numeric attributes like Unique Device Count, Total, Area, Radius, or Distance are acceptable fallbacks. Fill the Minimum and Maximum fields with realistic values.',
      'For numeric min/max attributes (like count, distance, area), use realistic ranges: count/device/total use 100-10000, distance/radius use 100-1000, area/sqm use 100-100000. Ensure both min and max are filled.',
      'If numeric range filter Save stays disabled, try clicking "Include Nulls" checkbox as a workaround before giving up on the attribute.',
      'Avoid weak placeholder filters such as IDs, codes, or raw measurements unless categorical options are unavailable.',
      'For the filter value itself, prefer a realistic user-like visible option, not an arbitrary checkbox position and not a synthetic minimum like 1 unless that is the only workable numeric path.',
      'Prefer concrete visible values over placeholders such as All, Undefined, Unspecified, or empty selections.',
      'If only weak numeric filters are available, say so explicitly in suspected_issue instead of pretending the filter coverage is strong.',
      'If you observe limits or behavior boundaries, such as preview row windows or truncated data, mention them explicitly in suspected_issue or progress_assessment instead of skipping them.',
      'If post-add evidence later shows 0 entries in the data table or no visible map geometry, interpret that first as a likely over-restrictive province/filter combination rather than a failed add_dataset action.',
      'For area-based and grid datasets, after the data table is verified, prefer one consistency check that compares a sampled table row against the map detail panel.',
      'Preview on Map is a reliable way to center the intended geometry before clicking it directly on the map.',
      'For map-versus-table consistency, prioritize overlapping fields such as City Name, City Code, Province Name, Province Code, and visible business metrics.',
      'Do not call the map inconsistent unless the right-side map detail panel clearly contradicts the sampled table row on overlapping fields.',
      'When a dataset is already committed in Data Selection, prefer editing the existing dataset filter over removing the dataset and starting the add flow from scratch.',
      'For Administrative Area recovery, consider whether the chosen dataset title indicates a shallow coverage level such as City; if so, a deeper District or Village dataset may be a better verification target.',
      'Use only these whitelisted action types: search_dataset, toggle_source_mode, paginate, select_aggregation, select_dataset, choose_province, apply_attribute_filter, open_preview, close_preview, add_dataset, dismiss_modal, verify_state.',
      'Every suggested action must include action_type, target_text, input_text, expected_signal, rationale, and priority.',
      'Keep each step reversible and safe. Do not suggest destructive actions.',
      'When a control is sticky, prefer bounded retries on the same control before giving up. Do not repeat the exact same ineffective action indefinitely.',
      'If Dataset Explorer closes or state resets after add_dataset, reopen and continue with the next planned branch instead of re-running the same branch verification loop.',
      'If one candidate hits a pre-add issue, stay on the same candidate first: retry the failing control, or dismiss in-progress filter editor and continue; switch to next unlocked candidate only after bounded retries fail.',
      'Do not recommend source-filter toggles (e.g., partner checkboxes) unless there is explicit evidence that the current candidate list is exhausted; never use source toggles as a substitute for unfinished filter input.',
      'Classify branches clearly as passed, blocked, invalid, or partial based on visible evidence.',
      'Recommend retry_recommended=true only when there is a safe visible retry path within Dataset Explorer.',
      'Use stop_reason to say why the branch should stop when no useful next action remains.',
    ].join(' ');
  }

  if (workflow.includes('spatial-analysis')) {
    return [
      'You are helping a QA exploration agent continue the Spatial Analysis workflow in Lokasi.',
      'Treat Spatial Analysis as a gated workflow and a coverage matrix, not a single happy path.',
      'Think like a QA analyst diagnosing a multi-step configuration wizard: identify exactly which prerequisite is satisfied, which one is missing, and which one only appears satisfied but is not yet committed.',
      'The important input dimensions are: Define by, Output mode, Output type, resolution, area input requirements, and dataset count.',
      'The critical visible prerequisites are: Filter Area, Data Selection, Spatial Settings, Define by, Output Analysis, and Generate Results.',
      'For every case, reason in this order: Filter Area -> Data Selection dataset attached -> Spatial Settings expanded -> Define by committed -> area-input summary committed -> output mode/type committed -> resolution committed if applicable -> Generate Results actually actionable -> result surface visible.',
      'Do not skip ahead to result validation if an earlier prerequisite is still weak or only partially visible.',
      'Treat map-side utility controls such as recenter, zoom, basemap, and the standalone draw button as secondary unless the current workflow explicitly requires them.',
      'Inside Spatial Settings, explicitly reason about Define by and its options such as Administrative Area, Polygon, and Catchment.',
      'If the current Define by value does not read back as the intended value, treat that as a sticky-control failure, not a completed selection.',
      'If polygon input is needed, prefer the in-panel path: Spatial Settings -> Define by -> Polygon -> Set Polygon Area. Do not default to side-map controls unless the workflow explicitly says to do so.',
      'If catchment input is needed, prefer the visible in-panel Catchment flow. In this UI the usual path is Define by -> Catchment -> Set Catchment -> Location -> Search Place -> choose a suggestion or add the location as a marker -> set radius/road access -> Save.',
      'For catchment, success is not just a visible modal. Confirm that a marker was actually added or that the saved Spatial Settings summary card shows Coordinate, Catchment Type, and Radius before treating the catchment input as configured.',
      'If the catchment search says Cannot find place, treat that as a concrete blocker in suspected_issue rather than describing the whole catchment flow as generic failure.',
      'If the location search fails but a coordinate/manual fallback is available and visible, recommend that fallback explicitly before giving up.',
      'Inside Output Analysis, read the visible option labels and descriptions to infer the differences between modes and when each should be used. Use only the visible descriptions; do not invent hidden semantics.',
      'Availability can be dynamic. A missing or disabled option is not automatically a bug.',
      'Some controls are sticky or flaky: a visible option can appear in the dropdown but fail to commit into the control value on the first click.',
      'When a selection does not commit, do not fail immediately. Prefer a safe retry pattern: reopen the same control, click the same option again, try a different clickable part of the same option row, then verify whether the field value changed.',
      'If a control value still does not change after a few safe retries, describe that as a sticky-control blocker rather than a missing DOM blocker.',
      'Resolution options may be constrained by the current combination. If a preferred resolution is disabled or unavailable, inspect the enabled options and choose the highest enabled valid option instead of failing immediately.',
      'Apply the same reasoning to other dynamic controls: if one visible option is disabled but alternative enabled options exist, continue with a valid enabled option and record the fallback clearly.',
      'For Profiling cases, do not assume output type or resolution are required unless the visible UI still shows them as active required inputs. If Profiling changes the required inputs, describe that difference explicitly.',
      'When a case uses Grid, check whether output type and resolution still apply. When a case uses Profiling, check whether the output-type radios or resolution controls disappear, remain optional, or stay required.',
      'When reasoning about progress, prefer systematic coverage: identify which combinations have already been exercised, which ones are still untested, which ones are blocked by prerequisites, and which ones appear invalid by product rules.',
      'Do not assume Generate Results is ready just because the button is visible; inspect whether inputs are still missing or a prerequisite panel is collapsed.',
      'Treat a visible Generate Results button as insufficient. Prefer wording like ready only when the current case inputs are visibly committed and no area/resolution error is shown.',
      'If a step fails, explain which precondition is still missing in suspected_issue.',
      'Differentiate these cases clearly: option missing from dropdown, option visible but disabled, option visible and clicked but value did not persist, and downstream prerequisite still missing after selection.',
      'Also differentiate these result states clearly: submitted but result cards not yet visible, dataset card visible without result card, result card visible without dataset card, and full result surface verified.',
      'Prefer guidance that reveals current UI state: expand Spatial Settings, inspect Define by, confirm area-input requirements, inspect Output Analysis choices and descriptions, confirm dataset attachment, and verify whether Generate Results is enabled or still gated.',
      'Use Data Selection as the source of truth for whether a dataset is actually attached to the analysis.',
      'For result validation, the trusted visible signals are: Analysis Result panel, spatial analysis result card, expected dataset card, and Edit Input link. If these are missing, explain exactly which ones are missing.',
      'When the result screen is visible, verify the result state explicitly before trying to return to inputs: Analysis Result panel exists, the spatial analysis result card exists, the expected dataset card exists, and Edit Input is visible.',
      'If Edit Input is clicked and an Unsaved Changes confirmation appears, choose Leave and then verify the full input form is back before continuing.',
      'If the Analysis Result panel is not fully verified, do not claim that Edit Input should have been usable yet.',
      'Analysis Job Queue is secondary for the current MVP. Prefer result-card validation first. Only mention queue data if it is visible and useful as supporting evidence.',
      'If queue data is used, treat only dataset count, define-by mode, and output mode as stable. Ignore random job ids, timestamps, and transient status text.',
      'Use visible evidence only; do not invent backend behavior.',
      'When a case is blocked, distinguish between: blocked by missing prerequisite, blocked by incomplete result-to-input transition, blocked because only disabled choices are available, and invalid by product rules.',
      'When a case is partial, explain exactly what was achieved and what visible signal is still missing. Avoid vague summaries like not fully verified.',
      'When you recommend a retry, make it specific to the failing control or panel instead of suggesting a full restart unless the whole surface is degraded.',
      'Recommend retry_recommended=true only when there is a safe, visible retry path.',
      'Do not suggest destructive actions.',
      'Each action must be a safe visible UI action with target_text and expected_signal.',
    ].join(' ');
  }

  return [
    'You are helping a QA exploration agent continue a partially completed workflow.',
    'Suggest only safe visible next actions that are likely to make progress.',
    'Prefer reversible actions and avoid destructive operations.',
    'Summarize current progress, suspected blocker, whether a retry is recommended, and why.',
    'Each suggested action must use the executable action schema: action_type, target_text, input_text, expected_signal, rationale, and priority.',
  ].join(' ');
}

export async function analyzePage(pageSnapshot) {
  const fallback = {
    page_name: pageSnapshot.title || pageSnapshot.url,
    purpose: 'LLM unavailable; using raw snapshot only.',
    capability_summary: 'No LLM summary generated.',
    why_this_page: 'Fallback path used because the LLM was unavailable or timed out.',
    likely_features: [],
    candidate_next_actions: [],
    version_hints: pageSnapshot.versionHints || [],
  };

  return callStructuredJson({
    instructions: pageAnalysisInstructions(),
    input: JSON.stringify(pageSnapshot),
    schema: PAGE_ANALYSIS_SCHEMA,
    fallback,
  });
}

export async function reviewDiff(diffPayload) {
  const fallback = {
    summary: 'No LLM diff review generated.',
    notable_changes: [],
    suspected_regressions: [],
    likely_intended_changes: [],
  };

  return callStructuredJson({
    instructions: [
      'You are reviewing a before-vs-after regression diff for a web application.',
      'Separate notable changes into likely intended changes versus suspected regressions.',
      'Stay conservative: if uncertain, keep the item in notable_changes without overclaiming.',
    ].join(' '),
    input: JSON.stringify(diffPayload),
    schema: DIFF_REVIEW_SCHEMA,
    fallback,
  });
}

export async function suggestGuidedActions(payload) {
  const fallback = {
    summary: 'No guided action suggestions generated.',
    progress_assessment: 'No progress assessment generated.',
    suspected_issue: 'No suspected issue generated.',
    retry_recommended: false,
    stop_reason: 'LLM unavailable or no safe retry plan generated.',
    actions: [],
  };

  return callStructuredJson({
    instructions: guidedActionInstructions(payload),
    input: JSON.stringify(payload),
    schema: GUIDED_ACTIONS_SCHEMA,
    fallback,
  });
}

export async function suggestDatasetExplorerRecoveryActions(payload) {
  const fallback = {
    summary: 'No Dataset Explorer recovery guidance generated.',
    progress_assessment: 'Recovery agent disabled, unavailable, or no safe recovery plan generated.',
    suspected_issue: 'No recovery-specific issue generated.',
    retry_recommended: false,
    stop_reason: 'No safe recovery plan generated.',
    actions: [],
  };

  return callStructuredJson({
    instructions: [
      'You are a dedicated recovery agent for the Dataset Explorer workflow in Lokasi.',
      'You are called only after the main deterministic runner has already made progress and hit a recovery-worthy state.',
      'Do not re-plan the whole workflow. Preserve intent and recommend the smallest safe recovery action.',
      'Prefer, in order: restore lost explorer intent, edit existing filter without reset, relax or switch the current filter, re-choose province if it was lost, switch to a more granular Administrative Area dataset when the current one is too shallow.',
      'Treat saved filter cards, committed province values, and enabled Add Dataset as stronger evidence than raw click history.',
      'For Administrative Area datasets, Village is deeper than District, and District is deeper than City.',
      'If explorer state was reset, prefer restoring the last search query and dataset selection before suggesting unrelated recovery.',
      'If a dataset is already committed in Data Selection, prefer editing the existing dataset filter over removing the dataset and starting over.',
      'If both a tabular sample row and a map detail panel are available, compare overlapping fields like City Name, City Code, Province Name, Province Code, and visible metrics before diagnosing a map inconsistency.',
      'Use Preview on Map as a safe way to center the expected geometry before recommending a direct map click as a verification step.',
      'Use only the allowed visible action types from the schema.',
      'Return concise operator-facing reasoning, not hidden chain-of-thought.',
    ].join(' '),
    input: JSON.stringify(payload),
    schema: GUIDED_ACTIONS_SCHEMA,
    fallback,
  });
}

export async function verifyDatasetFilter(payload) {
  const fallback = {
    summary: 'No dataset filter verification generated.',
    verified: false,
    confidence: 0,
    checked_column: payload?.attributeFilter?.attribute || '',
    checked_value: payload?.attributeFilter?.selectedValue || '',
    suspected_issue: 'LLM unavailable or insufficient table evidence.',
    notes: [],
  };

  return callStructuredJson({
    instructions: [
      'You are verifying whether a dataset filter appears to be reflected in the loaded dataset table.',
      'Use only the visible table headers, sample rows, pagination text, dataset title, and the applied filter metadata that were provided.',
      'Be conservative. Mark verified=true only when the sampled rows clearly support that the filtered column/value is respected.',
      'If the visible table state clearly reports 0 entries or no results, treat that as a valid empty-result outcome for the current committed filters, not a broken load.',
      'If the applied filter metadata is incomplete, explain that in suspected_issue instead of overclaiming.',
      'If the filtered attribute is categorical and the sample rows all align with the selected value, that is strong evidence.',
      'If the filtered attribute is numeric and only a minimum/threshold is known, check whether sampled values are consistent with that threshold when visible.',
      'If the relevant column is not visible in the sample, explain that and keep verified=false unless another strong signal exists.',
      'Return concise operator-facing reasoning, not hidden chain-of-thought.',
    ].join(' '),
    input: JSON.stringify(payload),
    schema: DATASET_FILTER_VERIFICATION_SCHEMA,
    fallback,
  });
}

export async function suggestDatasetTitleAliases(payload) {
  const fallback = {
    summary: 'No dataset title alias suggestions generated.',
    canonical_title: payload?.datasetTitle || '',
    aliases: [],
    confidence: 0,
    suspected_issue: 'LLM unavailable or insufficient title evidence.',
  };

  return callStructuredJson({
    instructions: [
      'You are mapping a verbose Dataset Explorer title to the shorter dataset label that may appear in Analysis > Data Selection.',
      'Use only the provided dataset title, deterministic aliases, and any visible loaded titles.',
      'Prefer conservative aliases that are likely to be rendered exactly as a row label in Data Selection.',
      'Favor the shortest unambiguous business-facing dataset title over long descriptive subtitles.',
      'Do not invent aliases unrelated to the provided title.',
      'Return 1-5 aliases ordered from best to weaker candidates.',
    ].join(' '),
    input: JSON.stringify(payload),
    schema: DATASET_TITLE_ALIAS_SCHEMA,
    fallback,
  });
}
