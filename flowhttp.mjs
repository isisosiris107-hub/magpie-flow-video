// flowhttp.mjs — Flow over node:http. No browser, no CDP, no Chromium, no undici.
//
// flow.google.com serves WIZ_global_data (at / bl / f.sid / recaptcha sitekey)
// in the HTML of a normal GET, and batchexecute accepts the same form POST a
// browser sends. reCAPTCHA Enterprise tokens can be minted over HTTP as long as
// the `sa` action matches the RPC, so a 700 MB Chrome tree is unnecessary.
// node:http instead of global fetch: undici + llhttp-wasm add ~20 MB of RSS.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { config, USER_AGENT } from './config.mjs';
import { loadCookies } from './browser.mjs';
import { BATCH_PATH, FLOW_ORIGIN, CAPTCHA_SLOT, CAPTCHA_VIDEO, SITE_KEY } from './flow.mjs';

const jarWritable = (file) => /\/flow-video\/cookies[^/]*\.json$/.test(file);
const wizKey = (html, k) => html.match(new RegExp(`"${k}"\\s*:\\s*"([^"\\\\]+)"`))?.[1] || null;

/** Small fetch-shaped helper over node:http/https. Never follows redirects. */
export function request(url, { method = 'GET', headers = {}, body = null, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port || undefined,
      path: u.pathname + u.search, method,
      headers: { 'Accept-Encoding': 'identity', ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode, url,
          headers: {
            ...res.headers,
            get: (k) => res.headers[String(k).toLowerCase()] ?? null,
            getSetCookie: () => res.headers['set-cookie'] || [],
          },
          text: () => buf.toString('utf8'),
          buffer: () => buf,
        });
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`request timed out after ${timeout}ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function domainOf(c) { return String(c.domain || c.host || '').replace(/^\./, '').toLowerCase(); }

/** Cookie header for one host, using browser-style domain + path scoping. */
export function cookieHeader(cookies, host, pathname = '/') {
  const h = host.toLowerCase();
  const parts = new Map();
  for (const c of cookies) {
    const d = domainOf(c), value = c.value ?? '';
    if (!d || !c.name || !/^[\x20-\xff]*$/.test(value)) continue; // Node headers need ByteStrings
    if (h !== d && !h.endsWith('.' + d)) continue;
    const cp = c.path || '/';
    if (pathname !== cp && !pathname.startsWith(cp.endsWith('/') ? cp : cp + '/')) continue;
    if (c.expires > 0 && c.expires < Date.now() / 1000) continue;
    parts.set(`${d}|${c.path || '/'}|${c.name}`, `${c.name}=${value}`); // last wins
  }
  return [...parts.values()].join('; ');
}

/** Fold Set-Cookie values back into the jar so SIDCC/*PSIDTS rotations survive. */
export function mergeSetCookies(cookies, setCookies, urlHost) {
  const out = cookies.slice();
  for (const raw of setCookies || []) {
    const bits = String(raw).split(';');
    const eq = bits[0].indexOf('=');
    if (eq < 1) continue;
    const name = bits[0].slice(0, eq).trim();
    const value = bits[0].slice(eq + 1).trim();
    if (!/^[\x20-\xff]*$/.test(value)) continue;
    let domain = urlHost, cp = '/', expires = -1, secure = false, httpOnly = false, dead = false;
    for (const b of bits.slice(1)) {
      const [k, ...v] = b.trim().split('=');
      const val = v.join('=');
      switch (k.toLowerCase()) {
        case 'domain': domain = val.replace(/^\./, ''); break;
        case 'path': cp = val || '/'; break;
        case 'expires': { const t = Date.parse(val); if (Number.isFinite(t)) expires = Math.floor(t / 1000); break; }
        case 'max-age': { const n = Number(val); if (Number.isFinite(n)) { expires = Math.floor(Date.now() / 1000) + n; dead = n <= 0; } break; }
        case 'secure': secure = true; break;
        case 'httponly': httpOnly = true; break;
      }
    }
    if (!/\.google\.[a-z.]+$|^google\.[a-z.]+$/.test(domain)) continue;
    const key = (c) => `${domainOf(c)}|${c.path || '/'}|${c.name}`;
    const idx = out.findIndex((c) => key(c) === `${domain}|${cp}|${name}`);
    if (dead) { if (idx >= 0) out.splice(idx, 1); continue; }
    const next = { name, value, domain, path: cp, expires, secure, httpOnly };
    if (idx >= 0) out[idx] = { ...out[idx], ...next }; else out.push(next);
  }
  return out;
}

export class FlowClient {
  constructor(cfg = config) {
    this.cfg = cfg;
    this.cookies = [];
    this.opened = false;
    this.injectCookies = true;
    this.lastUsed = Date.now();
    this.path = '/';
    this.tokens = {};
    this.title = '';
  }

  async open() {
    if (this.opened) return;
    if (fs.existsSync(this.cfg.cookiesFile)) this.cookies = await loadCookies(this.cfg.cookiesFile);
    await this.bootstrap();
    this.opened = true;
  }

  async bootstrap() {
    const url = FLOW_ORIGIN + this.path;
    const res = await request(url, { headers: this.headers('flow.google.com'), timeout: 30000 });
    this.absorb(res, 'flow.google.com');
    const html = res.text();
    this.tokens = {
      at: wizKey(html, 'SNlM0e'), bl: wizKey(html, 'cfb2h'),
      sid: wizKey(html, 'FdrFJe'), sitekey: wizKey(html, 'xZbWve') || SITE_KEY,
    };
    this.title = html.match(/<title>([^<]*)<\/title>/i)?.[1] || '';
    this.url = res.status >= 300 && res.status < 400 ? (res.headers.get('location') || url) : url;
    if (!this.tokens.at) {
      if (res.status === 401 || res.status === 403) throw new Error(`Flow returned HTTP ${res.status} — cookies are stale.`);
      throw new Error('Flow page has no SNlM0e (at) token — the Google session is not signed in. Run `npm run login` and sign in.');
    }
  }

  headers(host, extra = {}) {
    const h = {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
      ...extra,
    };
    const jar = cookieHeader(this.cookies, host, this.path);
    if (jar) h.Cookie = jar;
    return h;
  }

  absorb(res, host) {
    const set = res.headers.getSetCookie?.() || [];
    if (!set.length) return;
    this.cookies = mergeSetCookies(this.cookies, set, host);
    this.persistCookies();
  }

  async persistCookies() {
    if (!jarWritable(this.cfg.cookiesFile)) return;
    try {
      fs.mkdirSync(path.dirname(this.cfg.cookiesFile), { recursive: true });
      const tmp = `${this.cfg.cookiesFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ cookies: this.cookies }));
      fs.renameSync(tmp, this.cfg.cookiesFile);
    } catch {}
  }

  async saveCookies(file) {
    fs.writeFileSync(file, JSON.stringify({ cookies: this.cookies }));
    return this.cookies.length;
  }

  async mintCaptcha(action = CAPTCHA_VIDEO, attempts = 2) {
    const key = this.tokens.sitekey || SITE_KEY;
    let last = 'no token';
    for (let i = 0; i < attempts; i++) {
      try {
        const jsr = await request(`https://www.google.com/recaptcha/enterprise.js?render=${key}`,
          { headers: this.headers('www.google.com'), timeout: 20000 });
        const v = jsr.text().match(/releases\/([\w-]+)\//)?.[1];
        if (!v) throw new Error('recaptcha release not found');
        const co = Buffer.from('https://flow.google.com:443').toString('base64').replace(/=+$/, '');
        const cb = 'c' + Math.random().toString(36).slice(2, 10);
        const anchor = `https://www.google.com/recaptcha/enterprise/anchor?ar=2&k=${key}&co=${encodeURIComponent(co)}&hl=en&v=${v}&size=invisible&anchor-ms=20000&execute-ms=30000&cb=${cb}&sa=${encodeURIComponent(action)}`;
        const ar = await request(anchor, { headers: this.headers('www.google.com', { Referer: FLOW_ORIGIN + '/' }), timeout: 30000 });
        this.absorb(ar, 'www.google.com');
        const html = ar.text();
        const ctok = html.match(/id="recaptcha-token"[^>]*value="([^"]+)"/)?.[1] || html.match(/(03AFcWeA[\w-]{40,})/)?.[1];
        if (!ctok) throw new Error('anchor token not found');
        const form = { v, reason: 'q', c: ctok, k: key, co, hl: 'en', size: 'invisible', sa: action, chr: '', vh: '', bg: '' };
        const rr = await request(`https://www.google.com/recaptcha/enterprise/reload?k=${key}`, {
          method: 'POST',
          headers: this.headers('www.google.com', { 'Content-Type': 'application/x-www-form-urlencoded', Referer: anchor, Origin: 'https://www.google.com' }),
          body: new URLSearchParams(form).toString(), timeout: 30000,
        });
        this.absorb(rr, 'www.google.com');
        const text = rr.text();
        const token = text.match(/\["rresp","([^"]+)"/)?.[1];
        if (token) return { token, sitekey: key, source: 'http' };
        last = text.slice(0, 120) || 'empty reload response';
      } catch (e) { last = e.message; }
    }
    throw new Error(`reCAPTCHA mint failed (${last})`);
  }

  async call(rpcid, envelope, { captchaAction = null, _retried = false } = {}) {
    this.lastUsed = Date.now();
    await this.open();
    let body = envelope;
    if (body.includes(CAPTCHA_SLOT)) {
      const c = await this.mintCaptcha(captchaAction || CAPTCHA_VIDEO);
      body = body.split(CAPTCHA_SLOT).join(c.token);
    }
    const q = new URLSearchParams({
      rpcids: rpcid, 'source-path': this.path, bl: this.tokens.bl || '',
      'f.sid': this.tokens.sid || '', hl: 'en', _reqid: String(100000 + Math.floor(Math.random() * 899999)), rt: 'c',
    });
    const res = await request(`${FLOW_ORIGIN}${BATCH_PATH}?${q}`, {
      method: 'POST',
      headers: this.headers('flow.google.com', {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Same-Domain': '1', Origin: FLOW_ORIGIN, Referer: FLOW_ORIGIN + '/',
      }),
      body: new URLSearchParams({ 'f.req': body, at: this.tokens.at }).toString(),
      timeout: 120000,
    });
    this.absorb(res, 'flow.google.com');
    const text = res.text();
    if ((res.status === 401 || res.status === 403) && !_retried) {
      await this.bootstrap();
      return this.call(rpcid, envelope, { captchaAction, _retried: true });
    }
    if (!res.ok) throw new Error(`Flow returned HTTP ${res.status} — ${this.staleHint()} (${text.slice(0, 120).replace(/\n/g, ' ')})`);
    return text;
  }

  staleHint() {
    const jar = path.basename(this.cfg.cookiesFile);
    const id = /^cookies-(.+)\.json$/.exec(jar)?.[1];
    if (id) return `the Google session is stale. Run \`npm run login -- ${id}\` to refresh cookies.`;
    if (jar.endsWith('.sqlite')) return 'this Firefox jar has no signed-in Flow session. Sign in to Flow there.';
    return 'the Google session is stale. Run `npm run login` and sign in.';
  }

  async goto(url) { try { this.path = new URL(url).pathname || '/'; } catch {} }

  async wiz() {
    await this.open();
    return {
      url: this.url, title: this.title,
      at: !!this.tokens.at, bl: !!this.tokens.bl, sid: !!this.tokens.sid,
      recaptcha: false, pristine: false, sitekey: this.tokens.sitekey, transport: 'http',
    };
  }

  async download(url) {
    const res = await request(url, {
      headers: { 'User-Agent': USER_AGENT, Referer: FLOW_ORIGIN + '/' },
      timeout: 120000,
    });
    if (!res.ok) throw new Error(`video download: HTTP ${res.status}`);
    return res.buffer();
  }

  close() {}
}
