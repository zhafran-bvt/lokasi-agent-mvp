import path from 'node:path';
import { chromium } from 'playwright';
import { config } from './config.js';
import { suggestGuidedActions } from './llm.js';
import { actionPriority, agentPolicy, isDangerousLabel, normalizePolicyText } from './policy.js';
import { screenshotDir } from './storage.js';
import { hash, pickText, sleep, slugify, truncate, uniqueBy, withTimeout } from './utils.js';
import { runFeatureWorkflow } from './workflows/index.js';

async function findFirstUsable(page, selectors, predicate) {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      const usable = await predicate(candidate).catch(() => false);
      if (usable) return candidate;
    }
  }
  return null;
}

async function clickFirstMatching(page, selectors) {
  const candidate = await findFirstUsable(
    page,
    selectors,
    async (locator) => (await locator.isVisible()) && (await locator.isEnabled()),
  );
  if (candidate) {
    await candidate.click({ timeout: 5_000 });
    return true;
  }
  return false;
}

async function fillFirstMatching(page, selectors, value) {
  const candidate = await findFirstUsable(
    page,
    selectors,
    async (locator) => (await locator.isVisible()) && (await locator.isEditable()),
  );
  if (candidate) {
    await candidate.fill(value, { timeout: 5_000 });
    return true;
  }
  return false;
}

async function hasVisibleEditable(page, selectors) {
  const candidate = await findFirstUsable(
    page,
    selectors,
    async (locator) => (await locator.isVisible()) && (await locator.isEditable()),
  );
  return Boolean(candidate);
}

async function waitBrieflyForIdle(page, ms = 2_000) {
  await Promise.race([
    page.waitForLoadState('networkidle').catch(() => {}),
    sleep(ms),
  ]).catch(() => {});
}

async function captureDebugWorkflowScreenshot(page, suffix) {
  const runId = page.__agentRunId;
  if (!runId) return '';
  const filename = `${Date.now()}-${slugify(suffix)}.png`;
  const file = path.join(screenshotDir(runId), filename);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}

async function clickVisibleActionable(page, label) {
  const target = normalizePolicyText(label);
  if (!target) return false;

  const selector = 'button, [role="button"], a[href], input[type="button"], input[type="submit"], [data-testid]';
  const matched = await page.locator(selector).evaluateAll((elements, expected) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    let sequence = 0;
    for (const element of elements) {
      if (!(element instanceof HTMLElement) || !visible(element)) continue;

      const candidates = [
        element.innerText,
        element.textContent,
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.getAttribute('data-testid'),
        element.getAttribute('name'),
        element.getAttribute('value'),
      ].map(normalize).filter(Boolean);

      if (!candidates.includes(expected)) continue;

      sequence += 1;
      element.setAttribute('data-agent-click-target', String(sequence));
      return String(sequence);
    }

    return null;
  }, target);

  if (!matched) return false;

  try {
    await page.locator(`[data-agent-click-target="${matched}"]`).click({ timeout: 5_000 });
    return true;
  } finally {
    await page.locator('[data-agent-click-target]').evaluateAll((elements) => {
      for (const element of elements) {
        element.removeAttribute('data-agent-click-target');
      }
    }).catch(() => {});
  }
}

async function clickVisibleContaining(page, label) {
  const target = normalizePolicyText(label);
  if (!target) return false;

  const selector = 'button, [role="button"], [role="combobox"], a[href], input[type="button"], input[type="submit"], [data-testid], div';
  const matched = await page.locator(selector).evaluateAll((elements, expected) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    let sequence = 0;
    for (const element of elements) {
      if (!(element instanceof HTMLElement) || !visible(element)) continue;

      const candidates = [
        element.innerText,
        element.textContent,
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.getAttribute('data-testid'),
        element.getAttribute('name'),
        element.getAttribute('value'),
        element.getAttribute('placeholder'),
      ].map(normalize).filter(Boolean);

      if (!candidates.some((candidate) => candidate.includes(expected))) continue;

      sequence += 1;
      element.setAttribute('data-agent-click-target', String(sequence));
      return String(sequence);
    }

    return null;
  }, target);

  if (!matched) return false;

  try {
    await page.locator(`[data-agent-click-target="${matched}"]`).click({ timeout: 5_000 });
    return true;
  } finally {
    await page.locator('[data-agent-click-target]').evaluateAll((elements) => {
      for (const element of elements) {
        element.removeAttribute('data-agent-click-target');
      }
    }).catch(() => {});
  }
}

async function isEnabledButtonByText(page, text) {
  return page.evaluate((expected) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    return Array.from(document.querySelectorAll('button'))
      .filter((el) => visible(el))
      .some((el) => normalize(el.innerText || el.textContent).includes(normalize(expected)) && !el.disabled);
  }, text).catch(() => false);
}

async function clickDatasetCard(page, aggregation) {
  const aggregationPattern = ({
    Point: /Point/i,
    Polygon: /Polygon/i,
    H3: /H3/i,
    'Administrative Area': /Admin\.?\s*Area|Administrative Area/i,
    Geohash: /Geohash/i,
    Line: /Line/i,
  })[aggregation] || new RegExp(aggregation, 'i');

  const cards = page.locator('div[role="button"]')
    .filter({ hasText: /BVT/i })
    .filter({ hasText: aggregationPattern });

  const count = await cards.count();
  const preferredTexts = aggregation === 'Polygon'
    ? [
        /Regional Planning RDTR Indonesia City/i,
        /Regional Planning RTRW Indonesia City/i,
      ]
    : [];

  for (const preferredText of preferredTexts) {
    const preferredCard = cards.filter({ hasText: preferredText }).first();
    if (await preferredCard.count()) {
      await preferredCard.click({ timeout: 5_000 }).catch(() => {});
      await sleep(800);
      return { clicked: true, reason: '' };
    }
  }

  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    await card.click({ timeout: 5_000 }).catch(() => {});
    await sleep(800);
    return { clicked: true, reason: '' };
  }
  return { clicked: false, reason: `No BVT dataset card found for ${aggregation}` };
}

async function listDatasetCardCandidates(page, aggregation) {
  const aggregationPattern = ({
    Point: /Point/i,
    Polygon: /Polygon/i,
    H3: /H3/i,
    'Administrative Area': /Admin\.?\s*Area|Administrative Area/i,
    Geohash: /Geohash/i,
    Line: /Line/i,
  })[aggregation] || new RegExp(aggregation, 'i');

  const cards = page.locator('div[role="button"]')
    .filter({ hasText: /BVT/i })
    .filter({ hasText: aggregationPattern });

  const count = await cards.count();
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    const text = await card.innerText().catch(() => '');
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) continue;
    const locked = await card.evaluate((element) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };

      const nodes = [element, ...Array.from(element.querySelectorAll('*'))];
      return nodes.some((node) => {
        if (!(node instanceof HTMLElement) || !visible(node)) return false;
        const label = normalize(
          node.getAttribute('aria-label')
          || node.getAttribute('title')
          || node.textContent,
        );
        if (label === 'locked' || label.includes('locked dataset')) return true;
        if (label === 'lock' || label === 'locked') return true;
        const classes = normalize(node.className || '');
        return classes.includes('lock');
      });
    }).catch(() => false);
    const title = normalized.split(/Polygon|Point|H3|Administrative Area|Admin\. Area|Geohash|Line/i)[0].trim() || normalized;
    candidates.push({
      id: `${aggregation}:${index}:${title.toLowerCase()}`,
      index,
      title,
      text: normalized,
      signature: normalized.slice(0, 240),
      locked,
    });
  }

  const unique = uniqueBy(candidates, (item) => item.id);
  const preferredTitles = aggregation === 'Polygon'
    ? [
        'Regional Planning RDTR Indonesia City',
        'Regional Planning RTRW Indonesia City',
      ]
    : [];

  return unique.sort((a, b) => {
    const aIndex = preferredTitles.findIndex((item) => item.toLowerCase() === a.title.toLowerCase());
    const bIndex = preferredTitles.findIndex((item) => item.toLowerCase() === b.title.toLowerCase());
    if (aIndex !== -1 || bIndex !== -1) {
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;
      return aIndex - bIndex;
    }
    if (a.locked !== b.locked) return a.locked ? 1 : -1;
    return a.title.localeCompare(b.title);
  });
}

async function openDatasetExplorerBase(page) {
  await clickVisibleActionable(page, 'Dataset Explorer').catch(() => false);
  await waitBrieflyForIdle(page);
  await sleep(500);
  await clickVisibleContaining(page, 'Bvarta & Partner Data').catch(() => false);
  await sleep(300);
}

async function openAnalysisBase(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await waitBrieflyForIdle(page);
  await sleep(500);
  await dismissTransientUi(page).catch(() => []);
  const analysisVisible = await page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const required = ['Filter Area', 'Data Selection', 'Spatial Settings', 'Generate Results'];
    const texts = Array.from(document.querySelectorAll('body *'))
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => visible(el))
      .map((el) => normalize(el.textContent))
      .filter(Boolean);
    return required.every((item) => texts.includes(item));
  }).catch(() => false);

  if (!analysisVisible) {
    await clickVisibleActionable(page, 'Analysis').catch(() => false);
    await waitBrieflyForIdle(page);
    await sleep(500);
  }
}

async function resetAnalysisState(page, baseUrl) {
  await openAnalysisBase(page, baseUrl);

  const resetButton = await findFirstUsable(
    page,
    [
      'button:has-text("Reset Analysis")',
      '[data-testid="reset-analysis-button"]',
    ],
    async (locator) => (await locator.isVisible()) && (await locator.isEnabled()),
  );

  if (!resetButton) {
    return { reset: false, reason: 'Reset Analysis button not found' };
  }

  const clicked = await resetButton.click({ timeout: 5_000 }).then(() => true).catch(() => false);
  if (!clicked) {
    return { reset: false, reason: 'Failed to click Reset Analysis' };
  }

  await sleep(1_000);
  await dismissTransientUi(page).catch(() => []);
  await sleep(500);
  await openAnalysisBase(page, baseUrl);

  const cleared = await page.getByText(/No datasets yet\./i).first().isVisible().catch(() => false);
  return {
    reset: cleared,
    reason: cleared ? '' : 'Analysis did not return to empty state after reset',
  };
}

async function readAnalysisResultState(page, expectedDatasetTitle = 'Bank and Financial 2025') {
  return page.locator('body *').evaluateAll((elements, expectedDataset) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    const visibleElements = elements
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => visible(el));

    const heading = visibleElements.find((el) => normalize(el.textContent) === 'analysis result');
    let panelRoot = heading?.parentElement || null;
    while (panelRoot && panelRoot instanceof HTMLElement && panelRoot.querySelectorAll('button, a, input').length < 3) {
      panelRoot = panelRoot.parentElement;
    }

    const panelElements = panelRoot
      ? Array.from(panelRoot.querySelectorAll('*'))
        .filter((el) => el instanceof HTMLElement)
        .filter((el) => visible(el))
      : [];

    const texts = (panelElements.length ? panelElements : visibleElements)
      .flatMap((el) => [
        String(el.innerText || el.textContent || ''),
        String(el.getAttribute?.('aria-label') || ''),
        String(el.getAttribute?.('title') || ''),
        String(el.getAttribute?.('value') || ''),
      ])
      .map((text) => String(text).replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    const normalizedTexts = Array.from(new Set(texts.map((text) => normalize(text)).filter(Boolean)));
    return {
      hasAnalysisResult: Boolean(heading),
      hasSpatialAnalysisResultCard: normalizedTexts.some((text) => text === 'spatial analysis result' || text.includes('spatial analysis result')),
      hasDatasetCard: normalizedTexts.some((text) => text === normalize(expectedDataset) || text.includes(normalize(expectedDataset))),
      hasEditInput: normalizedTexts.includes('edit input'),
    };
  }, expectedDatasetTitle).catch(() => ({
    hasAnalysisResult: false,
    hasSpatialAnalysisResultCard: false,
    hasDatasetCard: false,
    hasEditInput: false,
  }));
}

async function waitForAnalysisResultState(page, expectedDatasetTitle = 'Bank and Financial 2025', timeoutMs = 45_000) {
  const startedAt = Date.now();
  let lastState = await readAnalysisResultState(page, expectedDatasetTitle);
  while (Date.now() - startedAt < timeoutMs) {
    if (lastState.hasSpatialAnalysisResultCard && lastState.hasDatasetCard) {
      return lastState;
    }
    await sleep(500);
    lastState = await readAnalysisResultState(page, expectedDatasetTitle);
  }
  return lastState;
}

async function returnToAnalysisInput(page, baseUrl, expectedDatasetTitle = 'Bank and Financial 2025') {
  async function analysisVisibleNow() {
    return page.getByText(/Data Selection/i).first().isVisible().catch(() => false);
  }

  async function readResultPanelState() {
    return readAnalysisResultState(page, expectedDatasetTitle);
  }

  async function clickEditInputControl() {
    const marked = await page.locator('body *').evaluateAll((elements) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };

      const candidates = elements
        .filter((el) => el instanceof HTMLElement)
        .filter((el) => visible(el))
        .filter((el) => ['A', 'BUTTON', 'SPAN'].includes(el.tagName));

      for (const element of candidates) {
        const text = normalize(element.innerText || element.textContent || '');
        if (text !== 'edit input') continue;
        element.setAttribute('data-agent-edit-input', 'true');
        return {
          tagName: element.tagName,
          className: element.className || '',
          text,
        };
      }

      return null;
    }).catch(() => null);

    if (!marked) return false;
    const clicked = await page.locator('[data-agent-edit-input="true"]').click({ timeout: 5_000 }).then(() => true).catch(() => false);
    await page.locator('[data-agent-edit-input]').evaluateAll((elements) => {
      for (const element of elements) {
        element.removeAttribute('data-agent-edit-input');
      }
    }).catch(() => {});
    return clicked;
  }

  async function confirmUnsavedChangesLeave() {
    const marked = await page.locator('body *').evaluateAll((elements) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };

      const dialogVisible = elements
        .filter((el) => el instanceof HTMLElement)
        .filter((el) => visible(el))
        .some((el) => normalize(el.textContent).includes('unsaved changes'));
      if (!dialogVisible) return null;

      for (const element of elements) {
        if (!(element instanceof HTMLElement) || !visible(element)) continue;
        const text = normalize(element.innerText || element.textContent || '');
        if (text !== 'leave') continue;
        element.setAttribute('data-agent-unsaved-leave', 'true');
        return 'true';
      }
      return null;
    }).catch(() => null);

    if (!marked) return false;
    const clicked = await page.locator('[data-agent-unsaved-leave="true"]').click({ timeout: 5_000 }).then(() => true).catch(() => false);
    await page.locator('[data-agent-unsaved-leave]').evaluateAll((elements) => {
      for (const element of elements) {
        element.removeAttribute('data-agent-unsaved-leave');
      }
    }).catch(() => {});
    if (clicked) {
      await sleep(1_000);
    }
    return clicked;
  }

  async function closeAnalysisResultPanel() {
    const marked = await page.locator('body *').evaluateAll((elements) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };

      const heading = elements
        .filter((el) => el instanceof HTMLElement)
        .filter((el) => visible(el))
        .find((el) => normalize(el.textContent) === 'analysis result');
      if (!(heading instanceof HTMLElement)) return null;

      let root = heading.parentElement;
      while (root && !Array.from(root.querySelectorAll('button')).some((button) => visible(button))) {
        root = root.parentElement;
      }
      if (!(root instanceof HTMLElement)) return null;

      const buttons = Array.from(root.querySelectorAll('button'))
        .filter((button) => button instanceof HTMLElement && visible(button));
      const closeButton = buttons.find((button) => {
        const label = normalize(button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent);
        return label === 'close' || label === 'x' || label.includes('close');
      }) || buttons[0];

      if (!(closeButton instanceof HTMLElement)) return null;
      closeButton.setAttribute('data-agent-analysis-result-close', 'true');
      return 'true';
    }).catch(() => null);

    if (!marked) return false;
    const clicked = await page.locator('[data-agent-analysis-result-close="true"]').click({ timeout: 5_000 }).then(() => true).catch(() => false);
    await page.locator('[data-agent-analysis-result-close]').evaluateAll((elements) => {
      for (const element of elements) {
        element.removeAttribute('data-agent-analysis-result-close');
      }
    }).catch(() => {});
    if (clicked) {
      await sleep(800);
    }
    return clicked;
  }

  const resultPanelState = await readResultPanelState();
  const resultPanelReady = resultPanelState.hasAnalysisResult
    && resultPanelState.hasSpatialAnalysisResultCard
    && resultPanelState.hasDatasetCard
    && resultPanelState.hasEditInput;

  let clickedEditInput = false;
  let clickedLeave = false;
  if (resultPanelReady) {
    clickedEditInput = await clickEditInputControl();
    if (clickedEditInput) {
      await sleep(1_200);
      clickedLeave = await confirmUnsavedChangesLeave();
      const analysisVisible = await analysisVisibleNow();
      if (analysisVisible) {
        return {
          restored: true,
          method: clickedLeave ? 'edit-input+leave' : 'edit-input',
          reason: '',
          verification: resultPanelState,
        };
      }
    }
  }

  await openAnalysisBase(page, baseUrl);
  let analysisVisible = await analysisVisibleNow();
  let closeResultTried = false;
  if (!analysisVisible) {
    closeResultTried = await closeAnalysisResultPanel();
    if (closeResultTried) {
      await openAnalysisBase(page, baseUrl);
      analysisVisible = await analysisVisibleNow();
    }
  }
  return {
    restored: analysisVisible,
    method: clickedEditInput
      ? (clickedLeave
        ? (closeResultTried ? 'edit-input+leave+open-analysis+close-result' : 'edit-input+leave+open-analysis')
        : (closeResultTried ? 'edit-input+open-analysis+close-result' : 'edit-input+open-analysis'))
      : (closeResultTried ? 'open-analysis+close-result' : 'open-analysis'),
    verification: resultPanelState,
    reason: analysisVisible
      ? ''
      : (clickedEditInput
        ? 'Edit Input flow did not restore Analysis inputs, and reopening Analysis still failed'
        : (!resultPanelReady
          ? 'Analysis Result panel was not fully verified before attempting return to input'
          : 'Analysis inputs were not visible after reopening Analysis')),
  };
}

async function readVisibleAnalysisSections(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    const targets = ['Filter Area', 'Data Selection', 'Spatial Settings', 'Generate Results'];
    const visibleTexts = Array.from(document.querySelectorAll('body *'))
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => visible(el))
      .map((el) => normalize(el.textContent))
      .filter(Boolean);

    return targets.filter((target) => visibleTexts.includes(target));
  }).catch(() => []);
}

async function chooseAdminAreaCountry(page, country = 'Indonesia') {
  async function countryLooksSelected(locator) {
    const value = locator ? await locator.inputValue().catch(() => '') : '';
    if (String(value || '').trim().toLowerCase() === String(country || '').trim().toLowerCase()) return true;
    return hasVisibleEditable(page, [
      'input[name="admin-area-1"]',
      'input[placeholder*="Province" i]',
      'input[aria-label="Search Province"]',
    ]);
  }

  async function clickCountryOption() {
    const exactPattern = new RegExp(`^${String(country).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const directLocators = [
      page.getByRole('menuitem', { name: exactPattern }).first(),
      page.getByRole('option', { name: exactPattern }).first(),
      page.getByText(exactPattern).last(),
    ];

    for (const locator of directLocators) {
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      const clicked = await locator.click({ timeout: 5_000 }).then(() => true).catch(() => false);
      if (clicked) return true;
    }

    const selected = await page.locator('[role="menuitem"], [cmdk-item], [data-radix-collection-item]')
      .evaluateAll((elements, expected) => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const visible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };

        let sequence = 0;
        for (const element of elements) {
          if (!(element instanceof HTMLElement) || !visible(element)) continue;
          const text = normalize(element.innerText || element.textContent);
          if (text !== normalize(expected)) continue;
          sequence += 1;
          element.setAttribute('data-agent-country-target', String(sequence));
          return String(sequence);
        }
        return null;
      }, country)
      .catch(() => null);

    if (!selected) return false;
    const clicked = await page.locator(`[data-agent-country-target="${selected}"]`).click({ timeout: 5_000 }).then(() => true).catch(() => false);
    await page.locator('[data-agent-country-target]').evaluateAll((elements) => {
      for (const element of elements) {
        element.removeAttribute('data-agent-country-target');
      }
    }).catch(() => {});
    return clicked;
  }

  const existingCountry = await findFirstUsable(
    page,
    [
      'input[placeholder*="Country" i]',
      'input[placeholder=" Country"]',
      'input[aria-label="Country"]',
    ],
    async (locator) => (await locator.isVisible()),
  );
  const existingValue = existingCountry
    ? await existingCountry.inputValue().catch(() => '')
    : '';
  const provinceVisible = await hasVisibleEditable(page, [
    'input[name="admin-area-1"]',
    'input[placeholder*="Province" i]',
    'input[aria-label="Search Province"]',
  ]);
  if (String(existingValue || '').trim().toLowerCase() === String(country).trim().toLowerCase() && provinceVisible) {
    return true;
  }

  let countryInput = existingCountry;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!countryInput || !(await countryInput.isEditable().catch(() => false))) {
      const trigger = await findFirstUsable(
        page,
        [
          '[data-testid="admin-area-settings-popup"] button',
          'button:has(input[placeholder*="Country" i])',
          'button:has(input[placeholder=" Country"])',
          'button:has-text("Country")',
        ],
        async (locator) => (await locator.isVisible()),
      );
      if (trigger) {
        await trigger.click({ timeout: 5_000 }).catch(() => {});
        await sleep(300);
      }
    }

    countryInput = await findFirstUsable(
      page,
      [
        'input[placeholder*="Country" i]',
        'input[placeholder=" Country"]',
        'input[aria-label="Country"]',
      ],
      async (locator) => (await locator.isVisible()) && (await locator.isEditable()),
    );

    if (!countryInput) continue;
    await countryInput.click({ timeout: 5_000 }).catch(() => {});
    await countryInput.fill(country, { timeout: 5_000 }).catch(() => {});
    await sleep(500);
    await clickCountryOption();
    await sleep(600);
    if (await countryLooksSelected(countryInput)) return true;
  }

  return false;
}

async function setGlobalFilterArea(page, country = 'Indonesia', province = config.datasetExplorerProvince) {
  async function waitForProvinceSelector() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const ready = await hasVisibleEditable(page, [
        'input[name="admin-area-1"]',
        'input[placeholder*="Province" i]',
        'input[aria-label="Search Province"]',
      ]);
      if (ready) return true;
      await sleep(500);
    }
    return false;
  }

  let lastResult = { opened: false, countrySelected: false, provinceSelected: false, saved: false, reason: 'Filter area trigger not found' };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const trigger = await findFirstUsable(
      page,
      [
        '[data-testid="global-filter-set-filter-area-button"]',
        'button:has-text("Set Filter Area")',
        'button:has-text("Edit Filter Area")',
      ],
      async (locator) => (await locator.isVisible()) && (await locator.isEnabled()),
    );

    if (!trigger) {
      lastResult = { opened: false, countrySelected: false, provinceSelected: false, saved: false, reason: 'Filter area trigger not found' };
      continue;
    }

    const opened = await trigger.click({ timeout: 5_000 }).then(() => true).catch(() => false);
    if (!opened) {
      lastResult = { opened: false, countrySelected: false, provinceSelected: false, saved: false, reason: 'Failed to open filter area dialog' };
      continue;
    }
    await sleep(500);

    const countrySelected = await chooseAdminAreaCountry(page, country);
    if (countrySelected) {
      await waitForProvinceSelector();
    }
    const provinceSelected = countrySelected ? await chooseProvince(page, { requireDatasetButtons: false }) : false;

    const saveButton = await findFirstUsable(
      page,
      [
        '[data-testid="admin-area-settings-popup-save-button"]',
        'button:has-text("Save")',
      ],
      async (locator) => (await locator.isVisible()) && (await locator.isEnabled()),
    );

    if (!saveButton) {
      lastResult = { opened: true, countrySelected, provinceSelected, saved: false, reason: 'Save filter area button disabled' };
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(400);
      continue;
    }

    const saved = await saveButton.click({ timeout: 5_000 }).then(() => true).catch(() => false);
    await sleep(800);
    const configured = await page.locator('body').evaluate((body, expectedProvince) => {
      const text = String(body.innerText || body.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      return text.includes(String(expectedProvince || '').trim().toLowerCase());
    }, province).catch(() => false);

    lastResult = {
      opened: true,
      countrySelected,
      provinceSelected,
      saved: saved && configured,
      reason: saved && configured ? '' : 'Filter area did not persist after save',
    };
    if (lastResult.saved) return lastResult;
  }

  return lastResult;
}

async function activateDrawPolygonMode(page) {
  const clicked = await clickVisibleActionable(page, 'Draw Polygon').catch(() => false);
  if (!clicked) {
    return { activated: false, exited: false, reason: 'Draw Polygon button not found' };
  }

  await sleep(700);
  const activated = await Promise.any([
    page.getByText(/Custom Polygon/i).first().isVisible().then(() => true),
    page.getByRole('button', { name: /^Select$/i }).first().isVisible().then(() => true),
    page.getByRole('button', { name: /^Polygon$/i }).first().isVisible().then(() => true),
  ]).catch(() => false);

  let exited = false;
  if (activated) {
    exited = await clickVisibleActionable(page, 'Select').catch(() => false);
    if (!exited) {
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(300);
      exited = true;
    }
  }

  return {
    activated,
    exited,
    reason: activated ? '' : 'Polygon drawing mode did not show expected controls',
  };
}

async function openAnalysisAddDataset(page) {
  const sectionScopedTarget = await page.locator('body *').evaluateAll((elements) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    const visibleElements = elements
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => visible(el));
    const heading = visibleElements.find((el) => normalize(el.textContent) === 'data selection');
    if (!(heading instanceof HTMLElement)) return null;

    let sectionRoot = heading.parentElement;
    while (sectionRoot && !Array.from(sectionRoot.querySelectorAll('button')).some((button) => normalize(button.textContent).includes('add dataset'))) {
      sectionRoot = sectionRoot.parentElement;
    }

    if (!(sectionRoot instanceof HTMLElement)) return null;
    const button = Array.from(sectionRoot.querySelectorAll('button'))
      .find((item) => item instanceof HTMLElement && visible(item) && normalize(item.textContent).includes('add dataset'));
    if (!(button instanceof HTMLElement)) return null;

    button.setAttribute('data-agent-analysis-add-dataset', 'true');
    return 'true';
  }).catch(() => null);

  const opened = sectionScopedTarget
    ? await page.locator('[data-agent-analysis-add-dataset="true"]').click({ timeout: 5_000 }).then(() => true).catch(() => false)
    : await clickVisibleActionable(page, 'Add Dataset').catch(() => false);
  await page.locator('[data-agent-analysis-add-dataset]').evaluateAll((elements) => {
    for (const element of elements) {
      element.removeAttribute('data-agent-analysis-add-dataset');
    }
  }).catch(() => {});
  if (!opened) {
    return { opened: false, reason: 'Add Dataset button not found' };
  }
  await sleep(800);
  const datasetExplorerVisible = await Promise.any([
    page.getByText(/Dataset\s*Explorer/i).first().isVisible().then(() => true),
    page.locator('input[placeholder*="search datasets" i]').first().isVisible().then(() => true),
    page.getByText(/Attribute Filter/i).first().isVisible().then(() => true),
  ]).catch(() => false);
  return {
    opened: datasetExplorerVisible,
    reason: datasetExplorerVisible ? '' : 'Dataset Explorer modal did not open from Analysis',
  };
}

async function expandSpatialSettings(page) {
  const alreadyExpanded = await page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    const expected = ['Area Input', 'Output Analysis', 'Resolution Settings'];
    const texts = Array.from(document.querySelectorAll('body *'))
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => visible(el))
      .map((el) => normalize(el.textContent))
      .filter(Boolean);

    return expected.every((item) => texts.some((text) => text === item || text.includes(item)));
  }).catch(() => false);

  const toggleMarked = await page.locator('body *').evaluateAll((elements) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    const visibleElements = elements
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => visible(el));

    const directToggle = visibleElements.find((el) => {
      if (!(el instanceof HTMLButtonElement)) return false;
      const texts = [
        el.innerText,
        el.textContent,
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
      ].map(normalize).filter(Boolean);
      return texts.some((text) => text.includes('toggle spatial settings section') || text === 'spatial settings');
    });

    const target = directToggle || (() => {
      const heading = visibleElements.find((el) => normalize(el.textContent) === 'spatial settings');
      if (!(heading instanceof HTMLElement)) return null;
      const parent = heading.parentElement;
      if (!(parent instanceof HTMLElement)) return null;
      return Array.from(parent.querySelectorAll('button'))
        .find((button) => button instanceof HTMLElement && visible(button)) || null;
    })();

    if (!(target instanceof HTMLElement)) return null;
    target.setAttribute('data-agent-spatial-settings-toggle', 'true');
    return 'true';
  }).catch(() => null);

  const clicked = alreadyExpanded
    ? true
    : (
      toggleMarked
        ? await page.locator('[data-agent-spatial-settings-toggle="true"]').click({ timeout: 5_000 }).then(() => true).catch(() => false)
        : await clickVisibleContaining(page, 'Spatial Settings').catch(() => false)
    );
  await page.locator('[data-agent-spatial-settings-toggle]').evaluateAll((elements) => {
    for (const element of elements) {
      element.removeAttribute('data-agent-spatial-settings-toggle');
    }
  }).catch(() => {});
  if (!clicked) {
    return { expanded: false, reason: 'Spatial Settings toggle not found' };
  }
  await sleep(700);

  const details = await page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const expected = [
      'Area Input',
      'Define by',
      'Set Polygon Area',
      'Output Analysis',
      'Grid',
      'Profiling',
      'Geohash',
      'H3',
      'Resolution Settings',
      'Setting Data Weight',
    ];

    const texts = Array.from(document.querySelectorAll('body *'))
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => visible(el))
      .map((el) => normalize(el.textContent))
      .filter(Boolean);

    const uniqueTexts = Array.from(new Set(texts));
    const visibleItems = expected.filter((item) => uniqueTexts.some((text) => text === item || text.includes(item)));
    const generateEnabled = Array.from(document.querySelectorAll('button'))
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => visible(el))
      .some((el) => normalize(el.textContent).includes('Generate Results') && !el.disabled);

    return {
      visibleItems,
      generateEnabled,
      polygonMissingPrompt: uniqueTexts.some((text) => text.includes("You haven't drawn a custom polygon yet")),
    };
  }).catch(() => ({ visibleItems: [], generateEnabled: false, polygonMissingPrompt: false }));

  const currentDefineBy = await page.locator('body *').evaluateAll((elements) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    const visibleElements = elements
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => visible(el));
    const defineBy = visibleElements.find((el) => normalize(el.textContent) === 'Define by');
    const areaInput = visibleElements.find((el) => normalize(el.textContent) === 'Area Input');
    const outputAnalysis = visibleElements.find((el) => normalize(el.textContent) === 'Output Analysis');
    if (!(defineBy instanceof HTMLElement) || !(areaInput instanceof HTMLElement)) return '';

    const labelRect = defineBy.getBoundingClientRect();
    const outputTop = outputAnalysis instanceof HTMLElement ? outputAnalysis.getBoundingClientRect().top : labelRect.bottom + 140;
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"], [aria-haspopup], input, div'))
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => visible(el))
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = normalize(
          el.getAttribute('value')
          || el.getAttribute('aria-label')
          || el.textContent,
        );
        return {
          element: el,
          text,
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        };
      })
      .filter((item) => item.width > 120 && item.height > 24 && item.height <= 90)
      .filter((item) => item.top >= labelRect.top - 8 && item.top <= outputTop - 8)
      .filter((item) => Math.abs(item.left - labelRect.left) <= 40)
      .sort((left, right) => left.top - right.top || left.left - right.left);

    const value = (candidates[0]?.text || '').replace(/\s*Define by\s*$/i, '').trim();
    return value === 'Define by' ? '' : value;
  }).catch(() => '');

  const defineByButtonMarked = await page.locator('body *').evaluateAll((elements) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    const visibleElements = elements
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => visible(el));
    const defineBy = visibleElements.find((el) => normalize(el.textContent) === 'Define by');
    const areaInput = visibleElements.find((el) => normalize(el.textContent) === 'Area Input');
    const outputAnalysis = visibleElements.find((el) => normalize(el.textContent) === 'Output Analysis');
    if (!(defineBy instanceof HTMLElement) || !(areaInput instanceof HTMLElement)) return null;

    const labelRect = defineBy.getBoundingClientRect();
    const outputTop = outputAnalysis instanceof HTMLElement ? outputAnalysis.getBoundingClientRect().top : labelRect.bottom + 140;
    const control = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"], [aria-haspopup], input, div'))
      .filter((item) => item instanceof HTMLElement)
      .filter((item) => visible(item))
      .find((item) => {
        const rect = item.getBoundingClientRect();
        const text = normalize(
          item.getAttribute('value')
          || item.getAttribute('aria-label')
          || item.textContent,
        );
        return rect.width > 120
          && rect.height > 24
          && rect.height <= 90
          && rect.top >= labelRect.top - 8
          && rect.top <= outputTop - 8
          && Math.abs(rect.left - labelRect.left) <= 40;
      });
    if (!(control instanceof HTMLElement)) return null;
    control.setAttribute('data-agent-define-by-target', 'true');
    return 'true';
  }).catch(() => null);

  let defineByOptions = [];
  if (defineByButtonMarked) {
    const opened = await page.locator('[data-agent-define-by-target="true"]').click({ timeout: 5_000 }).then(() => true).catch(() => false);
    await page.locator('[data-agent-define-by-target]').evaluateAll((elements) => {
      for (const element of elements) {
        element.removeAttribute('data-agent-define-by-target');
      }
    }).catch(() => {});

    if (opened) {
      await sleep(300);
      defineByOptions = await page.evaluate(() => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };

        const optionTexts = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [cmdk-item], [data-radix-collection-item], button'))
          .filter((el) => el instanceof HTMLElement)
          .filter((el) => visible(el))
          .map((el) => normalize(el.textContent))
          .filter(Boolean);

        return Array.from(new Set(optionTexts.filter((text) => ['Administrative Area', 'Catchment', 'Polygon'].includes(text))));
      }).catch(() => []);
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(200);
    }
  }

  const outputAnalysis = await page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    const visibleElements = Array.from(document.querySelectorAll('body *'))
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => visible(el));
    const label = visibleElements.find((el) => normalize(el.textContent) === 'Output Analysis');
    if (!(label instanceof HTMLElement)) {
      return { options: [], descriptions: {} };
    }

    let root = label.parentElement;
    while (root && !Array.from(root.querySelectorAll('*')).some((el) => visible(el) && /Geohash|H3|Grid|Profiling/i.test(normalize(el.textContent)))) {
      root = root.parentElement;
    }
    if (!(root instanceof HTMLElement)) {
      return { options: [], descriptions: {} };
    }

    const texts = Array.from(root.querySelectorAll('*'))
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => visible(el))
      .map((el) => normalize(el.textContent))
      .filter(Boolean);
    const uniqueTexts = Array.from(new Set(texts));
    const optionNames = ['Grid', 'Profiling', 'Geohash', 'H3'];
    const options = optionNames.filter((name) => uniqueTexts.some((text) => text === name || text.includes(name)));
    const descriptions = {};

    for (const name of optionNames) {
      const detail = uniqueTexts.find((text) => (
        text.startsWith(name)
        && text.length > name.length + 8
        && !['Grid', 'Profiling', 'Geohash', 'H3'].includes(text)
      ));
      if (detail) {
        descriptions[name] = detail.replace(new RegExp(`^${name}\\s*`, 'i'), '').trim();
      }
    }

    const helper = uniqueTexts.find((text) => text.includes('Select your preferred output visualization'));
    return {
      options,
      descriptions,
      helperText: helper || '',
    };
  }).catch(() => ({ options: [], descriptions: {}, helperText: '' }));

  const expanded = details.visibleItems.length > 0;
  return {
    expanded,
    ...details,
    currentDefineBy,
    defineByOptions,
    outputAnalysis,
    reason: expanded ? '' : 'Spatial Settings did not reveal expected configuration controls',
  };
}

async function chooseDefineByOption(page, option = 'Administrative Area') {
  async function debugDefineByState(stage) {
    const state = await page.locator('body').evaluate((body, currentStage) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };

      const all = Array.from(document.querySelectorAll('body *')).filter((el) => visible(el));
      const defineBy = all.find((el) => normalize(el.textContent) === 'Define by');
      const areaInput = all.find((el) => normalize(el.textContent) === 'Area Input');
      const outputAnalysis = all.find((el) => normalize(el.textContent) === 'Output Analysis');
      if (!(defineBy instanceof HTMLElement)) {
        return { stage: currentStage, error: 'Define by label not found' };
      }
      const labelRect = defineBy.getBoundingClientRect();
      const outputTop = outputAnalysis instanceof HTMLElement ? outputAnalysis.getBoundingClientRect().top : labelRect.bottom + 140;
      const band = all.map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          role: el.getAttribute('role') || '',
          text: normalize(el.textContent || el.getAttribute('value') || ''),
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      }).filter((item) => item.top >= labelRect.top - 8 && item.top <= outputTop + 8).slice(0, 40);
      const controls = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"], [aria-haspopup], input, div'))
        .filter((el) => visible(el))
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            role: el.getAttribute('role') || '',
            popup: el.getAttribute('aria-haspopup') || '',
            expanded: el.getAttribute('aria-expanded') || '',
            text: normalize(el.getAttribute('value') || el.getAttribute('aria-label') || el.textContent),
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        })
        .filter((item) => item.width > 120 && item.height > 24 && item.height <= 90)
        .filter((item) => item.top >= labelRect.top - 8 && item.top <= outputTop - 8)
        .filter((item) => Math.abs(item.left - labelRect.left) <= 60)
        .slice(0, 12);
      const options = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [cmdk-item], [data-radix-collection-item], button, div'))
        .filter((el) => visible(el))
        .map((el) => normalize(el.textContent))
        .filter(Boolean)
        .filter((text) => ['Administrative Area', 'Catchment', 'Polygon'].includes(text));
      return {
        stage: currentStage,
        labelRect: { top: Math.round(labelRect.top), left: Math.round(labelRect.left), bottom: Math.round(labelRect.bottom) },
        areaRect: areaInput instanceof HTMLElement ? {
          top: Math.round(areaInput.getBoundingClientRect().top),
          left: Math.round(areaInput.getBoundingClientRect().left),
          bottom: Math.round(areaInput.getBoundingClientRect().bottom),
        } : null,
        outputTop: Math.round(outputTop),
        band,
        controls,
        options: Array.from(new Set(options)),
        bodySnippet: normalize(body.innerText || body.textContent || '').slice(0, 500),
      };
    }, stage).catch((error) => ({ stage, error: error.message }));
    console.log(`[define-by-debug] ${JSON.stringify(state)}`);
  }

  async function downstreamStateMatches(expected) {
    return page.locator('body').evaluate((body, expected) => {
      const text = String(body.innerText || body.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const target = String(expected || '').trim().toLowerCase();
      if (target === 'administrative area') {
        return text.includes('administrative area');
      }
      if (target === 'catchment') {
        return text.includes('set catchment')
          || text.includes('input location by')
          || text.includes('catchment type')
          || (text.includes('list of marker') && text.includes('radius'));
      }
      if (target === 'polygon') {
        return text.includes('set polygon area');
      }
      return false;
    }, option).catch(() => false);
  }

  async function readCurrentDefineBy() {
    return page.locator('body *').evaluateAll((elements) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };

      const visibleElements = elements
        .filter((el) => el instanceof HTMLElement)
        .filter((el) => visible(el));
      const defineBy = visibleElements.find((el) => normalize(el.textContent) === 'Define by');
      const areaInput = visibleElements.find((el) => normalize(el.textContent) === 'Area Input');
      const outputAnalysis = visibleElements.find((el) => normalize(el.textContent) === 'Output Analysis');
      if (!(defineBy instanceof HTMLElement) || !(areaInput instanceof HTMLElement)) return '';

      const labelRect = defineBy.getBoundingClientRect();
      const outputTop = outputAnalysis instanceof HTMLElement ? outputAnalysis.getBoundingClientRect().top : labelRect.bottom + 140;
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"], [aria-haspopup], input, div'))
        .filter((el) => el instanceof HTMLElement)
        .filter((el) => visible(el))
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const text = normalize(el.textContent || el.getAttribute('value') || el.getAttribute('aria-label') || '');
          return { text, top: rect.top, left: rect.left, width: rect.width, height: rect.height };
        })
        .filter((item) => item.top >= labelRect.top - 8 && item.top <= outputTop - 8)
        .filter((item) => Math.abs(item.left - labelRect.left) <= 40)
        .filter((item) => item.width > 120 && item.height > 24 && item.height <= 90)
        .filter((item) => item.text);

      const value = (candidates.sort((left, right) => left.top - right.top || left.left - right.left)[0]?.text || '')
        .replace(/\s*Define by\s*$/i, '')
        .trim();
      return value === 'Define by' ? '' : value;
    }).catch(() => '');
  }

  async function valueMatches(expected) {
    const current = await readCurrentDefineBy();
    return String(current || '').trim().toLowerCase() === String(expected || '').trim().toLowerCase();
  }

  async function selectionConfirmed(expected) {
    if (String(expected || '').trim().toLowerCase() === 'administrative area') {
      return valueMatches(expected);
    }
    return (await valueMatches(expected)) || (await downstreamStateMatches(expected));
  }

  async function markDefineByControl(attributeName) {
    return page.locator('body *').evaluateAll((elements, marker) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };

      const visibleElements = elements
        .filter((el) => el instanceof HTMLElement)
        .filter((el) => visible(el));
      const defineBy = visibleElements.find((el) => normalize(el.textContent) === 'Define by');
      const outputAnalysis = visibleElements.find((el) => normalize(el.textContent) === 'Output Analysis');
      if (!(defineBy instanceof HTMLElement)) return null;
      const labelRect = defineBy.getBoundingClientRect();
      const outputTop = outputAnalysis instanceof HTMLElement ? outputAnalysis.getBoundingClientRect().top : labelRect.bottom + 140;
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"], [aria-haspopup], [aria-expanded], div'))
        .filter((el) => el instanceof HTMLElement)
        .filter((el) => visible(el))
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const text = normalize(el.textContent || el.getAttribute('aria-label') || el.getAttribute('value') || '');
          const horizontalDistance = Math.abs(rect.left - labelRect.left);
          const verticalDistance = rect.top - labelRect.top;
          return {
            el,
            text,
            popup: String(el.getAttribute('aria-haspopup') || ''),
            tag: el.tagName,
            horizontalDistance,
            verticalDistance,
            top: rect.top,
            height: rect.height,
            area: rect.width * rect.height,
          };
        })
        .filter((item) => item.top >= labelRect.top - 8 && item.top <= outputTop - 8)
        .filter((item) => item.horizontalDistance < 40)
        .filter((item) => item.height > 24 && item.height <= 90)
        .filter((item) => item.popup || item.tag === 'BUTTON' || item.text === 'Define by' || item.text === 'Dropdown menu');

      const best = candidates.sort((left, right) => {
        const leftPriority = left.popup ? 0 : (left.tag === 'BUTTON' ? 1 : 2);
        const rightPriority = right.popup ? 0 : (right.tag === 'BUTTON' ? 1 : 2);
        if (leftPriority !== rightPriority) return leftPriority - rightPriority;
        if (left.verticalDistance !== right.verticalDistance) return left.verticalDistance - right.verticalDistance;
        if (left.horizontalDistance !== right.horizontalDistance) return left.horizontalDistance - right.horizontalDistance;
        return right.area - left.area;
      })[0];

      if (!(best?.el instanceof HTMLElement)) return null;
      best.el.setAttribute(marker, 'true');
      return 'true';
    }, attributeName).catch(() => null);
  }

  const current = await readCurrentDefineBy();

  if (String(current || '').trim().toLowerCase() === String(option || '').trim().toLowerCase()) {
    return { selected: true, option, reason: '' };
  }

  const exactPattern = new RegExp(`^${String(option || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

  async function openDefineByDropdown() {
    const marker = 'data-agent-define-by-select';
    const marked = await markDefineByControl(marker);
    let clicked = false;
    if (marked) {
      clicked = await page.locator(`[${marker}="true"]`).click({ timeout: 5_000 }).then(() => true).catch(() => false);
    }
    await page.locator(`[${marker}]`).evaluateAll((elements, attr) => {
      for (const element of elements) {
        element.removeAttribute(attr);
      }
    }, marker).catch(() => {});
    if (!clicked) {
      const clickPoint = await page.locator('body *').evaluateAll((elements) => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };

        const visibleElements = elements
          .filter((el) => el instanceof HTMLElement)
          .filter((el) => visible(el));
        const defineBy = visibleElements.find((el) => normalize(el.textContent) === 'Define by');
        const outputAnalysis = visibleElements.find((el) => normalize(el.textContent) === 'Output Analysis');
        if (!(defineBy instanceof HTMLElement)) return null;
        const labelRect = defineBy.getBoundingClientRect();
        const y = Math.min(labelRect.top + 20, (outputAnalysis instanceof HTMLElement ? outputAnalysis.getBoundingClientRect().top : labelRect.bottom + 110) - 20);
        const x = labelRect.left + 120;
        const target = document.elementFromPoint(x, y);
        if (!(target instanceof HTMLElement)) return { x, y };
        const clickable = target.closest('button, [role="button"], [role="combobox"], [aria-haspopup], input, div');
        if (!(clickable instanceof HTMLElement)) return { x, y };
        const rect = clickable.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      }).catch(() => null);
      if (clickPoint) {
        clicked = await page.mouse.click(clickPoint.x, clickPoint.y).then(() => true).catch(() => false);
      }
    }
    if (!clicked) return false;
    await sleep(300);
    return true;
  }

  async function tryKeyboardSelection() {
    const order = ['Administrative Area', 'Catchment', 'Polygon'];
    const index = order.findIndex((item) => item.toLowerCase() === String(option || '').toLowerCase());
    if (index < 0) return false;
    await page.keyboard.press('Home').catch(() => {});
    await sleep(100);
    for (let step = 0; step < index; step += 1) {
      await page.keyboard.press('ArrowDown').catch(() => {});
      await sleep(100);
    }
    await page.keyboard.press('Enter').catch(() => {});
    await sleep(500);
    return selectionConfirmed(option);
  }

  async function tryDirectLocatorClick(locator) {
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) return false;
    const clicked = await locator.click({ timeout: 5_000 }).then(() => true).catch(() => false);
    if (!clicked) return false;
    await sleep(500);
    return selectionConfirmed(option);
  }

  async function tryCoordinateClick() {
    const point = await page.locator('body *').evaluateAll((elements, expected) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };

      for (const element of elements) {
        if (!(element instanceof HTMLElement) || !visible(element)) continue;
        const text = normalize(element.innerText || element.textContent || '');
        if (text !== normalize(expected)) continue;
        const rect = element.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      }
      return null;
    }, option).catch(() => null);

    if (!point) return false;
    await page.mouse.click(point.x, point.y).catch(() => {});
    await sleep(500);
    return valueMatches(option);
  }

  async function clickOptionByEvaluation() {
    const clicked = await page.locator('body *')
    .evaluateAll((elements, expected) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };

      let seq = 0;
      for (const element of elements) {
        if (!(element instanceof HTMLElement) || !visible(element)) continue;
        if (normalize(element.textContent) !== normalize(expected)) continue;
        seq += 1;
        element.setAttribute('data-agent-define-by-option', String(seq));
        return String(seq);
      }
      return null;
    }, option).catch(() => null);

    const clickedOption = clicked
      ? await page.locator(`[data-agent-define-by-option="${clicked}"]`).click({ timeout: 5_000 }).then(() => true).catch(() => false)
      : await clickVisibleContaining(page, option).catch(() => false);
    await page.locator('[data-agent-define-by-option]').evaluateAll((elements) => {
      for (const element of elements) {
        element.removeAttribute('data-agent-define-by-option');
      }
    }).catch(() => {});
    if (!clickedOption) return false;
    await sleep(500);
    return valueMatches(option);
  }

  const directOptionLocators = [
    page.getByRole('option', { name: exactPattern }).first(),
    page.getByRole('menuitem', { name: exactPattern }).first(),
    page.locator('[cmdk-item]').getByText(exactPattern).first(),
    page.locator('[data-radix-collection-item]').getByText(exactPattern).first(),
    page.getByText(exactPattern).last(),
  ];

  const attempts = [
    async () => {
      const openedNow = await openDefineByDropdown();
      if (!openedNow) return false;
      for (const locator of directOptionLocators) {
        if (await tryDirectLocatorClick(locator)) return true;
      }
      return false;
    },
    async () => {
      const openedNow = await openDefineByDropdown();
      if (!openedNow) return false;
      return tryCoordinateClick();
    },
    async () => {
      const openedNow = await openDefineByDropdown();
      if (!openedNow) return false;
      return clickOptionByEvaluation();
    },
    async () => {
      const openedNow = await openDefineByDropdown();
      if (!openedNow) return false;
      return tryKeyboardSelection();
    },
    async () => {
      const openedNow = await openDefineByDropdown();
      if (!openedNow) return false;
      const fallbackClicked = await clickVisibleContaining(page, option).catch(() => false);
      if (!fallbackClicked) return false;
      await sleep(500);
      return selectionConfirmed(option);
    },
  ];

  for (const attempt of attempts) {
    if (await attempt()) {
      return { selected: true, option, reason: '' };
    }
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(200);
  }

  await debugDefineByState('failed');
  return { selected: false, option, reason: `Define by selection did not persist: ${option}` };
}

async function readSpatialAnalysisConfigState(page) {
  return page.locator('body').evaluate((body) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const lower = (value) => normalize(value).toLowerCase();
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    const allVisible = Array.from(document.querySelectorAll('body *'))
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => visible(el));

    const bodyText = normalize(body.innerText || body.textContent || '');
    const bodyLower = bodyText.toLowerCase();

    const findLabeledControlText = (labelText) => {
      const label = allVisible.find((el) => lower(el.textContent) === lower(labelText));
      if (!(label instanceof HTMLElement)) return '';
      const labelRect = label.getBoundingClientRect();
      const outputAnalysis = allVisible.find((el) => lower(el.textContent) === 'output analysis');
      const regionTop = labelRect.top - 8;
      const regionBottom = labelText === 'Define by' && outputAnalysis instanceof HTMLElement
        ? outputAnalysis.getBoundingClientRect().top - 8
        : labelRect.bottom + 80;
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"], [aria-haspopup], input, div'))
        .filter((el) => el instanceof HTMLElement)
        .filter((el) => visible(el))
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            text: normalize(el.textContent || el.getAttribute('value') || el.getAttribute('aria-label') || ''),
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          };
        })
        .filter((item) => item.text)
        .filter((item) => item.width > 120 && item.height > 24 && item.height <= 90)
        .filter((item) => item.top >= regionTop && item.top <= regionBottom)
        .filter((item) => Math.abs(item.left - labelRect.left) <= 40);

      const value = candidates.sort((a, b) => a.top - b.top || a.left - b.left)[0]?.text || '';
      if (labelText === 'Define by' && value === 'Define by') return '';
      return value;
    };

    const defineByValue = findLabeledControlText('Define by').replace(/\s*Define by\s*$/i, '').trim();
    const resolutionValue = findLabeledControlText('Resolution Settings') || findLabeledControlText('Resolution');

    const selectedOutputType = (() => {
      const checked = Array.from(document.querySelectorAll('input[type="radio"]'))
        .find((input) => input instanceof HTMLInputElement && input.checked);
      if (checked instanceof HTMLInputElement) {
        const container = checked.closest('label, div');
        const text = normalize(container?.textContent || '');
        if (/Geohash/i.test(text)) return 'Geohash';
        if (/\bH3\b/i.test(text)) return 'H3';
      }

      for (const type of ['Geohash', 'H3']) {
        const el = allVisible.find((node) => {
          const text = lower(node.textContent);
          if (!(text === type.toLowerCase() || text.startsWith(`${type.toLowerCase()} `))) return false;
          const radio = node.querySelector('input[type="radio"]');
          if (radio instanceof HTMLInputElement) return radio.checked;
          const aria = node.getAttribute('aria-checked');
          if (aria === 'true') return true;
          return /selected|checked|active/.test(String(node.className || '').toLowerCase());
        });
        if (el) return type;
      }
      return '';
    })();

    const selectedOutputMode = (() => {
      for (const mode of ['Grid', 'Profiling']) {
        const el = allVisible.find((node) => lower(node.textContent) === mode.toLowerCase());
        if (!el) continue;
        const className = String(el.className || '').toLowerCase();
        const aria = String(el.getAttribute('aria-pressed') || el.getAttribute('aria-checked') || '').toLowerCase();
        if (aria === 'true' || /selected|active|checked/.test(className)) return mode;
      }
      return '';
    })();

    const hasCatchmentSummary = (() => {
      const spatialSettings = allVisible.find((node) => lower(node.textContent) === 'spatial settings');
      const outputAnalysis = allVisible.find((node) => lower(node.textContent) === 'output analysis');
      if (!(spatialSettings instanceof HTMLElement) || !(outputAnalysis instanceof HTMLElement)) {
        return false;
      }
      const top = spatialSettings.getBoundingClientRect().bottom;
      const bottom = outputAnalysis.getBoundingClientRect().top;
      const regionTexts = allVisible
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.top >= top - 8 && rect.bottom <= bottom + 8;
        })
        .filter((node) => !node.closest('[role="dialog"]'))
        .map((node) => normalize(node.textContent))
        .join(' ')
        .toLowerCase();
      return regionTexts.includes('coordinate')
        && regionTexts.includes('catchment type')
        && regionTexts.includes('radius')
        && !regionTexts.includes('list of marker')
        && !regionTexts.includes('input location by');
    })();

    return {
      defineByValue,
      selectedOutputMode,
      selectedOutputType,
      resolutionValue,
      hasCatchmentSummary,
      hasAreaError: bodyLower.includes('area not selected'),
      hasResolutionError: bodyLower.includes('resolution not selected'),
      hasResultPanel: bodyLower.includes('analysis result'),
    };
  }).catch(() => ({
    defineByValue: '',
    selectedOutputMode: '',
    selectedOutputType: '',
    resolutionValue: '',
    hasCatchmentSummary: false,
    hasAreaError: false,
    hasResolutionError: false,
    hasResultPanel: false,
  }));
}

async function chooseCatchmentInputSource(page, option = 'Location') {
  const normalizedOption = String(option || '').trim().toLowerCase();
  async function capture(stage) {
    const file = await captureDebugWorkflowScreenshot(page, `workflow-spatial-analysis-catchment-${stage}`);
    if (file) console.log(`[catchment-debug] screenshot=${file}`);
  }
  async function readMarkerCount() {
    const markerCountText = await page.locator('body').evaluate((body) => {
      const text = String(body.innerText || body.textContent || '');
      const match = text.match(/List of marker\s+(\d+)\/100/i);
      return match ? match[1] : '';
    }).catch(() => '');
    return Number.parseInt(markerCountText || '0', 10) || 0;
  }

  async function downstreamVisibleFor(expected) {
    return page.locator('body').evaluate((body, value) => {
      const text = String(body.innerText || body.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const target = String(value || '').trim().toLowerCase();
      if (target === 'location') {
        return text.includes('search place')
          || text.includes('search location')
          || text.includes('input location')
          || text.includes('select location')
          || text.includes('list of marker');
      }
      if (target === 'dataset') {
        return text.includes('select dataset') || text.includes('dataset');
      }
      return false;
    }, expected).catch(() => false);
  }

  async function openCatchmentSettings() {
    const modalVisible = async () => Promise.any([
      page.getByTestId('catchment-settings-popup-save-button').isVisible().then(() => true),
      page.getByTestId('catchment-place-section-search-input').isVisible().then(() => true),
      page.locator('input[placeholder*="Search Place" i]').first().isVisible().then(() => true),
      (async () => {
        const headingVisible = await page.getByRole('heading', { name: /^Catchment$/i }).isVisible().catch(() => false);
        const searchVisible = await page.locator('input[placeholder*="Search Place" i], [data-testid="catchment-place-section-search-input"]').first().isVisible().catch(() => false);
        return headingVisible && searchVisible;
      })(),
    ]).catch(() => false);

    const alreadyOpen = await modalVisible();
    if (alreadyOpen) return true;

    const setButton = await findFirstUsable(
      page,
      [
        'button:has-text("Set Catchment")',
        '[data-testid="spatial-analysis-set-catchment-button"]',
      ],
      async (locator) => (await locator.isVisible()) && (await locator.isEnabled()),
    );
    if (!setButton) return false;
    const opened = await setButton.click({ timeout: 5_000 }).then(() => true).catch(() => false);
    if (!opened) return false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await sleep(300);
      if (await modalVisible()) return true;
    }
    return false;
  }

  async function clickInputMode(expected) {
    const direct = await page.locator('body *').evaluateAll((elements, targetText) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };

      let sequence = 0;
      for (const element of elements) {
        if (!(element instanceof HTMLElement) || !visible(element)) continue;
        const text = normalize(
          element.getAttribute('aria-label')
          || element.innerText
          || element.textContent,
        );
        if (text !== targetText) continue;
        const target = element.closest('[role="radio"], [role="button"], button, label, div');
        if (!(target instanceof HTMLElement) || !visible(target)) continue;
        sequence += 1;
        target.setAttribute('data-agent-catchment-input', String(sequence));
        return String(sequence);
      }
      return null;
    }, expected).catch(() => null);

    if (!direct) return false;
    const clicked = await page.locator(`[data-agent-catchment-input="${direct}"]`).click({ timeout: 5_000 }).then(() => true).catch(() => false);
    await page.locator('[data-agent-catchment-input]').evaluateAll((elements) => {
      for (const element of elements) {
        element.removeAttribute('data-agent-catchment-input');
      }
    }).catch(() => {});
    await sleep(400);
    return clicked;
  }

  async function catchmentSummaryVisible() {
    return page.locator('body *').evaluateAll((elements) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };

      const allVisible = elements
        .filter((el) => el instanceof HTMLElement)
        .filter((el) => visible(el));
      const spatialSettings = allVisible.find((node) => normalize(node.textContent) === 'spatial settings');
      const outputAnalysis = allVisible.find((node) => normalize(node.textContent) === 'output analysis');
      if (!(spatialSettings instanceof HTMLElement) || !(outputAnalysis instanceof HTMLElement)) return false;

      const top = spatialSettings.getBoundingClientRect().bottom;
      const bottom = outputAnalysis.getBoundingClientRect().top;
      const regionTexts = allVisible
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.top >= top - 8 && rect.bottom <= bottom + 8;
        })
        .filter((node) => !node.closest('[role="dialog"]'))
        .map((node) => normalize(node.textContent))
        .join(' ');

      return regionTexts.includes('coordinate')
        && regionTexts.includes('catchment type')
        && regionTexts.includes('radius')
        && !regionTexts.includes('list of marker')
        && !regionTexts.includes('input location by');
    }).catch(() => false);
  }

  async function configureLocationCatchment() {
    await capture('location-start');
    if (await catchmentSummaryVisible()) {
      await capture('location-summary-already-visible');
      return { selected: true, option, reason: '' };
    }

    const searchInput = await findFirstUsable(
      page,
      [
        '[data-testid="catchment-place-section-search-input"]',
        'input[placeholder*="Search Place" i]',
        'input[name="search-autocomplete"]',
      ],
      async (locator) => (await locator.isVisible()) && (await locator.isEditable()),
    );
    if (!searchInput) {
      await capture('location-search-input-missing');
      return { selected: false, option, reason: `Catchment input source clicked but downstream UI did not appear: ${option}` };
    }

    const existingMarkers = await readMarkerCount();

    let markerIssue = '';

    if (existingMarkers < 1) {
      const queries = Array.from(new Set([
        String(config.spatialAnalysisCatchmentLocationQuery || '').trim(),
        'Monas',
        'Monumen Nasional',
      ].filter(Boolean)));

      let queryTokens = [];

      async function triggerSearchAction() {
        await searchInput.press('Enter').catch(() => {});
        await sleep(600);
        await capture('location-trigger-search-before-action');
        const directButton = await searchInput.evaluate((input) => {
          const visible = (el) => {
            if (!(el instanceof HTMLElement)) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
          };

          const inputRect = input.getBoundingClientRect();
          const candidates = [];
          const row = input.closest('div');
          if (row instanceof HTMLElement) {
            candidates.push(...Array.from(row.querySelectorAll('button, [role="button"]')));
          }
          const dialog = input.closest('[role="dialog"], [data-testid*="catchment"], div');
          if (dialog instanceof HTMLElement) {
            candidates.push(...Array.from(dialog.querySelectorAll('button, [role="button"]')));
          }

          let best = null;
          let bestScore = Number.POSITIVE_INFINITY;
          for (const element of candidates) {
            if (!(element instanceof HTMLElement) || !visible(element) || element.contains(input)) continue;
            const rect = element.getBoundingClientRect();
            const sameBand = Math.abs(rect.top - inputRect.top) <= 40 || Math.abs(rect.bottom - inputRect.bottom) <= 40;
            const toRight = rect.left >= inputRect.right - 48;
            if (!sameBand || !toRight) continue;
            const score = Math.abs(rect.left - inputRect.right) + Math.abs(rect.top - inputRect.top);
            if (score < bestScore) {
              best = element;
              bestScore = score;
            }
          }

          if (!(best instanceof HTMLElement)) return null;
          best.setAttribute('data-agent-catchment-search-trigger', 'true');
          return 'true';
        }).catch(() => null);
        if (directButton) {
          await page.locator('[data-agent-catchment-search-trigger="true"]').click({ timeout: 5_000 }).catch(() => {});
          await page.locator('[data-agent-catchment-search-trigger]').evaluateAll((elements) => {
            for (const element of elements) element.removeAttribute('data-agent-catchment-search-trigger');
          }).catch(() => {});
          await sleep(900);
          await capture('location-trigger-search-after-direct-button');
        }
        const marked = await searchInput.evaluate((input) => {
          const visible = (el) => {
            if (!(el instanceof HTMLElement)) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
          };

          const row = input.closest('div');
          const candidates = [];
          if (row instanceof HTMLElement) {
            candidates.push(...Array.from(row.querySelectorAll('button, [role="button"]')));
          }
          const modal = input.closest('[role="dialog"], [data-testid*="catchment"], div');
          if (modal instanceof HTMLElement) {
            candidates.push(...Array.from(modal.querySelectorAll('button, [role="button"]')));
          }

          let sequence = 0;
          for (const element of candidates) {
            if (!(element instanceof HTMLElement) || !visible(element)) continue;
            if (element.contains(input)) continue;
            const rect = element.getBoundingClientRect();
            const inputRect = input.getBoundingClientRect();
            const sameRow = Math.abs(rect.top - inputRect.top) < 24;
            const toRight = rect.left >= inputRect.right - 24;
            if (!sameRow || !toRight) continue;
            sequence += 1;
            element.setAttribute('data-agent-catchment-row-action', String(sequence));
            return String(sequence);
          }
          return null;
        }).catch(() => null);
        if (marked) {
          await page.locator(`[data-agent-catchment-row-action="${marked}"]`).click({ timeout: 5_000 }).catch(() => {});
          await page.locator('[data-agent-catchment-row-action]').evaluateAll((elements) => {
            for (const element of elements) element.removeAttribute('data-agent-catchment-row-action');
          }).catch(() => {});
          await sleep(800);
          await capture('location-trigger-search-after-action');
        }
      }

      async function chooseSuggestion(preferredTokens) {
        const suggestion = await searchInput.evaluate((input, preferredTokens) => {
          const visible = (el) => {
            if (!(el instanceof HTMLElement)) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
          };
          const inputRect = input.getBoundingClientRect();
          const candidates = Array.from(document.querySelectorAll('body *'))
            .filter((el) => el instanceof HTMLElement)
            .filter((el) => visible(el))
            .map((el) => {
              const target = el.closest('button, [role="button"], [role="option"], [role="listitem"], li, div');
              if (!(target instanceof HTMLElement) || !visible(target)) return null;
              const rect = target.getBoundingClientRect();
              const text = String(target.innerText || target.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
              return { el: target, rect, text, area: rect.width * rect.height };
            })
            .filter(Boolean)
            .filter((item) => item.text)
            .filter((item) => item.rect.top >= inputRect.bottom - 4 && item.rect.top <= inputRect.bottom + 260)
            .filter((item) => item.rect.left >= inputRect.left - 32 && item.rect.left <= inputRect.right + 160)
            .filter((item) => item.rect.width >= 120 && item.rect.height >= 16)
            .filter((item) => item.rect.height <= 120)
            .filter((item) => !item.text.includes('list of marker'))
            .filter((item) => !item.text.includes('please create a marker'));

          const preferred = candidates.find((item) => preferredTokens.some((token) => item.text.includes(token)));
          const best = preferred || candidates.sort((a, b) => a.rect.top - b.rect.top || a.area - b.area || a.rect.left - b.rect.left)[0];
          if (!(best?.el instanceof HTMLElement)) return null;
          best.el.setAttribute('data-agent-catchment-suggestion', 'true');
          return 'true';
        }, preferredTokens).catch(() => null);

        if (!suggestion) return false;
        const clickedSuggestion = await page.locator('[data-agent-catchment-suggestion="true"]').click({ timeout: 5_000 }).then(() => true).catch(() => false);
        await page.locator('[data-agent-catchment-suggestion]').evaluateAll((elements) => {
          for (const element of elements) {
            element.removeAttribute('data-agent-catchment-suggestion');
          }
        }).catch(() => {});
        await sleep(1000);
        return clickedSuggestion;
      }

      for (const query of queries) {
        queryTokens = query
          .toLowerCase()
          .split(/[\s,]+/)
          .filter(Boolean)
          .slice(0, 3);

        await searchInput.fill(query, { timeout: 5_000 }).catch(() => {});
        await sleep(800);
        await capture('location-query-filled');
        await searchInput.press('ArrowDown').catch(() => {});
        await sleep(150);
        await searchInput.press('Enter').catch(() => {});
        await sleep(800);
        await capture('location-after-arrow-enter');
        await triggerSearchAction();
        const suggestionPicked = await chooseSuggestion(queryTokens);
        if (suggestionPicked) {
          await capture('location-after-suggestion');
          await triggerSearchAction();
        }
        const afterQueryMarkers = await readMarkerCount();
        console.log(`[catchment-debug] markerCount.afterQuery(${query})=${afterQueryMarkers}`);
        if (afterQueryMarkers > 0) break;
      }

      let markerCount = await readMarkerCount();
      console.log(`[catchment-debug] markerCount.afterSuggestion=${markerCount}`);
      if (markerCount < 1) {
        const resultClicked = await page.locator('body *').evaluateAll((elements, tokens) => {
          const visible = (el) => {
            if (!(el instanceof HTMLElement)) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
          };
          const normalizedTokens = Array.isArray(tokens) ? tokens : [];
          let sequence = 0;
          for (const element of elements) {
            if (!(element instanceof HTMLElement) || !visible(element)) continue;
            const text = String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!text) continue;
            const matchesQuery = normalizedTokens.every((token) => text.includes(token));
            const looksLikePopup = /address|adm area|expand|jakarta/i.test(text);
            if (!matchesQuery && !looksLikePopup) continue;
            const clickable = element.closest('button, [role="button"], [role="dialog"], .mapboxgl-popup, .leaflet-popup, div');
            if (!(clickable instanceof HTMLElement) || !visible(clickable)) continue;
            const rect = clickable.getBoundingClientRect();
            if (rect.width < 80 || rect.height < 24) continue;
            sequence += 1;
            clickable.setAttribute('data-agent-catchment-result', String(sequence));
            return String(sequence);
          }
          return null;
        }, queryTokens).catch(() => null);
        if (resultClicked) {
          await page.locator(`[data-agent-catchment-result="${resultClicked}"]`).click({ timeout: 5_000 }).catch(() => {});
          await page.locator('[data-agent-catchment-result]').evaluateAll((elements) => {
            for (const element of elements) element.removeAttribute('data-agent-catchment-result');
          }).catch(() => {});
          await sleep(1_000);
          await capture('location-after-result-click');
        }
      }

      markerCount = await readMarkerCount();
      console.log(`[catchment-debug] markerCount.afterResult=${markerCount}`);
      if (markerCount < 1) {
        await triggerSearchAction();
        markerCount = await readMarkerCount();
        console.log(`[catchment-debug] markerCount.afterTriggerRetry=${markerCount}`);
        await capture('location-after-trigger-retry');
      }

      if (markerCount < 1) {
        const viewport = page.viewportSize();
        if (viewport) {
          const clickX = Math.round(Math.max(420, viewport.width * 0.62));
          const clickY = Math.round(viewport.height * 0.48);
          await page.mouse.click(clickX, clickY).catch(() => {});
          await sleep(1_000);
          markerCount = await readMarkerCount();
          console.log(`[catchment-debug] markerCount.afterMapClick=${markerCount}`);
          await capture('location-after-map-click');
        }
      }

      if (markerCount < 1) {
        const coords = await page.locator('body').evaluate((body, fallback) => {
          const text = String(body.innerText || body.textContent || '');
          const match = text.match(/(-?\d+\.\d+)\s*,\s*(\d+\.\d+)/);
          if (match) return { lat: match[1], lng: match[2] };
          return fallback;
        }, {
          lat: String(config.spatialAnalysisCatchmentLatitude || '').trim(),
          lng: String(config.spatialAnalysisCatchmentLongitude || '').trim(),
        }).catch(() => null);

        if (coords?.lat && coords?.lng) {
          const manualInputs = await page.locator('input').evaluateAll((elements) => {
            const visible = (el) => {
              if (!(el instanceof HTMLElement)) return false;
              const style = window.getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
            };

            let sequence = 0;
            const marked = [];
            for (const element of elements) {
              if (!(element instanceof HTMLInputElement) || !visible(element)) continue;
              const placeholder = String(element.placeholder || '').toLowerCase();
              const value = String(element.value || '').trim();
              if (placeholder.includes('search') || placeholder.includes('radius')) continue;
              if (value && Number.isNaN(Number.parseFloat(value))) continue;
              sequence += 1;
              element.setAttribute('data-agent-catchment-coordinate-input', String(sequence));
              marked.push(String(sequence));
              if (marked.length >= 2) break;
            }
            return marked;
          }).catch(() => []);

          if (manualInputs.length >= 2) {
            await page.locator('[data-agent-catchment-coordinate-input="1"]').fill(String(coords.lat)).catch(() => {});
            await page.locator('[data-agent-catchment-coordinate-input="2"]').fill(String(coords.lng)).catch(() => {});
            await page.locator('[data-agent-catchment-coordinate-input]').evaluateAll((elements) => {
              for (const element of elements) element.removeAttribute('data-agent-catchment-coordinate-input');
            }).catch(() => {});
            await sleep(800);
            markerCount = await readMarkerCount();
            console.log(`[catchment-debug] markerCount.afterManualCoords=${markerCount}`);
            await capture('location-after-manual-coords');
          }
        }
      }

      if (markerCount < 1) {
        const diagnostic = await page.locator('body').evaluate((body) => {
          const text = String(body.innerText || body.textContent || '').replace(/\s+/g, ' ').trim();
          const excerpt = text.match(/Catchment[\s\S]{0,400}/i)?.[0] || text.slice(0, 400);
          return excerpt;
        }).catch(() => '');
        markerIssue = `Catchment marker was not added for: ${config.spatialAnalysisCatchmentLocationQuery}${diagnostic ? ` | ${diagnostic}` : ''}`;
        await capture('location-marker-not-added');
      }
    }

    const radiusInput = await findFirstUsable(
      page,
      [
        'input[placeholder*="Radius" i]',
        'input[inputmode="numeric"]',
        'input[type="number"]',
      ],
      async (locator) => (await locator.isVisible()) && (await locator.isEditable()),
    );
    if (!radiusInput) {
      await capture('location-radius-missing');
      return { selected: false, option, reason: 'Catchment radius input not found' };
    }

    const currentRadius = await radiusInput.inputValue().catch(() => '');
    if (!String(currentRadius || '').trim()) {
      await radiusInput.fill(String(config.spatialAnalysisCatchmentRadiusMeters), { timeout: 5_000 }).catch(() => {});
      await sleep(300);
      await capture('location-radius-filled');
    }

    const addMoreButton = await findFirstUsable(
      page,
      [
        'button:has-text("Add More")',
        '[data-testid*="catchment"][data-testid*="add"]',
      ],
      async (locator) => (await locator.isVisible()) && (await locator.isEnabled()),
    );
    if (addMoreButton) {
      await addMoreButton.click({ timeout: 5_000 }).catch(() => {});
      await sleep(500);
      await capture('location-after-add-more');
    }

    if (await catchmentSummaryVisible()) {
      await capture('location-summary-visible-before-save');
      return { selected: true, option, reason: '' };
    }

    const saveButton = await findFirstUsable(
      page,
      [
        '[data-testid="catchment-settings-popup-save-button"]',
        'button:has-text("Save")',
      ],
      async (locator) => (await locator.isVisible()) && (await locator.isEnabled()),
    );
    if (!saveButton) {
      await capture('location-save-missing');
      return { selected: false, option, reason: markerIssue || 'Catchment Save button disabled' };
    }

    const saved = await saveButton.click({ timeout: 5_000 }).then(() => true).catch(() => false);
    if (!saved) {
      await capture('location-save-click-failed');
      return { selected: false, option, reason: markerIssue || 'Failed to save Catchment configuration' };
    }
    await sleep(700);
    const summaryVisible = await catchmentSummaryVisible();
    await capture(summaryVisible ? 'location-summary-visible-after-save' : 'location-summary-missing-after-save');
    return {
      selected: summaryVisible,
      option,
      reason: summaryVisible ? '' : (markerIssue || 'Catchment saved but summary did not appear in Spatial Settings'),
    };
  }

  const directSetCatchmentVisible = normalizedOption === 'location'
    ? await page.getByRole('button', { name: /^Set Catchment$/i }).first().isVisible().catch(() => false)
    : false;
  if (directSetCatchmentVisible) {
    const openedDirectly = await page.getByRole('button', { name: /^Set Catchment$/i }).first()
      .click({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (openedDirectly) {
      await sleep(700);
      return configureLocationCatchment();
    }
  }

  const settingsOpen = await openCatchmentSettings();
  if (!settingsOpen) {
    return { selected: false, option, reason: 'Set Catchment button not found or Catchment dialog did not open' };
  }

  const alreadyVisible = await downstreamVisibleFor(normalizedOption);
  const clicked = alreadyVisible ? true : await clickInputMode(normalizedOption);
  if (!clicked) {
    return { selected: false, option, reason: `Catchment input source not found: ${option}` };
  }

  if (normalizedOption === 'location') {
    return configureLocationCatchment();
  }

  const downstreamVisible = await downstreamVisibleFor(normalizedOption);

  return {
    selected: clicked && downstreamVisible,
    option,
    reason: clicked
      ? (downstreamVisible ? '' : `Catchment input source clicked but downstream UI did not appear: ${option}`)
      : `Failed to click Catchment input source: ${option}`,
  };
}

async function chooseAdministrativeAreaInput(page) {
  const button = await findFirstUsable(
    page,
    [
      'button:has-text("Set Administrative Area")',
      '[data-testid="spatial-analysis-set-administrative-area-button"]',
    ],
    async (locator) => (await locator.isVisible()) && (await locator.isEnabled()),
  );

  let clicked = false;
  if (button) {
    clicked = await button.click({ timeout: 5_000 }).then(() => true).catch(() => false);
  }
  if (!clicked) {
    clicked = await clickVisibleContaining(page, 'Set Administrative Area').catch(() => false);
  }
  if (!clicked) {
    clicked = await clickVisibleActionable(page, 'Set Administrative Area').catch(() => false);
  }
  await sleep(600);
  return {
    selected: clicked,
    reason: clicked ? '' : (button ? 'Failed to click Set Administrative Area' : 'Set Administrative Area button not found'),
  };
}

async function chooseOutputAnalysisOption(page, option = 'Grid') {
  const marked = await page.locator('body *').evaluateAll((elements, expected) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    const visibleElements = elements
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => visible(el));
    const label = visibleElements.find((el) => normalize(el.textContent) === 'Output Analysis');
    if (!(label instanceof HTMLElement)) return null;

    let root = label.parentElement;
    while (root && !Array.from(root.querySelectorAll('*')).some((el) => visible(el) && normalize(el.textContent) === expected)) {
      root = root.parentElement;
    }
    if (!(root instanceof HTMLElement)) return null;

    const target = Array.from(root.querySelectorAll('button, [role="button"], [role="radio"], label'))
      .find((item) => item instanceof HTMLElement && visible(item) && normalize(item.textContent) === expected);
    if (!(target instanceof HTMLElement)) return null;
    target.setAttribute('data-agent-output-option', 'true');
    return 'true';
  }, option).catch(() => null);

  if (!marked) {
    return { selected: false, option, reason: `Output Analysis option not found: ${option}` };
  }

  const clicked = await page.locator('[data-agent-output-option="true"]').click({ timeout: 5_000 }).then(() => true).catch(() => false);
  await page.locator('[data-agent-output-option]').evaluateAll((elements) => {
    for (const element of elements) {
      element.removeAttribute('data-agent-output-option');
    }
  }).catch(() => {});
  await sleep(400);
  return { selected: clicked, option, reason: clicked ? '' : `Failed to click Output Analysis option: ${option}` };
}

async function chooseOutputAnalysisType(page, option = 'H3') {
  const pattern = new RegExp(`^${String(option || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const directRadio = page.getByRole('radio', { name: pattern }).first();
  const directVisible = await directRadio.isVisible().catch(() => false);
  if (directVisible) {
    const clicked = await directRadio.click({ timeout: 5_000 }).then(() => true).catch(() => false);
    await sleep(400);
    return { selected: clicked, option, reason: clicked ? '' : `Failed to click output type: ${option}` };
  }

  const marked = await page.locator('body *').evaluateAll((elements, expected) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    for (const element of elements) {
      if (!(element instanceof HTMLElement) || !visible(element)) continue;
      const text = normalize(
        element.getAttribute('aria-label')
        || element.innerText
        || element.textContent,
      );
      if (!(text === expected || text.startsWith(`${expected} `))) continue;
      const target = element.closest('[role="radio"], label, button, div');
      if (!(target instanceof HTMLElement) || !visible(target)) continue;
      target.setAttribute('data-agent-output-type', 'true');
      return 'true';
    }
    return null;
  }, String(option || '').trim().toLowerCase()).catch(() => null);

  if (!marked) {
    return { selected: false, option, reason: `Output type not found: ${option}` };
  }

  const clicked = await page.locator('[data-agent-output-type="true"]').click({ timeout: 5_000 }).then(() => true).catch(() => false);
  await page.locator('[data-agent-output-type]').evaluateAll((elements) => {
    for (const element of elements) {
      element.removeAttribute('data-agent-output-type');
    }
  }).catch(() => {});
  await sleep(400);
  return { selected: clicked, option, reason: clicked ? '' : `Failed to click output type: ${option}` };
}

async function chooseResolutionOption(page, option = '7') {
  const trigger = await findFirstUsable(
    page,
    [
      'button:has-text("Resolution")',
      'button[aria-haspopup="menu"]',
    ],
    async (locator) => {
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) return false;
      const text = (await locator.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      return /Resolution|Km|Km2/.test(text);
    },
  );

  if (!trigger) {
    return { selected: false, option, reason: 'Resolution dropdown not found' };
  }

  const opened = await trigger.click({ timeout: 5_000 }).then(() => true).catch(() => false);
  if (!opened) {
    return { selected: false, option, reason: 'Failed to open resolution dropdown' };
  }
  await sleep(300);

  const triggerBox = await trigger.boundingBox().catch(() => null);
  const resolutionState = await page.locator('body *').evaluateAll((elements, context) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const triggerLeft = Number(context?.triggerLeft || 0);
    const triggerTop = Number(context?.triggerTop || 0);
    const triggerBottom = Number(context?.triggerBottom || 0);
    const expected = String(context?.expected || '').trim().toLowerCase();

    const options = [];
    for (const element of elements) {
      if (!(element instanceof HTMLElement) || !visible(element)) continue;
      const rawText = String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      const firstToken = rawText.split(/\s+/)[0] || '';
      if (!/^\d+$/.test(firstToken)) continue;
      if (!/km/i.test(rawText)) continue;
      const target = element;
      const rect = target.getBoundingClientRect();
      const nearTrigger = rect.top >= triggerTop - 360
        && rect.top <= triggerBottom + 60
        && Math.abs(rect.left - triggerLeft) <= 120;
      if (!nearTrigger) continue;
      const value = firstToken;
      if (!value) continue;
      const disabled = target.hasAttribute('disabled')
        || target.getAttribute('aria-disabled') === 'true'
        || target.className.includes('disabled')
        || window.getComputedStyle(target).pointerEvents === 'none'
        || window.getComputedStyle(target).opacity === '0.5';
      options.push({ value, disabled, area: rect.width * rect.height });
    }
    const deduped = Array.from(
      options.reduce((map, item) => {
        const existing = map.get(item.value);
        if (!existing || item.area < existing.area) map.set(item.value, item);
        return map;
      }, new Map()).values(),
    );
    const enabledOptions = deduped.filter((item) => !item.disabled);
    const preferred = enabledOptions.find((item) => item.value === expected);
    const expectedNumber = Number.parseInt(expected, 10);
    const fallback = enabledOptions
      .slice()
      .sort((a, b) => {
        const aValue = Number.parseInt(a.value, 10);
        const bValue = Number.parseInt(b.value, 10);
        const aLowerPenalty = Number.isFinite(expectedNumber) && aValue <= expectedNumber ? 0 : 1;
        const bLowerPenalty = Number.isFinite(expectedNumber) && bValue <= expectedNumber ? 0 : 1;
        if (aLowerPenalty !== bLowerPenalty) return aLowerPenalty - bLowerPenalty;
        const aDistance = Math.abs(aValue - expectedNumber);
        const bDistance = Math.abs(bValue - expectedNumber);
        if (aDistance !== bDistance) return aDistance - bDistance;
        return aValue - bValue;
      })[0] || null;
    return {
      targetValue: preferred?.value || fallback?.value || '',
      requestedValue: expected,
      fallbackUsed: Boolean(!preferred && fallback),
      options: deduped,
    };
  }, {
    expected: String(option || '').trim().toLowerCase(),
    triggerLeft: triggerBox?.x || 0,
    triggerTop: triggerBox?.y || 0,
    triggerBottom: triggerBox ? triggerBox.y + triggerBox.height : 0,
  }).catch(() => null);

  if (!resolutionState?.targetValue) {
    await page.keyboard.press('Escape').catch(() => {});
    return { selected: false, option, reason: `Resolution option not found: ${option}` };
  }
  console.log(`[resolution-debug] requested=${option} chosen=${resolutionState.targetValue} fallback=${resolutionState.fallbackUsed} options=${JSON.stringify(resolutionState.options || [])}`);

  const clicked = await page.locator('body *').evaluateAll((elements, context) => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const expected = String(context?.expected || '').trim().toLowerCase();
    const triggerLeft = Number(context?.triggerLeft || 0);
    const triggerTop = Number(context?.triggerTop || 0);
    const triggerBottom = Number(context?.triggerBottom || 0);

    let seq = 0;
    for (const element of elements) {
      if (!(element instanceof HTMLElement) || !visible(element)) continue;
      const rawText = String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      const firstToken = rawText.split(/\s+/)[0] || '';
      if (firstToken !== expected) continue;
      if (!/km/i.test(rawText)) continue;
      const target = element;
      const rect = target.getBoundingClientRect();
      const nearTrigger = rect.top >= triggerTop - 360
        && rect.top <= triggerBottom + 60
        && Math.abs(rect.left - triggerLeft) <= 120;
      if (!nearTrigger) continue;
      const disabled = target.hasAttribute('disabled')
        || target.getAttribute('aria-disabled') === 'true'
        || target.className.includes('disabled')
        || window.getComputedStyle(target).pointerEvents === 'none';
      if (disabled) continue;
      seq += 1;
      target.setAttribute('data-agent-resolution-option', String(seq));
      return String(seq);
    }
    return null;
  }, {
    expected: resolutionState.targetValue,
    triggerLeft: triggerBox?.x || 0,
    triggerTop: triggerBox?.y || 0,
    triggerBottom: triggerBox ? triggerBox.y + triggerBox.height : 0,
  }).catch(() => null);

  if (!clicked) {
    await page.keyboard.press('Escape').catch(() => {});
    return {
      selected: false,
      option,
      reason: `Resolution option could not be clicked: ${resolutionState.targetValue}`,
    };
  }

  await page.locator(`[data-agent-resolution-option="${clicked}"]`).click({ timeout: 5_000 }).catch(() => {});
  await page.locator('[data-agent-resolution-option]').evaluateAll((elements) => {
    for (const element of elements) {
      element.removeAttribute('data-agent-resolution-option');
    }
  }).catch(() => {});
  await sleep(400);
  return {
    selected: true,
    option: resolutionState.targetValue,
    reason: resolutionState.fallbackUsed
      ? `Preferred resolution ${option} unavailable; used ${resolutionState.targetValue}`
      : '',
  };
}

async function clickGenerateResults(page) {
  const button = page.getByRole('button', { name: /Generate Results/i }).first();
  const enabled = await button.isEnabled().catch(() => false);
  if (!enabled) {
    return { enabled: false, clicked: false, reason: 'Generate Results disabled' };
  }

  const clicked = await button.click({ timeout: 5_000 }).then(() => true).catch(() => false);
  await sleep(1_500);
  const toastText = await Promise.any([
    page.getByText(/success|queued|running|created|submitted/i).first().innerText(),
    page.getByText(/error|failed|required/i).first().innerText(),
  ]).catch(() => '');

  return {
    enabled: true,
    clicked,
    reason: clicked ? '' : 'Failed to click Generate Results',
    toastText,
  };
}

async function readAnalysisJobQueueEntries(page) {
  const opened = await clickVisibleContaining(page, 'Analysis Job Queue').catch(() => false);
  await sleep(1_000);
  const data = await page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    const panelHeading = Array.from(document.querySelectorAll('body *'))
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => visible(el))
      .find((el) => normalize(el.textContent) === 'Analysis List');

    let panelRoot = panelHeading?.parentElement || null;
    while (panelRoot && panelRoot instanceof HTMLElement && panelRoot.querySelectorAll('[role="listitem"], li, button').length < 3) {
      panelRoot = panelRoot.parentElement;
    }

    const cards = [];
    const headings = panelRoot
      ? Array.from(panelRoot.querySelectorAll('*'))
        .filter((el) => el instanceof HTMLElement)
        .filter((el) => visible(el))
      : [];

    let currentSection = '';
    for (const element of headings) {
      const text = normalize(element.textContent);
      if (/^(Running|Waiting|Completed)\s*\(\d+\)$/i.test(text)) {
        currentSection = text.replace(/\s*\(\d+\)$/, '');
      }

      if (!/^(Analysis|Spatial Analysis)\s+[A-Za-z0-9-]+/i.test(text)) continue;
      const card = element.closest('button, [role="button"], div');
      if (!(card instanceof HTMLElement) || !visible(card)) continue;

      const cardText = normalize(card.innerText || card.textContent || '');
      const datasetCountText = cardText.match(/\b\d+\s+dataset(?:s)?\b/i)?.[0] || '';
      const defineBy = cardText.match(/\b(Adm Area|Administrative Area|Catchment|Polygon)\b/i)?.[0] || '';
      const outputMode = cardText.match(/\b(Grid|Profiling)\b/i)?.[0] || '';

      cards.push({
        title: text,
        section: currentSection,
        datasetCount: datasetCountText,
        defineBy,
        outputMode,
      });
    }

    const uniqueCards = [];
    const seen = new Set();
    for (const card of cards) {
      const key = `${card.section}::${card.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueCards.push(card);
    }

    return {
      entries: uniqueCards.map((card) => card.title).slice(0, 20),
      cards: uniqueCards.slice(0, 20),
    };
  }).catch(() => ({ entries: [], cards: [] }));

  return { opened, entries: data.entries || [], cards: data.cards || [] };
}

async function searchDatasetExplorer(page, query) {
  const input = await findFirstUsable(
    page,
    [
      '[data-testid="dataset-explorer-search-dataset-input"]',
      'input[name="dataset-explorer-search-dataset"]',
      'input[placeholder*="search datasets" i]',
    ],
    async (locator) => (await locator.isVisible()) && (await locator.isEditable()),
  );

  if (!input) return false;
  const normalizedQuery = String(query || '').replace(/\s+/g, ' ').trim().toLowerCase();
  await input.fill(query, { timeout: 5_000 }).catch(() => {});

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await sleep(500);
    const refreshed = await page.evaluate((expected) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };

      const searchInput = document.querySelector('[data-testid="dataset-explorer-search-dataset-input"], input[name="dataset-explorer-search-dataset"], input[placeholder*="search datasets" i]');
      const currentValue = searchInput instanceof HTMLInputElement ? normalize(searchInput.value) : '';
      const cards = Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter((el) => visible(el))
        .map((el) => normalize(el.textContent || el.getAttribute('aria-label') || ''))
        .filter((text) => text.includes('bvt') && (text.includes('admin. area') || text.includes('administrative area') || text.includes('point') || text.includes('polygon') || text.includes('h3')));

      if (currentValue !== expected) return false;
      if (!expected) return true;
      return cards.some((text) => text.includes(expected));
    }, normalizedQuery).catch(() => false);

    if (refreshed) return true;
  }

  return await input.inputValue().then((value) => String(value || '').trim().toLowerCase() === normalizedQuery).catch(() => false);
}

async function resetDatasetExplorerContext(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await waitBrieflyForIdle(page);
  await sleep(500);
  await dismissTransientUi(page).catch(() => []);
  await openDatasetExplorerBase(page);
}

async function captureWorkflowScreenshot(page, runId, label) {
  if (!runId) return '';
  const timestamp = Date.now();
  const shotFile = path.join(screenshotDir(runId), `${String(timestamp)}-${slugify(label)}.png`);
  await page.screenshot({ path: shotFile, fullPage: true }).catch(() => {});
  return shotFile;
}

async function selectAggregation(page, aggregation) {
  await clickVisibleActionable(page, aggregation).catch(() => false);
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const settled = await page.locator('body').evaluate(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const visibleTexts = Array.from(document.querySelectorAll('body *'))
        .filter((el) => visible(el))
        .map((el) => normalize(el.textContent || ''))
        .filter(Boolean);
      const loadingVisible = visibleTexts.some((text) => text === 'loading...' || text === 'loading');
      const cardsVisible = Array.from(document.querySelectorAll('div[role="button"]'))
        .some((el) => visible(el) && /bvt/i.test(String(el.textContent || '')));
      const emptyStateVisible = visibleTexts.some((text) => text.includes('0 of 0') || text.includes('no datasets') || text.includes('no data'));
      return !loadingVisible && (cardsVisible || emptyStateVisible);
    }).catch(() => false);
    if (settled) break;
    await sleep(400);
  }
  await sleep(300);
}

async function clickDatasetCardByTitle(page, aggregation, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const card = page.locator('div[role="button"]')
    .filter({ hasText: /BVT/i })
    .filter({ hasText: new RegExp(escaped, 'i') })
    .filter({ hasText: ({
      Point: /Point/i,
      Polygon: /Polygon/i,
      H3: /H3/i,
      'Administrative Area': /Admin\.?\s*Area|Administrative Area/i,
      Geohash: /Geohash/i,
      Line: /Line/i,
    })[aggregation] || new RegExp(aggregation, 'i') })
    .first();

  if (!(await card.count())) {
    return false;
  }

  await card.click({ timeout: 5_000 }).catch(() => {});
  await sleep(800);
  return true;
}

async function clickDatasetCardCandidate(page, aggregation, candidate) {
  const aggregationPattern = ({
    Point: /Point/i,
    Polygon: /Polygon/i,
    H3: /H3/i,
    'Administrative Area': /Admin\.?\s*Area|Administrative Area/i,
    Geohash: /Geohash/i,
    Line: /Line/i,
  })[aggregation] || new RegExp(aggregation, 'i');
  const normalizedTarget = String(candidate?.title || '').replace(/\s+/g, ' ').trim();
  const titleKey = normalizedTarget.match(/^(.+?\b\d{4}\b)/)?.[1]
    || normalizedTarget.split(' ').slice(0, 6).join(' ');
  const targetPattern = new RegExp(titleKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

  const cards = page.locator('div[role="button"]')
    .filter({ hasText: /BVT/i })
    .filter({ hasText: aggregationPattern });

  async function clickCard(locator) {
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) return false;
    await locator.scrollIntoViewIfNeeded().catch(() => {});

    const clickLocators = [
      locator,
      locator.getByText(targetPattern).first(),
      locator.locator('input[type="checkbox"]').first(),
    ];

    for (const target of clickLocators) {
      const clicked = await target.click({ timeout: 5_000 }).then(() => true).catch(() => false);
      if (clicked) {
        await sleep(800);
        return true;
      }
    }

    const dispatched = await locator.evaluate((element) => {
      if (!(element instanceof HTMLElement)) return false;
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
      return true;
    }).catch(() => false);
    if (dispatched) {
      await sleep(800);
      return true;
    }

    return false;
  }

  const byIndex = cards.nth(candidate.index);
  if (await byIndex.count()) {
    const text = await byIndex.innerText().catch(() => '');
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (normalized && titleKey && (normalized.includes(normalizedTarget) || normalized.includes(titleKey))) {
      const clicked = await clickCard(byIndex);
      if (clicked) return true;
    }
  }

  const bySignature = cards.filter({ hasText: targetPattern }).first();
  if (await bySignature.count()) {
    const clicked = await clickCard(bySignature);
    if (clicked) return true;
  }

  const taggedMatch = await cards.evaluateAll((elements, expected) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    const target = normalize(expected);
    let sequence = 0;
    for (const element of elements) {
      if (!(element instanceof HTMLElement) || !visible(element)) continue;
      const text = normalize(element.innerText || element.textContent);
      if (!text.includes(target)) continue;
      sequence += 1;
      element.setAttribute('data-agent-card-click-target', String(sequence));
      return String(sequence);
    }
    return null;
  }, titleKey).catch(() => null);

  if (taggedMatch) {
    const tagged = page.locator(`[data-agent-card-click-target="${taggedMatch}"]`).first();
    const clicked = await clickCard(tagged);
    await page.locator('[data-agent-card-click-target]').evaluateAll((elements) => {
      for (const element of elements) element.removeAttribute('data-agent-card-click-target');
    }).catch(() => {});
    if (clicked) return true;
  }

  return false;
}

async function readActiveDatasetSelection(page) {
  const active = await page.locator('div[role="button"]')
    .evaluateAll((elements) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const cards = elements
        .filter((el) => el instanceof HTMLElement)
        .filter((el) => visible(el))
        .map((el) => ({
          className: el.className || '',
          text: normalize(el.innerText || el.textContent),
        }))
        .filter((item) => item.text.includes('BVT'));

      const activeCard = cards.find((item) => item.className.includes('bg-teal-50') || item.className.includes('border-teal-200'));
      if (!activeCard) return null;

      const text = activeCard.text;
      const aggregationMatch = text.match(/\b(Point|Polygon|H3|Administrative Area|Admin\. Area|Geohash|Line)\b/i);
      const aggregation = aggregationMatch
        ? (aggregationMatch[1].toLowerCase().includes('admin') ? 'Administrative Area' : aggregationMatch[1])
        : '';
      const title = normalize(text.split(/Point|Polygon|H3|Administrative Area|Admin\. Area|Geohash|Line/i)[0]);

      return { title, aggregation, text };
    })
    .catch(() => null);

  return active || null;
}

async function chooseProvince(page, options = {}) {
  const {
    requireDatasetButtons = true,
    preferredProvince = config.datasetExplorerProvince,
  } = options;
  const normalizedPreferredProvince = String(preferredProvince || config.datasetExplorerProvince).trim();
  async function getProvinceInput() {
    return findFirstUsable(
      page,
      [
        'input[name="admin-area-1"]',
        'input[placeholder*="province" i]',
      ],
      async (locator) => (await locator.isVisible()) && (await locator.isEditable()),
    );
  }

  async function clickProvinceSuggestion() {
    const exactPattern = new RegExp(`^${normalizedPreferredProvince.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const directLocators = [
      page.getByRole('menuitem', { name: exactPattern }).first(),
      page.getByRole('option', { name: exactPattern }).first(),
      page.getByText(exactPattern).last(),
    ];

    for (const locator of directLocators) {
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      const clicked = await locator.click({ timeout: 5_000 }).then(() => true).catch(() => false);
      if (clicked) return true;
    }

    const selected = await page.locator('[role="menuitem"], [cmdk-item], [data-radix-collection-item]')
      .evaluateAll((elements, expected) => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const visible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };

        const target = normalize(expected);
        let sequence = 0;
        for (const element of elements) {
          if (!(element instanceof HTMLElement) || !visible(element)) continue;
          const text = normalize(element.innerText || element.textContent);
          if (text !== target) continue;
          sequence += 1;
          element.setAttribute('data-agent-click-target', String(sequence));
          return String(sequence);
        }

        return null;
      }, normalizedPreferredProvince)
      .catch(() => null);

    if (!selected) return false;
    const clicked = await page.locator(`[data-agent-click-target="${selected}"]`).click({ timeout: 5_000 }).then(() => true).catch(() => false);
    await page.locator('[data-agent-click-target]').evaluateAll((elements) => {
      for (const element of elements) {
        element.removeAttribute('data-agent-click-target');
      }
    }).catch(() => {});
    return clicked;
  }

  async function provinceLooksSelected(provinceInput) {
    const provinceValue = await provinceInput.inputValue().catch(() => '');
    const exact = String(provinceValue || '').trim().toLowerCase() === normalizedPreferredProvince.toLowerCase();
    if (exact) return true;
    if (!requireDatasetButtons) {
      const cityVisible = await hasVisibleEditable(page, [
        'input[name="admin-area-2"]',
        'input[placeholder*="city" i]',
      ]);
      const saveEnabled = await page
        .locator('[data-testid="admin-area-settings-popup-save-button"], button:has-text("Save")')
        .first()
        .isEnabled()
        .catch(() => false);
      return cityVisible || saveEnabled;
    }
    return false;
  }

  let provinceInput = await getProvinceInput();
  if (!provinceInput) {
    return false;
  }

  let provinceSelected = false;
  for (let attempt = 0; attempt < 3 && !provinceSelected; attempt += 1) {
    await provinceInput.click({ timeout: 5_000 }).catch(() => {});
    await provinceInput.fill(normalizedPreferredProvince, { timeout: 5_000 }).catch(() => {});
    await sleep(700);
    await clickProvinceSuggestion();
    await sleep(700);
    provinceInput = await getProvinceInput();
    if (!provinceInput) break;
    provinceSelected = await provinceLooksSelected(provinceInput);
  }

  if (!requireDatasetButtons) {
    return provinceSelected;
  }
  const filterEnabled = await isEnabledButtonByText(page, 'Add Attribute Filter');
  const addDatasetEnabled = await page
    .locator('[data-testid="dataset-explorer-attribute-filter-add-dataset-button"], button:has-text("Add Dataset")')
    .first()
    .isEnabled()
    .catch(() => false);

  return provinceSelected && (filterEnabled || addDatasetEnabled);
}

async function applyRandomAttributeFilter(page, aggregation = '', options = {}) {
  const avoidAttributes = new Set(
    (Array.isArray(options?.avoidAttributes) ? options.avoidAttributes : [options?.avoidAttribute])
      .filter(Boolean)
      .map((value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()),
  );
  const broaderRange = Boolean(options?.broaderRange);
  const preferredDateRange = (() => {
    const from = String(options?.preferredDateRange?.from || '').trim();
    const to = String(options?.preferredDateRange?.to || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
    return {
      from,
      to,
      selectedValue: String(options?.preferredDateRange?.selectedValue || `${from} - ${to}`).trim(),
      yearShiftFallback: String(options?.preferredDateRange?.yearShiftFallback || '').trim(),
    };
  })();

  async function isAttributeEditorOpen() {
    return page.evaluate(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      return Array.from(document.querySelectorAll('aside, div, section')).some((el) => (
        el instanceof HTMLElement
        && visible(el)
        && normalize(el.textContent || '').includes('attribute filter')
        && (
          normalize(el.textContent || '').includes('selected options')
          || normalize(el.textContent || '').includes('dropdown menu: attribute filter')
          || normalize(el.textContent || '').includes('options')
        )
      ));
    }).catch(() => false);
  }

  const addFilterButton = page
    .locator('[data-testid="dataset-explorer-attribute-filter-add-filter-button"], button:has-text("Add Attribute Filter")')
    .first();
  const enabled = await addFilterButton.isEnabled().catch(() => false);
  const editorOpen = await isAttributeEditorOpen();
  if (!enabled && !editorOpen) {
    return { attempted: false, applied: false, reason: 'Add Attribute Filter disabled (editor not open)' };
  }

  if (!editorOpen) {
    const clicked = await addFilterButton
      .click({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!clicked) {
      return { attempted: true, applied: false, reason: 'Failed to open attribute filter' };
    }
    await sleep(700);
  }

  const saveButton = page.getByTestId('dataset-explorer-attribute-filter-save-button').first();
  const saveButtonByText = page.getByRole('button', { name: /^Save$/i }).first();
  const attributeMenu = page.getByRole('button', { name: /Dropdown menu: Attribute Filter/i }).first();
  const optionLocator = page.locator('[role="menuitem"], [role="option"], [cmdk-item], [data-radix-collection-item]');

  async function readCommittedFilterSummary() {
    return page.evaluate(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const lowered = (value) => normalize(value).toLowerCase();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };

      const panel = Array.from(document.querySelectorAll('aside, div, section'))
        .find((el) => el instanceof HTMLElement && visible(el) && lowered(el.textContent).includes('attribute filter'));
      if (!(panel instanceof HTMLElement)) return '';

      const text = Array.from(panel.querySelectorAll('*'))
        .filter((el) => el instanceof HTMLElement && visible(el))
        .map((el) => normalize(el.textContent))
        .filter(Boolean)
        .filter((line) => {
          const value = lowered(line);
          if (!value) return false;
          if (value === 'attribute filter') return false;
          if (value.startsWith('you may add filters')) return false;
          if (value === 'province' || value === 'province *') return false;
          if (value === 'city') return false;
          if (value === 'minimum' || value === 'maximum') return false;
          if (value === 'include nulls') return false;
          if (value === 'save') return false;
          if (value === 'add attribute filter') return false;
          if (value.includes('select a dataset first')) return false;
          if (value === 'dki jakarta') return false;
          if (value === 'select city') return false;
          if (value.startsWith('enter minimum value')) return false;
          if (value.startsWith('enter maximum value')) return false;
          return true;
        });
      return text.join(' | ');
    }).catch(() => '');
  }

  async function hasCommittedFilterRow(candidate = {}) {
    return page.evaluate((expected) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };

      const target = normalize(expected?.label || '');
      if (!target) return false;
      const numericParts = String(expected?.selectedValue || '')
        .match(/\d[\d,.]*/g)
        || [];
      const numericDigits = numericParts
        .map((value) => String(value || '').replace(/[^\d]/g, ''))
        .filter(Boolean);

      const panel = Array.from(document.querySelectorAll('aside, div, section'))
        .find((el) => el instanceof HTMLElement && visible(el) && normalize(el.textContent || '').includes('attribute filter'));
      if (!(panel instanceof HTMLElement)) return false;

      const ignoredTexts = new Set([
        'attribute filter',
        'province',
        'province *',
        'city',
        'minimum',
        'maximum',
        'include nulls',
        'save',
        'add attribute filter',
        'dki jakarta',
        'select city',
      ]);

      const candidateRows = Array.from(panel.querySelectorAll('div, section, article, li'))
        .filter((el) => el instanceof HTMLElement && visible(el))
        .map((el) => {
          const text = normalize(el.textContent || '');
          const digits = text.replace(/[^\d]+/g, ' ').trim();
          return { text, digits };
        })
        .filter((row) => row.text && row.text.includes(target))
        .filter((row) => !ignoredTexts.has(row.text))
        .filter((row) => !row.text.includes('dropdown menu: attribute filter'))
        .filter((row) => !row.text.includes('selected options'))
        .filter((row) => !row.text.includes('enter minimum value'))
        .filter((row) => !row.text.includes('enter maximum value'));

      if (!candidateRows.length) return false;
      if (!numericDigits.length) return true;
      return candidateRows.some((row) => numericDigits.every((digits) => row.digits.includes(digits)));
    }, candidate).catch(() => false);
  }

  async function isAddDatasetButtonEnabled() {
    return page
      .locator('[data-testid="dataset-explorer-attribute-filter-add-dataset-button"], button:has-text("Add Dataset")')
      .first()
      .isEnabled()
      .catch(() => false);
  }

  async function waitForCommittedFilter(candidate = {}, timeoutMs = 12_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const committedSummary = await readCommittedFilterSummary().catch(() => '');
      if (summaryMatchesCommittedFilter(committedSummary, candidate)) {
        return { matched: true, summary: committedSummary };
      }
      const rowVisible = await hasCommittedFilterRow(candidate).catch(() => false);
      const addDatasetEnabled = await isAddDatasetButtonEnabled().catch(() => false);
      if (rowVisible || (addDatasetEnabled && committedSummary)) {
        return { matched: true, summary: committedSummary };
      }
      await sleep(500);
    }
    return {
      matched: false,
      summary: await readCommittedFilterSummary().catch(() => ''),
    };
  }

  function summaryMatchesCommittedFilter(summary = '', candidate = {}) {
    const normalizedSummary = normalizeLabel(summary);
    const attributeLabel = normalizeLabel(candidate.label || '');
    const selectedValue = normalizeLabel(candidate.selectedValue || '');
    if (!normalizedSummary || !attributeLabel) return false;
    const numericParts = String(candidate.selectedValue || '')
      .match(/\d[\d,.]*/g)
      || [];
    const normalizedSummaryDigits = normalizedSummary.replace(/[^\d]+/g, ' ').trim();
    const attributeTokens = attributeLabel.split(' ').filter(Boolean);
    const selectedTokens = selectedValue.split(' ').filter(Boolean);
    const attributeMatched = normalizedSummary.includes(attributeLabel)
      || attributeTokens.some((token) => token.length >= 4 && normalizedSummary.includes(token));
    if (!attributeMatched) return false;
    if (!selectedTokens.length) return true;
    if (numericParts.length >= 2) {
      const numericMatched = numericParts.every((part) => {
        const digits = String(part || '').replace(/[^\d]/g, '');
        return digits && normalizedSummaryDigits.includes(digits);
      });
      if (numericMatched) return true;
    }
    return selectedTokens.some((token) => token.length >= 3 && normalizedSummary.includes(token));
  }

  async function openAttributeMenu() {
    return attributeMenu.click({ timeout: 5_000 }).then(() => true).catch(() => false);
  }

  async function visibleOptionCount() {
    return optionLocator.evaluateAll((elements) => {
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      return elements.filter((el) => el instanceof HTMLElement && visible(el) && String(el.textContent || '').trim()).length;
    }).catch(() => 0);
  }

  async function readVisibleAttributeOptions() {
    return optionLocator.evaluateAll((elements) => {
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };

      return elements
        .filter((el) => el instanceof HTMLElement && visible(el))
        .map((el, index) => ({
          index,
          label: String(el.textContent || '').replace(/\s+/g, ' ').trim(),
        }))
        .filter((item) => item.label);
    }).catch(() => []);
  }

  async function clickVisibleAttributeOption(index) {
    const optionTarget = await optionLocator.evaluateAll((elements, requestedIndex) => {
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };

      let visibleIndex = -1;
      for (const element of elements) {
        if (!(element instanceof HTMLElement) || !visible(element) || !String(element.textContent || '').trim()) continue;
        visibleIndex += 1;
        if (visibleIndex !== requestedIndex) continue;
        element.setAttribute('data-agent-attribute-option', String(requestedIndex));
        return String(requestedIndex);
      }
      return null;
    }, index).catch(() => null);

    const clickedOption = optionTarget
      ? await page.locator(`[data-agent-attribute-option="${optionTarget}"]`).click({ timeout: 5_000 }).then(() => true).catch(() => false)
      : false;
    await page.locator('[data-agent-attribute-option]').evaluateAll((elements) => {
      for (const element of elements) {
        element.removeAttribute('data-agent-attribute-option');
      }
    }).catch(() => {});
    return clickedOption;
  }

  function numericRangeForAttribute(label = '', rangeOptions = {}) {
    const broaden = Boolean(rangeOptions?.broaderRange);
    const normalized = normalizeLabel(label);
    // City/administrative related
    if (normalized === 'city' || normalized.includes('city')) return broaden ? { min: '1', max: '1000' } : { min: '1', max: '100' };
    if (normalized.includes('household expenditure') || normalized.includes('expenditure')) return { min: '0', max: '999999999' };
    // Unique counts
    if (normalized.includes('unique device') || normalized.includes('unique count')) return broaden ? { min: '1', max: '250000' } : { min: '100', max: '50000' };
    // Generic counts
    if (normalized.includes('device') || normalized.includes('count') || normalized.includes('total')) return broaden ? { min: '1', max: '250000' } : { min: '100', max: '10000' };
    // Distance/radius
    if (normalized.includes('radius')) return broaden ? { min: '1', max: '10000' } : { min: '100', max: '1000' };
    if (normalized.includes('distance') || normalized.includes('length')) return broaden ? { min: '1', max: '50000' } : { min: '100', max: '5000' };
    // Area
    if (normalized.includes('area') || normalized.includes('sqm') || normalized.includes('meter')) return broaden ? { min: '1', max: '100000000' } : { min: '100', max: '100000' };
    // IDs and codes
    if (normalized.includes('id') || normalized.includes('code') || normalized.includes('number')) return broaden ? { min: '1', max: '999999999' } : { min: '1', max: '100000' };
    // Consumption/value data
    if (normalized.includes('consumption') || normalized.includes('value') || normalized.includes('amount')) return broaden ? { min: '1', max: '1000000' } : { min: '1000', max: '100000' };
    // Default
    return broaden ? { min: '1', max: '100000' } : { min: '10', max: '1000' };
  }

  async function fillMinimumIfPresent(value = '10') {
    // Try multiple selector patterns for minimum input
    const minSelectors = [
      'input[placeholder*="minimum" i]',
      'input[placeholder*="min" i]',
      'input[name*="minimum" i]',
      'input[name*="min" i]',
      'input[aria-label*="minimum" i]',
      'input[data-testid*="minimum" i]',
      'input[data-testid*="min" i]',
    ];
    for (const selector of minSelectors) {
      const minimum = page.locator(selector).first();
      const visible = await minimum.isVisible().catch(() => false);
      const editable = await minimum.isEditable().catch(() => false);
      if (visible && editable) {
        return minimum.fill(String(value), { timeout: 5_000 }).then(() => true).catch(() => false);
      }
    }
    return false;
  }

  async function fillMaximumIfPresent(value = '1000') {
    // Try multiple selector patterns for maximum input
    const maxSelectors = [
      'input[placeholder*="maximum" i]',
      'input[placeholder*="max" i]',
      'input[name*="maximum" i]',
      'input[name*="max" i]',
      'input[aria-label*="maximum" i]',
      'input[data-testid*="maximum" i]',
      'input[data-testid*="max" i]',
    ];
    for (const selector of maxSelectors) {
      const maximum = page.locator(selector).first();
      const visible = await maximum.isVisible().catch(() => false);
      const editable = await maximum.isEditable().catch(() => false);
      if (visible && editable) {
        return maximum.fill(String(value), { timeout: 5_000 }).then(() => true).catch(() => false);
      }
    }
    return false;
  }

  async function clickFirstRealOptionCheckbox() {
    return page.evaluate(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const lowered = (value) => normalize(value).toLowerCase();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const hasBlockedLabel = (value) => {
        const text = lowered(value);
        return text.includes('ray white')
          || text === 'bvt'
          || text.includes('data source')
          || text.includes('my organization')
          || text.includes('bvarta');
      };

      // Stable scope: the opened attribute-filter editor (contains "Selected options").
      const panelCandidates = Array.from(document.querySelectorAll('aside, div, section'))
        .filter((el) => (
          el instanceof HTMLElement
          && visible(el)
          && lowered(el.textContent || '').includes('attribute filter')
          && lowered(el.textContent || '').includes('selected options')
        ))
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const area = Math.max(1, rect.width * rect.height);
          return { el, area };
        })
        .sort((a, b) => a.area - b.area);
      const panel = panelCandidates[0]?.el;
      if (!(panel instanceof HTMLElement)) return { clicked: false, label: '' };

      // Hard-scope to option rows with real labels, exclude "Select All" and sidebar controls.
      const optionRegionCandidates = Array.from(panel.querySelectorAll('div, section, ul, ol'))
        .filter((el) => el instanceof HTMLElement && visible(el))
        .map((el) => {
          const checkboxCount = el.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length;
          const text = lowered(el.textContent || '');
          return { el, checkboxCount, text };
        })
        .filter((item) => item.checkboxCount > 0 && item.text.includes('selected options'));
      const optionRegion = optionRegionCandidates[0]?.el || panel;
      if (!(optionRegion instanceof HTMLElement)) {
        return { clicked: false, label: '' };
      }

      const scopedBoxes = Array.from(optionRegion.querySelectorAll('input[type="checkbox"], [role="checkbox"]'))
        .filter((el) => el instanceof HTMLElement && visible(el));
      const visibleBoxes = scopedBoxes.filter((el) => {
        const labelEl = el.closest('label') || el;
        const labelText = normalize(labelEl.textContent || el.textContent || '');
        const labelLower = lowered(labelText);
        if (!labelText) return false;
        if (hasBlockedLabel(labelText)) return false;
        if (labelLower === 'select all' || labelLower.includes('select all')) return false;
        return true;
      });
      if (!visibleBoxes.length) {
        const optionRows = Array.from(optionRegion.querySelectorAll('label, li, div, [role="menuitemcheckbox"]'))
          .filter((el) => el instanceof HTMLElement && visible(el))
          .map((el) => {
            const text = normalize(el.textContent || '');
            const textLower = lowered(text);
            const hasCheckbox = Boolean(el.querySelector('input[type="checkbox"], [role="checkbox"]'));
            return { el, text, textLower, hasCheckbox };
          })
          .filter((row) => row.text && row.hasCheckbox && row.textLower !== 'select all' && !hasBlockedLabel(row.text))
          .sort((a, b) => a.text.length - b.text.length);
        const row = optionRows[0];
        if (!row?.el) return { clicked: false, label: '' };
        row.el.click();
        return { clicked: true, label: row.text };
      }
      const scored = visibleBoxes.map((target, index) => {
        const labelEl = target.closest('label') || target;
        const text = normalize(labelEl.textContent || target.textContent || '');
        const textLower = lowered(text);
        let score = 0;
        if (!text) score -= 1000;
        if (hasBlockedLabel(text)) score -= 2000;
        if (textLower === 'all' || textLower.includes('select all')) score -= 500;
        if (textLower === 'undefined' || textLower === 'unspecified' || textLower === 'null') score -= 400;
        if (textLower === 'bank') score += 450;
        if (textLower === 'insurance') score += 430;
        if (textLower.includes('financial service')) score += 420;
        if (textLower.includes('other')) score -= 50;
        if (/\b\d+\b/.test(textLower)) score += 20;
        if (/[a-z]/i.test(text)) score += 100;
        score += Math.max(0, 40 - index);
        return { target, labelEl, text, score };
      }).sort((left, right) => right.score - left.score);

      const best = scored.find((item) => item.score > -200) || scored[0];
      if (!best?.target || !(best.target instanceof HTMLElement)) return { clicked: false, label: '' };
      best.target.click();
      best.labelEl.click();
      return { clicked: true, label: best.text };
    }).catch(() => ({ clicked: false, label: '' }));
  }

  async function isAttributeOptionsEmpty() {
    return page.evaluate(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const panel = Array.from(document.querySelectorAll('aside, div, section'))
        .find((el) => {
          if (!(el instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if (style.visibility === 'hidden' || style.display === 'none' || rect.width <= 0 || rect.height <= 0) return false;
          const text = normalize(el.textContent || '');
          return text.includes('attribute filter') && (text.includes('options not found') || text.includes('selected options (0 of 0)'));
        });
      return Boolean(panel);
    }).catch(() => false);
  }

  async function clickIncludeNullsIfPresent() {
    return page.evaluate(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const candidates = Array.from(document.querySelectorAll('label, button, div, span'))
        .filter((el) => el instanceof HTMLElement && visible(el) && normalize(el.textContent || '') === 'include nulls');
      const target = candidates[0];
      if (!(target instanceof HTMLElement)) return false;
      target.click();
      return true;
    }).catch(() => false);
  }

  async function saveFilterIfEnabled() {
    // Try multiple methods to find and click the Save button
    const saveButtonCandidates = [
      saveButton, // by test-id
      saveButtonByText, // by role + name "Save"
      page.locator('button:has-text("Save")').first(), // by text content
      page.locator('[data-testid*="save" i]').first(), // by partial test-id
    ];

    for (let attempt = 0; attempt < 3; attempt++) {
      for (const candidate of saveButtonCandidates) {
        try {
          const visible = await candidate.isVisible().catch(() => false);
          const enabled = await candidate.isEnabled().catch(() => false);
          if (visible && enabled) {
            const clicked = await candidate.click({ timeout: 5_000 }).then(() => true).catch(() => false);
            if (clicked) {
              await sleep(500); // Wait for UI to process the save
              return true;
            }
          }
        } catch {
          // Continue to next candidate
        }
      }
      await sleep(300);
    }
    return false;
  }

  async function isSaveButtonEnabled() {
    // Check multiple Save button candidates to see if any is visible and enabled
    const candidates = [
      saveButton,
      saveButtonByText,
      page.locator('button:has-text("Save")').first(),
    ];
    for (const candidate of candidates) {
      try {
        const visible = await candidate.isVisible().catch(() => false);
        const enabled = await candidate.isEnabled().catch(() => false);
        if (visible && enabled) return true;
      } catch {
        // Continue to next candidate
      }
    }
    return false;
  }

  async function clickPreferredBusinessOption() {
    const options = ['Bank', 'Insurance', 'Financial Service'];
    for (const label of options) {
      const checkbox = page.getByRole('checkbox', { name: new RegExp(`^${label}$`, 'i') }).first();
      const visible = await checkbox.isVisible().catch(() => false);
      if (!visible) continue;
      const clicked = await checkbox.click({ timeout: 3_000 }).then(() => true).catch(() => false);
      if (clicked) return { clicked: true, label };
    }

    return page.evaluate(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const preferred = ['bank', 'insurance', 'financial service'];
      for (const label of preferred) {
        const row = Array.from(document.querySelectorAll('label, div, li'))
          .find((el) => el instanceof HTMLElement && visible(el) && normalize(el.textContent || '') === label);
        if (!(row instanceof HTMLElement)) continue;
        const checkbox = row.querySelector('input[type="checkbox"], [role="checkbox"]');
        if (checkbox instanceof HTMLElement) checkbox.click();
        row.click();
        return { clicked: true, label: row.textContent || '' };
      }
      return { clicked: false, label: '' };
    }).catch(() => ({ clicked: false, label: '' }));
  }

  async function readSelectedOptionsCount() {
    return page.evaluate(() => {
      const textNodes = Array.from(document.querySelectorAll('body *'))
        .map((el) => (el instanceof HTMLElement ? String(el.textContent || '') : ''))
        .map((value) => value.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      for (const text of textNodes) {
        const match = text.match(/selected options\s*\((\d+)\s*of\s*(\d+)\)/i);
        if (match) {
          const value = Number.parseInt(match[1], 10);
          return Number.isFinite(value) ? value : 0;
        }
      }
      return 0;
    }).catch(() => 0);
  }

  function normalizeLabel(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function isLikelyDateAttribute(label) {
    const normalized = normalizeLabel(label);
    return normalized === 'date'
      || normalized.endsWith(' date')
      || normalized.includes('datetime')
      || normalized.includes('timestamp');
  }

  function isLikelyNumericAttribute(label) {
    const normalized = normalizeLabel(label);
    return normalized === 'poi id'
      || normalized === 'poiid'
      || normalized.endsWith(' id')
      || normalized.endsWith('id')
      || normalized.includes('number')
      || normalized.includes('code')
      || normalized.includes('sqm')
      || normalized.includes('meter')
      || normalized.includes('radius')
      || normalized.includes('distance')
      || normalized.includes('length')
      || normalized.includes('width')
      || normalized.includes('height')
      || normalized.includes('count')
      || normalized.includes('total')
      || normalized.includes('expenditure')
      || normalized.includes('income')
      || normalized.includes('area');
  }

  function scoreAttributeOption(label) {
    const normalized = normalizeLabel(label);
    const exactPreferredOrder = [
      'household expenditure',
      'type',
      'brand',
      'category',
      'group',
      'service level',
      'name',
      'address',
      'phone',
    ];
    const exactIndex = exactPreferredOrder.indexOf(normalized);
    if (exactIndex >= 0) return 1000 - exactIndex;
    if (normalized.includes('household expenditure')) return 960;
    if (normalized.includes('expenditure')) return 950;
    if (normalized.includes('type')) return 900;
    if (normalized.includes('brand')) return 890;
    if (normalized.includes('category')) return 880;
    if (normalized.includes('group')) return 870;
    if (normalized.includes('service')) return 860;
    if (normalized.includes('name')) return 850;
    if (normalized.includes('address')) return 840;
    if (normalized.includes('phone')) return 830;
    if (isLikelyDateAttribute(normalized)) return 520;
    if (normalized.includes('class area') || normalized.includes('sqm') || normalized.includes('area')) return 120;
    if (isLikelyNumericAttribute(normalized)) return 100;
    return 500;
  }

  async function fillDateRangeIfPresent(fromValue = '2025-01-01', toValue = '2025-01-31') {
    const fromSelectors = [
      'input[placeholder*="from" i]',
      'input[placeholder*="start" i]',
      'input[name*="from" i]',
      'input[name*="start" i]',
      'input[aria-label*="from" i]',
      'input[aria-label*="start" i]',
      'input[data-testid*="from" i]',
      'input[data-testid*="start" i]',
    ];
    const toSelectors = [
      'input[placeholder*="until" i]',
      'input[placeholder*="to" i]',
      'input[placeholder*="end" i]',
      'input[name*="until" i]',
      'input[name*="to" i]',
      'input[name*="end" i]',
      'input[aria-label*="until" i]',
      'input[aria-label*="to" i]',
      'input[aria-label*="end" i]',
      'input[data-testid*="until" i]',
      'input[data-testid*="to" i]',
      'input[data-testid*="end" i]',
    ];

    let fromFilled = false;
    let toFilled = false;

    for (const selector of fromSelectors) {
      const input = page.locator(selector).first();
      const visible = await input.isVisible().catch(() => false);
      const editable = await input.isEditable().catch(() => false);
      if (!visible || !editable) continue;
      fromFilled = await input.fill(String(fromValue), { timeout: 5_000 }).then(() => true).catch(() => false);
      if (fromFilled) break;
    }

    for (const selector of toSelectors) {
      const input = page.locator(selector).first();
      const visible = await input.isVisible().catch(() => false);
      const editable = await input.isEditable().catch(() => false);
      if (!visible || !editable) continue;
      toFilled = await input.fill(String(toValue), { timeout: 5_000 }).then(() => true).catch(() => false);
      if (toFilled) break;
    }

    return { fromFilled, toFilled };
  }

  async function detectAttributeEditorMode() {
    return page.evaluate(() => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };

      const hasVisibleInput = (selectors) => selectors.some((selector) => {
        const element = document.querySelector(selector);
        return element instanceof HTMLInputElement && visible(element);
      });

      const hasDateInputs = hasVisibleInput([
        'input[placeholder*="from" i]',
        'input[placeholder*="until" i]',
        'input[aria-label*="from" i]',
        'input[aria-label*="until" i]',
      ]);
      if (hasDateInputs) return 'date';

      const hasNumericInputs = hasVisibleInput([
        'input[placeholder*="minimum" i]',
        'input[placeholder*="maximum" i]',
        'input[placeholder*="min" i]',
        'input[placeholder*="max" i]',
        'input[aria-label*="minimum" i]',
        'input[aria-label*="maximum" i]',
      ]);
      if (hasNumericInputs) return 'numeric';

      const checkboxCount = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]'))
        .filter((el) => visible(el))
        .filter((el) => {
          const text = String(el.textContent || el.parentElement?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
          return text !== 'include nulls';
        })
        .length;
      if (checkboxCount > 0) return 'categorical';

      return 'unknown';
    }).catch(() => 'unknown');
  }

  const menuOpened = await openAttributeMenu();
  if (!menuOpened) {
    return { attempted: true, applied: false, reason: 'No attribute filter dropdown found' };
  }
  await sleep(300);

  const count = await visibleOptionCount();
  if (!count) {
    return { attempted: true, applied: false, reason: 'No visible attribute option found' };
  }

  const optionItems = await readVisibleAttributeOptions();
  const orderedCandidates = optionItems
    .map((item) => ({
      ...item,
      score: scoreAttributeOption(item.label) - (avoidAttributes.has(normalizeLabel(item.label)) ? 10_000 : 0),
      isNumeric: isLikelyNumericAttribute(item.label),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.min(count, aggregation === 'Polygon' ? 6 : 5));

  // Separate categorical and numeric candidates for fallback strategy
  const categoricalCandidates = orderedCandidates.filter((item) => !item.isNumeric);
  const numericCandidates = orderedCandidates.filter((item) => item.isNumeric);
  // Try categorical first, then numeric as fallback
  const orderedAttemptList = [...categoricalCandidates, ...numericCandidates];
  const failedAttributes = [];

  for (const [attemptIndex, candidate] of orderedAttemptList.entries()) {
    if (attemptIndex > 0) {
      const reopened = await openAttributeMenu();
      if (!reopened) break;
      await sleep(300);
    }

    const optionSelected = await clickVisibleAttributeOption(candidate.index);
    if (!optionSelected) {
      failedAttributes.push({ label: candidate.label, reason: 'option not clickable' });
      continue;
    }
    await sleep(400);
    const optionsEmpty = await isAttributeOptionsEmpty();
    if (optionsEmpty) {
      // This attribute has no options ("Options Not Found"), try next attribute
      failedAttributes.push({ label: candidate.label, reason: 'options not found' });
      continue;
    }

    const editorMode = await detectAttributeEditorMode();
    const treatAsDate = editorMode === 'date' || (editorMode === 'unknown' && isLikelyDateAttribute(candidate.label));
    const treatAsNumeric = editorMode === 'numeric' || (editorMode === 'unknown' && candidate.isNumeric);
    const selectedMode = treatAsDate ? 'date' : (treatAsNumeric ? 'numeric' : 'categorical');

    if (!treatAsNumeric) {
      if (treatAsDate) {
        const targetDateRange = preferredDateRange || {
          from: '2025-01-01',
          to: '2025-01-31',
          selectedValue: '2025-01-01 - 2025-01-31',
          yearShiftFallback: '',
        };
        const dateRange = await fillDateRangeIfPresent(targetDateRange.from, targetDateRange.to);
        if (!dateRange.fromFilled && !dateRange.toFilled) {
          failedAttributes.push({ label: candidate.label, reason: 'date inputs not fillable' });
          continue;
        }
        candidate.selectedValue = targetDateRange.selectedValue;
        candidate.yearShiftFallback = targetDateRange.yearShiftFallback;
        await page.keyboard.press('Tab').catch(() => {});
        await sleep(500);
        let saveEnabledAfterDateRange = await isSaveButtonEnabled();
        if (!saveEnabledAfterDateRange) {
          await clickIncludeNullsIfPresent();
          await sleep(400);
          saveEnabledAfterDateRange = await isSaveButtonEnabled();
        }
        if (!saveEnabledAfterDateRange) {
          failedAttributes.push({ label: candidate.label, reason: 'date range did not enable save' });
          continue;
        }
      } else {
        // Categorical attribute: try to select a checkbox option
        const beforeSelectedCount = await readSelectedOptionsCount();
        const preferredOption = await clickPreferredBusinessOption();
        const checkboxResult = preferredOption.clicked ? preferredOption : await clickFirstRealOptionCheckbox();
        if (!checkboxResult.clicked) {
          failedAttributes.push({ label: candidate.label, reason: 'no clickable option' });
          continue;
        }
        await sleep(300);
        const afterSelectedCount = await readSelectedOptionsCount();
        if (afterSelectedCount <= beforeSelectedCount) {
          failedAttributes.push({ label: candidate.label, reason: 'selection did not commit' });
          continue;
        }
        candidate.selectedValue = checkboxResult.label || '';
      }
    } else {
      // Numeric attribute: always try to fill min/max range values
      const range = numericRangeForAttribute(candidate.label, { broaderRange });
      const minFilled = await fillMinimumIfPresent(range.min);
      const maxFilled = await fillMaximumIfPresent(range.max);
      if (!minFilled && !maxFilled) {
        // No min/max inputs visible, try checkbox fallback
        const checkboxResult = await clickFirstRealOptionCheckbox();
        if (checkboxResult.clicked) {
          candidate.selectedValue = checkboxResult.label || '';
        } else {
          failedAttributes.push({ label: candidate.label, reason: 'numeric inputs not fillable' });
          continue;
        }
      } else {
        candidate.selectedValue = `${range.min} - ${range.max}`;
      }
      // Blur the input fields to trigger validation by pressing Tab or clicking elsewhere
      await page.keyboard.press('Tab').catch(() => {});
      await sleep(500);
      // Check if Save is enabled after filling range (check multiple times with delay)
      let saveEnabledAfterRange = await isSaveButtonEnabled();
      if (!saveEnabledAfterRange) {
        // Wait a bit more for UI to update
        await sleep(300);
        saveEnabledAfterRange = await isSaveButtonEnabled();
      }
      if (!saveEnabledAfterRange) {
        // Try enabling Include Nulls checkbox as a workaround
        await clickIncludeNullsIfPresent();
        await sleep(400);
      }
    }

    const saved = await saveFilterIfEnabled();
    if (saved) {
      // Wait for app loading state to complete after Save (backend data refresh)
      // The app may show loading state for several seconds, disabling Add Dataset temporarily
      await sleep(2000);
      // Wait for Add Dataset to become enabled again (max 10 seconds)
      let addBecameEnabled = false;
      for (let waitAttempt = 0; waitAttempt < 20; waitAttempt++) {
        const addEnabled = await page
          .locator('button:has-text("Add Dataset")')
          .first()
          .isEnabled()
          .catch(() => false);
        if (addEnabled) {
          addBecameEnabled = true;
          break;
        }
        await sleep(500);
      }
      const committedFilter = await waitForCommittedFilter(candidate);
      if (!committedFilter.matched) {
        failedAttributes.push({ label: candidate.label, reason: 'save clicked but no committed filter summary detected' });
        continue;
      }
      return {
        attempted: true,
        applied: true,
        reason: addBecameEnabled ? '' : 'Filter saved but Add Dataset did not re-enable',
        attribute: candidate.label,
        mode: selectedMode,
        selectedValue: candidate.selectedValue || '',
        yearShiftFallback: candidate.yearShiftFallback || '',
        triedAttributes: failedAttributes,
        addDatasetEnabled: addBecameEnabled,
      };
    }

    // Save button was not enabled or click failed - but check if filter was committed anyway
    // (some UIs auto-commit filter values on input blur)
    await sleep(500);
    const committedFilter = await waitForCommittedFilter(candidate, 6_000);
    const filterMightBeCommitted = committedFilter.matched;
    if (filterMightBeCommitted) {
      // Filter appears to be committed in UI even though Save wasn't clicked
      // Wait for Add Dataset to become enabled (max 10 seconds)
      await sleep(2000);
      let addBecameEnabled = false;
      for (let waitAttempt = 0; waitAttempt < 16; waitAttempt++) {
        const addEnabled = await page
          .locator('button:has-text("Add Dataset")')
          .first()
          .isEnabled()
          .catch(() => false);
        if (addEnabled) {
          addBecameEnabled = true;
          break;
        }
        await sleep(500);
      }
      return {
        attempted: true,
        applied: true,
        reason: 'Filter committed via UI (auto-commit)',
        attribute: candidate.label,
        mode: selectedMode,
        selectedValue: candidate.selectedValue || '',
        yearShiftFallback: candidate.yearShiftFallback || '',
        triedAttributes: failedAttributes,
        addDatasetEnabled: addBecameEnabled,
      };
    }

    // Save was not enabled and filter not committed, track this failure and try next attribute
    failedAttributes.push({ label: candidate.label, reason: 'save stayed disabled' });
  }

  // Build detailed reason with all tried attributes
  const triedSummary = failedAttributes.length > 0
    ? ` (tried: ${failedAttributes.map((f) => `${f.label}=${f.reason}`).join(', ')})`
    : '';
  return {
    attempted: true,
    applied: false,
    reason: `Attribute filter save stayed disabled${triedSummary}`,
    triedAttributes: failedAttributes,
  };
}

async function openDataSelectionEditFilter(page, expectedTitle = '') {
  const aliases = buildExpectedDatasetAliases(expectedTitle).filter(Boolean);
  await page.getByText(/^Data Selection$/i).first().scrollIntoViewIfNeeded().catch(() => {});

  const normalizedAliases = aliases
    .map((alias) => normalizeDatasetText(alias))
    .filter(Boolean);
  const aliasTokens = normalizedAliases.map((alias) => alias.split(' ').filter(Boolean));

  async function markTargets() {
    return page.evaluate(({ normalizedAliases: aliasesInPage, aliasTokens: aliasTokensInPage }) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const normalizeDataset = (value) => normalize(value).toLowerCase();
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const inDataSelectionBand = (rect, top, bottom) => (
        rect.bottom >= top - 8
        && rect.top <= bottom - 8
      );
      const isButtonLike = (el) => (
        el instanceof HTMLElement
        && (
          el.tagName === 'BUTTON'
          || el.getAttribute('role') === 'button'
          || el.getAttribute('aria-haspopup') === 'menu'
        )
      );
      const clearMarkers = () => {
        Array.from(document.querySelectorAll('[data-codex-edit-target],[data-codex-expand-target]')).forEach((el) => {
          el.removeAttribute('data-codex-edit-target');
          el.removeAttribute('data-codex-expand-target');
        });
      };
      const scoreText = (text) => {
        const normalizedText = normalizeDataset(text);
        if (
          !normalizedText
          || normalizedText === 'data selection'
          || normalizedText === 'add dataset'
          || normalizedText.includes('select your own data or explore our dataset library')
        ) {
          return 0;
        }
        let score = 0;
        for (const alias of aliasesInPage) {
          if (normalizedText.includes(alias) || alias.includes(normalizedText)) score = Math.max(score, 1000 + alias.length);
        }
        score = Math.max(score, tokenScore(text));
        return score;
      };
      const tokenScore = (text) => {
        const tokens = new Set(normalizeDataset(text).split(' ').filter(Boolean));
        return aliasTokensInPage.reduce((best, group) => {
          let matches = 0;
          for (const token of group) {
            if (tokens.has(token)) matches += 1;
          }
          return Math.max(best, matches);
        }, 0);
      };

      clearMarkers();

      const headingNames = ['Data Selection', 'Spatial Settings', 'Generate Results'];
      const headingMatches = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],button,span,div,p'))
        .filter((el) => el instanceof HTMLElement && visible(el))
        .map((el) => ({ el, text: normalize(el.textContent) }))
        .filter(({ text }) => headingNames.includes(text));
      const dataSelectionHeading = headingMatches.find(({ text }) => text === 'Data Selection')?.el || null;
      if (!(dataSelectionHeading instanceof HTMLElement)) {
        return { found: false, reason: 'Data Selection heading not visible' };
      }
      const dataSelectionTop = dataSelectionHeading instanceof HTMLElement
        ? dataSelectionHeading.getBoundingClientRect().top
        : Number.NEGATIVE_INFINITY;
      const nextHeadingTop = headingMatches
        .filter(({ text, el }) => (
          text !== 'Data Selection'
          && el instanceof HTMLElement
          && el.getBoundingClientRect().top > dataSelectionTop + 4
        ))
        .map(({ el }) => el.getBoundingClientRect().top)
        .sort((a, b) => a - b)[0] ?? Number.POSITIVE_INFINITY;

      let scanRoot = dataSelectionHeading.parentElement;
      while (scanRoot) {
        const buttons = Array.from(scanRoot.querySelectorAll('button, [role="button"]'))
          .filter((el) => el instanceof HTMLElement && visible(el))
          .map((el) => normalizeDataset(el.textContent || el.getAttribute('aria-label') || ''));
        const rootText = normalizeDataset(scanRoot.textContent || '');
        const hasAddDataset = buttons.some((text) => text.includes('add dataset')) || rootText.includes('add dataset');
        const hasExplorerHeading = rootText.includes('dataset explorer');
        if (hasAddDataset && !hasExplorerHeading) break;
        scanRoot = scanRoot.parentElement;
      }
      if (!(scanRoot instanceof HTMLElement)) {
        return { found: false, reason: 'Data Selection container not found' };
      }

      const interactiveControls = Array.from(scanRoot.querySelectorAll('[data-testid="edit-button"], [data-testid="expand-dataset-trigger"], [data-testid="trash-button"]'))
        .filter((el) => el instanceof HTMLElement && visible(el));

      const rows = interactiveControls
        .map((control) => {
          let current = control.parentElement;
          let best = null;
          while (current && current !== scanRoot && current instanceof HTMLElement) {
            if (visible(current)) {
              const rect = current.getBoundingClientRect();
              const text = normalize(current.innerText || current.textContent || '');
              const score = scoreText(text);
              if (
                inDataSelectionBand(rect, dataSelectionTop, nextHeadingTop)
                && score > 0
              ) {
                const sizePenalty = Math.min(text.length, 800) / 1000;
                const weightedScore = score - sizePenalty;
                if (!best || weightedScore > best.weightedScore) {
                  best = { row: current, score, weightedScore };
                }
              }
            }
            current = current.parentElement;
          }
          return best;
        })
        .filter(Boolean)
        .filter((item, index, arr) => arr.findIndex((other) => other.row === item.row) === index)
        .sort((left, right) => right.weightedScore - left.weightedScore);

      const textAnchors = Array.from(scanRoot.querySelectorAll('button,[role="button"],div,section,article,li,span,p,h1,h2,h3,h4,h5,h6'))
        .filter((el) => el instanceof HTMLElement && visible(el))
        .map((anchor) => {
          const anchorRect = anchor.getBoundingClientRect();
          if (!inDataSelectionBand(anchorRect, dataSelectionTop, nextHeadingTop)) return null;
          const anchorText = normalize(anchor.innerText || anchor.textContent || '');
          const anchorScore = scoreText(anchorText);
          if (anchorScore <= 0) return null;
          let current = anchor;
          let best = null;
          while (current && current !== scanRoot && current instanceof HTMLElement) {
            if (visible(current)) {
              const rect = current.getBoundingClientRect();
              if (inDataSelectionBand(rect, dataSelectionTop, nextHeadingTop)) {
                const text = normalize(current.innerText || current.textContent || '');
                const score = Math.max(scoreText(text), anchorScore);
                const controlBonus = current.querySelector('[data-testid="edit-button"], [data-testid="expand-dataset-trigger"], [data-testid="trash-button"], button, [role="button"]')
                  ? 200
                  : 0;
                const weightedScore = score + controlBonus - (Math.min(text.length, 1200) / 1000);
                if (!best || weightedScore > best.weightedScore) {
                  best = { row: current, score, weightedScore };
                }
              }
            }
            current = current.parentElement;
          }
          return best;
        })
        .filter(Boolean)
        .filter((item, index, arr) => arr.findIndex((other) => other.row === item.row) === index)
        .sort((left, right) => right.weightedScore - left.weightedScore);

      rows.unshift(...textAnchors);
      rows.sort((left, right) => right.weightedScore - left.weightedScore);

      if (!rows.length) {
        const fallbackRows = Array.from(scanRoot.querySelectorAll('button, [role="button"], div, section, article, li'))
          .filter((el) => el instanceof HTMLElement && visible(el))
          .map((row) => {
            const rect = row.getBoundingClientRect();
            const text = normalize(row.innerText || row.textContent || '');
            const score = scoreText(text);
            if (
              !inDataSelectionBand(rect, dataSelectionTop, nextHeadingTop)
              || score <= 0
            ) {
              return null;
            }
            return { row, score, weightedScore: score - (Math.min(text.length, 800) / 1000) };
          })
          .filter(Boolean)
          .sort((left, right) => right.weightedScore - left.weightedScore);
        rows.push(...fallbackRows);
      }

      // Final fallback: ignore inDataSelectionBand entirely — the row may be inside
      // a scrollable sub-container whose getBoundingClientRect() falls outside the
      // heading-derived band even though it is visually present (the known false-negative).
      if (!rows.length) {
        const wideFallbackRows = Array.from(scanRoot.querySelectorAll(
          'button, [role="button"], div, section, article, li'
        ))
          .filter((el) => el instanceof HTMLElement && visible(el))
          .map((row) => {
            const text = normalize(row.innerText || row.textContent || '');
            const score = scoreText(text);
            if (score <= 0) return null;
            const hasControl = !!row.querySelector(
              '[data-testid="edit-button"], [data-testid="expand-dataset-trigger"], [data-testid="trash-button"], button, [role="button"]'
            );
            const controlBonus = hasControl ? 200 : 0;
            const weightedScore = score + controlBonus - (Math.min(text.length, 1200) / 1000);
            return { row, score, weightedScore };
          })
          .filter(Boolean)
          .filter((item, index, arr) => arr.findIndex((other) => other.row === item.row) === index)
          .sort((left, right) => right.weightedScore - left.weightedScore);
        rows.push(...wideFallbackRows);
      }

      const bestRow = rows[0]?.row;
      if (!(bestRow instanceof HTMLElement) || rows[0].score <= 0) {
        return { found: false, reason: 'Loaded dataset row not found in Data Selection' };
      }

      const editButton = bestRow.querySelector('[data-testid="edit-button"]');
      if (editButton instanceof HTMLElement && visible(editButton)) {
        editButton.setAttribute('data-codex-edit-target', 'true');
        return { found: true, expanded: true };
      }

      const expandButton = bestRow.querySelector('[data-testid="expand-dataset-trigger"]');
      if (expandButton instanceof HTMLElement && visible(expandButton)) {
        expandButton.setAttribute('data-codex-expand-target', 'true');
        return { found: true, expanded: false };
      }

      const genericButtons = Array.from(bestRow.querySelectorAll('button, [role="button"]'))
        .filter((el) => el instanceof HTMLElement && visible(el))
        .filter((el) => {
          const text = normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '');
          return !text.includes('add dataset') && !text.includes('generate results');
        })
        .sort((left, right) => {
          const leftRect = left.getBoundingClientRect();
          const rightRect = right.getBoundingClientRect();
          if (Math.abs(rightRect.right - leftRect.right) > 4) return rightRect.right - leftRect.right;
          return leftRect.top - rightRect.top;
        });
      const genericExpand = genericButtons[0];
      if (genericExpand instanceof HTMLElement) {
        genericExpand.setAttribute('data-codex-expand-target', 'true');
        return { found: true, expanded: false };
      }

      if (isButtonLike(bestRow)) {
        bestRow.setAttribute('data-codex-expand-target', 'true');
        return { found: true, expanded: false };
      }

      return { found: true, expanded: false, reason: 'Edit controls not visible in dataset row' };
    }, { normalizedAliases, aliasTokens });
  }

  let targets = await markTargets().catch(() => ({ found: false, reason: 'Failed to inspect Data Selection row' }));
  if (!targets?.found) {
    return { opened: false, reason: targets?.reason || 'Loaded dataset row not found in Data Selection' };
  }

  if (!targets.expanded) {
    const expanded = await page.locator('[data-codex-expand-target="true"]').first().click({ timeout: 5_000 }).then(() => true).catch(() => false);
    await page.locator('[data-codex-expand-target]').evaluateAll((elements) => {
      elements.forEach((el) => el.removeAttribute('data-codex-expand-target'));
    }).catch(() => {});
    if (!expanded) {
      return { opened: false, reason: targets.reason || 'Failed to expand loaded dataset row' };
    }
    await sleep(400);
    targets = await markTargets().catch(() => ({ found: false, reason: 'Failed to re-scan expanded dataset row' }));
    if (!targets?.found) {
      return { opened: false, reason: targets?.reason || 'Loaded dataset row not found after expand' };
    }
  }

  const clickedEdit = await page.locator('[data-codex-edit-target="true"]').first().click({ timeout: 5_000 }).then(() => true).catch(() => false);
  await page.locator('[data-codex-edit-target]').evaluateAll((elements) => {
    elements.forEach((el) => el.removeAttribute('data-codex-edit-target'));
  }).catch(() => {});
  if (!clickedEdit) {
    return { opened: false, reason: 'Edit attribute filter button not clickable' };
  }

  await sleep(700);
  return { opened: true, reason: '' };
}

async function readCommittedFilterCards(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const lower = (value) => normalize(value).toLowerCase();
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    const panel = Array.from(document.querySelectorAll('aside, div, section'))
      .find((el) => (
        el instanceof HTMLElement
        && visible(el)
        && lower(el.textContent || '').includes('attribute filter')
      ));
    if (!(panel instanceof HTMLElement)) return [];

    const ignoredExact = new Set([
      'attribute filter',
      'province',
      'province *',
      'city',
      'minimum',
      'maximum',
      'include nulls',
      'save',
      'add attribute filter',
      'select city',
    ]);
    const ignoredContains = [
      'you may add filters',
      'dropdown menu: attribute filter',
      'selected options',
      'enter minimum value',
      'enter maximum value',
      'select a dataset first',
      'administrative area selection',
    ];

    const cards = Array.from(panel.querySelectorAll('div, section, article, li'))
      .filter((el) => el instanceof HTMLElement && visible(el))
      .map((el) => {
        const lines = normalize(el.innerText || el.textContent || '')
          .split('\n')
          .map((line) => normalize(line))
          .filter(Boolean)
          .filter((line) => {
            const value = lower(line);
            if (!value) return false;
            if (ignoredExact.has(value)) return false;
            if (ignoredContains.some((token) => value.includes(token))) return false;
            if (/^dki jakarta$/i.test(line)) return false;
            return true;
          });
        if (!lines.length) return null;

        const buttons = Array.from(el.querySelectorAll('button, [role="button"]'))
          .filter((button) => button instanceof HTMLElement && visible(button));
        const hasEdit = buttons.some((button) => /edit/i.test(normalize(
          button.getAttribute('aria-label')
          || button.getAttribute('title')
          || button.textContent,
        )));
        const hasDelete = buttons.some((button) => /delete|trash|remove/i.test(normalize(
          button.getAttribute('aria-label')
          || button.getAttribute('title')
          || button.textContent,
        )));
        if (!hasEdit && !hasDelete && buttons.length < 2) return null;

        const [label, ...rest] = lines;
        if (!label || label.length < 3) return null;
        return {
          label,
          summary: rest.join(' | '),
          text: lines.join(' | '),
          hasEdit,
          hasDelete,
        };
      })
      .filter(Boolean);

    const seen = new Set();
    return cards.filter((card) => {
      const key = `${lower(card.label)}::${lower(card.summary)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }).catch(() => []);
}

async function deleteCommittedFilterCard(page, expectedLabel = '') {
  const normalizeCardLabel = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const beforeCards = await readCommittedFilterCards(page).catch(() => []);
  if (!beforeCards.length) {
    return {
      attempted: true,
      deleted: false,
      reason: 'No committed filter cards were visible to delete.',
      beforeCount: 0,
      afterCount: 0,
      targetLabel: String(expectedLabel || '').trim(),
    };
  }

  const markTarget = await page.evaluate((expected) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const lower = (value) => normalize(value).toLowerCase();
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    const panel = Array.from(document.querySelectorAll('aside, div, section'))
      .find((el) => (
        el instanceof HTMLElement
        && visible(el)
        && lower(el.textContent || '').includes('attribute filter')
      ));
    if (!(panel instanceof HTMLElement)) return { found: false, reason: 'Attribute Filter panel not visible.' };

    const expectedLower = lower(expected || '');
    const cards = Array.from(panel.querySelectorAll('div, section, article, li'))
      .filter((el) => el instanceof HTMLElement && visible(el))
      .map((el) => {
        const text = normalize(el.innerText || el.textContent || '');
        const buttons = Array.from(el.querySelectorAll('button, [role="button"]'))
          .filter((button) => button instanceof HTMLElement && visible(button));
        if (!text || !buttons.length) return null;
        const deleteButton = buttons.find((button) => /delete|trash|remove/i.test(normalize(
          button.getAttribute('aria-label')
          || button.getAttribute('title')
          || button.textContent,
        )));
        if (!(deleteButton instanceof HTMLElement)) return null;
        return { el, text };
      })
      .filter(Boolean);

    if (!cards.length) return { found: false, reason: 'No deletable saved filter card was visible.' };

    const target = cards.find((card) => expectedLower && lower(card.text).includes(expectedLower))
      || cards[cards.length - 1];
    const deleteButton = Array.from(target.el.querySelectorAll('button, [role="button"]'))
      .find((button) => button instanceof HTMLElement && visible(button) && /delete|trash|remove/i.test(normalize(
        button.getAttribute('aria-label')
        || button.getAttribute('title')
        || button.textContent,
      )));
    if (!(deleteButton instanceof HTMLElement)) {
      return { found: false, reason: 'Delete button was not visible on the saved filter card.' };
    }
    deleteButton.setAttribute('data-codex-delete-filter-target', 'true');
    return { found: true, label: normalize(target.text).split('\n').map((line) => normalize(line)).filter(Boolean)[0] || '' };
  }, expectedLabel).catch(() => ({ found: false, reason: 'Failed to inspect saved filter cards.' }));

  if (!markTarget?.found) {
    return {
      attempted: true,
      deleted: false,
      reason: markTarget?.reason || 'Delete target was not found.',
      beforeCount: beforeCards.length,
      afterCount: beforeCards.length,
      targetLabel: String(expectedLabel || '').trim(),
    };
  }

  const clicked = await page.locator('[data-codex-delete-filter-target="true"]').first().click({ timeout: 5_000 }).then(() => true).catch(() => false);
  await page.locator('[data-codex-delete-filter-target]').evaluateAll((elements) => {
    elements.forEach((el) => el.removeAttribute('data-codex-delete-filter-target'));
  }).catch(() => {});
  if (!clicked) {
    return {
      attempted: true,
      deleted: false,
      reason: 'Delete button was not clickable.',
      beforeCount: beforeCards.length,
      afterCount: beforeCards.length,
      targetLabel: markTarget?.label || String(expectedLabel || '').trim(),
    };
  }

  await sleep(800);
  const afterCards = await readCommittedFilterCards(page).catch(() => []);
  const deleted = afterCards.length < beforeCards.length
    || !afterCards.some((card) => normalizeCardLabel(card.label) === normalizeCardLabel(markTarget?.label || ''));

  return {
    attempted: true,
    deleted,
    reason: deleted ? '' : 'Saved filter card count did not decrease after delete.',
    beforeCount: beforeCards.length,
    afterCount: afterCards.length,
    targetLabel: markTarget?.label || String(expectedLabel || '').trim(),
    beforeCards,
    afterCards,
  };
}

async function readLoadedDatasetTitles(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const normalizedLower = (value) => normalize(value).toLowerCase();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    const visibleElements = Array.from(document.querySelectorAll('body *'))
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => visible(el));
    const explorerVisible = visibleElements.some((el) => normalizedLower(el.textContent || '') === 'dataset explorer');
    if (explorerVisible) return [];

    const heading = visibleElements.find((el) => {
      const text = normalizedLower(el.textContent);
      return text === 'data selection' || text.startsWith('data selection ');
    });
    if (!(heading instanceof HTMLElement)) return [];

    let scanRoot = heading.parentElement;
    while (scanRoot) {
      const buttons = Array.from(scanRoot.querySelectorAll('button'))
        .filter((el) => el instanceof HTMLElement)
        .filter((el) => visible(el))
        .map((el) => normalizedLower(el.textContent || el.getAttribute('aria-label') || ''));
      const rootText = normalizedLower(scanRoot.textContent || '');
      const hasAddDataset = buttons.some((text) => text.includes('add dataset')) || rootText.includes('add dataset');
      const hasExplorerHeading = normalizedLower(scanRoot.textContent).includes('dataset explorer');
      if (hasAddDataset && !hasExplorerHeading) break;
      scanRoot = scanRoot.parentElement;
    }
    if (!(scanRoot instanceof HTMLElement)) return [];

    const extractTitleFromText = (value) => normalize(value)
      .split('\n')
      .map((line) => normalize(line))
      .find((line) => {
        const lowered = normalizedLower(line);
        if (!line || line.length < 4) return false;
        if (lowered === 'add dataset' || lowered === 'data selection') return false;
        if (lowered.includes('select your own data')) return false;
        if (lowered === 'show data table') return false;
        if (lowered === 'preview on map') return false;
        if (lowered === 'save as') return false;
        return true;
      }) || '';

    const rowContainers = Array.from(scanRoot.querySelectorAll(':scope > div, :scope > section > div, :scope > div > div'))
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => visible(el))
      .filter((el) => {
        const text = normalizedLower(el.textContent || '');
        return text && !text.includes('select your own data or explore our dataset library');
      });
    const simpleRows = rowContainers
      .map((container) => {
        const buttons = Array.from(container.querySelectorAll('button, [role="button"]'))
          .filter((el) => el instanceof HTMLElement)
          .filter((el) => visible(el));
        if (!buttons.length) return '';
        return extractTitleFromText(container.textContent || '');
      })
      .filter(Boolean);
    if (simpleRows.length) {
      return Array.from(new Set(simpleRows)).slice(0, 8);
    }

    const buttonAnchoredRows = Array.from(scanRoot.querySelectorAll('button, [role="button"]'))
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => visible(el))
      .map((button) => extractTitleFromText(button.closest('div, section, li, article')?.textContent || button.textContent || ''))
      .filter(Boolean);
    if (buttonAnchoredRows.length) {
      return Array.from(new Set(buttonAnchoredRows)).slice(0, 8);
    }

    const extractTitle = (container) => {
      const candidates = Array.from(container.querySelectorAll('input, textarea, [role="textbox"], h3, button, [aria-label], p, span, div'))
        .filter((el) => el instanceof HTMLElement)
        .filter((el) => visible(el))
        .map((el) => {
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            return normalize(el.value);
          }
          return normalize(
            el.getAttribute('aria-label')
            || el.textContent
            || ('value' in el ? el.value : ''),
          );
        })
        .filter(Boolean)
        .map((text) => text.replace(/^POI icon\s+/i, '').trim())
        .map((text) => text.replace(/\s+\(\d+\)$/i, '').trim())
        .filter((text) => !/^Toggle dataset /i.test(text))
        .filter((text) => !/^Add Dataset$/i.test(text))
        .filter((text) => !/^First Page$|^Previous Page$|^Next Page$|^Last Page$/i.test(text))
        .filter((text) => !/^Go to page /i.test(text));

      return candidates.find((text) => {
        const lowered = normalizedLower(text);
        if (text.length < 6) return false;
        if (lowered === 'data selection' || lowered === 'filter area' || lowered === 'spatial settings') return false;
        if (lowered.includes('select your own data')) return false;
        if (lowered === 'country' || lowered === 'province') return false;
        if (lowered === 'set filter area' || lowered === 'add dataset' || lowered === 'generate results') return false;
        if (lowered === 'save as') return false;
        return true;
      }) || '';
    };

    const listCandidates = Array.from(scanRoot.querySelectorAll('[role="list"], ul, ol'))
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => visible(el))
      .filter((list) => !normalizedLower(list.textContent).includes('pagination'));

    const list = listCandidates.find((candidate) => {
      const items = Array.from(candidate.querySelectorAll('[role="listitem"], li'))
        .filter((el) => el instanceof HTMLElement)
        .filter((el) => visible(el));
      return items.some((item) => {
        const itemText = normalizedLower(item.textContent || '');
        return itemText.includes('poi icon') || itemText.includes('toggle dataset');
      });
    });
    const items = list instanceof HTMLElement
      ? Array.from(list.querySelectorAll('[role="listitem"], li'))
        .filter((el) => el instanceof HTMLElement)
        .filter((el) => visible(el))
      : [];

    let titles = items.map((item) => extractTitle(item)).filter(Boolean);
    if (!titles.length) {
      const datasetCards = Array.from(scanRoot.querySelectorAll('button, [role="button"], [role="textbox"], input'))
        .filter((el) => el instanceof HTMLElement)
        .filter((el) => visible(el))
        .filter((el) => {
          const text = normalizedLower(
            el.getAttribute('aria-label')
            || el.textContent
            || ('value' in el ? el.value : ''),
          );
          return text.includes('poi icon') || text.includes('toggle dataset');
        });
      titles = datasetCards.map((card) => extractTitle(card.closest('div, li, [role="listitem"]') || card)).filter(Boolean);
    }

    if (!titles.length) {
      const lines = normalize(scanRoot.innerText || scanRoot.textContent || '')
        .split('\n')
        .map((line) => normalize(line))
        .filter(Boolean)
        .filter((line) => {
          const lowered = normalizedLower(line);
          if (line.length < 6) return false;
          if (lowered === 'data selection' || lowered === 'filter area' || lowered === 'spatial settings') return false;
          if (lowered.includes('select your own data')) return false;
          if (lowered === 'add dataset' || lowered === 'set filter area' || lowered === 'generate results') return false;
          if (lowered === 'save as') return false;
          if (lowered === 'no global filter area yet. set one to get started.') return false;
          return true;
        });
      titles = lines.slice(0, 4);
    }

    return Array.from(new Set(titles));
  }).catch(() => []);
}

async function hasAnalysisDatasetLoaded(page, expectedTitle = '') {
  return page.evaluate((expected) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    const visibleElements = Array.from(document.querySelectorAll('body *'))
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => visible(el));
    const explorerVisible = visibleElements.some((el) => normalize(el.textContent || '') === 'dataset explorer');
    if (explorerVisible) return false;
    const heading = visibleElements.find((el) => {
      const text = normalize(el.textContent);
      return text === 'data selection' || text.startsWith('data selection ');
    });
    if (!(heading instanceof HTMLElement)) return false;

    let root = heading.parentElement;
    while (root) {
      const buttons = Array.from(root.querySelectorAll('button'))
        .filter((el) => el instanceof HTMLElement)
        .filter((el) => visible(el))
        .map((el) => normalize(el.textContent || el.getAttribute('aria-label') || ''));
      const rootText = normalize(root.textContent || '');
      const hasExplorerHeading = rootText.includes('dataset explorer');
      if ((buttons.some((text) => text.includes('add dataset')) || rootText.includes('add dataset')) && !hasExplorerHeading) break;
      root = root.parentElement;
    }
    if (!(root instanceof HTMLElement)) return false;

    const rootText = normalize(root.innerText || root.textContent || '');
    if (expected && rootText.includes(normalize(expected))) return true;

    const rowMatch = Array.from(root.querySelectorAll(':scope > div, :scope > section > div, :scope > div > div, button, [role="button"]'))
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => visible(el))
      .some((container) => {
        const buttons = Array.from((container instanceof HTMLElement ? container : document.createElement('div')).querySelectorAll?.('button, [role="button"]') || [])
          .filter((el) => el instanceof HTMLElement)
          .filter((el) => visible(el));
        if (!buttons.length && !/button/i.test(container.tagName)) return false;
        const text = normalize(container.innerText || container.textContent || '');
        return expected ? text.includes(normalize(expected)) : text.length > 3;
      });
    if (rowMatch) return true;

    const buttonMatch = Array.from(root.querySelectorAll('button, [role="button"], [role="textbox"], input, textarea'))
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => visible(el))
      .some((el) => {
        const text = normalize(
          el.getAttribute('aria-label')
          || ('value' in el ? el.value : '')
          || el.textContent,
        );
        return text.includes('poi icon')
          || text.includes('toggle dataset')
          || (expected && text.includes(normalize(expected)));
      });
    if (buttonMatch) return true;

    const lines = normalize(root.innerText || root.textContent || '')
      .split('\n')
      .map((line) => normalize(line))
      .filter(Boolean);
    if (!expected) {
      return lines.some((line) => {
        const lowered = normalize(line);
        return lowered && lowered !== 'data selection' && lowered !== 'add dataset';
      });
    }
    return lines.some((line) => normalize(line).includes(normalize(expected)));
  }, expectedTitle).catch(() => false);
}

function datasetTitleMatches(loadedTitle, expectedTitle) {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const loaded = normalize(loadedTitle);
  const expected = normalize(expectedTitle);
  if (!loaded || !expected) return false;
  if (loaded.includes(expected) || expected.includes(loaded)) return true;

  const words = expected.split(' ').filter((item) => item.length > 2);
  const prefix = words.slice(0, 4).join(' ');
  return Boolean(prefix) && loaded.includes(prefix);
}

function buildExpectedDatasetLabel(expectedTitle) {
  const normalized = String(expectedTitle || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.split(' ').slice(0, 5).join(' ');
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

function buildExpectedDatasetAliases(expectedTitle) {
  const values = Array.isArray(expectedTitle) ? expectedTitle : [expectedTitle];
  const normalizedValues = values
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const normalized = normalizedValues[0] || '';
  if (!normalized) return [];

  const aliases = new Set([...normalizedValues, buildExpectedDatasetLabel(normalized)]);
  aliases.add(buildDatasetSearchQuery(normalized));
  aliases.add(normalized.split(/Provides|Description:|Weekly|Daily|A statistical|based on/i)[0].trim());
  aliases.add(normalized.split(/\s+(Polygon|Point|H3|Administrative Area|Admin\. Area|Geohash|Line)\b/i)[0].trim());
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

function normalizeDatasetText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function openDataSelectionTable(page, expectedTitle = '') {
  const aliases = buildExpectedDatasetAliases(expectedTitle).filter(Boolean);
  await page.getByText(/^Data Selection$/i).first().scrollIntoViewIfNeeded().catch(() => {});

  const normalizedAliases = aliases
    .map((alias) => normalizeDatasetText(alias))
    .filter(Boolean);
  const aliasTokens = normalizedAliases.map((alias) => new Set(alias.split(' ').filter(Boolean)));

  const rowCandidates = await page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const clearMarkers = () => {
      Array.from(document.querySelectorAll('[data-codex-data-selection-row]'))
        .forEach((el) => el.removeAttribute('data-codex-data-selection-row'));
    };
    const headingNames = ['Data Selection', 'Spatial Settings', 'Generate Results'];
    const headingMatches = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],button,span,div,p'))
      .filter((el) => el instanceof HTMLElement && visible(el))
      .map((el) => ({ el, text: normalize(el.textContent) }))
      .filter(({ text }) => headingNames.includes(text));
    const dataSelectionHeading = headingMatches.find(({ text }) => text === 'Data Selection')?.el || null;
    const dataSelectionTop = dataSelectionHeading instanceof HTMLElement
      ? dataSelectionHeading.getBoundingClientRect().top
      : Number.NEGATIVE_INFINITY;
    const nextHeadingTop = headingMatches
      .filter(({ text, el }) => (
        text !== 'Data Selection'
        && el instanceof HTMLElement
        && el.getBoundingClientRect().top > dataSelectionTop + 4
      ))
      .map(({ el }) => el.getBoundingClientRect().top)
      .sort((a, b) => a - b)[0] ?? Number.POSITIVE_INFINITY;

    const allRows = Array.from(document.querySelectorAll('[role="listitem"], li'))
      .filter((el, index, arr) => (
        el instanceof HTMLElement
        && visible(el)
        && arr.findIndex((candidate) => candidate === el) === index
      ));

    clearMarkers();

    let rowIndex = 0;
    return allRows
      .map((row) => {
        const rect = row.getBoundingClientRect();
        if (rect.bottom < dataSelectionTop - 8) return null;
        if (rect.top > nextHeadingTop - 8) return null;

        const descendantValues = Array.from(row.querySelectorAll('input,textarea,[role="textbox"],[contenteditable="true"]'))
          .filter((el) => el instanceof HTMLElement && visible(el))
          .map((el) => normalize(
            el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
              ? el.value
              : el.textContent,
          ))
          .filter(Boolean);
        const descendantLabels = Array.from(row.querySelectorAll('*'))
          .filter((el) => el instanceof HTMLElement && visible(el))
          .map((el) => normalize(
            el.getAttribute('aria-label')
            || el.getAttribute('title')
            || (el.tagName === 'IMG' ? el.getAttribute('alt') : '')
            || '',
          ))
          .filter(Boolean);
        const text = [
          normalize(row.innerText || row.textContent || ''),
          ...descendantValues,
          ...descendantLabels,
        ].filter(Boolean).join(' | ');

        if (!text) return null;
        const marker = `codex-row-${rowIndex += 1}`;
        row.setAttribute('data-codex-data-selection-row', marker);
        return {
          marker,
          text,
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
        };
      })
      .filter(Boolean);
  }).catch(() => []);

  let matchedMarker = '';
  let bestScore = -1;
  for (const row of rowCandidates) {
    const normalizedRowText = normalizeDatasetText(row?.text);
    if (!normalizedRowText) continue;
    const rowTokens = new Set(normalizedRowText.split(' ').filter(Boolean));
    let score = 0;
    for (let index = 0; index < normalizedAliases.length; index += 1) {
      const alias = normalizedAliases[index];
      const tokens = aliasTokens[index];
      if (!alias) continue;
      if (normalizedRowText.includes(alias)) score = Math.max(score, 1000 + alias.length);
      else if (alias.includes(normalizedRowText)) score = Math.max(score, 700 + normalizedRowText.length);
      else {
        let shared = 0;
        for (const token of tokens) {
          if (token && rowTokens.has(token)) shared += 1;
        }
        const coverage = tokens.size ? shared / tokens.size : 0;
        const tokenScore = Math.round(coverage * 100) + shared * 10;
        score = Math.max(score, tokenScore);
      }
    }
    if (score > bestScore) {
      bestScore = score;
      matchedMarker = row.marker;
    }
  }

  if (!matchedMarker || bestScore < 40) {
    const sampledRows = rowCandidates
      .slice(0, 5)
      .map((row) => row.text)
      .filter(Boolean)
      .join(' || ');
    return {
      opened: false,
      reason: sampledRows
        ? `Loaded dataset row not found in Data Selection (rows: ${sampledRows})`
        : 'Loaded dataset row not found in Data Selection',
    };
  }

  const matchedRow = page.locator(`[data-codex-data-selection-row="${matchedMarker}"]`).first();
  await matchedRow.scrollIntoViewIfNeeded().catch(() => {});
  await matchedRow.hover().catch(() => {});
  const rowBox = await matchedRow.boundingBox().catch(() => null);
  if (rowBox) {
    await page.mouse.move(
      Math.round(rowBox.x + Math.min(Math.max(rowBox.width - 12, 12), rowBox.width / 2)),
      Math.round(rowBox.y + Math.max(Math.min(rowBox.height / 2, rowBox.height - 8), 8)),
    ).catch(() => {});
  }
  await sleep(400);

  let clicked = false;
  const testIdButton = matchedRow.locator('button[data-testid="table-button"]').first();
  const testIdVisible = await testIdButton.isVisible().catch(() => false);
  if (testIdVisible) {
    clicked = await testIdButton.click({ timeout: 5_000 }).then(() => true).catch(() => false);
  }

  let explicitImage = matchedRow.locator('img[alt="Show data table"], img[aria-label="Show data table"]').first();
  let explicitImageVisible = await explicitImage.isVisible().catch(() => false);
  if (!clicked && !explicitImageVisible) {
    const nearbyButtonMarker = await page.evaluate((rowMarker) => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const row = document.querySelector(`[data-codex-data-selection-row="${rowMarker}"]`);
      if (!(row instanceof HTMLElement) || !visible(row)) return '';
      const rowRect = row.getBoundingClientRect();
      const buttons = Array.from(document.querySelectorAll('button'))
        .filter((button) => button instanceof HTMLElement && visible(button))
        .map((button) => {
          const image = button.querySelector('img[alt="Show data table"], img[aria-label="Show data table"]');
          if (!(image instanceof HTMLElement) || !visible(image)) return null;
          const rect = button.getBoundingClientRect();
          const verticalOverlap = Math.min(rect.bottom, rowRect.bottom) - Math.max(rect.top, rowRect.top);
          const horizontalDistance = Math.abs(rect.left - rowRect.right);
          const score = (
            (verticalOverlap > 0 ? 10_000 : 0)
            - Math.round(horizontalDistance)
            - Math.round(Math.abs(rect.top - rowRect.top))
          );
          return { button, score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);
      const winner = buttons[0]?.button;
      if (!(winner instanceof HTMLElement)) return '';
      const marker = 'codex-show-data-table-target';
      Array.from(document.querySelectorAll(`[data-codex-data-table-button="${marker}"]`))
        .forEach((el) => el.removeAttribute('data-codex-data-table-button'));
      winner.setAttribute('data-codex-data-table-button', marker);
      return marker;
    }, matchedMarker).catch(() => '');
    if (nearbyButtonMarker) {
      const nearbyButton = page.locator(`[data-codex-data-table-button="${nearbyButtonMarker}"]`).first();
      const nearbyVisible = await nearbyButton.isVisible().catch(() => false);
      if (nearbyVisible) {
        clicked = await nearbyButton.click({ timeout: 5_000 }).then(() => true).catch(() => false);
      }
      explicitImage = nearbyButton.locator('img[alt="Show data table"], img[aria-label="Show data table"]').first();
      explicitImageVisible = await explicitImage.isVisible().catch(() => false);
    }
  }
  if (!clicked && explicitImageVisible) {
    const explicitButton = explicitImage.locator('xpath=ancestor::button[1]').first();
    clicked = await explicitButton.click({ timeout: 5_000 }).then(() => true).catch(() => false);
  }

  if (!clicked) {
    const explicitButton = matchedRow.locator('button[aria-label*="data table" i], button[title*="data table" i]').first();
    const explicitButtonVisible = await explicitButton.isVisible().catch(() => false);
    if (explicitButtonVisible) {
      clicked = await explicitButton.click({ timeout: 5_000 }).then(() => true).catch(() => false);
    }
  }

  if (!clicked) {
    const tooltipButtons = matchedRow.locator('button').filter({ has: matchedRow.locator('img') });
    const buttonCount = await tooltipButtons.count().catch(() => 0);
    for (let index = 0; index < buttonCount; index += 1) {
      const button = tooltipButtons.nth(index);
      const visible = await button.isVisible().catch(() => false);
      if (!visible) continue;
      const imageAlt = await button.locator('img').first().getAttribute('alt').catch(() => '');
      if (/show data table/i.test(String(imageAlt || ''))) {
        clicked = await button.click({ timeout: 5_000 }).then(() => true).catch(() => false);
        if (clicked) break;
      }
    }
  }

  if (!clicked) {
    return { opened: false, reason: 'Show data table control not found' };
  }

  const visibleTable = await Promise.any([
    page.locator('table').first().waitFor({ state: 'visible', timeout: 10_000 }).then(() => true),
    page.getByText(/Search and filter/i).first().waitFor({ state: 'visible', timeout: 10_000 }).then(() => true),
  ]).catch(() => false);

  return { opened: visibleTable, reason: visibleTable ? '' : 'Data table did not open' };
}

async function readDataSelectionTableSample(page) {
  const readVisibleTablePage = () => page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const normalizedLabel = (el) => normalize(
      el?.getAttribute?.('aria-label')
      || el?.getAttribute?.('title')
      || el?.textContent
      || '',
    ).toLowerCase();
    const isDisabled = (el) => (
      !(el instanceof HTMLElement)
      || el.hasAttribute('disabled')
      || el.getAttribute('aria-disabled') === 'true'
      || el.getAttribute('data-disabled') === 'true'
    );

    const table = Array.from(document.querySelectorAll('table'))
      .find((el) => el instanceof HTMLElement && visible(el));
    if (!(table instanceof HTMLTableElement)) {
      return {
        title: '',
        headers: [],
        rows: [],
        rowObjects: [],
        pageInfo: '',
        paginationText: [],
        currentPage: '',
        canNext: false,
      };
    }

    let root = table.closest('[role="dialog"], [aria-modal="true"], [data-radix-dialog-content]');
    if (!(root instanceof HTMLElement)) {
      root = table.parentElement;
      while (root && root.parentElement) {
        const buttonCount = Array.from(root.querySelectorAll('button,[role="button"]'))
          .filter((el) => el instanceof HTMLElement && visible(el))
          .length;
        if (buttonCount >= 2) break;
        root = root.parentElement;
      }
    }
    const scope = root instanceof HTMLElement ? root : document.body;

    const title = Array.from(scope.querySelectorAll('h1,h2,h3,[role="heading"]'))
      .filter((el) => el instanceof HTMLElement && visible(el))
      .map((el) => normalize(el.textContent))
      .find(Boolean) || '';

    const headers = Array.from(table.querySelectorAll('thead th, th'))
      .filter((el) => el instanceof HTMLElement && visible(el))
      .map((el) => normalize(el.textContent))
      .filter(Boolean)
      .slice(0, 40);

    const rows = Array.from(table.querySelectorAll('tbody tr'))
      .filter((el) => el instanceof HTMLElement && visible(el))
      .map((row) => Array.from(row.querySelectorAll('td'))
        .filter((el) => el instanceof HTMLElement && visible(el))
        .map((cell) => normalize(cell.textContent))
        .slice(0, headers.length || 40));

    const rowObjects = rows.map((cells) => {
      const mapped = {};
      for (let index = 0; index < cells.length; index += 1) {
        const key = headers[index] || `column_${index + 1}`;
        mapped[key] = cells[index] || '';
      }
      return mapped;
    });

    const visibleTexts = Array.from(scope.querySelectorAll('*'))
      .filter((el) => el instanceof HTMLElement && visible(el))
      .map((el) => normalize(el.textContent))
      .filter(Boolean);

    const pageInfo = visibleTexts.find((text) => /of \d+ entries/i.test(text)) || '';
    const paginationText = visibleTexts
      .filter((text) => /^(\d+|‹|›|«|»|\.{3}|next|previous)$/i.test(text) || /of \d+ entries/i.test(text))
      .slice(0, 30);

    const paginationButtons = Array.from(scope.querySelectorAll('button,[role="button"]'))
      .filter((el) => el instanceof HTMLElement && visible(el));
    const currentPage = paginationButtons
      .find((el) => el.getAttribute('aria-current') === 'page' || el.getAttribute('aria-selected') === 'true');
    const currentPageText = currentPage instanceof HTMLElement ? normalize(currentPage.textContent) : '';

    let nextButton = paginationButtons.find((el) => {
      const label = normalizedLabel(el);
      return (
        (label === '›' || label === '»' || label === '>' || label === 'next' || label.includes('next page'))
        && !isDisabled(el)
      );
    });

    if (!(nextButton instanceof HTMLElement)) {
      const numberedButtons = paginationButtons.filter((el) => /^\d+$/.test(normalize(el.textContent)));
      const activeIndex = numberedButtons.findIndex((el) => (
        el.getAttribute('aria-current') === 'page'
        || el.getAttribute('aria-selected') === 'true'
        || el.getAttribute('data-state') === 'active'
      ));
      if (activeIndex >= 0) {
        nextButton = numberedButtons.slice(activeIndex + 1).find((el) => !isDisabled(el));
      }
    }

    return {
      title,
      headers,
      rows,
      rowObjects,
      pageInfo,
      paginationText,
      currentPage: currentPageText,
      canNext: nextButton instanceof HTMLElement,
    };
  }).catch(() => ({
    title: '',
    headers: [],
    rows: [],
    rowObjects: [],
    pageInfo: '',
    paginationText: [],
    currentPage: '',
    canNext: false,
  }));

  const clickNextTablePage = () => page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const isDisabled = (el) => (
      !(el instanceof HTMLElement)
      || el.hasAttribute('disabled')
      || el.getAttribute('aria-disabled') === 'true'
      || el.getAttribute('data-disabled') === 'true'
    );

    const table = Array.from(document.querySelectorAll('table'))
      .find((el) => el instanceof HTMLElement && visible(el));
    if (!(table instanceof HTMLTableElement)) return false;

    let root = table.closest('[role="dialog"], [aria-modal="true"], [data-radix-dialog-content]');
    if (!(root instanceof HTMLElement)) {
      root = table.parentElement;
      while (root && root.parentElement) {
        const buttonCount = Array.from(root.querySelectorAll('button,[role="button"]'))
          .filter((el) => el instanceof HTMLElement && visible(el))
          .length;
        if (buttonCount >= 2) break;
        root = root.parentElement;
      }
    }
    const scope = root instanceof HTMLElement ? root : document.body;
    const buttons = Array.from(scope.querySelectorAll('button,[role="button"]'))
      .filter((el) => el instanceof HTMLElement && visible(el));

    let target = buttons.find((el) => {
      const label = normalize(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '');
      return (
        (label === '›' || label === '»' || label === '>' || label === 'next' || label.includes('next page'))
        && !isDisabled(el)
      );
    });

    if (!(target instanceof HTMLElement)) {
      const numberedButtons = buttons.filter((el) => /^\d+$/.test(String(el.textContent || '').trim()));
      const activeIndex = numberedButtons.findIndex((el) => (
        el.getAttribute('aria-current') === 'page'
        || el.getAttribute('aria-selected') === 'true'
        || el.getAttribute('data-state') === 'active'
      ));
      if (activeIndex >= 0) {
        target = numberedButtons.slice(activeIndex + 1).find((el) => !isDisabled(el));
      }
    }

    if (!(target instanceof HTMLElement) || isDisabled(target)) return false;
    target.click();
    return true;
  }).catch(() => false);

  const pages = [];
  const seenSignatures = new Set();
  let title = '';
  let headers = [];
  let pageInfo = '';
  let paginationText = [];
  const maxPages = 8;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const snapshot = await readVisibleTablePage();
    const signature = JSON.stringify({
      headers: snapshot.headers,
      rows: snapshot.rows.slice(0, 5),
      pageInfo: snapshot.pageInfo,
      currentPage: snapshot.currentPage,
    });

    if (seenSignatures.has(signature)) break;
    seenSignatures.add(signature);

    title ||= snapshot.title;
    headers = headers.length ? headers : snapshot.headers;
    pageInfo = snapshot.pageInfo || pageInfo;
    paginationText = snapshot.paginationText?.length ? snapshot.paginationText : paginationText;
    pages.push(snapshot);

    if (!snapshot.canNext) break;
    const clicked = await clickNextTablePage();
    if (!clicked) break;
    await sleep(900);
  }

  const combinedRows = pages.flatMap((item) => item.rows || []);
  const combinedRowObjects = pages.flatMap((item) => item.rowObjects || []);
  const rowEvidence = pages.flatMap((item, pageIndex) => (item.rowObjects || []).map((row, rowIndex) => ({
    page: pageIndex + 1,
    row: rowIndex + 1,
    values: row,
  })));
  return {
    title,
    headers,
    rows: combinedRows,
    rowObjects: combinedRowObjects,
    rowEvidence,
    pageInfo,
    paginationText,
    pages,
    totalPagesRead: pages.length,
    truncated: pages.length >= maxPages && Boolean(pages[pages.length - 1]?.canNext),
  };
}

async function closeDataSelectionTable(page) {
  await page.keyboard.press('Escape').catch(() => {});
  const closed = await page.getByRole('button', { name: /Close/i }).first().click({ timeout: 5_000 }).then(() => true).catch(() => false)
    || await page.locator('button[aria-label*="close" i], button[title*="close" i]').first().click({ timeout: 5_000 }).then(() => true).catch(() => false);
  await sleep(400);
  return closed;
}

async function previewDataSelectionTableRowOnMap(page, preferred = {}) {
  const target = await page.evaluate((expected) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const lowered = (value) => normalize(value).toLowerCase();
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const preferredRow = expected?.row && typeof expected.row === 'object' ? expected.row : {};

    const table = Array.from(document.querySelectorAll('table'))
      .find((el) => el instanceof HTMLElement && visible(el));
    if (!(table instanceof HTMLTableElement)) return null;

    let root = table.closest('[role="dialog"], [aria-modal="true"], [data-radix-dialog-content]');
    if (!(root instanceof HTMLElement)) {
      root = table.parentElement;
      while (root && root.parentElement) {
        const buttonCount = Array.from(root.querySelectorAll('button,[role="button"]'))
          .filter((el) => el instanceof HTMLElement && visible(el))
          .length;
        if (buttonCount >= 2) break;
        root = root.parentElement;
      }
    }
    const scope = root instanceof HTMLElement ? root : document.body;
    const headers = Array.from(table.querySelectorAll('thead th, th'))
      .filter((el) => el instanceof HTMLElement && visible(el))
      .map((el) => normalize(el.textContent))
      .filter(Boolean)
      .slice(0, 40);

    const rows = Array.from(scope.querySelectorAll('tbody tr'))
      .filter((row) => row instanceof HTMLElement && visible(row))
      .map((row, index) => {
        const cells = Array.from(row.querySelectorAll('td'))
          .filter((el) => el instanceof HTMLElement && visible(el))
          .map((cell) => normalize(cell.textContent))
          .slice(0, headers.length || 40);
        const rowValues = {};
        for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
          rowValues[headers[cellIndex] || `column_${cellIndex + 1}`] = cells[cellIndex] || '';
        }
        const previewButton = Array.from(row.querySelectorAll('button,[role="button"]'))
          .find((button) => button instanceof HTMLElement && visible(button) && /preview on map/i.test(normalize(button.textContent || button.getAttribute('aria-label') || button.getAttribute('title') || '')));
        if (!(previewButton instanceof HTMLElement)) return null;

        let score = 0;
        for (const [key, value] of Object.entries(preferredRow)) {
          if (!value) continue;
          const actual = String(rowValues[key] || '');
          if (!actual) continue;
          if (lowered(actual) === lowered(value)) score += 50;
          else if (lowered(actual).includes(lowered(value)) || lowered(value).includes(lowered(actual))) score += 20;
        }
        const marker = `codex-preview-map-target-${index + 1}`;
        previewButton.setAttribute('data-codex-preview-map-target', marker);
        return { marker, rowValues, score };
      })
      .filter(Boolean)
      .sort((left, right) => right.score - left.score);

    return rows[0] || null;
  }, preferred).catch(() => null);

  if (!target?.marker) {
    return { clicked: false, reason: 'Preview on Map row not found', rowValues: {} };
  }

  const clicked = await page.locator(`[data-codex-preview-map-target="${target.marker}"]`).first()
    .click({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  await page.locator('[data-codex-preview-map-target]').evaluateAll((elements) => {
    for (const element of elements) element.removeAttribute('data-codex-preview-map-target');
  }).catch(() => {});
  await sleep(900);

  return {
    clicked,
    reason: clicked ? '' : 'Preview on Map button not clickable',
    rowValues: target.rowValues || {},
  };
}

async function readMapDetailPanel(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const dedupeLines = (lines) => {
      const unique = [];
      for (const line of lines) {
        if (!line) continue;
        if (unique[unique.length - 1] === line) continue;
        unique.push(line);
      }
      return unique;
    };

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const panels = Array.from(document.querySelectorAll('aside, section, div, article'))
      .filter((el) => el instanceof HTMLElement && visible(el))
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const rawText = String(el.innerText || el.textContent || '');
        const text = normalize(rawText);
        const lines = dedupeLines(rawText.split('\n').map((line) => normalize(line)).filter(Boolean));
        const score = (
          (rect.left > viewportWidth * 0.55 ? 200 : 0)
          + (text.toLowerCase().includes('collapse') ? 120 : 0)
          + Math.min(lines.length * 8, 120)
          + Math.round(rect.width / 10)
          + Math.round(rect.height / 20)
        );
        return { el, rect, text, lines, score };
      })
      .filter((item) => item.rect.width >= 220 && item.rect.height >= 180)
      .filter((item) => item.rect.left > viewportWidth * 0.45)
      .filter((item) => item.lines.length >= 4)
      .sort((left, right) => right.score - left.score || right.rect.height - left.rect.height);

    const panel = panels[0];
    if (!panel) {
      return { opened: false, title: '', fields: [], lines: [] };
    }

    const lines = panel.lines
      .filter((line) => !/^collapse$/i.test(line))
      .filter((line) => !/^close$/i.test(line));
    const title = lines[0] || '';
    const bodyLines = lines.slice(1);
    const fields = [];

    for (let index = 0; index < bodyLines.length - 1; index += 1) {
      const label = bodyLines[index];
      const value = bodyLines[index + 1];
      if (!label || !value) continue;
      if (/^collapse$/i.test(label) || /^collapse$/i.test(value)) continue;
      if (/^[\d.,-]+$/.test(label)) continue;
      if (label.length > 100 || value.length > 120) continue;
      fields.push({ label, value });
      index += 1;
    }

    return {
      opened: fields.length > 0 || Boolean(title),
      title,
      fields,
      lines,
    };
  }).catch(() => ({ opened: false, title: '', fields: [], lines: [] }));
}

async function closeMapDetailPanel(page) {
  await page.keyboard.press('Escape').catch(() => {});
  const closed = await page.getByRole('button', { name: /close|collapse/i }).first().click({ timeout: 5_000 }).then(() => true).catch(() => false)
    || await page.locator('button[aria-label*="close" i], button[title*="close" i], button[aria-label*="collapse" i], button[title*="collapse" i]').first().click({ timeout: 5_000 }).then(() => true).catch(() => false);
  await sleep(500);
  return closed;
}

async function clickMapGeometryAndReadDetail(page) {
  const initialPanel = await readMapDetailPanel(page).catch(() => ({ opened: false, title: '', fields: [], lines: [] }));
  if (initialPanel?.opened) {
    await closeMapDetailPanel(page).catch(() => false);
    await sleep(300);
  }
  const clickPoints = await page.evaluate(() => {
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const panelLike = Array.from(document.querySelectorAll('aside, section, div, article'))
      .filter((el) => el instanceof HTMLElement && visible(el))
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return { rect, text };
      });
    const canvases = Array.from(document.querySelectorAll('canvas'))
      .filter((el) => el instanceof HTMLElement && visible(el))
      .map((el) => ({ el, rect: el.getBoundingClientRect(), area: el.getBoundingClientRect().width * el.getBoundingClientRect().height }))
      .sort((left, right) => right.area - left.area);
    const canvas = canvases[0];
    if (!canvas) return [];

    const { left, top, width, height } = canvas.rect;
    const leftPanel = panelLike
      .filter((item) => item.rect.left < width * 0.4)
      .filter((item) => item.rect.width >= 180 && item.rect.height >= 180)
      .sort((a, b) => b.rect.width - a.rect.width)[0];
    const rightPanel = panelLike
      .filter((item) => item.rect.left > width * 0.45)
      .filter((item) => item.rect.width >= 180 && item.rect.height >= 180)
      .sort((a, b) => b.rect.width - a.rect.width)[0];
    const mapLeft = Math.max(left, leftPanel ? leftPanel.rect.right + 24 : left + width * 0.12);
    const mapRight = Math.min(left + width, rightPanel ? rightPanel.rect.left - 24 : left + width * 0.88);
    const safeWidth = Math.max(120, mapRight - mapLeft);
    const centerX = mapLeft + safeWidth * 0.5;
    const candidates = [
      { x: centerX, y: top + height * 0.50 },
      { x: centerX - safeWidth * 0.08, y: top + height * 0.50 },
      { x: centerX + safeWidth * 0.08, y: top + height * 0.50 },
      { x: centerX, y: top + height * 0.42 },
      { x: centerX, y: top + height * 0.58 },
      { x: centerX - safeWidth * 0.12, y: top + height * 0.42 },
      { x: centerX + safeWidth * 0.12, y: top + height * 0.58 },
    ];
    return candidates.map((point) => ({
      x: Math.round(point.x),
      y: Math.round(point.y),
    }));
  }).catch(() => []);

  for (const point of clickPoints) {
    await page.mouse.click(point.x, point.y).catch(() => {});
    await sleep(900);
    const panel = await readMapDetailPanel(page).catch(() => ({ opened: false, title: '', fields: [], lines: [] }));
    const changed = JSON.stringify(panel.fields || []) !== JSON.stringify(initialPanel.fields || [])
      || String(panel.title || '') !== String(initialPanel.title || '');
    if (panel.opened && panel.fields?.length && changed) {
      return {
        opened: true,
        title: panel.title || '',
        fields: panel.fields || [],
        lines: panel.lines || [],
        clickPoint: point,
      };
    }
  }

  const fallbackPanel = await readMapDetailPanel(page).catch(() => ({ opened: false, title: '', fields: [], lines: [] }));
  return {
    opened: Boolean(fallbackPanel.opened && (fallbackPanel.fields || []).length),
    title: fallbackPanel.title || '',
    fields: fallbackPanel.fields || [],
    lines: fallbackPanel.lines || [],
    clickPoint: null,
    reason: fallbackPanel.opened ? '' : 'Map detail panel did not open after clicking visible geometry candidates',
  };
}

async function addDatasetFromExplorer(page, expectedTitle = '') {
  const button = page
    .locator('[data-testid="dataset-explorer-attribute-filter-add-dataset-button"], [role="button"], button')
    .filter({ hasText: /add dataset/i })
    .first();
  const isButtonVisible = await button.isVisible().catch(() => false);
  if (!isButtonVisible) {
    return { attempted: false, added: false, reason: 'Add Dataset button not found' };
  }
  const enabled = await button.isEnabled().catch(() => false);
  if (!enabled) {
    return { attempted: false, added: false, reason: 'Add Dataset disabled' };
  }

  const beforeTitles = await readLoadedDatasetTitles(page);
  const clicked = await button.click({ timeout: 5_000 }).then(() => true).catch(() => false);
  if (!clicked) {
    return { attempted: true, added: false, reason: 'Failed to click Add Dataset' };
  }

  const startedAt = Date.now();
  const maxWaitMs = 35_000;
  const noSignalBudgetMs = 35_000;
  let sawSuccessToast = false;
  let loadedTitles = beforeTitles;
  let sawLoadingToast = false;
  let explorerClosed = false;
  const expectedAliases = buildExpectedDatasetAliases(expectedTitle);
  const aliasVisibleInBody = async () => Promise.any(
    expectedAliases.map((alias) => page.getByText(new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).first().isVisible().catch(() => false)),
  ).catch(() => false);
  while (Date.now() - startedAt < maxWaitMs) {
    sawLoadingToast ||= await page.getByText(/Please wait while dataset is being loaded/i).first().isVisible().catch(() => false);
    sawSuccessToast ||= await page.getByText(/Dataset Loaded Successfully/i).first().isVisible().catch(() => false);
    explorerClosed ||= !await page.getByText(/^Dataset Explorer$/).first().isVisible().catch(() => false);
    const elapsed = Date.now() - startedAt;

    const analysisLoaded = expectedAliases.length
      ? await Promise.any(expectedAliases.map((alias) => hasAnalysisDatasetLoaded(page, alias).catch(() => false)))
        .catch(() => false)
      : await hasAnalysisDatasetLoaded(page, '').catch(() => false);

    if (!sawLoadingToast && !sawSuccessToast && !analysisLoaded && elapsed > noSignalBudgetMs) {
      return {
        attempted: true,
        added: false,
        reason: 'No loading/success signal after Add Dataset',
        sawSuccessToast,
        sawLoadingToast,
        loadedTitles,
      };
    }

    if (!explorerClosed && !analysisLoaded) {
      if (sawSuccessToast) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.getByRole('button', { name: /Close/i }).first().click().catch(() => {});
        await sleep(700);
        explorerClosed = !await page.getByText(/^Dataset Explorer$/).first().isVisible().catch(() => false);
      }
      await sleep(500);
      continue;
    }

    loadedTitles = await readLoadedDatasetTitles(page);
    const titleMatched = expectedAliases.length
      ? loadedTitles.some((title) => expectedAliases.some((alias) => datasetTitleMatches(title, alias)))
      : false;
    const labelVisible = explorerClosed ? await aliasVisibleInBody() : false;

    if (analysisLoaded || titleMatched || (explorerClosed && sawSuccessToast)) {
      return {
        attempted: true,
        added: true,
        reason: analysisLoaded || titleMatched ? '' : 'Success toast observed; committed-state verification deferred to post-add reconciliation.',
        sawSuccessToast,
        loadedTitles,
        explorerClosed,
        labelVisible,
      };
    }

    await sleep(500);
  }

  if (sawSuccessToast) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.getByRole('button', { name: /Close/i }).first().click().catch(() => {});
    await sleep(700);
    const loadedTitlesAfterClose = await readLoadedDatasetTitles(page);
    const visibleAfterClose = expectedAliases.length
      ? await Promise.any(expectedAliases.map((alias) => hasAnalysisDatasetLoaded(page, alias).catch(() => false))).catch(() => false)
      : await hasAnalysisDatasetLoaded(page, '').catch(() => false);
    const titleMatchedAfterClose = expectedAliases.length
      ? loadedTitlesAfterClose.some((title) => expectedAliases.some((alias) => datasetTitleMatches(title, alias)))
      : false;
    if (visibleAfterClose || titleMatchedAfterClose) {
      return {
        attempted: true,
        added: true,
        reason: '',
        sawSuccessToast,
        loadedTitles: loadedTitlesAfterClose,
        explorerClosed: true,
        labelVisible: true,
      };
    }
    return {
      attempted: true,
      added: true,
      reason: 'Success toast observed; committed-state verification deferred to post-add reconciliation.',
      sawSuccessToast,
      sawLoadingToast,
      loadedTitles: loadedTitlesAfterClose,
      explorerClosed: true,
      labelVisible: false,
    };
  }

  return {
    attempted: true,
    added: false,
    reason: 'Dataset did not appear in Data Selection after Add Dataset',
    sawSuccessToast,
    sawLoadingToast,
    loadedTitles,
  };
}

async function runDatasetExplorerFocusedWorkflow(page, action, beforeUrl, beforeTitle, runId = '') {
  const openResult = await clickVisibleActionable(page, action.text);
  if (!openResult) {
    return {
      ok: false,
      action,
      beforeUrl,
      afterUrl: page.url(),
      afterTitle: await page.title().catch(() => beforeTitle),
      error: 'Failed to open Dataset Explorer',
    };
  }

  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(1000);
  await clickVisibleContaining(page, 'Bvarta & Partner Data').catch(() => {});
  await sleep(500);

  const steps = [];
  const workflowBaseUrl = beforeUrl;

  for (const aggregation of config.datasetExplorerSpatialAggregations) {
    const step = {
      aggregation,
      selectedDataset: false,
      provinceSelected: false,
      attributeFilter: null,
      addDataset: null,
      attempts: [],
    };
    const completedStep = await withTimeout(async () => {
      const result = step;

      await resetDatasetExplorerContext(page, workflowBaseUrl);
      await selectAggregation(page, aggregation);
      result.contextScreenshot = await captureWorkflowScreenshot(page, runId, `workflow-${aggregation}-landing`);

      const candidates = await listDatasetCardCandidates(page, aggregation);
      if (!candidates.length) {
        result.error = `No BVT dataset card found for ${aggregation}`;
        result.url = page.url();
        result.title = await page.title().catch(() => '');
        return result;
      }

      const candidateList = candidates.filter((candidate) => !candidate.locked);

      for (const candidate of candidateList.slice(0, config.workflowCandidateLimit)) {
        await withTimeout(async () => {
          await resetDatasetExplorerContext(page, workflowBaseUrl);
          await selectAggregation(page, aggregation);

          const attempt = {
            candidate: candidate.title,
            clicked: false,
            locked: Boolean(candidate.locked),
            provinceSelected: false,
            attributeFilter: null,
            addDataset: null,
            screenshot: '',
          };

          const clicked = await clickDatasetCardByTitle(page, aggregation, candidate.title);
          attempt.clicked = clicked;

          if (!clicked) {
            attempt.error = 'Candidate card not clickable';
            attempt.screenshot = await captureWorkflowScreenshot(page, runId, `workflow-${aggregation}-${candidate.title}-not-clickable`);
            result.attempts.push(attempt);
            return;
          }

          attempt.provinceSelected = await chooseProvince(page);
          attempt.attributeFilter = await applyRandomAttributeFilter(page);
          attempt.addDataset = await addDatasetFromExplorer(page, candidate.title);
          attempt.screenshot = await captureWorkflowScreenshot(page, runId, `workflow-${aggregation}-${candidate.title}`);
          result.attempts.push(attempt);

          const progressed = attempt.provinceSelected || attempt.attributeFilter?.applied || attempt.addDataset?.added;
          if (!progressed) {
            await dismissTransientUi(page).catch(() => []);
            return;
          }

          result.selectedDataset = true;
          result.selectedCandidate = candidate.title;
          result.provinceSelected = attempt.provinceSelected;
          result.attributeFilter = attempt.attributeFilter;
          result.addDataset = attempt.addDataset;
        }, config.workflowStepTimeoutMs, `Dataset Explorer candidate ${aggregation}:${candidate.title}`).catch((error) => {
          result.attempts.push({
            candidate: candidate.title,
            clicked: false,
            provinceSelected: false,
            attributeFilter: null,
            addDataset: null,
            screenshot: '',
            error: error instanceof Error ? error.message : String(error),
          });
        });

        if (result.selectedDataset) break;
      }

      if (!result.selectedDataset) {
        if (!candidateList.length) {
          result.error = `No unlocked candidate found for ${aggregation}`;
        } else {
          result.error = result.attempts.some((item) => item.clicked && (item.provinceSelected || item.attributeFilter?.applied || item.addDataset?.added))
            ? `No meaningful progress after trying ${result.attempts.length} candidate(s)`
            : `Failed to click any ${aggregation} candidate card`;
        }

        const succeededAttempt = result.attempts.find((item) => item.clicked && (item.provinceSelected || item.attributeFilter?.applied || item.addDataset?.added));
        result.selectedDataset = Boolean(succeededAttempt);
        result.selectedCandidate = succeededAttempt?.candidate || '';
        result.provinceSelected = succeededAttempt?.provinceSelected || false;
        result.attributeFilter = succeededAttempt?.attributeFilter || { attempted: false, applied: false, reason: 'No successful progress' };
        result.addDataset = succeededAttempt?.addDataset || { attempted: false, added: false, reason: 'No successful progress' };
      }

      if (result.error) {
        result.llmGuidance = await suggestGuidedActions({
          workflow: 'dataset-explorer-bvt',
          aggregation,
          attempts: result.attempts,
          currentUrl: page.url(),
          title: await page.title().catch(() => ''),
          maxSuggestedActions: config.llmMaxGuidedSteps,
        });
      }

      result.url = page.url();
      result.title = await page.title().catch(() => '');
      return result;
    }, config.workflowStepTimeoutMs * 3, `Dataset Explorer aggregation ${aggregation}`).catch(async (error) => {
      step.attributeFilter = step.attributeFilter || { attempted: false, applied: false, reason: 'Aggregation timed out' };
      step.addDataset = step.addDataset || { attempted: false, added: false, reason: 'Aggregation timed out' };
      step.error = error instanceof Error ? error.message : String(error);
      step.url = page.url();
      step.title = await page.title().catch(() => '');
      step.timeoutScreenshot = await captureWorkflowScreenshot(page, runId, `workflow-${aggregation}-timeout`);
      return step;
    });

    steps.push(completedStep);
  }

  return {
    ok: steps.some((step) => step.addDataset?.added || step.provinceSelected || step.selectedDataset),
    action,
    beforeUrl,
    afterUrl: page.url(),
    afterTitle: await page.title().catch(() => ''),
    mode: 'workflow',
    workflow: {
      name: 'dataset-explorer-bvt',
      steps,
    },
  };
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function shouldRecoverFromError(error) {
  const message = errorText(error).toLowerCase();
  return agentPolicy.safety.retryOnTransientUi && (
    message.includes('intercepts pointer events')
    || message.includes('another element would receive the click')
    || message.includes('element is not attached')
    || message.includes('timeout')
  );
}

async function dismissTransientUi(page) {
  const recoverySteps = [];

  await page.keyboard.press('Escape').catch(() => {});
  await sleep(300);

  const closeSelectors = [
    '[data-testid="modal"] button',
    '[role="dialog"] button',
    'button[aria-label*="close" i]',
    'button[title*="close" i]',
    'button:has-text("Close")',
    'button:has-text("Cancel")',
    'button:has-text("Done")',
    'button:has-text("Back")',
  ];

  for (const selector of closeSelectors) {
    const clicked = await clickFirstMatching(page, [selector]).catch(() => false);
    if (clicked) {
      recoverySteps.push(`clicked:${selector}`);
      await sleep(300);
      break;
    }
  }

  await page.waitForLoadState('networkidle').catch(() => {});
  return recoverySteps;
}

async function dismissAttributeFilterEditor(page) {
  const steps = [];
  const backButton = page
    .locator('[data-testid="header-back-button"], button:has(svg), button:has-text("Back")')
    .first();

  const hasEditor = await page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    return Array.from(document.querySelectorAll('aside, div, section')).some((el) => (
      el instanceof HTMLElement
      && visible(el)
      && normalize(el.textContent || '').includes('attribute filter')
      && normalize(el.textContent || '').includes('selected options')
    ));
  }).catch(() => false);

  if (!hasEditor) {
    return steps;
  }

  const clickedBack = await backButton.click({ timeout: 5_000 }).then(() => true).catch(() => false);
  if (clickedBack) {
    steps.push('attribute-filter:back');
    await sleep(350);
  }

  return steps;
}

async function performAction(page, action, beforeUrl, beforeTitle, runId = '') {
  const workflowResult = await runFeatureWorkflow({
    page,
    action,
    beforeUrl,
    beforeTitle,
    runId,
    helpers: {
      clickVisibleActionable,
      clickVisibleContaining,
      openAnalysisBase,
      resetAnalysisState,
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
      readAnalysisJobQueueEntries,
      activateDrawPolygonMode,
      openAnalysisAddDataset,
      listDatasetCardCandidates,
      searchDatasetExplorer,
      resetDatasetExplorerContext,
      selectAggregation,
      clickDatasetCardByTitle,
      clickDatasetCardCandidate,
      readActiveDatasetSelection,
      readLoadedDatasetTitles,
      hasAnalysisDatasetLoaded,
      openDataSelectionTable,
      openDataSelectionEditFilter,
      readCommittedFilterCards,
      readDataSelectionTableSample,
      closeDataSelectionTable,
      previewDataSelectionTableRowOnMap,
      readMapDetailPanel,
      clickMapGeometryAndReadDetail,
      chooseProvince,
      applyRandomAttributeFilter,
      deleteCommittedFilterCard,
      addDatasetFromExplorer,
      dismissAttributeFilterEditor,
      dismissTransientUi,
      captureWorkflowScreenshot,
      waitBrieflyForIdle,
      sleep,
    },
  });
  if (workflowResult) {
    return workflowResult;
  }

  if (action.type === 'link' && action.href) {
    await page.goto(action.href, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    return { ok: true, action, beforeUrl, afterUrl: page.url(), afterTitle: await page.title().catch(() => ''), mode: 'navigate' };
  }

  if (action.type === 'button') {
    const clicked = await clickVisibleActionable(page, action.text);
    if (!clicked) {
      return {
        ok: false,
        action,
        beforeUrl,
        afterUrl: page.url(),
        afterTitle: await page.title().catch(() => ''),
        error: `No visible actionable element matched: ${action.text}`,
      };
    }
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(1000);
    return { ok: true, action, beforeUrl, afterUrl: page.url(), afterTitle: await page.title().catch(() => ''), mode: 'click' };
  }

  return { ok: false, action, beforeUrl, afterUrl: page.url(), afterTitle: await page.title().catch(() => beforeTitle), error: 'Unsupported action type' };
}

export async function createBrowserSession(runId) {
  const browser = await chromium.launch({
    headless: config.headless,
    args: [
      '--use-angle=gl',
      '--use-gl=angle',
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  context.setDefaultTimeout(config.requestTimeoutMs);
  context.setDefaultNavigationTimeout(config.navigationTimeoutMs);
  const page = await context.newPage();
  page.__agentRunId = runId;
  return { browser, context, page, runId, screenshotsPath: screenshotDir(runId) };
}

export async function closeBrowserSession(session) {
  await session.browser.close();
}

export async function login(page) {
  const emailSelectors = [
    'input[type="email"]',
    'input[name*="email" i]',
    'input[id*="email" i]',
    'input[placeholder*="email" i]',
    'input[autocomplete="username"]',
  ];
  const passwordSelectors = [
    'input[type="password"]',
    'input[name*="password" i]',
    'input[id*="password" i]',
    'input[placeholder*="password" i]',
    'input[autocomplete="current-password"]',
  ];
  const submitSelectors = [
    'button:has-text("Sign in")',
    'button:has-text("Login")',
    'button:has-text("Log in")',
    'button:has-text("Masuk")',
    'button:has-text("Continue")',
    'button:has-text("Lanjut")',
    'button[type="submit"]',
    'input[type="submit"]',
  ];

  await page.goto(config.appUrl, { waitUntil: 'domcontentloaded' });
  await waitBrieflyForIdle(page);

  if (config.loginSelectors.email) {
    await page.locator(config.loginSelectors.email).fill(config.appEmail);
  } else {
    await fillFirstMatching(page, emailSelectors, config.appEmail);
  }

  if (!config.loginSelectors.password && !(await hasVisibleEditable(page, passwordSelectors))) {
    await clickFirstMatching(page, submitSelectors);
    await waitBrieflyForIdle(page);
    await sleep(1000);
  }

  if (config.loginSelectors.password) {
    await page.locator(config.loginSelectors.password).fill(config.appPassword);
  } else {
    await fillFirstMatching(page, passwordSelectors, config.appPassword);
  }

  if (config.loginSelectors.submit) {
    await page.locator(config.loginSelectors.submit).click();
  } else {
    await clickFirstMatching(page, submitSelectors);
  }

  await waitBrieflyForIdle(page);
  await sleep(1500);
  return {
    currentUrl: page.url(),
    title: await page.title(),
  };
}

export async function capturePageSnapshot(page, runId, label = 'page') {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});

  const timestamp = Date.now();
  const shotFile = path.join(screenshotDir(runId), `${String(timestamp)}-${slugify(label)}.png`);
  await page.screenshot({ path: shotFile, fullPage: true }).catch(() => {});

  const data = await page.evaluate(({ appUrl }) => {
    const origin = new URL(appUrl).origin;
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const uniq = (items, keyFn) => {
      const seen = new Set();
      return items.filter((item) => {
        const key = keyFn(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };

    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .filter(visible)
      .map((el) => textOf(el))
      .filter(Boolean)
      .slice(0, 20);

    const buttons = uniq(
      Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'))
        .filter(visible)
        .map((el) => ({ text: textOf(el) || el.getAttribute('aria-label') || el.getAttribute('title') || '', type: el.tagName.toLowerCase() }))
        .filter((item) => item.text),
      (item) => `${item.type}:${item.text}`,
    ).slice(0, 50);

    const links = uniq(
      Array.from(document.querySelectorAll('a[href]'))
        .filter(visible)
        .map((el) => {
          const href = el.href;
          const sameOrigin = href.startsWith(origin);
          return {
            text: textOf(el) || el.getAttribute('aria-label') || el.getAttribute('title') || href,
            href,
            sameOrigin,
          };
        })
        .filter((item) => item.sameOrigin),
      (item) => item.href,
    ).slice(0, 80);

    const inputs = uniq(
      Array.from(document.querySelectorAll('input, textarea, select'))
        .filter(visible)
        .map((el) => {
          const label = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
          return {
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || '',
            name: el.getAttribute('name') || '',
            id: el.getAttribute('id') || '',
            placeholder: el.getAttribute('placeholder') || '',
            label: label ? textOf(label) : '',
          };
        }),
      (item) => `${item.tag}:${item.type}:${item.name}:${item.id}:${item.placeholder}:${item.label}`,
    ).slice(0, 50);

    const forms = Array.from(document.querySelectorAll('form')).map((form, index) => ({
      index,
      action: form.getAttribute('action') || '',
      method: form.getAttribute('method') || 'get',
      inputCount: form.querySelectorAll('input, textarea, select').length,
      buttonCount: form.querySelectorAll('button, input[type="submit"]').length,
    }));

    const tables = Array.from(document.querySelectorAll('table')).map((table, index) => ({
      index,
      headers: Array.from(table.querySelectorAll('th')).map((el) => textOf(el)).filter(Boolean).slice(0, 10),
      rowCount: table.querySelectorAll('tbody tr').length || table.querySelectorAll('tr').length,
    })).slice(0, 20);

    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], dialog')).filter(visible).map((el) => textOf(el)).filter(Boolean).slice(0, 10);

    const bodyText = textOf(document.body).slice(0, 4000);
    const htmlLang = document.documentElement.lang || '';
    const metaVersion = Array.from(document.querySelectorAll('meta[name], meta[property]'))
      .map((el) => `${el.getAttribute('name') || el.getAttribute('property')}:${el.getAttribute('content') || ''}`)
      .filter((item) => /version|build|commit/i.test(item))
      .slice(0, 20);
    const assets = Array.from(document.querySelectorAll('script[src], link[href]'))
      .map((el) => el.getAttribute('src') || el.getAttribute('href') || '')
      .filter(Boolean)
      .filter((value) => /build|chunk|version|main|app/i.test(value))
      .slice(0, 15);

    const bodyLines = textOf(document.body)
      .split(/\s{2,}|\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => /version|build|commit|release|v\d+/i.test(line))
      .slice(0, 20);

    return {
      url: location.href,
      pathname: location.pathname,
      title: document.title,
      htmlLang,
      headings,
      buttons,
      links,
      inputs,
      forms,
      tables,
      dialogs,
      bodyText,
      versionHints: [...metaVersion, ...assets, ...bodyLines],
    };
  }, { appUrl: config.appUrl });

  const pageKey = `${data.pathname || '/'}::${data.title || 'untitled'}`;
  return {
    ...data,
    pageKey,
    screenshot: shotFile,
    fingerprint: hash(JSON.stringify({
      pathname: data.pathname,
      title: data.title,
      headings: data.headings,
      buttons: data.buttons,
      inputs: data.inputs,
      forms: data.forms,
      tables: data.tables,
      dialogs: data.dialogs,
      bodyText: data.bodyText,
    })),
  };
}

export function buildCandidateLinks(pageSnapshot) {
  return uniqueBy(
    (pageSnapshot.links || [])
      .filter((link) => link.sameOrigin)
      .filter((link) => !/logout|signout|log out|keluar/i.test(link.text))
      .slice(0, config.maxNavLinksPerPage),
    (link) => link.href,
  );
}

export function buildCandidateActions(pageSnapshot) {
  const actions = [];

  for (const button of pageSnapshot.buttons || []) {
    const text = pickText(button.text);
    if (!text) continue;
    if (isDangerousLabel(text) && !config.allowDestructive) continue;
    actions.push({ type: 'button', text, dangerous: isDangerousLabel(text), priority: actionPriority(text) });
  }

  for (const link of pageSnapshot.links || []) {
    const text = pickText(link.text);
    if (!text) continue;
    if (isDangerousLabel(text) && !config.allowDestructive) continue;
    actions.push({ type: 'link', text, href: link.href, dangerous: isDangerousLabel(text), priority: actionPriority(text) });
  }

  const prioritized = uniqueBy(actions, (item) => `${item.type}:${item.text}:${item.href || ''}`)
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.text.localeCompare(b.text);
    })
    .map(({ priority, ...action }) => action);

  if (String(config.focusedWorkflow || '').startsWith('dataset-explorer')) {
    return prioritized.filter((action) => action.text === 'Dataset Explorer').slice(0, 1);
  }

  if (config.focusedWorkflow === 'spatial-analysis-workflow') {
    return prioritized.filter((action) => action.text === 'Analysis').slice(0, 1);
  }

  return prioritized.slice(0, config.maxActionsPerPage);
}

export async function executeCandidateAction(page, action) {
  const beforeUrl = page.url();
  const beforeTitle = await page.title().catch(() => '');
  const runId = page.__agentRunId || '';

  try {
    return await performAction(page, action, beforeUrl, beforeTitle, runId);
  } catch (error) {
    if (shouldRecoverFromError(error)) {
      const recoverySteps = await dismissTransientUi(page);
      try {
        const retried = await performAction(page, action, beforeUrl, beforeTitle, runId);
        return {
          ...retried,
          recovery: {
            attempted: true,
            steps: recoverySteps,
            retried: true,
            originalError: errorText(error),
          },
        };
      } catch (retryError) {
        return {
          ok: false,
          action,
          beforeUrl,
          afterUrl: page.url(),
          afterTitle: await page.title().catch(() => beforeTitle),
          error: errorText(retryError),
          recovery: {
            attempted: true,
            steps: recoverySteps,
            retried: true,
            originalError: errorText(error),
            retryError: errorText(retryError),
          },
        };
      }
    }

    return {
      ok: false,
      action,
      beforeUrl,
      afterUrl: page.url(),
      afterTitle: await page.title().catch(() => beforeTitle),
      error: errorText(error),
    };
  }
}

export async function restorePage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
}
