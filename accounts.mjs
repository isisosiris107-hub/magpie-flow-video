// accounts.mjs — every Google cookie jar gets its own id, Chromium and Flow project.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.mjs';

const dir = path.dirname(config.projectFile);
export const ACCOUNTS_FILE = path.join(dir, 'accounts.json');
export const USAGE_FILE = path.join(dir, 'usage.jsonl');

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'account';

function savedIsSession(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')).cookies || [];
    return c.some((x) => x.name === 'SID') && c.some((x) => x.name === 'SAPISID');
  } catch { return false; }
}

export function discoverAccounts() {
  const found = [];
  const add = (cookiesFile, label) => {
    if (!cookiesFile || !fs.existsSync(cookiesFile) || found.some((f) => f.cookiesFile === cookiesFile)) return;
    found.push({ cookiesFile, label });
  };
  const own = path.join(dir, 'cookies.json');
  if (savedIsSession(own)) add(own, 'Saved Flow login');
  for (const root of [path.join(os.homedir(), '.waterfox'), path.join(os.homedir(), '.mozilla/firefox')]) {
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root)) add(path.join(root, d, 'cookies.sqlite'), `Firefox ${slug(d)}`);
  }
  const auth = path.join(os.homedir(), '.local/share/magpie-ai-studio/auth');
  if (fs.existsSync(auth)) {
    for (const d of fs.readdirSync(auth)) add(path.join(auth, d, 'storage-state.json'), `AI Studio ${slug(d)}`);
  }
  const env = process.env.FLOW_COOKIES;
  if (env && env !== 'waterfox') add(env, 'FLOW_COOKIES');

  const used = new Set();
  const accounts = found.map((f) => {
    let id = f.cookiesFile.endsWith('cookies.json') && path.dirname(f.cookiesFile) === dir ? 'saved' : slug(path.basename(path.dirname(f.cookiesFile)));
    const base = id;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return { id, label: f.label, cookiesFile: f.cookiesFile };
  });
  // The live default keeps index 0 (and therefore the existing CDP port/profile).
  const preferred = accounts.findIndex((a) => a.cookiesFile === config.cookiesFile);
  if (preferred > 0) accounts.unshift(accounts.splice(preferred, 1)[0]);
  return { default: accounts[0]?.id || 'saved', accounts };
}

export function loadAccounts() {
  try {
    const saved = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    if (Array.isArray(saved.accounts) && saved.accounts.length && saved.accounts.every((a) => a.id && a.cookiesFile)) return saved;
  } catch {}
  const discovered = discoverAccounts();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(discovered, null, 2));
  } catch {}
  return discovered;
}

/** One Chromium (debug port + profile) per account, so cookies never mix. */
export function accountConfig(account, index) {
  return {
    ...config,
    cookiesFile: account.cookiesFile,
    userDataDir: account.userDataDir || (index === 0 ? config.userDataDir : `${config.userDataDir}-${account.id}`),
    // A login window leaves its signed-in Chromium running on this port. Attach
    // to it (no cookie injection) instead of starting a fresh browser from a jar.
    debugPort: account.debugPort || config.debugPort + index,
  };
}

export function appendUsage(entry) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(USAGE_FILE, JSON.stringify(entry) + '\n');
}

export function readUsage(limit = 500) {
  try {
    const lines = fs.readFileSync(USAGE_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
