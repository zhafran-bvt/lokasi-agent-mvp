# Surge.sh Deployment Guide

## Quick Start

### Prerequisites
1. Install surge CLI globally:
   ```bash
   npm install -g surge
   ```

2. Create a free Surge.sh account (if you don't have one):
   ```bash
   surge
   # Follow the prompts to create an account
   ```

### Deploy Your Report

**Option 1: Auto-generate and deploy (simplest)**
```bash
npm run deploy
```
This will:
1. Generate the latest report (if you haven't run one recently, run `npm run report` first)
2. Build the deployable site (`npm run build`)
3. Deploy to Surge with an auto-generated domain name

**Option 2: Deploy to a custom domain**
```bash
npm run deploy -- lokasi-regression-reports.surge.sh
```

**Option 3: Just build without deploying**
```bash
npm run build
# Then manually deploy:
surge dist/ --domain my-custom-domain.surge.sh
```

---

## What Gets Built

The `npm run build` command:
1. **Finds** the latest report from `data/reports/`
2. **Copies** all screenshots to `dist/screenshots/`
3. **Converts** Markdown to beautiful HTML
4. **Rewrites** screenshot paths from absolute → relative
5. **Creates** `dist/index.html` ready to deploy

Result: `dist/` folder (~10MB for a typical run)

---

## After Deployment

Once deployed, you'll get a public URL like:
```
https://lokasi-regression-reports.surge.sh
```

**Anyone** can access this URL to see:
- Full regression report with tables, status indicators
- All screenshots embedded and clickable
- Feature analysis, failures, passing tests
- No login required, no cost

---

## Tips

- **Keeping history**: Each `npm run deploy` overwrites the previous version. For history, use different domain names:
  ```bash
  npm run deploy -- lokasi-reports-2026-03-23.surge.sh
  ```

- **Speed**: First deploy takes ~5-10s (uploading 33 screenshots). Subsequent deploys only upload changed files.

- **Custom domain**: If you own a domain, Surge supports custom domains (detailed instructions at https://surge.sh/help/adding-a-custom-domain)

- **Storage limit**: Surge.sh free tier = 1GB. A typical run (~30-50 screenshots) = ~10MB, so you can store hundreds of reports.

---

## Troubleshooting

**"Command surge not found"**
- Install globally: `npm install -g surge`

**"No report found in data/reports/"**
- Run a regression first: `npm run regression`

**Path issues on the deployed site**
- All screenshot paths are automatically rewritten during build
- Check `dist/index.html` to verify paths before deploying

**Want to delete a deployed report?**
```bash
surge list  # shows all your projects
surge teardown lokasi-regression-reports.surge.sh
```

---

**Happy deploying!** 🚀
