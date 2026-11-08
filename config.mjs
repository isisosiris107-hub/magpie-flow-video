// config.mjs — one place for the handful of knobs, all overridable by env.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const home = os.homedir();
const win = process.platform === 'win32';
const mac = process.platform === 'darwin';

/** Where this tool keeps its own state (accounts, saved jars, models). */
export function dataDir() {
  if (process.env.FLOW_DATA_DIR) return process.env.FLOW_DATA_DIR;
  if (win) return path.join(process.env.APPDATA || path.join(home, 'AppData/Roaming'), 'flow-video');
  if (mac) return path.join(home, 'Library/Application Support/flow-video');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local/share'), 'flow-video');
}

/** Where .mp4 files land. */
export function outputDir() {
  if (process.env.FLOW_OUTPUT_DIR) return process.env.FLOW_OUTPUT_DIR;
  if (win) return path.join(home, 'Videos/flow-video');
  if (mac) return path.join(home, 'Movies/flow-video');
  return path.join(home, 'flow-video/outputs');
}

/** The profile folders of every browser whose Google cookies we can read,
 *  newest first. Chrome and Chromium keep cookies in an encrypted SQLite DB
 *  (we don't read those); Firefox, Waterfox and Zen keep a plain one. */
function browserRoots() {
  if (win) {
    const app = process.env.APPDATA || path.join(home, 'AppData/Roaming');
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData/Local');
    return [path.join(app, 'Mozilla/Firefox'), path.join(app, 'Waterfox'), path.join(app, 'Zen'),
      path.join(local, 'Waterfox')];
  }
  if (mac) {
    const app = path.join(home, 'Library/Application Support');
    return [path.join(app, 'Firefox'), path.join(app, 'Waterfox'), path.join(app, 'Zen')];
  }
  return [path.join(home, '.mozilla/firefox'), path.join(home, '.waterfox'), path.join(home, '.zen'),
    path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'waterfox')];
}

/** Every readable cookies.sqlite, newest-modified first: the profile written
 *  last holds the live (rotated) __Secure-1PSIDTS. */
export function firefoxCookiesFiles() {
  const found = [];
  for (const root of browserRoots()) {
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, 'cookies.sqlite');
      if (!fs.existsSync(f)) continue;
      try { found.push({ file: f, mtime: fs.statSync(f).mtimeMs }); } catch {}
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found.map((x) => x.file);
}

/** Kept for older callers: the single newest Firefox-family cookie DB. */
export const firefoxCookiesFile = () => firefoxCookiesFiles()[0] || null;
export const waterfoxCookiesFile = firefoxCookiesFile;

/** A saved jar only counts if it holds a real Google session. Google's sign-in
 *  page also exposes SNlM0e, so an early save there must not shadow a browser. */
export function hasSession(file) {
  try {
    const names = new Set((JSON.parse(fs.readFileSync(file, 'utf8')).cookies || []).map((c) => c.name));
    return names.has('SID') && names.has('SAPISID');
  } catch { return false; }
}

/** Chrome/Chromium/Edge/Waterfox binaries that could open a sign-in window. */
export function chromeCandidates() {
  const out = [];
  const add = (p) => { if (p && fs.existsSync(p) && !out.includes(p)) out.push(p); };
  if (process.env.FLOW_CHROME) return [process.env.FLOW_CHROME];
  const cache = path.join(home, '.cache/ms-playwright');
  if (fs.existsSync(cache)) {
    // playwright's bundled Chromium, any build number
    for (const d of fs.readdirSync(cache).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      add(path.join(cache, d, 'chrome-linux64/chrome'));
      add(path.join(cache, d, 'chrome-linux/chrome'));
      add(path.join(cache, d, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'));
      add(path.join(cache, d, 'chrome-win/chrome.exe'));
    }
  }
  if (win) {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData/Local');
    for (const rel of ['Google/Chrome/Application/chrome.exe', 'Chromium/Application/chrome.exe',
      'Microsoft/Edge/Application/msedge.exe', 'BraveSoftware/Brave-Browser/Application/brave.exe']) {
      add(path.join(local, rel));
    }
    add('C:/Program Files/Google/Chrome/Application/chrome.exe');
    add('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
  } else if (mac) {
    for (const rel of ['Google Chrome.app/Contents/MacOS/Google Chrome',
      'Chromium.app/Contents/MacOS/Chromium', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Brave Browser.app/Contents/MacOS/Brave Browser', 'Waterfox.app/Contents/MacOS/waterfox']) {
      add(path.join('/Applications', rel));
      add(path.join(home, 'Applications', rel));
    }
  } else {
    for (const p of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
      '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/usr/bin/brave',
      '/opt/google/chrome/chrome', '/snap/bin/chromium', '/usr/bin/waterfox']) add(p);
  }
  return out;
}

/** The saved jar wins once it holds a session (it rotates its own tokens);
 *  before that, the newest Firefox-family profile; then a Playwright storage
 *  state from magpie's AI Studio plugin. */
function defaultCookies() {
  const own = path.join(dataDir(), 'cookies.json');
  const env = process.env.FLOW_COOKIES;
  if (env) return ['waterfox', 'firefox'].includes(env) ? (firefoxCookiesFile() || own) : env;
  if (fs.existsSync(own) && hasSession(own)) return own;
  const ff = firefoxCookiesFile();
  if (ff) return ff;
  try {
    const root = path.join(dataDir(), '..', 'magpie-ai-studio/auth');
    const dirs = fs.readdirSync(root)
      .map((d) => path.join(root, d, 'storage-state.json'))
      .filter((f) => fs.existsSync(f))
      .map((file) => ({ file, count: (JSON.parse(fs.readFileSync(file, 'utf8')).cookies || []).filter((c) => /\.?google\.com$/.test(c.domain)).length }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count);
    if (dirs.length) return dirs[0].file;
  } catch {}
  return own;
}

export const config = {
  port: Number(process.env.FLOW_PORT || 8787),
  host: process.env.FLOW_HOST || '127.0.0.1',
  chrome: chromeCandidates()[0] || '',
  userDataDir: process.env.FLOW_USER_DATA_DIR || path.join(dataDir(), 'chrome-profile'),
  cookiesFile: defaultCookies(),
  debugPort: Number(process.env.FLOW_DEBUG_PORT || 9334),
  headless: process.env.FLOW_HEADLESS !== '0',
  outputDir: outputDir(),
  dataDir: dataDir(),
  projectFile: path.join(dataDir(), 'project.json'),
  timeoutMs: Number(process.env.FLOW_TIMEOUT_MS || 15 * 60 * 1000),
  pollMs: Number(process.env.FLOW_POLL_MS || 5000),
};

export const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
