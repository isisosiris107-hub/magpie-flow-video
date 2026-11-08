// signin.mjs — the one place a Google session is created.
//
// It opens a real Chrome window (the user's own browser if we can find one),
// lets them sign in to flow.google.com normally, then saves the cookies to a
// .json jar and registers that jar as an account. Nothing is scraped from a
// browser they did not open, and the window is closed afterwards.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, chromeCandidates, dataDir } from './config.mjs';
import { FlowBrowser } from './browser.mjs';
import { RPC, creditsEnvelope, operationEnvelope } from './flow.mjs';
import { ACCOUNTS_FILE, loadAccounts } from './accounts.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SIGN_IN_URL = 'https://accounts.google.com/ServiceLogin?passive=1209600&osid=1'
  + '&continue=https%3A%2F%2Fflow.google.com%2F&followup=https%3A%2F%2Fflow.google.com%2F';

/** Jobs are kept in memory so an MCP tool call can start a window and a later
 *  call can collect the result, without the caller holding the connection. */
export const jobs = new Map();

export function chromeFor() {
  if (config.chrome) return config.chrome;
  const found = chromeCandidates()[0];
  if (found) return found;
  throw new Error('No Chrome, Chromium, Edge or Brave found. Install one, or set FLOW_CHROME to its path.');
}

/** id for a new account: a slug of the label, unique against accounts.json */
export function newAccountId(label) {
  const base = String(label || 'flow').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'flow';
  const taken = new Set(loadAccounts().accounts.map((a) => a.id));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 500; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Open a sign-in window and wait for a valid Flow session.
 * Resolves { id, cookiesFile, cookies, email, credits } or throws.
 * Progress lines go to `log` so both the CLI and an HTTP job can show them.
 */
export async function signIn({ id = null, label = null, timeoutMs = 20 * 60 * 1000, log = () => {} } = {}) {
  const accountId = id || newAccountId(label);
  const own = path.join(dataDir(), `cookies-${accountId}.json`);
  // A per-id port + profile lets two windows run at once; +100 keeps them clear
  // of every account's own CDP port (base + index).
  const offset = [...accountId].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 20;
  const b = new FlowBrowser({
    ...config,
    chrome: chromeFor(),
    headless: false,
    debugPort: config.debugPort + 100 + offset,
    userDataDir: `${config.userDataDir}-login-${accountId}`,
    cookiesFile: own,
  }, { injectCookies: false });

  await b.open();
  // Signed-out Flow serves a marketing /about page. Follow its own sign-in link
  // so the window shows a Google form instead of a "Create with Google Flow" button.
  const link = await b.cdp.evaluate(`(() => {
    const a = [...document.querySelectorAll('a[href]')].find((x) => /ServiceLogin|signin\\/identifier/.test(x.href));
    return a ? a.href : '';
  })()`).catch(() => '');
  await b.goto(link || SIGN_IN_URL);
  log('A browser window is open at Google sign-in. Sign in with the account that has Flow access, then let it return to flow.google.com.');

  const deadline = Date.now() + timeoutMs;
  let last = {};
  try {
    while (Date.now() < deadline) {
      await sleep(2000);
      const w = await b.wiz().catch(() => ({}));
      last = w;
      // accounts.google.com has its own SNlM0e, so require Flow's domain AND a
      // successful read RPC before treating the session as usable.
      if (!w.at || !/^https:\/\/flow\.google\.com\//.test(w.url || '')) continue;
      try {
        await b.call(RPC.operation, operationEnvelope(crypto.randomUUID()));
      } catch (e) {
        last.readRpc = e.message;
        continue;
      }
      // Google rotates SIDCC / *PSIDTS on the request after sign-in. Saving at
      // once leaves a fresh client with a rejected pre-rotation token, so settle.
      for (let k = 0; k < 3; k++) {
        await sleep(1500);
        await b.call(RPC.credits, creditsEnvelope()).catch(() => {});
      }
      const cookies = await b.saveCookies(own);
      const reg = loadAccounts();
      const target = reg.accounts.find((x) => x.id === accountId);
      const entry = target || { id: accountId, label: label || `Flow ${accountId}`, cookiesFile: own };
      entry.cookiesFile = own;
      // serve/mcp talks plain HTTP with the saved jar, so no browser stays open.
      delete entry.debugPort;
      delete entry.userDataDir;
      if (!target) reg.accounts.push(entry);
      fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
      fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(reg, null, 2));
      log(`Signed in. Saved ${cookies} cookies to ${own} and registered account "${entry.id}".`);
      return { id: entry.id, label: entry.label, cookiesFile: own, cookies };
    }
    throw new Error(`Sign-in timed out. Last page: ${last.url || '?'}`
      + (last.readRpc ? ` (Flow read failed: ${last.readRpc})` : '')
      + '. If it keeps returning to /about, that Google account has no Flow access.');
  } finally {
    b.close();
  }
}

/** Run signIn in the background under a job id an HTTP caller can poll. */
export function startSignIn({ id = null, label = null } = {}) {
  // One window at a time: a second click, or a plugin reload, would otherwise
  // stack Chrome windows on top of each other.
  const busy = [...jobs.values()].find((j) => j.status === 'waiting');
  if (busy) {
    return { ...busy, status: busy.status, message: 'A sign-in window is already open. Finish it there first.' };
  }
  const jobId = `login_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const job = { id: jobId, account: id, status: 'waiting', message: 'Opening a browser window…', lines: [], startedAt: Date.now() };
  jobs.set(jobId, job);
  const log = (m) => { job.message = m; job.lines.push(m); if (job.lines.length > 40) job.lines.shift(); };
  signIn({ id, label, log })
    .then((r) => { job.status = 'done'; job.account = r.id; job.cookies = r.cookies; job.message = `Account "${r.id}" is signed in.`; })
    .catch((e) => { job.status = 'failed'; job.message = e.message; })
    .finally(() => { job.finishedAt = Date.now(); });
  // A job left for ten minutes is only a leaked map entry, so they are dropped.
  setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000).unref?.();
  return job;
}

/** Whether this machine can even open a sign-in window. */
export function signInAvailable() {
  try { return { ok: true, chrome: chromeFor() }; }
  catch (e) { return { ok: false, error: e.message }; }
}
