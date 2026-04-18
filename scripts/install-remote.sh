#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${REMOTE_HOST:?Set REMOTE_HOST to the SSH alias or hostname for your OpenClaw machine}"
REMOTE_EXT_DIR="${REMOTE_EXT_DIR:-.openclaw/extensions/totalreclaw}"
REMOTE_SKILL_DIR="${REMOTE_SKILL_DIR:-.openclaw/skills/TotalReClaw}"
REMOTE_STORE_ROOT="${REMOTE_STORE_ROOT:-.openclaw/totalreclaw}"

echo "[totalreclaw] syncing repo to ${REMOTE_HOST}:${REMOTE_EXT_DIR}"
rsync -az --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'coverage/' \
  --exclude '.DS_Store' \
  "${REPO_ROOT}/" "${REMOTE_HOST}:${REMOTE_EXT_DIR}/"

echo "[totalreclaw] syncing managed skill to ${REMOTE_HOST}:${REMOTE_SKILL_DIR}"
ssh "${REMOTE_HOST}" "mkdir -p '${REMOTE_SKILL_DIR}'"
rsync -az --delete "${REPO_ROOT}/skills/TotalReClaw/" "${REMOTE_HOST}:${REMOTE_SKILL_DIR}/"

echo "[totalreclaw] configuring remote OpenClaw plugin state"
ssh "${REMOTE_HOST}" "REMOTE_EXT_DIR='${REMOTE_EXT_DIR}' REMOTE_STORE_ROOT='${REMOTE_STORE_ROOT}' node - <<'NODE'
const fs = require('fs');
const path = require('path');

const home = process.env.HOME;
const configPath = path.join(home, '.openclaw', 'openclaw.json');
const backupPath = configPath + '.bak-totalreclaw-' + Date.now();
const resolveHomePath = (input) => path.isAbsolute(input) ? input : path.join(home, input);
const remoteExtDir = resolveHomePath(process.env.REMOTE_EXT_DIR);
const remoteStoreRoot = resolveHomePath(process.env.REMOTE_STORE_ROOT);

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
fs.copyFileSync(configPath, backupPath);

config.plugins = config.plugins ?? {};
config.plugins.entries = config.plugins.entries ?? {};
config.plugins.installs = config.plugins.installs ?? {};
config.plugins.allow = Array.isArray(config.plugins.allow) ? config.plugins.allow : [];

if (!config.plugins.allow.includes('totalreclaw')) {
  config.plugins.allow.push('totalreclaw');
}

const existingEntry = config.plugins.entries.totalreclaw ?? {};
const existingConfig =
  existingEntry && typeof existingEntry === 'object' && existingEntry.config && typeof existingEntry.config === 'object'
    ? existingEntry.config
    : {};

config.plugins.entries.totalreclaw = {
  enabled: true,
  config: {
    ...existingConfig,
    enableAutoRecall: true,
    enableAutoCheck: true,
    enableAutoCapture: true,
    dbPath: path.join(remoteStoreRoot, 'totalreclaw.db'),
    storePath: path.join(remoteStoreRoot, 'lessons.jsonl'),
    draftPath: path.join(remoteStoreRoot, 'review'),
    sessionStatePath: path.join(remoteStoreRoot, 'state', 'sessions'),
    hookTimeoutMs: 800,
    summaryModel: 'deterministic',
    priorFixThreshold: 0.65,
    noMatchThreshold: 0.4,
    conflictWindow: 0.1,
    maxRecordsInjected: 3,
    maxTokensInjected: 500
  }
};

config.plugins.installs.totalreclaw = {
  source: 'path',
  spec: remoteExtDir,
  sourcePath: remoteExtDir,
  installPath: remoteExtDir,
  version: '0.2.0',
  resolvedSpec: remoteExtDir,
  installedAt: new Date().toISOString()
};

fs.mkdirSync(path.join(remoteStoreRoot, 'review'), { recursive: true });
fs.mkdirSync(path.join(remoteStoreRoot, 'state', 'sessions'), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

console.log('[totalreclaw] backed up config to ' + backupPath);
console.log('[totalreclaw] wrote plugin config to ' + configPath);
NODE"

echo "[totalreclaw] validating config"
ssh "${REMOTE_HOST}" "openclaw config validate"

echo "[totalreclaw] restarting gateway"
ssh "${REMOTE_HOST}" "openclaw gateway restart || openclaw gateway start"

echo "[totalreclaw] checking managed skill visibility"
ssh "${REMOTE_HOST}" "openclaw skills info TotalReClaw >/dev/null 2>&1 || openclaw skills info totalreclaw >/dev/null 2>&1"

echo "[totalreclaw] remote install complete"
