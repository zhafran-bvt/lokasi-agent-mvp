# 📊 Baseline Report — Lokasi Intelligence Staging

**Run ID:** `baseline-lokasi-preprod-latest` | **Date:** 3/24/2026, 7:51:46 PM | **Duration:** 14m 4s
**Pages Discovered:** 1 | **Status:** • RUNNING *(partial)*

## Coverage Overview
| | Count | Share |
|---|---|---|
| Total features tested | **10** | 100% |
| ✅ Passed | **9** | 90% |
| ⚠️ Partial / Issues | **1** | 10% |
| ❌ Failed / Invalid | **0** | 0% |
| Workflow attempts | 19 | — |

## Feature Test Results
| Status | Group | Feature | Dataset Used |
|---|---|---|---|
| ✅ `completed` | Spatial Analysis | **Analysis panel / job submission** | - |
| ✅ `completed` | Dataset Explorer | **Dataset Explorer** | - |
| ✅ `completed` | Dataset Management | **Dataset Management** | - |
| ✅ `completed` | Project Management | **Analysis Job Queue** | - |
| ✅ `completed` | Spatial Analysis | **Map interaction: Draw Polygon** | - |
| ✅ `completed` | Spatial Analysis | **Map control: Recenter Map** | - |
| ✅ `completed` | Search | **Search** | - |
| ✅ `completed` | Settings | **Settings and My Account** | - |
| ✅ `completed` | Collapse | **UI toggle: Collapse** | - |
| 🚫 `blocked` | Dataset Explorer | **Administrative Area** | Household Expenditure Village Jakarta |

## ⚠️ Issues & Failures — Detail
### 🚫 Administrative Area — `blocked`
> Branch did not reach a committed success state: Administrative Area
##### 🚫 Edit existing filter
**Dataset Operations:**
- Dataset Selected: Yes — *Household Expenditure Village Jakarta 2024 The mean annual expenditure per house…*
- Province Selected: Yes
- Attribute Filter: Applied
- Dataset Added: Yes ✅
✅ **Data Verification:** Province filter matched every visible row in column Province Namestring. Checked 80 rows across 8 pages. Numeric filter …
- Confidence: 100%
**Map Verification:**
- Preview on Map: inconclusive
- Direct Map Click: matched
- Compared Fields: Household Expenditurefloat, Household Food Expenditurefloat, Household Non Food Expenditurefloat, District Namestring, District Codestring, City Namestring
- Result: Map detail panel opened, but there were not enough overlapping fields to compare against the tabular row. Checked 1 rows across 1 page. Map detail panel matched…
**Existing Filter Maintenance:**
- Edit Existing Filter: Not verified ❌
- Edit Issue: Loaded dataset row not found in Data Selection
**Evidence:**
- ![Context](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774356804048-workflow-dataset-explorer-edit-existing-filter-landing.png)
- ![Step 1](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774356804048-workflow-dataset-explorer-edit-existing-filter-landing.png)
- ![Step 2](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774356817941-workflow-dataset-explorer-edit-existing-filter-search-dataset.png)
- ![Step 3](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774356831898-workflow-dataset-explorer-edit-existing-filter-select-dataset.png)
- ![Step 4](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774356843448-workflow-dataset-explorer-edit-existing-filter-choose-province.png)
- ![Step 5](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774356859326-workflow-dataset-explorer-edit-existing-filter-apply-attribute-filter.png)
- ![Step 6](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774356868132-workflow-dataset-explorer-edit-existing-filter-add-dataset.png)
- ![Step 7](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774356912249-workflow-dataset-explorer-administrative-area-immediate-data-table.png)
- ![Step 8](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774356914286-workflow-dataset-explorer-administrative-area-immediate-map-detail.png)
- ![Step 9](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774356944177-workflow-dataset-explorer-edit-existing-filter-open-edit-filter.png)
- ![Step 10](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774356966883-workflow-dataset-explorer-edit-existing-filter-open-edit-filter.png)
- ![Step 11](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774356983664-workflow-dataset-explorer-edit-existing-filter-select-dataset.png)
- ![Step 12](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774356992456-workflow-dataset-explorer-edit-existing-filter-search-dataset.png)
- ![Step 13](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357006968-workflow-dataset-explorer-edit-existing-filter-select-dataset.png)
- ![Step 14](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357007434-workflow-dataset-explorer-edit-existing-filter-verify-state.png)
- ![Step 15](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357028647-workflow-dataset-explorer-edit-existing-filter-select-aggregation.png)
- ![Step 16](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357043589-workflow-dataset-explorer-edit-existing-filter-select-dataset.png)
- ![Step 17](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357069917-workflow-dataset-explorer-edit-existing-filter-verify-state.png)
- ![Step 18](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357088733-workflow-dataset-explorer-edit-existing-filter-verify-state.png)
- ![Step 19](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357101901-workflow-dataset-explorer-edit-existing-filter-select-dataset.png)
- ![Step 20](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357119450-workflow-dataset-explorer-edit-existing-filter-verify-state.png)
- ![Step 21](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357136691-workflow-dataset-explorer-edit-existing-filter-select-dataset.png)
- ![Step 22](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357150597-workflow-dataset-explorer-edit-existing-filter-verify-state.png)
**LLM Diagnosis:** Stalled: dataset is visible in UI text but prior attempts to click the committed dataset or its edit affordance failed. Need a non-mutating check of panel/clickability state.
- ⚠️ Suspected Issue: The Data Selection panel or edit-affordance may be collapsed, offscreen, or otherwise not interactive (dataset card shown in text but not clickable).
> ❌ **Error:** Branch did not reach a committed success state: Administrative Area
> 📝 **Notes:** Branch did not reach a committed success state: Administrative Area
##### 🚫 Delete existing filter
**Dataset Operations:**
- Dataset Selected: Yes — *Household Expenditure Village Jakarta 2024 The mean annual expenditure per house…*
- Province Selected: Yes
- Attribute Filter: Applied
- Dataset Added: Yes ✅
✅ **Data Verification:** Province filter matched every visible row in column Province Namestring. Checked 80 rows across 8 pages. Numeric filter …
- Confidence: 100%
**Map Verification:**
- Preview on Map: inconclusive
- Direct Map Click: matched
- Compared Fields: Household Expenditurefloat, Household Food Expenditurefloat, Household Non Food Expenditurefloat, District Namestring, District Codestring, City Namestring
- Result: Map detail panel opened, but there were not enough overlapping fields to compare against the tabular row. Checked 1 rows across 1 page. Map detail panel matched…
**Existing Filter Maintenance:**
- Edit Existing Filter: Not verified ❌
- Edit Issue: Loaded dataset row not found in Data Selection
**Evidence:**
- ![Context](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357187092-workflow-dataset-explorer-delete-existing-filter-landing.png)
- ![Step 1](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357187092-workflow-dataset-explorer-delete-existing-filter-landing.png)
- ![Step 2](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357197898-workflow-dataset-explorer-delete-existing-filter-select-dataset.png)
- ![Step 3](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357208383-workflow-dataset-explorer-delete-existing-filter-choose-province.png)
- ![Step 4](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357227014-workflow-dataset-explorer-delete-existing-filter-apply-attribute-filter.png)
- ![Step 5](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357238665-workflow-dataset-explorer-delete-existing-filter-add-dataset.png)
- ![Step 6](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357282813-workflow-dataset-explorer-administrative-area-immediate-data-table.png)
- ![Step 7](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357284824-workflow-dataset-explorer-administrative-area-immediate-map-detail.png)
- ![Step 8](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357308331-workflow-dataset-explorer-delete-existing-filter-open-edit-filter.png)
- ![Step 9](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357320151-workflow-dataset-explorer-delete-existing-filter-open-edit-filter.png)
- ![Step 10](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357353384-workflow-dataset-explorer-delete-existing-filter-open-preview.png)
- ![Step 11](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357353881-workflow-dataset-explorer-delete-existing-filter-verify-state.png)
- ![Step 12](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357376567-workflow-dataset-explorer-delete-existing-filter-select-aggregation.png)
- ![Step 13](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357387516-workflow-dataset-explorer-delete-existing-filter-select-dataset.png)
- ![Step 14](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357401548-workflow-dataset-explorer-delete-existing-filter-search-dataset.png)
- ![Step 15](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357433599-workflow-dataset-explorer-delete-existing-filter-select-aggregation.png)
- ![Step 16](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357458549-workflow-dataset-explorer-delete-existing-filter-select-aggregation.png)
- ![Step 17](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357484452-workflow-dataset-explorer-delete-existing-filter-select-aggregation.png)
- ![Step 18](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357505165-workflow-dataset-explorer-delete-existing-filter-select-dataset.png)
- ![Step 19](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357536049-workflow-dataset-explorer-delete-existing-filter-select-aggregation.png)
- ![Step 20](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774357550750-workflow-dataset-explorer-delete-existing-filter-select-dataset.png)
**LLM Diagnosis:** Branch setup shows the target dataset present in the UI text and visibility toggles, but prior select_dataset attempt failed. Dataset Explorer is open and Add Dataset is enabled; we need to activate the committed dataset first.
- ⚠️ Suspected Issue: Previous attempt used the base title without the visible duplicate suffix '(1)'; dataset row may require selecting the exact committed title 'Household Expenditure Village Jakarta 2024 (1)'.
> ❌ **Error:** Planner budget exhausted for Administrative Area
> 📝 **Notes:** Planner deadline exceeded before success or a clear blocker.


## ✅ Passing Features — Evidence
### ✅ Analysis panel / job submission

### ✅ Dataset Explorer

### ✅ Dataset Management

### ✅ Analysis Job Queue

### ✅ Map interaction: Draw Polygon

### ✅ Map control: Recenter Map

### ✅ Search

### ✅ Settings and My Account

### ✅ UI toggle: Collapse


## 📄 Spatial Analysis - LOKASI
**URL:** [`/intelligence`](https://preprod.lokasi.com/intelligence)
**Purpose:** Web UI for performing geospatial/spatial analysis on datasets: explore and manage datasets, draw spatial queries on a map, submit analysis jobs and monitor job queue.

![Page screenshot](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774356737125-page-1.png)

### 🔍 Features Discovered by LLM
| Feature | Group | Confidence | Risk |
|---|---|---|---|
| **Analysis panel / job submission** | Spatial Analysis | 90% | high |
| **Dataset Explorer** | Dataset Explorer | 90% | high |
| **Dataset Management** | Dataset Management | 85% | high |
| **Analysis Job Queue** | Project Management | 90% | high |
| **Map interaction: Draw Polygon** | Spatial Analysis | 95% | high |
| **Map control: Recenter Map** | Spatial Analysis | 80% | low |
| **Search** | Search | 80% | medium |
| **Settings and My Account** | Settings | 85% | low |
| **UI toggle: Collapse** | Collapse | 75% | low |

## ⚠️ Warnings & Errors
⚠️ **Partial Run:** This run did not complete fully. Some workflows may not have finished.

## Technical Metadata
**Fingerprint:** `-`
**Started:** 2026-03-24T12:51:46.966Z | **Finished:** 2026-03-24T13:05:51.016Z
**Version Hints:** preprod environment (preprod.lokasi.com) • route /intelligence; page title 'Spatial Analysis - LOKASI' • UI shows map-related controls: 'Draw Polygon', 'Recenter Map' and a map label '4 Street' (likely zoom/street label)
