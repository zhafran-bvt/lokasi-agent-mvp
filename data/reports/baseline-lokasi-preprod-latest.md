# 📊 Baseline Report — Lokasi Intelligence Staging

**Run ID:** `baseline-lokasi-preprod-latest` | **Date:** 3/23/2026, 10:04:23 PM | **Duration:** 13m 31s
**Pages Discovered:** 1 | **Status:** ✅ COMPLETED *(partial)*

## Coverage Overview
| | Count | Share |
|---|---|---|
| Total features tested | **15** | 100% |
| ✅ Passed | **13** | 87% |
| ⚠️ Partial / Issues | **2** | 13% |
| ❌ Failed / Invalid | **0** | 0% |
| Workflow attempts | 20 | — |

## Feature Test Results
| Status | Group | Feature | Dataset Used |
|---|---|---|---|
| ✅ `completed` | Spatial Analysis | **Run Analysis** | - |
| ✅ `completed` | Dataset Explorer | **Dataset Explorer** | - |
| ✅ `completed` | Dataset Management | **Dataset Management** | - |
| ✅ `completed` | Spatial Analysis | **Map Draw Tools (Draw Polygon)** | - |
| ✅ `completed` | Project Management | **Analysis Job Queue** | - |
| ✅ `completed` | Spatial Analysis | **Map Controls (Recenter Map)** | - |
| ✅ `completed` | Search | **Search (location/dataset)** | - |
| ✅ `completed` | Settings | **Settings & My Account** | - |
| ✅ `completed` | Collapse | **UI Collapse / Panel Controls** | - |
| ✅ `completed` | Dataset Explorer | **Point** | Bank and Financial 2025 |
| ✅ `completed` | Dataset Explorer | **Polygon** | Regional Planning RDTR Indonesia |
| ✅ `completed` | Dataset Explorer | **H3** | Daily Mobility Heatmap 2025 |
| ✅ `completed` | Dataset Explorer | **Administrative Area** | Household Expenditure Village Jakarta |
| ❌ `invalid` | Dataset Explorer | **Geohash** | - |
| ❌ `invalid` | Dataset Explorer | **Line** | - |

## ⚠️ Issues & Failures — Detail
### ❌ Geohash — `invalid`
> Skipped unsupported aggregation for current Dataset Explorer target
##### ❌ Geohash
**Dataset Operations:**
- Dataset Selected: No
- Province Selected: No
- Attribute Filter: Not applied
- Dataset Added: No ❌
> ❌ **Error:** Skipped unsupported aggregation for current Dataset Explorer target
> 📝 **Notes:** Skipped unsupported aggregation for current Dataset Explorer target.

### ❌ Line — `invalid`
> Skipped unsupported aggregation for current Dataset Explorer target
##### ❌ Line
**Dataset Operations:**
- Dataset Selected: No
- Province Selected: No
- Attribute Filter: Not applied
- Dataset Added: No ❌
> ❌ **Error:** Skipped unsupported aggregation for current Dataset Explorer target
> 📝 **Notes:** Skipped unsupported aggregation for current Dataset Explorer target.


## ✅ Passing Features — Evidence
### ✅ Run Analysis

### ✅ Dataset Explorer

### ✅ Dataset Management

### ✅ Map Draw Tools (Draw Polygon)

### ✅ Analysis Job Queue

### ✅ Map Controls (Recenter Map)

### ✅ Search (location/dataset)

### ✅ Settings & My Account

### ✅ UI Collapse / Panel Controls

### ✅ Point
##### ✅ Point
**Dataset Operations:**
- Dataset Selected: Yes — *Bank and Financial 2025 Bank and financial POIs dataset on year 2025*
- Province Selected: Yes
- Attribute Filter: Applied
- Dataset Added: Yes ✅
✅ **Data Verification:** Province filter matched every visible row in column Province Namestring. Checked 80 rows across 8 pages. Attribute filte…
- Confidence: 100%
**Evidence:**
- ![Context](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278367298-workflow-dataset-explorer-aggregation-point-landing.png)
- ![Step 1](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278367298-workflow-dataset-explorer-aggregation-point-landing.png)
- ![Step 2](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278368349-workflow-dataset-explorer-aggregation-point-select-dataset.png)
- ![Step 3](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278369966-workflow-dataset-explorer-aggregation-point-choose-province.png)
- ![Step 4](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278377884-workflow-dataset-explorer-aggregation-point-apply-attribute-filter.png)
- ![Step 5](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278380074-workflow-dataset-explorer-aggregation-point-add-dataset.png)
- ![Step 6](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278424265-workflow-dataset-explorer-point-immediate-data-table.png)
> 📝 **Notes:** Loaded dataset and verified data table filters for Bank and Financial 2025 Bank and financial POIs dataset on year 2025

### ✅ Polygon
##### ✅ Polygon
**Dataset Operations:**
- Dataset Selected: Yes — *Regional Planning RDTR Indonesia City Provides regional planning (RDTR Level) fo…*
- Province Selected: Yes
- Attribute Filter: Applied
- Dataset Added: Yes ✅
✅ **Data Verification:** Province filter matched every visible row in column Province Namestring. Checked 80 rows across 8 pages. Numeric filter …
- Confidence: 100%
**Map Verification:**
- Preview on Map: matched
- Direct Map Click: matched
- Compared Fields: Year of Publicationstring, Class IDstring, Classstring, Class Area (sqm)float, City Namestring, City Codestring
- Result: Map detail panel matched the selected tabular row for the visible overlapping fields. Checked 1 rows across 1 page. Map detail panel matched the selected tabula…
**Evidence:**
- ![Context](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278470650-workflow-dataset-explorer-aggregation-polygon-landing.png)
- ![Step 1](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278470650-workflow-dataset-explorer-aggregation-polygon-landing.png)
- ![Step 2](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278471643-workflow-dataset-explorer-aggregation-polygon-select-aggregation.png)
- ![Step 3](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278472616-workflow-dataset-explorer-aggregation-polygon-select-dataset.png)
- ![Step 4](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278474216-workflow-dataset-explorer-aggregation-polygon-choose-province.png)
- ![Step 5](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278481182-workflow-dataset-explorer-aggregation-polygon-apply-attribute-filter.png)
- ![Step 6](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278497730-workflow-dataset-explorer-aggregation-polygon-add-dataset.png)
- ![Step 7](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278542169-workflow-dataset-explorer-polygon-immediate-data-table.png)
- ![Step 8](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278560514-workflow-dataset-explorer-polygon-immediate-map-detail.png)
> 📝 **Notes:** Loaded dataset and verified data table filters for Regional Planning RDTR Indonesia City Provides regional planning (RDTR Level) for a city or province that is still applicable, including revisions and updates across Indonesia. Note: not all cities or provinces are available.

### ✅ H3
##### ✅ H3
**Dataset Operations:**
- Dataset Selected: Yes — *Daily Mobility Heatmap 2025 Daily Mobility heatmap based on telecommunication da…*
- Province Selected: Yes
- Attribute Filter: Applied
- Dataset Added: Yes ✅
✅ **Data Verification:** Aggregated H3 results returned visible rows. The table does not expose a row-level Date column, so non-empty H3 result r…
- Confidence: 100%
**Map Verification:**
- Preview on Map: inconclusive
- Direct Map Click: matched
- Compared Fields: H3 IDstring, Avg Unique Device Countint
- Result: Map detail panel opened, but there were not enough overlapping fields to compare against the tabular row. Checked 1 rows across 1 page. Map detail panel matched…
**Evidence:**
- ![Context](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278607064-workflow-dataset-explorer-aggregation-h3-landing.png)
- ![Step 1](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278607064-workflow-dataset-explorer-aggregation-h3-landing.png)
- ![Step 2](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278607993-workflow-dataset-explorer-aggregation-h3-select-aggregation.png)
- ![Step 3](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278609009-workflow-dataset-explorer-aggregation-h3-select-dataset.png)
- ![Step 4](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278610629-workflow-dataset-explorer-aggregation-h3-choose-province.png)
- ![Step 5](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278836516-workflow-dataset-explorer-aggregation-h3-apply-attribute-filter.png)
- ![Step 6](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278837180-workflow-dataset-explorer-aggregation-h3-add-dataset.png)
- ![Step 7](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278881434-workflow-dataset-explorer-h3-immediate-data-table.png)
- ![Step 8](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278883400-workflow-dataset-explorer-h3-immediate-map-detail.png)
> 📝 **Notes:** Loaded dataset and verified data table filters for Daily Mobility Heatmap 2025 Daily Mobility heatmap based on telecommunication data on year 2025

### ✅ Administrative Area
##### ✅ Administrative Area
**Dataset Operations:**
- Dataset Selected: Yes — *Household Expenditure Village Jakarta 2024 The mean annual expenditure per house…*
- Province Selected: Yes
- Attribute Filter: Applied
- Dataset Added: Yes ✅
✅ **Data Verification:** Province filter matched every visible row in column Province Namestring. Checked 80 rows across 8 pages. Numeric filter …
- Confidence: 100%
**Map Verification:**
- Preview on Map: matched
- Direct Map Click: matched
- Compared Fields: Household Expenditurefloat, Household Food Expenditurefloat, Household Non Food Expenditurefloat, District Namestring, District Codestring, City Namestring
- Result: Map detail panel matched the selected tabular row for the visible overlapping fields. Checked 1 rows across 1 page. Map detail panel matched the selected tabula…
**Evidence:**
- ![Context](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278929897-workflow-dataset-explorer-aggregation-administrative-area-landing.png)
- ![Step 1](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278929897-workflow-dataset-explorer-aggregation-administrative-area-landing.png)
- ![Step 2](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278930861-workflow-dataset-explorer-aggregation-administrative-area-select-aggregation.png)
- ![Step 3](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278932512-workflow-dataset-explorer-aggregation-administrative-area-search-dataset.png)
- ![Step 4](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278933527-workflow-dataset-explorer-aggregation-administrative-area-select-dataset.png)
- ![Step 5](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278935145-workflow-dataset-explorer-aggregation-administrative-area-choose-province.png)
- ![Step 6](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278939927-workflow-dataset-explorer-aggregation-administrative-area-apply-attribute-filter.png)
- ![Step 7](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278940608-workflow-dataset-explorer-aggregation-administrative-area-add-dataset.png)
- ![Step 8](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278984788-workflow-dataset-explorer-administrative-area-immediate-data-table.png)
- ![Step 9](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774279003270-workflow-dataset-explorer-administrative-area-immediate-map-detail.png)
> 📝 **Notes:** Loaded dataset and verified data table filters for Household Expenditure Village Jakarta 2024 The mean annual expenditure per household. Use this to analyze purchasing power and economic status at the family unit level in Jakarta.


## 📄 Spatial Analysis - LOKASI
**URL:** [`/intelligence`](https://preprod.lokasi.com/intelligence)
**Purpose:** Workspace for performing geospatial/spatial analyses: browse and manage datasets, select areas on a map, run analyses and monitor jobs.

![Page screenshot](/Users/bvt-zhafran/Downloads/lokasi-agent-mvp/data/screenshots/baseline-lokasi-preprod-latest/1774278293729-page-1.png)

### 🔍 Features Discovered by LLM
| Feature | Group | Confidence | Risk |
|---|---|---|---|
| **Run Analysis** | Spatial Analysis | 90% | medium |
| **Dataset Explorer** | Dataset Explorer | 95% | low |
| **Dataset Management** | Dataset Management | 85% | high |
| **Map Draw Tools (Draw Polygon)** | Spatial Analysis | 98% | low |
| **Analysis Job Queue** | Project Management | 95% | low |
| **Map Controls (Recenter Map)** | Spatial Analysis | 98% | low |
| **Search (location/dataset)** | Search | 80% | low |
| **Settings & My Account** | Settings | 95% | low |
| **UI Collapse / Panel Controls** | Collapse | 90% | low |

## ⚠️ Warnings & Errors
⚠️ **Partial Run:** This run did not complete fully. Some workflows may not have finished.

## Technical Metadata
**Fingerprint:** `76c79f43807aace0`
**Started:** 2026-03-23T15:04:23.566Z | **Finished:** 2026-03-23T15:17:54.723Z
**Version Hints:** preprod environment (URL contains preprod) • page key indicates 'Spatial Analysis - LOKASI' intelligence workspace • UI exposes a job queue for asynchronous analysis
