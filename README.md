# Lokasi Agent MVP

Agent lokal untuk **exploratory regression testing** pada web app Lokasi, berbasis Playwright + OpenAI + file-based artifacts. Agent ini mengotomatisasi skenario uji UI, menganalisis fitur aplikasi menggunakan LLM, dan menghasilkan laporan regresi terstruktur tanpa memerlukan server eksternal.

---

## Daftar Isi
- [Cara Kerja](#cara-kerja)
- [Kapabilitas](#kapabilitas)
- [Arsitektur & Struktur Kode](#arsitektur--struktur-kode)
- [Quick Start](#quick-start)
- [Run Modes](#run-modes)
- [Workflows](#workflows)
- [Output Artifacts](#output-artifacts)
- [Environment Variables](#environment-variables)
- [Guardrails & Safety](#guardrails--safety)
- [Logging & Observability](#logging--observability)
- [Limitasi](#limitasi)

---

## Cara Kerja

```
Browser (Playwright)
        │
        ▼
   explorer.js          ← crawl halaman, ambil snapshot DOM + screenshot
        │
        ▼
    llm.js               ← analisis snapshot via OpenAI (page analysis, guided actions)
        │
        ▼
  workflows/*            ← eksekusi skenario terstruktur per fitur
        │
        ▼
  diff.js + report.js    ← bandingkan dengan baseline, generate Markdown report
        │
        ▼
  storage.js             ← simpan run JSON, report MD, dan screenshot ke data/
```

1. **Baseline run** – agent login, crawl app, jalankan semua workflow, simpan hasilnya sebagai baseline.
2. **Regression run** – jalankan ulang dengan cara yang sama, lalu diff hasilnya terhadap baseline.
3. **Report** – generate laporan Markdown dari run terakhir.
4. **Approve** – promosikan run terakhir menjadi baseline baru.

---

## Kapabilitas

- Login otomatis dan eksplorasi halaman utama berbasis snapshot DOM terstruktur.
- Baseline/regression run dengan output JSON + Markdown report.
- Workflow terstruktur per feature group: **Dataset Explorer**, **Spatial Analysis**, **Project Management**, **Dataset Management**.
- Coverage matrix per spatial aggregation (`Point`, `Polygon`, `H3`, `Administrative Area`, `Line`, `Geohash`).
- Bukti langkah per aksi: screenshot per step + status branch (`passed`, `blocked`, `invalid`, `partial`).
- Post-add reconciliation terhadap loaded state di panel `Data Selection`.
- Opsional verifikasi hasil filter via data table sample (`verifyDatasetFilter`).
- Diff otomatis antar run: fitur ditambah, dihapus, atau berubah status terdeteksi dan dilaporkan.
- Policy engine untuk memblokir aksi destruktif (delete, hapus, archive, dst.).

---

## Arsitektur & Struktur Kode

```
lokasi-agent-mvp/
├── src/
│   ├── index.js                  # Entrypoint: mode baseline/regression/report/approve
│   ├── config.js                 # Konfigurasi terpusat dari environment variables
│   ├── browser.js                # Low-level Playwright executor (klik, ketik, screenshot, state reader)
│   ├── explorer.js               # Crawl app: navigasi halaman, ambil snapshot, trigger workflow
│   ├── llm.js                    # Integrasi OpenAI: analisis halaman, guided actions, diff review, filter verify
│   ├── schemas.js                # JSON schema terstruktur untuk output LLM (page analysis, guided actions)
│   ├── policy.js                 # Policy engine: keyword blocker, feature group classifier, action aliases
│   ├── diff.js                   # Pembanding run baseline vs regression (fitur, status, fingerprint)
│   ├── report.js                 # Generator laporan Markdown dari run record
│   ├── run-model.js              # Normalisasi feature records + summarize coverage
│   ├── storage.js                # File I/O: simpan/baca run, baseline, report, screenshot
│   ├── utils.js                  # Helpers: slugify, nowIso, withTimeout, dsb.
│   └── workflows/
│       ├── index.js              # Router: memilih workflow berdasarkan feature group
│       ├── dataset-explorer.js   # Workflow utama: planner loop LLM + guardrails + reconciliation
│       ├── spatial-analysis.js   # Workflow Spatial Analysis: matrix kombinasi defineBy/outputMode/outputType
│       └── generic-feature.js   # Workflow generik untuk Project Management & Dataset Management
├── data/
│   ├── baselines/                # Baseline JSON tersimpan per nama (e.g. lokasi-preprod.json)
│   ├── runs/                     # Run result JSON (latest overwrite, tidak akumulasi)
│   ├── reports/                  # Laporan Markdown per run
│   └── screenshots/              # Screenshot per step, diorganisasi per run-id
├── output/                       # Contoh output YAML dari eksperimen awal (referensi)
└── package.json
```

### Deskripsi modul utama

| Modul | Tanggung Jawab |
|---|---|
| `index.js` | Entrypoint CLI; mengorkestrasi login, eksplorasi, diff, report, dan approve |
| `config.js` | Membaca semua env var dengan validasi tipe (`must`, `bool`, `int`, `csv`) |
| `browser.js` | Abstraksi Playwright: click, fill, screenshot, wait, dan state reader |
| `explorer.js` | Crawl multi-halaman: snapshot DOM, trigger LLM analysis, jalankan workflow per action |
| `llm.js` | Panggilan OpenAI dengan structured output schema: analisis halaman, saran aksi, review diff |
| `schemas.js` | Definisi JSON Schema ketat untuk response LLM agar dapat di-parse safely |
| `policy.js` | Nilai keyword berbahaya, alias feature group, dan classifier untuk routing workflow |
| `diff.js` | Membandingkan dua run record: fitur added/removed/changed + LLM review ringkas |
| `report.js` | Menghasilkan laporan Markdown lengkap dengan status, diff, dan path screenshot |
| `run-model.js` | Normalisasi dan agregasi data fitur dari run record |
| `storage.js` | Semua file I/O: ensureDataDirs, save/load run, baseline, report, screenshot |
| `workflows/dataset-explorer.js` | Planner loop: LLM merencanakan langkah, executor memvalidasi di browser, branch dicatat |
| `workflows/spatial-analysis.js` | Matriks kombinasi analisis spasial: defineBy × outputMode × outputType |
| `workflows/generic-feature.js` | Workflow fallback untuk fitur tanpa workflow khusus |

---

## Quick Start

### Prasyarat
- Node.js 18+
- Akses ke instance Lokasi web app (URL + kredensial)
- OpenAI API key

### Instalasi

```bash
npm install
npx playwright install chromium
```

### Konfigurasi

```bash
cp .env.example .env
# Edit .env sesuai environment target
```

Minimal env yang harus diisi:

```env
APP_URL=https://your-lokasi-instance.example.com
APP_EMAIL=user@example.com
APP_PASSWORD=yourpassword
OPENAI_API_KEY=sk-...
BASELINE_NAME=lokasi-preprod
```

### Jalankan

```bash
npm run baseline     # Buat baseline baru
npm run regression   # Jalankan regression terhadap baseline
npm run report       # Generate laporan Markdown dari run terakhir
npm run approve -- all  # Jadikan run terakhir sebagai baseline baru
```

---

## Run Modes

| Mode | Perintah | Keterangan |
|---|---|---|
| `baseline` | `npm run baseline` | Login, crawl, jalankan semua workflow, simpan sebagai baseline |
| `regression` | `npm run regression` | Jalankan ulang, diff terhadap baseline, simpan run + laporan |
| `report-latest` | `npm run report` | Generate ulang laporan Markdown dari run JSON terakhir |
| `approve-latest` | `npm run approve -- all` | Promosikan run terakhir menjadi baseline baru |

---

## Workflows

### Dataset Explorer (`dataset-explorer-bvt`)

Workflow paling kompleks. Menggunakan **LLM planner loop** untuk mengeksplor setiap tipe spatial aggregation secara berurutan.

**Alur per branch (tipe aggregation):**
1. Buka panel Dataset Explorer
2. Planner LLM mengusulkan aksi berikutnya (dari whitelist safe actions)
3. Executor browser menjalankan dan memvalidasi aksi
4. Setelah dataset berhasil ditambah, lakukan post-add reconciliation di panel Data Selection
5. Branch dicatat dengan status: `passed`, `blocked`, `invalid`, atau `partial`

**Spatial aggregations yang dicakup:**
`Point` · `Polygon` · `H3` · `Administrative Area` · `Line` · `Geohash`

**Fokus workflow saja:**
```bash
FOCUSED_WORKFLOW=dataset-explorer-bvt npm run baseline
```

---

### Spatial Analysis

Menjalankan matriks kombinasi parameter analisis spasial:

| defineBy | outputMode | outputType |
|---|---|---|
| Administrative Area | Grid | H3 / Geohash |
| Administrative Area | Profiling | — |
| Catchment | Grid | H3 / Geohash |
| Catchment | Profiling | — |
| Polygon | Grid | H3 / Geohash |

Tiap kombinasi dieksekusi, statusnya dicatat, dan difoto.

---

### Generic Feature

Workflow fallback untuk feature group `Project Management` dan `Dataset Management`. Klik action yang ditemukan, lalu LLM memberikan guided actions jika klik gagal.

---

## Output Artifacts

Semua output disimpan di `data/`:

```
data/
├── baselines/
│   └── <baseline-name>.json       # Snapshot baseline yang disetujui
├── runs/
│   └── <run-id>-latest.json       # Hasil run terakhir (overwrite)
├── reports/
│   └── <run-id>-latest.md         # Laporan Markdown terakhir (overwrite)
└── screenshots/
    └── <run-id>-latest/
        └── *.png                  # Screenshot per langkah
```

> Run `*-latest` selalu overwrite file sebelumnya — tidak ada akumulasi file run lama dengan run-id berbeda.

---

## Environment Variables

### Wajib

| Variabel | Keterangan |
|---|---|
| `APP_URL` | URL app target |
| `APP_EMAIL` | Email login |
| `APP_PASSWORD` | Password login |
| `OPENAI_API_KEY` | API key OpenAI |
| `BASELINE_NAME` | Nama baseline yang digunakan (default: `default`) |

### Opsional — Umum

| Variabel | Default | Keterangan |
|---|---|---|
| `APP_NAME` | `Target App` | Nama app untuk label di laporan |
| `MODEL` | `gpt-5-mini` | Model OpenAI yang digunakan |
| `HEADLESS` | `true` | Jalankan browser headless |
| `ALLOW_DESTRUCTIVE` | `false` | Izinkan aksi destruktif (hapus, archive, dst.) |
| `DATA_DIR` | `./data` | Direktori penyimpanan artifacts |
| `FOCUSED_WORKFLOW` | _(kosong)_ | Jalankan satu workflow saja (e.g. `dataset-explorer-bvt`) |
| `PRINT_LLM_REASONING` | `true` | Tampilkan reasoning LLM di terminal |

### Opsional — Timeout

| Variabel | Default | Keterangan |
|---|---|---|
| `RUN_TIMEOUT_MS` | `300000` | Timeout keseluruhan run (ms) |
| `WORKFLOW_STEP_TIMEOUT_MS` | `45000` | Timeout per langkah workflow (ms) |
| `ACTION_TIMEOUT_MS` | `90000` | Timeout per aksi browser (ms) |
| `REQUEST_TIMEOUT_MS` | `20000` | Timeout HTTP request (ms) |
| `NAVIGATION_TIMEOUT_MS` | `30000` | Timeout navigasi halaman (ms) |
| `LLM_TIMEOUT_MS` | `60000` | Timeout panggilan LLM (ms) |

### Opsional — Dataset Explorer

| Variabel | Default | Keterangan |
|---|---|---|
| `DATASET_EXPLORER_PLANNER_MAX_STEPS` | `16` | Maks langkah planner per branch |
| `DATASET_EXPLORER_STICKY_RETRY_LIMIT` | `2` | Maks retry aksi sama sebelum branch dihentikan |
| `DATASET_EXPLORER_PROVINCE` | `DKI Jakarta` | Provinsi filter dataset |
| `DATASET_EXPLORER_SPATIAL_AGGREGATIONS` | _(semua)_ | CSV tipe aggregation yang diuji |
| `DATASET_EXPLORER_RECOVERY_AGENT_ENABLED` | `false` | Aktifkan recovery agent eksperimental |

### Opsional — Spatial Analysis

| Variabel | Default | Keterangan |
|---|---|---|
| `SPATIAL_ANALYSIS_CASE_LIMIT` | `6` | Maks kombinasi yang dijalankan |
| `SPATIAL_ANALYSIS_CATCHMENT_LOCATION_QUERY` | `Monas, Jakarta` | Query lokasi untuk catchment |
| `SPATIAL_ANALYSIS_CATCHMENT_RADIUS_METERS` | `100` | Radius catchment (meter) |
| `SPATIAL_ANALYSIS_CATCHMENT_LATITUDE` | `-6.17254319` | Latitude pusat catchment |
| `SPATIAL_ANALYSIS_CATCHMENT_LONGITUDE` | `106.82316816` | Longitude pusat catchment |

### Opsional — Konfigurasi Lanjutan

| Variabel | Default | Keterangan |
|---|---|---|
| `MAX_PAGES` | `20` | Maks halaman yang di-crawl |
| `MAX_NAV_LINKS_PER_PAGE` | `20` | Maks nav link per halaman |
| `MAX_ACTIONS_PER_PAGE` | `6` | Maks aksi yang dicoba per halaman |
| `WORKFLOW_CANDIDATE_LIMIT` | `4` | Maks kandidat workflow per halaman |
| `LLM_MAX_GUIDED_STEPS` | `3` | Maks langkah guided action dari LLM |
| `MAIN_FEATURES` | _(kosong)_ | CSV fitur utama (untuk klasifikasi tier) |
| `SECONDARY_FEATURES` | _(kosong)_ | CSV fitur sekunder |
| `LOGIN_EMAIL_SELECTOR` | _(auto)_ | CSS selector untuk field email login |
| `LOGIN_PASSWORD_SELECTOR` | _(auto)_ | CSS selector untuk field password login |

---

## Guardrails & Safety

- **Action whitelist**: Planner LLM hanya boleh mengusulkan aksi dari daftar safe UI actions yang telah ditentukan.
- **Keyword blocker**: Aksi dengan kata kunci berbahaya (`delete`, `hapus`, `archive`, `reset`, dst.) diblokir oleh `policy.js` kecuali `ALLOW_DESTRUCTIVE=true`.
- **Executor sebagai sumber kebenaran**: Validasi ketersediaan dan aksiabilitas elemen dilakukan di browser, bukan hanya dari LLM.
- **Locked dataset dihindari**: Dataset yang sedang dikunci (processing) akan di-skip.
- **Precondition order**: select dataset → pilih provinsi (jika ada) → apply filter (jika perlu) → add dataset.
- **`Add Dataset` diprioritaskan** saat tombol sudah enabled, tidak menunggu filter opsional selesai.
- **Retry bounded**: Jumlah retry per aksi dibatasi (`DATASET_EXPLORER_STICKY_RETRY_LIMIT`) dan total langkah dibatasi (`DATASET_EXPLORER_PLANNER_MAX_STEPS`).
- **Branch dihentikan dengan klasifikasi jelas** (`passed` / `blocked` / `invalid` / `partial`) agar tidak looping tanpa batas.

---

## Logging & Observability

Semua event penting dicetak ke terminal dengan format timestamp + run-id + stage:

```
[2026-03-23T08:00:00.000Z] [baseline-lokasi-preprod-latest] [dataset-explorer] planner:state ...
[2026-03-23T08:00:01.000Z] [baseline-lokasi-preprod-latest] [dataset-explorer] llm-guidance ...
[2026-03-23T08:00:02.000Z] [baseline-lokasi-preprod-latest] [dataset-explorer] planner:action:selected ...
[2026-03-23T08:00:03.000Z] [baseline-lokasi-preprod-latest] [dataset-explorer] planner:action:executed ...
```

- `PRINT_LLM_REASONING=true` menampilkan reasoning ringkas LLM saat membuat keputusan.
- Report Markdown menyimpan screenshot path + detail attempt per branch untuk audit manual.

---

## Limitasi

- Sebagian run masih bisa mengalami false-negative pada committed loaded-state jika UI async lambat atau tidak stabil.
- Verifikasi filter data table bergantung pada keterbukaan kolom/filter value di sample table — bisa berstatus `inconclusive`.
- Baseline bersifat safety-first; destructive actions default **off**.
- Run menggunakan pola `*-latest` (overwrite), sehingga tidak ada histori otomatis antar-run — simpan manual jika perlu perbandingan historis.
- Recovery agent (`DATASET_EXPLORER_RECOVERY_AGENT_ENABLED`) masih eksperimental dan default off.
