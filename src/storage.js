import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function ensureDataDirs() {
  ensureDir(config.dataDir);
  ensureDir(path.join(config.dataDir, 'runs'));
  ensureDir(path.join(config.dataDir, 'baselines'));
  ensureDir(path.join(config.dataDir, 'reports'));
  ensureDir(path.join(config.dataDir, 'screenshots'));
}

export function removePath(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeText(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, value, 'utf8');
}

export function runFile(runId) {
  return path.join(config.dataDir, 'runs', `${runId}.json`);
}

export function baselineFile(name = config.baselineName) {
  return path.join(config.dataDir, 'baselines', `${name}.json`);
}

export function reportFile(runId) {
  return path.join(config.dataDir, 'reports', `${runId}.md`);
}

export function screenshotDir(runId) {
  return path.join(config.dataDir, 'screenshots', runId);
}

export function loadBaseline(name = config.baselineName) {
  return readJson(baselineFile(name), null);
}

export function saveBaseline(name, value) {
  writeJson(baselineFile(name), value);
}

export function saveRun(runId, value) {
  writeJson(runFile(runId), value);
}

export function saveReport(runId, markdown) {
  writeText(reportFile(runId), markdown);
}
