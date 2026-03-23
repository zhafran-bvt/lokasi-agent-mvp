# GitHub Actions Auto-Deployment Setup

This guide helps you set up automatic deployment of regression reports to Surge.sh using GitHub Actions.

## Prerequisites

- GitHub repository with this codebase
- Surge.sh account (free tier available)
- GitHub repository secrets configured

## Step 1: Get Your Surge Credentials

### Option A: Using Surge CLI (Recommended)

```bash
# Login to Surge
surge login

# This will create/update your surge credentials typically stored at:
# ~/.surge.sh
```

### Option B: Get Token from Surge Dashboard

1. Go to https://surge.sh
2. Login to your account
3. Navigate to account settings
4. Find your authentication token

## Step 2: Configure GitHub Secrets

Add these secrets to your GitHub repository:

### Setting Secrets via GitHub UI:

1. Go to your repository on GitHub
2. Navigate to **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Add the following secrets:

#### Secret 1: `SURGE_LOGIN`
- **Value**: Your Surge email address

#### Secret 2: `SURGE_TOKEN`
- **Value**: Your Surge authentication token
- Get from `~/.surge.sh` or Surge dashboard
- Or run: `cat ~/.surge.sh` to find your token

#### Secret 3: `OPENAI_API_KEY` (Optional, if needed for report generation)
- **Value**: Your OpenAI API key
- Only needed if your report generation uses LLM features

### Setting Secrets via GitHub CLI:

```bash
# Install GitHub CLI if not already installed
# https://cli.github.com

gh secret set SURGE_LOGIN --body "your-email@example.com"
gh secret set SURGE_TOKEN --body "your-surge-token"
gh secret set OPENAI_API_KEY --body "sk-..." # If using LLM features
```

## Step 3: Verify Workflow Configuration

1. Go to **Actions** tab in your GitHub repository
2. Look for **Deploy Report to Surge** workflow
3. Verify it appears in the list

## Step 4: Trigger Deployment Manually (First Time)

### Option A: Via GitHub UI

1. Navigate to **Actions** tab
2. Select **Deploy Report to Surge** workflow
3. Click **Run workflow** button
4. Click **Run workflow** in the dropdown

### Option B: Via GitHub CLI

```bash
gh workflow run deploy-report.yml
```

## Automation Options

The workflow is configured to run:

1. **On Demand** (Manual Trigger)
   - Use GitHub UI or CLI anytime
   - Best for immediate deployment after test runs

2. **Daily Schedule** (10 AM UTC)
   - Automatically runs every day
   - Change cron time in `.github/workflows/deploy-report.yml`:
     ```yaml
     schedule:
       - cron: '0 10 * * *'  # Change these numbers
     ```

3. **On Push** (When reports change)
   - Automatically triggers when you push to `main`
   - Only if report files are modified

## Monitoring Deployments

### Check Deployment Status:

1. Go to **Actions** tab in GitHub
2. Click on the **Deploy Report to Surge** workflow
3. View the latest run

### View Logs:

- Click on any workflow run to see detailed logs
- Look for ✅ or ❌ status

### Live Report:

Once deployed, your report is live at:
```
https://lokasi-regression.surge.sh
```

## Troubleshooting

### Deployment Failed with "Invalid token"

- Verify `SURGE_TOKEN` is correct
- Re-generate token in Surge dashboard
- Update the GitHub secret

### Deployment Failed with "Domain already taken"

- Change the domain in `.github/workflows/deploy-report.yml`:
  ```yaml
  run: surge dist/ --domain YOUR-NEW-DOMAIN.surge.sh --token ...
  ```

### Report not generated

- Ensure `npm run report` works locally
- Check `OPENAI_API_KEY` is set if LLM features are used
- Verify data files exist in `data/runs/` and `data/reports/`

### Workflow not showing in Actions tab

- Push the `.github/workflows/deploy-report.yml` file to the repository
- Go to Actions tab and refresh
- It should appear within a few seconds

## Manual Deployment (Alternative)

If you prefer to deploy manually without GitHub Actions:

```bash
# Locally
npm run report    # Generate from latest run
npm run build     # Build HTML
npm run deploy    # Deploy to Surge
```

## Next Steps

1. ✅ Set up GitHub secrets
2. ✅ Trigger workflow manually (first time)
3. ✅ Verify deployment succeeds
4. ✅ Visit https://lokasi-regression.surge.sh
5. ✅ Share link with team!

## Questions?

- Surge.sh Docs: https://surge.sh/help/
- GitHub Actions Docs: https://docs.github.com/en/actions
- GitHub Secrets Docs: https://docs.github.com/en/actions/security-guides/encrypted-secrets
