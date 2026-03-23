function section(title, lines = []) {
  return [`## ${title}`, ...lines, ''].join('\n');
}

function statusIcon(status) {
  if (status === 'passed' || status === 'completed') return '✅';
  if (status === 'blocked') return '🚫';
  if (status === 'partial') return '⚠️';
  if (status === 'invalid' || status === 'failed') return '❌';
  return '•';
}

function formatDuration(startedAt, finishedAt) {
  const start = new Date(startedAt);
  const end = new Date(finishedAt);
  const ms = end - start;
  const secs = Math.round(ms / 1000);
  const mins = Math.floor(secs / 60);
  return mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`;
}

function truncate(str, max = 60) {
  if (!str) return '-';
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

function mapVerificationStatusLabel(result) {
  if (!result) return 'not attempted';
  if (result.verified) return 'matched';
  if (result.inconclusive) return 'inconclusive';
  return 'mismatch';
}

function mapVerificationComparedFields(result) {
  const columns = String(result?.checked_column || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return columns.length ? columns.join(', ') : '-';
}

function buildWorkflowStepDetails(step, action) {
  const lines = [];
  const stepLabel = step.name || step.aggregation || action?.action?.text || 'Step';
  const stepStatus = statusIcon(step.status);

  lines.push(`##### ${stepStatus} ${stepLabel}`);

  if (step.selectedDataset != null || step.provinceSelected != null || step.addDataset != null) {
    lines.push('**Dataset Operations:**');
    if (step.selectedDataset != null) {
      lines.push(`- Dataset Selected: ${step.selectedDataset ? 'Yes' : 'No'}${step.selectedCandidate ? ` — *${truncate(step.selectedCandidate, 80)}*` : ''}`);
    }
    if (step.provinceSelected != null) {
      lines.push(`- Province Selected: ${step.provinceSelected ? 'Yes' : 'No'}`);
    }
    if (step.attributeFilter != null) {
      lines.push(`- Attribute Filter: ${step.attributeFilter?.applied ? 'Applied' : 'Not applied'}${step.attributeFilter?.value ? ` (${step.attributeFilter.value})` : ''}`);
    }
    if (step.addDataset != null) {
      lines.push(`- Dataset Added: ${step.addDataset?.added ? 'Yes ✅' : 'No ❌'}${step.addDataset?.count ? ` (${step.addDataset.count} records)` : ''}`);
    }
  }

  if (step.defineBy || step.outputAnalysis) {
    lines.push('**Spatial Analysis Configuration:**');
    if (step.defineBy?.current) {
      lines.push(`- Define By: ${step.defineBy.current}${step.defineBy.options?.length ? ` (options: ${step.defineBy.options.join(', ')})` : ''}`);
    }
    if (step.outputAnalysis?.options?.length) {
      lines.push(`- Output Modes: ${step.outputAnalysis.options.join(', ')}`);
    }
  }

  if (step.reconciliation) {
    const icon = step.reconciliation.resolved ? '✅' : '⚠️';
    lines.push(`${icon} **Reconciliation:** ${step.reconciliation.reason || 'State verified'}`);
  }

  if (step.tableVerification) {
    const icon = step.tableVerification.verified ? '✅' : '⚠️';
    lines.push(`${icon} **Data Verification:** ${truncate(step.tableVerification.summary, 120)}`);
    if (step.tableVerification.suspectedIssue) {
      lines.push(`- ⚠️ Issue: ${step.tableVerification.suspectedIssue}`);
    }
    if (step.tableVerification.confidence != null) {
      lines.push(`- Confidence: ${Math.round(step.tableVerification.confidence * 100)}%`);
    }
    if (step.tableVerification.mapDetailVerification?.attempted) {
      const mapVerification = step.tableVerification.mapDetailVerification;
      const previewCheck = mapVerification.previewCheck || null;
      const clickCheck = mapVerification.mapClickCheck || null;
      lines.push('**Map Verification:**');
      lines.push(`- Preview on Map: ${mapVerificationStatusLabel(previewCheck)}`);
      lines.push(`- Direct Map Click: ${mapVerificationStatusLabel(clickCheck)}`);
      lines.push(`- Compared Fields: ${mapVerificationComparedFields(clickCheck?.verified ? clickCheck : previewCheck)}`);
      lines.push(`- Result: ${truncate(mapVerification.summary, 160)}`);
      if (mapVerification.suspected_issue) {
        lines.push(`- ⚠️ Map Issue: ${mapVerification.suspected_issue}`);
      }
      const mapNotes = [
        ...(previewCheck?.notes || []),
        ...(clickCheck?.notes || []),
      ].filter(Boolean);
      if (mapNotes.length) {
        lines.push(`- Comparison Notes: ${truncate(mapNotes.join(' | '), 200)}`);
      }
    }
  }

  if (step.editFilterVerification || step.deleteFilterVerification) {
    lines.push('**Existing Filter Maintenance:**');
    if (step.editFilterVerification) {
      lines.push(`- Edit Existing Filter: ${step.editFilterVerification.verified ? 'Verified ✅' : 'Not verified ❌'}`);
      if (Array.isArray(step.editFilterVerification.cards) && step.editFilterVerification.cards.length) {
        lines.push(`- Visible Saved Filters: ${step.editFilterVerification.cards.map((card) => truncate(card.label, 40)).join(', ')}`);
      }
      if (step.editFilterVerification.reason) {
        lines.push(`- Edit Issue: ${truncate(step.editFilterVerification.reason, 140)}`);
      }
    }
    if (step.deleteFilterVerification) {
      lines.push(`- Delete Existing Filter: ${step.deleteFilterVerification.verified ? 'Verified ✅' : 'Not verified ❌'}`);
      if (step.deleteFilterVerification.targetLabel) {
        lines.push(`- Deleted Filter Target: ${truncate(step.deleteFilterVerification.targetLabel, 60)}`);
      }
      if (step.deleteFilterVerification.beforeCount != null && step.deleteFilterVerification.afterCount != null) {
        lines.push(`- Saved Filter Count: ${step.deleteFilterVerification.beforeCount} -> ${step.deleteFilterVerification.afterCount}`);
      }
      if (step.deleteFilterVerification.reason) {
        lines.push(`- Delete Issue: ${truncate(step.deleteFilterVerification.reason, 140)}`);
      }
    }
  }

  if (step.screenshots?.length || step.contextScreenshot || step.timeoutScreenshot) {
    lines.push('**Evidence:**');
    if (step.contextScreenshot) lines.push(`- ![Context](${step.contextScreenshot})`);
    if (step.timeoutScreenshot) lines.push(`- ⚠️ ![Timeout](${step.timeoutScreenshot})`);
    for (const [i, s] of (step.screenshots || []).entries()) {
      lines.push(`- ![Step ${i + 1}](${s})`);
    }
  }

  if (step.llmGuidance?.actions?.length) {
    lines.push(`**LLM Diagnosis:** ${step.llmGuidance.progress_assessment || '-'}`);
    if (step.llmGuidance.suspected_issue) {
      lines.push(`- ⚠️ Suspected Issue: ${step.llmGuidance.suspected_issue}`);
    }
  }

  if (step.error) lines.push(`> ❌ **Error:** ${step.error}`);
  if (step.notes) lines.push(`> 📝 **Notes:** ${step.notes}`);

  return lines;
}

function buildBaselineReport(run) {
  const lines = [
    `# 📊 Baseline Report — ${run.appName}`,
    '',
    `**Run ID:** \`${run.runId}\` | **Date:** ${new Date(run.startedAt).toLocaleString()} | **Duration:** ${formatDuration(run.startedAt, run.finishedAt)}`,
    `**Pages Discovered:** ${run.pageCount} | **Status:** ${statusIcon(run.status)} ${(run.status || 'completed').toUpperCase()}${run.partial ? ' *(partial)*' : ''}`,
    '',
  ];

  // Coverage overview
  if (run.coverage) {
    const { totalFeatures, completedFeatures, partialFeatures, workflowAttempts } = run.coverage;
    const failedFeatures = totalFeatures - completedFeatures - partialFeatures;
    lines.push(section('Coverage Overview', [
      `| | Count | Share |`,
      `|---|---|---|`,
      `| Total features tested | **${totalFeatures}** | 100% |`,
      `| ✅ Passed | **${completedFeatures}** | ${Math.round(completedFeatures / totalFeatures * 100)}% |`,
      `| ⚠️ Partial / Issues | **${partialFeatures}** | ${Math.round(partialFeatures / totalFeatures * 100)}% |`,
      `| ❌ Failed / Invalid | **${failedFeatures}** | ${Math.round(failedFeatures / totalFeatures * 100)}% |`,
      `| Workflow attempts | ${workflowAttempts} | — |`,
    ]));
  }

  // Feature status table (concise)
  if (run.featureRecords?.length) {
    const rows = run.featureRecords.map((r) => {
      const icon = statusIcon(r.status);
      const candidate = r.selectedCandidate ? truncate(r.selectedCandidate.split(' ').slice(0, 4).join(' '), 50) : '-';
      return `| ${icon} \`${r.status}\` | ${r.featureGroup} | **${r.name}** | ${candidate} |`;
    });
    lines.push(section('Feature Test Results', [
      '| Status | Group | Feature | Dataset Used |',
      '|---|---|---|---|',
      ...rows,
    ]));
  }

  // Failures & partial — detailed breakdown only for non-passing
  const failingRecords = (run.featureRecords || []).filter((r) => r.status !== 'completed' && r.status !== 'passed');
  if (failingRecords.length > 0) {
    const failLines = [];
    for (const record of failingRecords) {
      failLines.push(`### ${statusIcon(record.status)} ${record.name} — \`${record.status}\``);
      if (record.notes) failLines.push(`> ${record.notes}`);

      // Find corresponding workflow steps
      for (const page of run.pages || []) {
        for (const action of page.actionResults || []) {
          for (const step of action.workflow?.steps || []) {
            const stepLabel = step.aggregation || step.name || '';
            if (stepLabel.toLowerCase() === record.name.toLowerCase()) {
              failLines.push(...buildWorkflowStepDetails(step, action));
            }
          }
        }
      }
      failLines.push('');
    }
    lines.push(section('⚠️ Issues & Failures — Detail', failLines));
  }

  // Passing steps evidence (collapsible-friendly: just show screenshots/notes)
  const passingRecords = (run.featureRecords || []).filter((r) => r.status === 'completed' || r.status === 'passed');
  if (passingRecords.length > 0) {
    const passLines = [];
    for (const record of passingRecords) {
      passLines.push(`### ✅ ${record.name}`);
      for (const page of run.pages || []) {
        for (const action of page.actionResults || []) {
          for (const step of action.workflow?.steps || []) {
            const stepLabel = step.aggregation || step.name || '';
            if (stepLabel.toLowerCase() === record.name.toLowerCase()) {
              passLines.push(...buildWorkflowStepDetails(step, action));
            }
          }
        }
      }
      passLines.push('');
    }
    lines.push(section('✅ Passing Features — Evidence', passLines));
  }

  // Page analysis detail
  for (const page of run.pages || []) {
    const pageLines = [
      `**URL:** [\`${new URL(page.url).pathname}\`](${page.url})`,
      `**Purpose:** ${page.llm?.purpose || '-'}`,
      '',
    ];

    if (page.screenshot) {
      pageLines.push(`![Page screenshot](${page.screenshot})`);
      pageLines.push('');
    }

    const features = page.llm?.likely_features || [];
    if (features.length) {
      pageLines.push('### 🔍 Features Discovered by LLM');
      pageLines.push('| Feature | Group | Confidence | Risk |');
      pageLines.push('|---|---|---|---|');
      for (const f of features) {
        pageLines.push(`| **${f.name}** | ${f.featureGroup || 'Unclassified'} | ${Math.round(f.confidence * 100)}% | ${f.risk_level} |`);
      }
    }

    lines.push(section(`📄 ${page.title || page.url}`, pageLines));
  }

  // Warnings
  const warnings = [];
  if (run.partial) warnings.push('⚠️ **Partial Run:** This run did not complete fully. Some workflows may not have finished.');
  if (run.errors?.length) {
    warnings.push(`❌ **${run.errors.length} Error(s):**`);
    for (const e of run.errors) warnings.push(`- \`${e.url}\`: ${e.message || e.error}`);
  }
  if (warnings.length) lines.push(section('⚠️ Warnings & Errors', warnings));

  lines.push(section('Technical Metadata', [
    `**Fingerprint:** \`${run.globalFingerprint || '-'}\``,
    `**Started:** ${run.startedAt} | **Finished:** ${run.finishedAt}`,
    `**Version Hints:** ${(run.globalVersionHints || []).slice(0, 3).join(' • ') || '-'}`,
  ]));

  return lines.join('\n');
}

function buildRegressionReport(run) {
  const lines = [
    `# 🔄 Regression Report — ${run.appName}`,
    '',
    `**Run ID:** \`${run.runId}\` | **Date:** ${new Date(run.startedAt).toLocaleString()} | **Duration:** ${formatDuration(run.startedAt, run.finishedAt)}`,
    `**Pages:** ${run.pageCount} | **Status:** ${statusIcon(run.status)} ${(run.status || 'completed').toUpperCase()}${run.partial ? ' *(partial)*' : ''}`,
    '',
  ];

  const total = run.featureRecords?.length || 0;
  const failing = (run.featureRecords || []).filter((r) => r.status !== 'completed' && r.status !== 'passed');
  const passing = (run.featureRecords || []).filter((r) => r.status === 'completed' || r.status === 'passed');

  // === TOP-LEVEL VERDICT ===
  if (failing.length === 0) {
    lines.push('> ✅ **All features passed.** No regressions detected.\n');
  } else {
    lines.push(`> 🚨 **${failing.length} of ${total} features require attention** — see details below.\n`);
  }

  // === DIFF SUMMARY ===
  if (run.diff) {
    const diffLines = [];

    if (run.diff.llmReview?.summary) {
      diffLines.push(`**LLM Assessment:** ${run.diff.llmReview.summary}`);
      diffLines.push('');
    }

    if (run.diff.llmReview?.suspected_regressions?.length) {
      diffLines.push('### 🚨 Suspected Regressions');
      for (const issue of run.diff.llmReview.suspected_regressions) {
        diffLines.push(`- ${issue}`);
      }
      diffLines.push('');
    }

    if (run.diff.llmReview?.notable_changes?.length) {
      diffLines.push('### 📝 Notable Changes');
      for (const change of run.diff.llmReview.notable_changes) {
        diffLines.push(`- ${change}`);
      }
      diffLines.push('');
    }

    if (run.diff.llmReview?.likely_intended_changes?.length) {
      diffLines.push('### ✅ Likely Intentional');
      for (const change of run.diff.llmReview.likely_intended_changes) {
        diffLines.push(`- ${change}`);
      }
      diffLines.push('');
    }

    diffLines.push('### Change Counts');
    diffLines.push('| Type | Pages | Features |');
    diffLines.push('|---|---|---|');
    diffLines.push(`| Added | ${run.diff.addedPages?.length || 0} | ${run.diff.featureDiff?.added?.length || 0} |`);
    diffLines.push(`| Removed | ${run.diff.removedPages?.length || 0} | ${run.diff.featureDiff?.removed?.length || 0} |`);
    diffLines.push(`| Changed | ${run.diff.changedPages?.length || 0} | ${run.diff.featureDiff?.changed?.length || 0} |`);

    lines.push(section('Diff vs Baseline', diffLines));
  }

  // === FEATURES NEEDING ATTENTION ===
  if (failing.length > 0) {
    const attentionLines = [];
    attentionLines.push('| Status | Feature | Group | Issue |');
    attentionLines.push('|---|---|---|---|');
    for (const r of failing) {
      attentionLines.push(`| ${statusIcon(r.status)} \`${r.status}\` | **${r.name}** | ${r.featureGroup} | ${truncate(r.notes, 60) || '-'} |`);
    }
    lines.push(section('🚨 Attention Required', attentionLines));

    // Detailed failure breakdown
    const failureLines = [];
    for (const record of failing) {
      failureLines.push(`### ${statusIcon(record.status)} ${record.name} — \`${record.status}\``);
      if (record.notes) failureLines.push(`> ${record.notes}`);

      for (const page of run.pages || []) {
        for (const action of page.actionResults || []) {
          for (const step of action.workflow?.steps || []) {
            const stepLabel = step.aggregation || step.name || '';
            if (stepLabel.toLowerCase() === record.name.toLowerCase()) {
              failureLines.push(...buildWorkflowStepDetails(step, action));
            }
          }
        }
      }
      failureLines.push('');
    }
    lines.push(section('Failure Details', failureLines));
  }

  // === PASSING FEATURES (compact) ===
  if (passing.length > 0) {
    const rows = passing.map((r) => {
      const candidate = r.selectedCandidate ? truncate(r.selectedCandidate.split(' ').slice(0, 5).join(' '), 55) : '-';
      return `| ✅ | **${r.name}** | ${r.featureGroup} | ${candidate} |`;
    });
    lines.push(section('✅ Passing Features', [
      '| | Feature | Group | Dataset Used |',
      '|---|---|---|---|',
      ...rows,
    ]));
  }

  // Approval info
  if (run.approval) {
    lines.push(section('Approval', [
      `**Source Run:** \`${run.approval.sourceRunId || '-'}\``,
      `**Approved Groups:** ${(run.approval.approvedFeatureGroups || []).join(', ') || 'None'}`,
      `**Approved At:** ${run.approval.approvedAt || '-'}`,
    ]));
  }

  // Warnings
  const warnings = [];
  if (run.partial) warnings.push('⚠️ **Partial Run:** This run did not complete fully. Some workflows may not have finished.');
  if (run.errors?.length) {
    warnings.push(`❌ **${run.errors.length} Error(s):**`);
    for (const e of run.errors) warnings.push(`- \`${e.url}\`: ${e.message || e.error}`);
  }
  if (warnings.length) lines.push(section('⚠️ Warnings & Errors', warnings));

  lines.push(section('Technical Metadata', [
    `**Fingerprint:** \`${run.globalFingerprint || '-'}\``,
    `**Started:** ${run.startedAt} | **Finished:** ${run.finishedAt}`,
  ]));

  return lines.join('\n');
}

export function buildMarkdownReport(run) {
  return run.mode === 'regression' ? buildRegressionReport(run) : buildBaselineReport(run);
}
