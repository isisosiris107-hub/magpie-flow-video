// browser.mjs — owns the persistent Chromium session that makes Flow's
// batchexecute RPCs possible.
//
// Why a browser instead of a plain HTTP client: Flow's `/data/batchexecute`
// endpoint needs (a) the per-page `at` CSRF token from WIZ_global_data,
// (b) a single-use reCAPTCHA Enterprise token minted in the page's MAIN world,
// and (c) the request to originate from the signed-in Flow tab. Replaying a
// captured token outside the browser returns PUBLIC_ERROR_UNUSUAL_ACTIVITY.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, USER_AGENT } from './config.mjs';
import { BATCH_PATH, CAPTCHA_SLOT, FLOW_ORIGIN, SITE_KEY } from './flow.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
    };
    ws.onclose = () => {
      for (const done of this.pending.values()) done({ error: { message: 'CDP connection closed', code: -1 } });
      this.pending.clear();
    };
  }
  static async connect(url, timeout = 10000) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('CDP websocket connect timed out')), timeout);
      ws.onopen = () => { clearTimeout(t); res(); };
      ws.onerror = (e) => { clearTimeout(t); rej(new Error(`CDP websocket failed: ${e?.message || 'unknown'}`)); };
    });
    return new CDP(ws);
  }
  send(method, params = {}) {
    return new Promise((resolve) => {
      const n = ++this.id;
      this.pending.set(n, resolve);
      this.ws.send(JSON.stringify({ id: n, method, params }));
    });
  }
  async call(method, params = {}) {
    const m = await this.send(method, params);
    if (m.error) throw new Error(`${method}: ${m.error.message} (${m.error.code})`);
    return m.result;
  }
  async evaluate(expression) {
    const r = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(`page script: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}`);
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

// Flow deliberately poisons grecaptcha.enterprise.execute with a wrapper that
// forces action "extension_hijack_detected". Capture the pristine function at
// document_start, before the wrapper is installed, and keep the clean one on
// the public object too. This is a compact re-implementation of the technique
// published in crisng95/flowkit extension/hijack_bypass.js.
const HIJACK_BYPASS = `(() => {
  const S = { pristine: null, source: null, traps: [] };
  Object.defineProperty(window, '__flowVideo', { value: S, configurable: true });
  const clean = (f) => typeof f === 'function' && !/extension_hijack_detected/.test(Function.prototype.toString.call(f));
  const save = (f, ctx, src) => {
    if (S.pristine || !clean(f)) return false;
    S.pristine = f.bind(ctx); S.source = src; return true;
  };
  const trap = (obj, key, onSet) => {
    if (!obj || typeof obj !== 'object') return;
    let v = obj[key];
    onSet(v, obj, key + ':initial');
    try {
      Object.defineProperty(obj, key, {
        configurable: true, enumerable: true,
        get: () => v,
        set: (n) => { if (!onSet(n, obj, key + ':set')) v = n; }
      });
      S.traps.push([obj, key]);
    } catch (_) {}
  };
  const trapExec = (ent, src) => trap(ent, 'execute', (f, ctx, s) => save(f, ctx, src + ':' + s));
  const trapEnterprise = (g, src) => {
    if (!g || typeof g !== 'object') return;
    trapExec(g.enterprise, src);
    trap(g, 'enterprise', (e, o, s) => { trapExec(e, src + ':' + s); return false; });
  };
  let g;
  try {
    Object.defineProperty(window, 'grecaptcha', {
      configurable: true, enumerable: true,
      get: () => g,
      set: (v) => { g = v; trapEnterprise(v, 'set'); }
    });
  } catch (_) {}
  let n = 0;
  const t = setInterval(() => {
    trapEnterprise(window.grecaptcha, 'poll');
    if (S.pristine || ++n > 1500) clearInterval(t);
  }, 2);
  return true;
})()`;

// Firefox/Waterfox expiry is usually seconds, but Waterfox writes milliseconds.
function firefoxExpiry(v) {
  if (!Number.isFinite(v) || v <= 0) return -1;
  if (v > 1e14) return Math.floor(v / 1e6);
  if (v > 1e11) return Math.floor(v / 1000);
  return Math.floor(v);
}

const googleOnly = (c) => {
  const host = String(c.domain || c.host || '').replace(/^\./, '');
  return /(^|\.)google\.[a-z.]+$/.test(host) && !/youtube/.test(host);
};

async function readFirefoxCookies(file) {
  // node:sqlite is experimental on Node 22; silence only that one warning.
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => {
    if (String(w).includes('SQLite is an experimental')) return;
    return emit(w, ...rest);
  };
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  finally { process.emitWarning = emit; }

  // Copy so a Waterfox holding a lock or a live WAL never blocks us.
  const tmp = path.join(os.tmpdir(), `flow-video-cookies-${process.pid}.sqlite`);
  fs.copyFileSync(file, tmp);
  const wal = `${file}-wal`;
  if (fs.existsSync(wal) && fs.statSync(wal).size) fs.copyFileSync(wal, `${tmp}-wal`);
  try {
    const db = new DatabaseSync(tmp, { readOnly: true });
    // Partitioned/container cookies belong to other first parties — injecting
    // them overwrites the real first-party Google session. Keep unpartitioned
    // rows only, newest first so duplicates on the same host collapse cleanly.
    const rows = db.prepare("select name,value,host,path,expiry,isSecure,isHttpOnly from moz_cookies where originAttributes = '' order by updateTime desc").all();
    db.close();
    const seen = new Set();
    return rows.filter((r) => {
      const key = `${r.host}/${r.name}/${r.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((r) => ({
      name: r.name, value: r.value, domain: r.host, path: r.path || '/',
      expires: firefoxExpiry(Number(r.expiry)),
      secure: !!r.isSecure, httpOnly: !!r.isHttpOnly,
    }));
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmp + suffix, { force: true });
  }
}

/** Read a Waterfox/Firefox cookies.sqlite or a Playwright storageState JSON.
 *  Returns only unexpired Google cookies in CDP Network.setCookie shape. */
export async function loadCookies(file) {
  let list;
  if (file.endsWith('.sqlite')) list = await readFirefoxCookies(file);
  else {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    list = Array.isArray(raw) ? raw : raw.cookies;
    if (!Array.isArray(list)) throw new Error(`${file} has no cookies array`);
    list = list.map((c) => ({ ...c, domain: c.domain || c.host }));
  }
  const now = Date.now() / 1000;
  return list.filter((c) => googleOnly(c) && !(c.expires > 0 && c.expires < now));
}

export class FlowBrowser {
  constructor(cfg = config, { injectCookies = true } = {}) {
    this.cfg = cfg;
    this.injectCookies = injectCookies;
    this.proc = null;
    this.cdp = null;
    this.cookies = [];
    this.opened = false;
    this.lastUsed = Date.now();
  }

  async open() {
    if (this.opened) return;
    fs.mkdirSync(this.cfg.userDataDir, { recursive: true });
    this.cookies = this.injectCookies && fs.existsSync(this.cfg.cookiesFile) ? await loadCookies(this.cfg.cookiesFile) : [];
    const base = `http://127.0.0.1:${this.cfg.debugPort}`;
    let live = false;
    try { live = (await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}

    if (!live) {
      const args = [
        '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--no-first-run', '--no-default-browser-check', '--disable-extensions',
        '--disable-background-networking', '--disable-component-update',
        '--disable-default-apps', '--disable-breakpad',
        '--renderer-process-limit=2',
        '--disable-features=Translate,MediaRouter,OptimizationHints,InterestFeedContentSuggestions,CalculateNativeWinOcclusion',
        `--remote-debugging-port=${this.cfg.debugPort}`,
        `--user-data-dir=${this.cfg.userDataDir}`,
        `--window-size=1440,900`, 'about:blank',
      ];
      if (this.cfg.headless) args.unshift('--headless=new');
      // A login window must outlive this short-lived process: the proxy attaches
      // to that very browser instead of replaying a cookie jar into a new one.
      const keep = !this.injectCookies;
      this.proc = spawn(this.cfg.chrome, args, { stdio: 'ignore', detached: keep });
      if (keep) this.proc.unref();
      this.proc.on('error', (e) => console.error('[flow] chrome:', e.message));
      let ok = false;
      for (let i = 0; i < 60 && !ok; i++) { await sleep(250); try { ok = (await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(500) })).ok; } catch {} }
      if (!ok) throw new Error(`Chromium did not open CDP on ${this.cfg.debugPort} (binary: ${this.cfg.chrome})`);
    }

    const targets = await (await fetch(`${base}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
    if (!page) throw new Error('no Chrome page target available');
    this.cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await this.cdp.call('Page.enable');
    await this.cdp.call('Runtime.enable');
    await this.cdp.call('Network.enable');
    await this.cdp.call('Network.setUserAgentOverride', { userAgent: USER_AGENT, acceptLanguage: 'en-US,en;q=0.9' });
    await this.cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: HIJACK_BYPASS, runImmediately: true });

    const bad = await this.setCookies();
    this.opened = true;
    if (this.injectCookies) console.error(`[flow] session ready: ${this.cookies.length - bad}/${this.cookies.length} cookies from ${path.basename(path.dirname(this.cfg.cookiesFile))}`);
    else console.error(`[flow] login window ready (fresh profile, no cookies injected — serve/mcp uses ${path.basename(this.cfg.cookiesFile)})`);
    await this.goto(`${FLOW_ORIGIN}/`);
  }

  async setCookies() {
    let bad = 0;
    for (const c of this.cookies) {
      const host = String(c.domain);
      const params = {
        name: c.name, value: c.value,
        domain: host.startsWith('.') ? host : undefined,
        url: host.startsWith('.') ? undefined : `https://${host}/`,
        path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly,
      };
      if (Number.isFinite(c.expires) && c.expires > 0) params.expires = c.expires;
      const r = await this.cdp.send('Network.setCookie', params);
      if (r.error || r.result?.success === false) bad++;
    }
    return bad;
  }

  /** Waterfox rotates __Secure-1PSIDTS; re-import its live cookie jar. */
  async refreshCookies() {
    this.cookies = await loadCookies(this.cfg.cookiesFile);
    const bad = await this.setCookies();
    console.error(`[flow] refreshed ${this.cookies.length - bad}/${this.cookies.length} cookies from ${path.basename(this.cfg.cookiesFile)}`);
  }

  async goto(url) {
    await this.cdp.call('Page.navigate', { url });
    for (let i = 0; i < 80; i++) {
      await sleep(300);
      const s = await this.cdp.evaluate('JSON.stringify({href:location.href,ready:document.readyState})').catch(() => null);
      if (s) { const j = JSON.parse(s); if (j.ready === 'complete') { await sleep(1200); return j.href; } }
    }
    throw new Error(`timed out loading ${url}`);
  }

  async wiz() {
    const s = await this.cdp.evaluate(`JSON.stringify((() => {
      const w = globalThis.WIZ_global_data || {};
      return { url: location.href, title: document.title, at: !!w.SNlM0e, bl: !!w.cfb2h, sid: !!w.FdrFJe,
        recaptcha: !!window.grecaptcha?.enterprise?.execute,
        pristine: !!window.__flowVideo?.pristine,
        sitekey: (() => { try { const c = window.___grecaptcha_cfg?.clients || {};
          for (const k in c) if (c[k]?.sitekey) return c[k].sitekey; } catch (_) {} return null; })() };
    })())`);
    return JSON.parse(s);
  }

  async mintCaptcha(action, attempts = 2) {
    for (let i = 0; i < attempts; i++) {
      const expr = `(async () => {
        const action = ${JSON.stringify(action)};
        let sitekey = null;
        try { const c = window.___grecaptcha_cfg?.clients || {};
          for (const k in c) if (c[k]?.sitekey) { sitekey = c[k].sitekey; break; } } catch (_) {}
        sitekey = sitekey || ${JSON.stringify(SITE_KEY)};
        const ent = window.grecaptcha?.enterprise;
        if (!ent) return JSON.stringify({ error: 'NO_GRECAPTCHA' });
        await new Promise((res) => { let done = false; const go = () => { if (!done) { done = true; res(); } };
          try { ent.ready?.(go); } catch (_) {} setTimeout(go, 5000); });
        const exec = window.__flowVideo?.pristine || ent.execute;
        if (typeof exec !== 'function') return JSON.stringify({ error: 'NO_EXECUTE' });
        const token = await Promise.race([
          Promise.resolve(exec(sitekey, { action })),
          new Promise((_, rej) => setTimeout(() => rej(new Error('execute_hang')), 30000))
        ]);
        return JSON.stringify({ token: String(token || ''), sitekey, source: window.__flowVideo?.source || 'public' });
      })()`;
      const out = JSON.parse(await this.cdp.evaluate(expr));
      if (out.token && out.token.length > 20) return out;
      if (i === attempts - 1) throw new Error(`reCAPTCHA mint failed (${out.error || 'empty token'})`);
      await sleep(1000);
    }
  }

  /** Google rotates SIDCC and the *PSIDTS cookies inside the live tab, and
   *  killing the proxy loses that state. Write on every successful RPC: a
   *  throttle leaves the jar one rotation behind and a fresh browser is 401. */
  async persistCookies() {
    // Only our own jars: never overwrite a Waterfox/AI Studio cookie store.
    if (!this.injectCookies || !/\/flow-video\/cookies[^/]*\.json$/.test(this.cfg.cookiesFile)) return;
    await this.saveCookies(this.cfg.cookiesFile);
  }

  /** POST one batchexecute RPC from inside the Flow tab. `envelope` may carry
   *  the CAPTCHA_SLOT placeholder; a fresh token is minted for every call. */
  async call(rpcid, envelope, { captchaAction = null, _retried = false } = {}) {
    await this.open();
    this.lastUsed = Date.now();
    let freq = envelope;
    if (freq.includes(CAPTCHA_SLOT)) {
      if (!captchaAction) throw new Error('envelope requests a captcha but no action was supplied');
      const cap = await this.mintCaptcha(captchaAction);
      freq = freq.split(CAPTCHA_SLOT).join(cap.token);
    }
    const expr = `(async () => {
      const w = globalThis.WIZ_global_data || {};
      const at = w.SNlM0e || '';
      const sid = w.FdrFJe || '';
      const bl = w.cfb2h || '';
      const reqid = Math.floor(Math.random() * 900000) + 100000;
      const hl = (document.documentElement.lang || navigator.language || 'en').split('-')[0];
      const q = new URLSearchParams({ rpcids: ${JSON.stringify(rpcid)},
        'source-path': location.pathname || '/', bl, 'f.sid': sid, hl, _reqid: String(reqid), rt: 'c' });
      const url = ${JSON.stringify(BATCH_PATH)} + '?' + q.toString();
      const body = new URLSearchParams({ 'f.req': ${JSON.stringify(freq)}, at });
      const resp = await fetch(url, { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'x-same-domain': '1' },
        body });
      return JSON.stringify({ status: resp.status, text: await resp.text() });
    })()`;
    const r = JSON.parse(await this.cdp.evaluate(expr));
    if (r.status === 401 || r.status === 403) {
      if (!_retried && this.cfg.cookiesFile.endsWith('.sqlite')) {
        await this.refreshCookies();
        await this.goto(await this.cdp.evaluate('location.href'));
        return this.call(rpcid, envelope, { captchaAction, _retried: true });
      }
      const jar = path.basename(this.cfg.cookiesFile);
      const id = /^cookies-(.+)\.json$/.exec(jar)?.[1];
      const hint = this.cfg.cookiesFile.endsWith('.sqlite')
        ? 'Sign in to Flow in Waterfox — the proxy reads its cookies.sqlite — and retry.'
        : id
          ? `Run \`npm run login -- ${id}\` to refresh this account's cookies.`
          : 'Run `npm run login` to refresh cookies.';
      throw new Error(`Flow returned HTTP ${r.status} — the Google session is stale. ${hint}`);
    }
    if (r.status !== 200) throw new Error(`batchexecute HTTP ${r.status}: ${String(r.text).slice(0, 300)}`);
    await this.persistCookies();
    return r.text;
  }

  async download(url) {
    const cookieHeader = this.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    try {
      const r = await fetch(url, { headers: { Cookie: cookieHeader, Referer: `${FLOW_ORIGIN}/`, 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(120000) });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
    } catch {}
    const expr = `(async () => {
      const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
      const b = new Uint8Array(await r.arrayBuffer());
      let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      return JSON.stringify({ status: r.status, data: btoa(s) });
    })()`;
    const out = JSON.parse(await this.cdp.evaluate(expr));
    if (out.status !== 200) throw new Error(`signed media URL returned HTTP ${out.status}`);
    return Buffer.from(out.data, 'base64');
  }

  async saveCookies(file) {
    const { cookies } = await this.cdp.call('Network.getCookies');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ cookies: cookies.map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
    })) }, null, 2));
    return cookies.length;
  }

  close() {
    this.cdp?.close();
    if (this.proc && !this.proc.killed) this.proc.kill('SIGTERM');
    this.proc = null;
    this.opened = false;
  }
}
