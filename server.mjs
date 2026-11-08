// server.mjs — the Flow video proxy (OpenAI-shaped /videos + stdio MCP).
//
//   node server.mjs serve   HTTP proxy on 127.0.0.1:8787
//   node server.mjs mcp     same proxy plus a stdio MCP server
//   node server.mjs check   verify cookies / at token / captcha, spend nothing
//   node server.mjs login   headed sign-in, writes fresh cookies
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { FlowBrowser } from './browser.mjs'; // only the one-off `login` window
import { FlowClient, request } from './flowhttp.mjs';
import { loadAccounts, accountConfig, appendUsage, readUsage, ACCOUNTS_FILE, USAGE_FILE } from './accounts.mjs';
import { jobs, startSignIn, signIn, signInAvailable } from './signin.mjs';
import { VIDEO_SCHEMA, TOOLS } from './schema.mjs';
import {
  RPC, MODELS, ASPECTS, RESOLUTION_CODES, DURATIONS, CAPTCHA_VIDEO,
  normalizeParams, buildVideoRequest, createProjectEnvelope, uploadEnvelope,
  operationEnvelope, projectMediaEnvelope, mediaEnvelope, creditsEnvelope, readCredits,
  peopleEnvelope, readPerson,
  modelsEnvelope, parseModelCatalog, resolveFamilyModel, familyModels,
  firstPayload, parseEnvelope, publicErrors, readVideoSubmit, listingMediaIds,
  mediaUrls, readCreatedProject, readUploadedMediaId,
} from './flow.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = `http://${config.host}:${config.port}`;
const readBody = (req) => new Promise((resolve, reject) => {
  let s = ''; req.on('data', (c) => { s += c; if (s.length > 100 * 1024 * 1024) reject(new Error('body too large')); });
  req.on('end', () => resolve(s)); req.on('error', reject);
});

// ── inputs ─────────────────────────────────────────────────────────────────
async function toB64(src) {
  const s = String(src);
  if (s.startsWith('data:')) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(s);
    if (!m) throw new Error('malformed data: URL');
    return { b64: m[2] ? m[3].replace(/\s/g, '') : Buffer.from(decodeURIComponent(m[3])).toString('base64'), mime: m[1] || 'image/jpeg' };
  }
  if (/^https?:\/\//i.test(s)) {
    const r = await request(s, { timeout: 60000 });
    if (!r.ok) throw new Error(`could not fetch ${s}: HTTP ${r.status}`);
    const t = r.headers.get('content-type') || 'image/jpeg';
    return { b64: r.buffer().toString('base64'), mime: t.split(';')[0] };
  }
  const f = path.resolve(s);
  if (!fs.existsSync(f)) throw new Error(`image not found: ${f}`);
  const ext = path.extname(f).toLowerCase();
  const mime = { '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }[ext] || 'image/jpeg';
  return { b64: fs.readFileSync(f).toString('base64'), mime };
}

function saveOutputs(job, dest) {
  fs.mkdirSync(config.outputDir, { recursive: true });
  const dir = dest && !dest.toLowerCase().endsWith('.mp4') ? path.resolve(dest) : null;
  if (dir) fs.mkdirSync(dir, { recursive: true });
  return job.outputs.map((o, i) => {
    const f = dest && dest.toLowerCase().endsWith('.mp4') && i === 0
      ? path.resolve(dest)
      : path.join(dir || config.outputDir, `${job.id}_${i + 1}.mp4`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const bytes = o.bytes.length;
    fs.writeFileSync(f, o.bytes);
    o.path = f;
    o.bytes = null; // keep mp4s on disk, not in the long-lived job map
    return { path: f, bytes, mediaId: o.mediaId, url: o.url };
  });
}

// ── job runner ─────────────────────────────────────────────────────────────
class Proxy {
  constructor() {
    this.reloadAccounts();
    this.browsers = new Map();
    this.creditCache = new Map();
    this.jobs = new Map();
    this.projects = {};
    this.modelFile = path.join(path.dirname(config.projectFile), 'models.json');
    this.modelCache = null;
    this.modelRefreshing = null;
    try {
      const saved = JSON.parse(fs.readFileSync(this.modelFile, 'utf8'));
      if (saved?.families?.length) this.modelCache = saved;
    } catch {}
    try {
      const raw = JSON.parse(fs.readFileSync(config.projectFile, 'utf8'));
      // Migrate the single-account {projectId} file.
      this.projects = raw.projects || (raw.projectId ? { [this.defaultAccount]: raw.projectId } : {});
    } catch {}
  }

  reloadAccounts() {
    const { accounts, default: def } = loadAccounts();
    this.accounts = accounts;
    this.defaultAccount = accounts.some((a) => a.id === def) ? def : accounts[0]?.id;
  }

  account(id) {
    const a = this.accounts.find((x) => x.id === (id || this.defaultAccount) || x.label === id);
    if (!a) throw new Error(`unknown account ${JSON.stringify(id)} — see GET /v1/accounts`);
    return a;
  }

  browser(accountId) {
    const a = this.account(accountId);
    if (!this.browsers.has(a.id)) {
      const i = this.accounts.findIndex((x) => x.id === a.id);
      this.browsers.set(a.id, new FlowClient(accountConfig(a, i)));
    }
    return this.browsers.get(a.id);
  }

  async credits(accountId, { force = false, cacheMs = 60000 } = {}) {
    const a = this.account(accountId);
    const hit = this.creditCache.get(a.id);
    if (!force && hit && Date.now() - hit.at < cacheMs) return hit.credits;
    const b = this.browser(a.id);
    await b.open();
    const text = await b.call(RPC.credits, creditsEnvelope());
    const out = readCredits(firstPayload(text, RPC.credits));
    // One extra captcha-free read per cache period identifies the Google account,
    // so two sessions of one account are not counted as two credit pools.
    try {
      const person = readPerson(firstPayload(await b.call(RPC.people, peopleEnvelope()), RPC.people));
      out.person_id = person.id;
      out.email = person.email;
    } catch { out.person_id = null; }
    this.creditCache.set(a.id, { at: Date.now(), credits: out });
    return out;
  }

  /** HTrJv is a captcha-free read. Persisting the catalog means magpie's
   *  frequent /models fetches never need a browser; ?refresh=1 refetches from
   *  Flow so a model released later shows up without a code change. */
  async catalog({ force = false, accountId = null } = {}) {
    if (!force && this.modelCache) return this.modelCache;
    if (this.modelRefreshing) return this.modelRefreshing;
    this.modelRefreshing = (async () => {
      const b = this.browser(accountId || this.defaultAccount);
      await b.open();
      const text = await b.call(RPC.models, modelsEnvelope());
      const cat = parseModelCatalog(text);
      try { cat.tier = (await this.credits(accountId || this.defaultAccount)).service_tier; } catch {}
      this.modelCache = cat;
      fs.mkdirSync(path.dirname(this.modelFile), { recursive: true });
      fs.writeFileSync(this.modelFile, JSON.stringify(cat));
      console.error(`[flow] model catalog: ${cat.families.length} families, ${cat.families.reduce((n, f) => n + f.models.length, 0)} keys`);
      return cat;
    })().finally(() => { this.modelRefreshing = null; });
    return this.modelRefreshing;
  }

  create(raw) {
    this.reloadAccounts();
    const body = { ...raw };
    const account = this.account(body.account).id;
    delete body.account;
    // magpie prefixes the model with its provider id. Strip that, but keep the
    // rest so a chosen family (flow-video/veo-3-1-fast) actually selects it.
    if (typeof body.model === 'string') {
      body.model = body.model.replace(/^flow-video\//, '');
      if (!body.model || body.model === 'flow-video') delete body.model;
    }
    const params = normalizeParams(body);
    const id = `flow_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const job = {
      id, account, params, status: 'queued', model: params.model || 'flow-video',
      seconds: params.seconds, progress: 0, outputs: [], error: null,
      createdAt: Date.now(), updatedAt: Date.now(), operations: [],
      creditsBefore: null, creditsUsed: null,
    };
    this.jobs.set(id, job);
    this.run(job).catch((e) => this.fail(job, e)).finally(() => this.recordUsage(job));
    return job;
  }

  fail(job, e) {
    job.status = 'failed';
    const raw = e?.message || String(e);
    job.error = raw.includes('PUBLIC_ERROR_MODEL_ACCESS_DENIED')
      ? `${raw} — Flow denied this model for this Google account (plan/tier). Call list_models and try omni-flash-1-2 or omni-flash-1-1.`
      : raw;
    job.updatedAt = Date.now();
    console.error(`[flow] ${job.id} failed: ${job.error}`);
  }

  // A generation's real price is the balance delta, not a guessed model price:
  // Flow has 0-credit models and daily free-credit refreshes.
  async recordUsage(job) {
    let after = null;
    try { after = (await this.credits(job.account, { force: true })).total; } catch (e) { console.error(`[flow] credits after ${job.id}: ${e.message}`); }
    const used = job.creditsBefore != null && after != null ? Math.max(0, job.creditsBefore - after) : null;
    job.creditsUsed = used;
    appendUsage({
      ts: Date.now(), account: job.account, job_id: job.id, status: job.status,
      model: job.model, duration: job.params.duration, output_count: job.params.outputCount,
      credits_before: job.creditsBefore, credits_after: after, credits_used: used,
      outputs: job.outputs.length, ...(job.error ? { error: job.error } : {}),
    });
    global.gc?.();
  }

  async project(p, accountId, fresh = false) {
    if (p.projectId) return p.projectId;
    if (!fresh && this.projects[accountId]) return this.projects[accountId];
    const text = await this.browser(accountId).call(RPC.createProject, createProjectEnvelope(p.projectTitle));
    const id = readCreatedProject(firstPayload(text, RPC.createProject));
    this.projects[accountId] = id;
    fs.mkdirSync(path.dirname(config.projectFile), { recursive: true });
    fs.writeFileSync(config.projectFile, JSON.stringify({ projects: this.projects }));
    console.error(`[flow] ${accountId}: created Flow project ${id.slice(0, 12)}…`);
    return id;
  }

  async uploads(p, projectId, accountId) {
    const all = [...new Set([...p.startFrames, ...p.endFrames, ...p.references])];
    const map = {};
    for (const src of all) {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]+$/i.test(src)) { map[src] = src; continue; }
      const { b64, mime } = await toB64(src);
      const text = await this.browser(accountId).call(RPC.uploadImage,
        uploadEnvelope(projectId, b64, mime), { captchaAction: CAPTCHA_VIDEO });
      map[src] = readUploadedMediaId(firstPayload(text, RPC.uploadImage));
      console.error(`[flow] uploaded ${mime} → ${map[src].slice(0, 12)}…`);
    }
    return map;
  }

  async run(job) {
    const b = this.browser(job.account);
    job.status = 'in_progress';
    await b.open();
    let p = job.params;
    // A friendly family name (omni-flash-1-1, veo-3-1-fast) becomes the exact
    // wire key for these parameters. An exact key passes through unchanged.
    try {
      const balance = await this.credits(job.account, { force: true });
      job.creditsBefore = balance.total;
      p = { ...p, tier: balance.service_tier };
    } catch (e) { console.error(`[flow] credits before ${job.id}: ${e.message}`); }
    let cat = null;
    try { cat = await this.catalog(); } catch (e) { console.error(`[flow] model catalog unavailable: ${e.message}`); }
    if (cat && p.model) {
      p = { ...p, model: resolveFamilyModel(cat, p.model, p) };
      // A tier may only allow the family's 8s key even when 4s was asked for.
      // Report what Flow will actually render, not the request.
      const wire = cat.families.flatMap((f) => f.models).find((m) => m.id === p.model);
      if (wire?.duration) { p = { ...p, duration: wire.duration }; job.seconds = String(wire.duration); }
      job.params = p;
    }
    let projectId = await this.project(p, job.account);
    // A project that has collected too many clips stops answering Zzl0ze with [5].
    // Check before submitting so credits are never spent on a project we cannot read.
    // Snapshot its media too: Flow's row timestamps can be an hour behind ours,
    // so new clips are found by ID difference, never by a wall-clock cutoff.
    const before = new Set();
    try {
      const pre = firstPayload(await b.call(RPC.projectMedia, projectMediaEnvelope(projectId)), RPC.projectMedia);
      for (const id of listingMediaIds(pre, 0)) before.add(id);
    } catch {
      if (!p.projectId) projectId = await this.project(p, job.account, true);
    }
    await b.goto(`https://flow.google.com/project/${projectId}`);
    const mediaIds = await this.uploads(p, projectId, job.account);

    const { rpcid, model, envelope, itemCount } = buildVideoRequest(p, { projectId, mediaIds });
    job.model = model;
    console.error(`[flow] ${job.account} ${job.id}: ${rpcid} ${model} ×${itemCount} ${p.duration}s ${p.resolution} aspect=${p.aspect}`);
    const submitText = await b.call(rpcid, envelope, { captchaAction: p.captchaAction });
    const submit = readVideoSubmit(firstPayload(submitText, rpcid));
    const submitRows = parseEnvelope(submitText);
    const errs = publicErrors(submitRows);
    if (errs.length) throw new Error(errs.join(', '));
    job.operations = submit.records;
    if (!submit.records.length && !submit.direct.length)
      throw new Error('Flow accepted the request but returned no video records');

    const found = new Map();
    for (const r of submit.direct) found.set(r.mediaId, r.url);
    const wanted = p.outputCount || 1;
    const deadline = Date.now() + config.timeoutMs;
    let lastError = null;
    while (found.size < wanted && Date.now() < deadline) {
      const t = await b.call(RPC.projectMedia, projectMediaEnvelope(projectId));
      const listing = firstPayload(t, RPC.projectMedia);
      const errs = publicErrors([listing, submitRows]);
      if (errs.length) throw new Error(errs.join(', '));
      for (const id of listingMediaIds(listing, 0)) {
        if (before.has(id) || found.has(id)) continue;
        try {
          const m = await b.call(RPC.media, mediaEnvelope(id));
          for (const r of mediaUrls(firstPayload(m, RPC.media))) found.set(r.mediaId, r.url);
          lastError = null;
        } catch (e) { lastError = e; }
      }
      job.progress = found.size ? Math.round(90 * found.size / wanted) : 5;
      job.updatedAt = Date.now();
      global.gc?.(); // the project listing is several MB of parsed JSON
      if (found.size < wanted) await sleep(config.pollMs);
    }
    if (!found.size) throw lastError || new Error(`Flow returned no downloadable video within ${Math.round(config.timeoutMs / 60000)} minutes`);

    for (const [mediaId, url] of found) {
      job.outputs.push({ mediaId, url, bytes: await b.download(url), path: null });
    }
    saveOutputs(job, p.path);
    global.gc?.(); // hand the mp4 buffers back before the next poll cycle
    job.progress = 100;
    job.status = 'completed';
    job.updatedAt = Date.now();
    console.error(`[flow] ${job.id} completed: ${job.outputs.length} video(s)`);
  }

  get(id) {
    const j = this.jobs.get(id);
    if (!j) return null;
    const o = {
      id: j.id, object: 'video', status: j.status, model: j.model, seconds: j.seconds,
      account: j.account, credits_used: j.creditsUsed,
      progress: j.progress, output_count: j.params.outputCount, created_at: j.createdAt,
      outputs: j.outputs.map((x, i) => ({ index: i, media_id: x.mediaId, path: x.path, url: x.url })),
    };
    if (j.error) o.error = { message: j.error };
    return o;
  }

  content(id, n = 0) {
    const p = this.jobs.get(id)?.outputs[n]?.path;
    return p ? fs.readFileSync(p) : null;
  }
}

// ── HTTP ───────────────────────────────────────────────────────────────────
function hasSessionCookies(file) {
  // Only our own login jars have ever held a Flow-usable session; the AI Studio
  // storage states carry Google cookies too but Flow rejects them.
  if (!file || !/\/flow-video\/cookies[^/]*\.json$/.test(file)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.cookies || [];
    const names = new Set(list.map((c) => c.name));
    return names.has('SID') && names.has('SAPISID');
  } catch { return false; }
}

function usageSummary(entries) {
  const by_account = {}, by_model = {}, by_day = {};
  let credits_used = 0, videos = 0;
  for (const e of entries) {
    const used = e.credits_used || 0;
    credits_used += used;
    videos += e.outputs || 0;
    const a = by_account[e.account] || (by_account[e.account] = { generations: 0, credits_used: 0, videos: 0 });
    a.generations++; a.credits_used += used; a.videos += e.outputs || 0;
    by_model[e.model || '?'] = (by_model[e.model || '?'] || 0) + used;
    const day = new Date(e.ts).toISOString().slice(0, 10);
    by_day[day] = (by_day[day] || 0) + used;
  }
  return { generations: entries.length, credits_used, videos, by_account, by_model, by_day };
}

function startHttp(proxy) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, BASE);
    let p = u.pathname;
    if (p.startsWith('/v1')) p = p.slice(3) || '/';
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    };
    const json = (code, v) => send(code, JSON.stringify(v));
    try {
      if (req.method === 'GET' && (p === '/health' || p === '/')) return json(200, { ok: true, service: 'magpie-flow-video',
        jobs: proxy.jobs.size, clients: proxy.browsers.size, transport: 'http',
        rss_mb: Math.round(process.memoryUsage().rss / 1048576) });
      if (req.method === 'GET' && p === '/models' || req.method === 'POST' && p === '/models/refresh') {
        const only = u.searchParams.get('account');
        const force = req.method === 'POST' || u.searchParams.get('refresh') === '1';
        let cat = null; let error = null;
        try { cat = await proxy.catalog({ force, accountId: only }); }
        catch (e) { error = e.message; }
        const fallback = [{ id: 'flow-video', object: 'model', kind: 'video', owned_by: 'google-flow' },
          ...MODELS.map((m) => ({ id: m.id, object: 'model', kind: 'video', owned_by: 'google-flow' }))];
        const data = cat ? familyModels(cat) : fallback;
        // Tier is captured when the catalog is fetched, so a plain /models read
        // never opens a browser (magpie fetches this list on a timer).
        const tier = cat?.tier ?? proxy.creditCache.get(only || proxy.defaultAccount)?.credits?.service_tier ?? null;
        const detail = u.searchParams.get('detail') === '1';
        return json(200, { object: 'list', data, live: !!cat, catalog_at: cat ? new Date(cat.at).toISOString() : null,
          ...(error ? { warning: error } : {}),
          ...(detail ? { tier, families: (cat?.families || []).map((f) => ({ ...f,
            available: f.models.filter((m) => tier == null || m.credits[String(tier)] != null).length })) } : {}) });
      }
      if (req.method === 'GET' && p === '/accounts') {
        proxy.reloadAccounts();
        // The live Google identity is cached from the last balance read. Showing
        // it here makes a window signed into the wrong account obvious.
        const accounts = proxy.accounts.map((a) => ({ ...a,
          email: proxy.creditCache.get(a.id)?.credits?.email || null }));
        return json(200, { default: proxy.defaultAccount, file: ACCOUNTS_FILE, accounts });
      }
      if (req.method === 'GET' && p === '/credits') {
        proxy.reloadAccounts();
        const all = u.searchParams.get('all') === '1';
        const probe = u.searchParams.get('probe') === '1';
        const only = u.searchParams.get('account');
        const ids = only ? [proxy.account(only).id] : all ? proxy.accounts.map((a) => a.id) : [proxy.defaultAccount];
        const accounts = [];
        for (const id of ids) {
          const a = proxy.account(id);
          const row = { account: id, label: a.label, cookies_file: a.cookiesFile };
          // Cold jars without a Flow session cost a native sqlite load and an HTTP
          // client each. Skip them unless the caller explicitly asks to probe.
          if (all && !probe && !proxy.creditCache.has(id) && !hasSessionCookies(a.cookiesFile)) {
            row.signed_in = false;
            row.skipped = 'no signed-in cookie jar; use ?account=<id> or ?probe=1';
            accounts.push(row);
            continue;
          }
          try { row.credits = await proxy.credits(id, { force: true }); row.signed_in = true; }
          catch (e) { row.signed_in = false; row.error = e.message; }
          accounts.push(row);
        }
        return json(200, { accounts, usage: usageSummary(readUsage()) });
      }
      // magpie's Usage page reads a provider's balanceURL; keep this cheap —
      // cached balances + the local ledger, no network on every refresh.
      if (req.method === 'GET' && p === '/balance') {
        proxy.reloadAccounts();
        const entries = readUsage(10000);
        const today = new Date().toISOString().slice(0, 10);
        const todays = entries.filter((e) => new Date(e.ts).toISOString().slice(0, 10) === today);
        const rows = [];
        for (const a of proxy.accounts) {
          let c = proxy.creditCache.get(a.id)?.credits || null;
          if (!c && (u.searchParams.get('refresh') === '1' || a.id === proxy.defaultAccount)) {
            try { c = await proxy.credits(a.id); } catch {}
          }
          if (!c) {
            const last = entries.filter((e) => e.account === a.id && e.credits_after != null).at(-1);
            if (last) c = { total: last.credits_after };
          }
          rows.push({ account: a.id, label: a.label, credits: c });
        }
        const known = rows.filter((r) => r.credits?.total != null);
        // FLOW_SEPARATE_ACCOUNTS=1 trusts the operator over the gaia-id probe
        // and counts every signed-in window as its own credit pool.
        const separate = process.env.FLOW_SEPARATE_ACCOUNTS === '1';
        const pools = new Map();
        for (const r of known) {
          const key = separate ? r.account : (r.credits.person_id || r.account);
          if (!pools.has(key)) pools.set(key, { total: r.credits.total, sessions: 1 });
          else pools.get(key).sessions++;
        }
        const out = {
          credits: [...pools.values()].reduce((s, x) => s + x.total, 0),
          accounts: rows.length, signed_in_accounts: pools.size,
          windows: known.length,
          used_today: todays.reduce((s, e) => s + (e.credits_used || 0), 0),
          used_total: entries.reduce((s, e) => s + (e.credits_used || 0), 0),
          generations_today: todays.length, generations_total: entries.length,
          per_account: rows,
        };
        const clip = (n) => `${n} ${n === 1 ? 'clip' : 'clips'}`;
        // magpie formats numeric balance fields with two decimals. String
        // values are shown verbatim, and several labeled parts are drawn as
        // neat label/value rows instead of one long wrapped paragraph.
        out.credits_text = `${out.credits} credits left`;
        out.today_text = `${out.used_today} credits · ${clip(out.generations_today)}`;
        out.total_text = `${out.used_total} credits · ${clip(out.generations_total)}`;
        out.accounts_text = `${out.signed_in_accounts} of ${out.accounts} accounts` +
          (out.windows > out.signed_in_accounts ? ` · ${out.windows} windows` : '') + ' signed in';
        return json(200, out);
      }
      if (req.method === 'GET' && p === '/usage') {
        const only = u.searchParams.get('account');
        let entries = readUsage(Number(u.searchParams.get('limit') || 200));
        if (only) entries = entries.filter((e) => e.account === only);
        return json(200, { object: 'list', file: USAGE_FILE, entries, summary: usageSummary(entries) });
      }
      if (req.method === 'GET' && p === '/session') {
        const a = proxy.account(u.searchParams.get('account'));
        const b = proxy.browser(a.id);
        await b.open();
        return json(200, { account: a.id, label: a.label, ...await b.wiz(),
          cookiesFile: a.cookiesFile, projectId: proxy.projects[a.id] || null });
      }
      // Sign-in from a browser or from magpie: POST /v1/login starts a window,
      // GET /v1/login/{id} says how it is going. Nothing is scraped from a
      // browser the user did not open.
      if (req.method === 'GET' && p === '/login') {
        const avail = signInAvailable();
        return json(200, { available: avail.ok, chrome: avail.chrome || null, ...(avail.error ? { error: avail.error } : {}),
          jobs: [...jobs.values()].map((j) => ({ id: j.id, account: j.account, status: j.status, message: j.message })) });
      }
      if (req.method === 'POST' && p === '/login') {
        const raw = await readBody(req);
        let body = {}; try { body = JSON.parse(raw || '{}'); } catch { return json(400, { error: { message: 'invalid JSON' } }); }
        const avail = signInAvailable();
        if (!avail.ok) return json(503, { error: { message: avail.error } });
        const job = startSignIn({ id: body.account || body.id || null, label: body.label || null });
        return json(200, { id: job.id, status: job.status, message: job.message, poll: `/v1/login/${job.id}` });
      }
      const lj = /^\/login\/([^/]+)$/.exec(p);
      if (lj && req.method === 'GET') {
        const job = jobs.get(decodeURIComponent(lj[1]));
        if (!job) return json(404, { error: { message: 'unknown sign-in id' } });
        return json(200, { id: job.id, account: job.account, status: job.status, message: job.message, lines: job.lines });
      }
      if (p === '/mcp') return mcpHttp(req, res, json, send);
      if (req.method === 'POST' && p === '/videos') {
        const raw = await readBody(req);
        let body; try { body = JSON.parse(raw || '{}'); } catch { return json(400, { error: { message: 'invalid JSON' } }); }
        let j; try { j = proxy.create(body); } catch (e) { return json(400, { error: { message: e.message } }); }
        return json(200, proxy.get(j.id));
      }
      const m = /^\/videos\/([^/]+)(\/content)?(?:\/(\d+))?$/.exec(p);
      if (m && req.method === 'GET') {
        const j = proxy.get(decodeURIComponent(m[1]));
        if (!j) return json(404, { error: { message: 'unknown video id' } });
        if (m[2]) {
          const bytes = proxy.content(j.id, Number(m[3] || 1) - 1);
          if (!bytes) return json(404, { error: { message: 'video content not ready' } });
          return send(200, bytes, 'video/mp4');
        }
        return json(200, j);
      }
      return json(404, { error: { message: `no route ${req.method} ${u.pathname}` } });
    } catch (e) {
      return json(500, { error: { message: e.message } });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', (e) => (e.code === 'EADDRINUSE' ? resolve(null) : reject(e)));
    server.listen(config.port, config.host, () => { console.error(`[flow] proxy on ${BASE}`); resolve(server); });
  });
}


async function api(method, p, body) {
  const r = await request(BASE + p, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = JSON.parse(r.text());
  if (!r.ok || j.error) throw new Error(j.error?.message || `HTTP ${r.status}`);
  return j;
}

async function waitFor(job, waitSeconds, dest) {
  const deadline = Date.now() + Math.min(Number(waitSeconds ?? 20), 45) * 1000; // MCP clients time out at 60s
  while (Date.now() < deadline) {
    if (job.status === 'completed' || job.status === 'failed') break;
    await sleep(1500);
    job = await api('GET', `/v1/videos/${encodeURIComponent(job.id)}`);
  }
  if (job.status === 'failed') throw new Error(job.error?.message || 'generation failed');
  if (job.status !== 'completed') {
    return { id: job.id, status: job.status, progress: job.progress, message: 'Still generating — call generation_result with this id.' };
  }
  // The proxy already wrote the mp4 files; `path` on a poll re-saves them.
  let paths = job.outputs.map((o) => o.path).filter(Boolean);
  if (dest && paths.length) {
    const dir = dest.toLowerCase().endsWith('.mp4') ? path.dirname(path.resolve(dest)) : path.resolve(dest);
    fs.mkdirSync(dir, { recursive: true });
    paths = paths.map((f, i) => {
      const to = dest.toLowerCase().endsWith('.mp4') && i === 0 ? path.resolve(dest) : path.join(dir, path.basename(f));
      if (to !== f) fs.copyFileSync(f, to);
      return to;
    });
  }
  return { id: job.id, status: 'completed', outputs: paths, output_count: paths.length, model: job.model, seconds: job.seconds };
}

async function callTool(name, args) {
  if (name === 'list_models') {
    const q = new URLSearchParams();
    if (args.refresh) q.set('refresh', '1');
    if (args.account) q.set('account', args.account);
    q.set('detail', '1');
    const live = await api('GET', '/v1/models?' + q);
    const families = live.families || [];
    const base = {
      durations: DURATIONS, resolutions: RESOLUTION_CODES, aspects: ASPECTS,
      output_count: [1, 2, 3, 4], live: !!live.live, catalog_at: live.catalog_at || null,
      tier: live.tier ?? null,
      ...(live.warning ? { warning: live.warning } : {}),
      note: 'Pass a family id or an exact key as `model`. Exact/new keys pass through untouched, so a model released by Flow works before any code change.',
    };
    if (!families.length) return { ...base,
      families: [{ id: 'flow-video', name: 'Offline fallback (Omni 1.1 / 1.2 Flash)', keys: MODELS.length,
        models: MODELS.map((m) => ({ key: m.id })) }],
      selectable: live.data.map((m) => m.id),
      warning: live.warning || 'No live catalog yet — start the proxy (serve) or pass refresh:true.' };
    return {
      ...base,
      families: families.map((f) => ({ id: f.preferred, name: f.label, family_id: f.id,
        aliases: f.aliases, keys: f.models.length, available: f.available ?? f.models.length,
        costs: [...new Set(f.models.flatMap((m) => Object.values(m.credits || {})))].sort((a, b) => a - b),
        models: f.models.map((m) => ({ key: m.id, mode: m.mode, duration: m.duration,
          resolution: m.resolution, credits: m.credits })) })),
      selectable: live.data.map((m) => m.id),
    };
  }
  if (name === 'session_status') return { ...await api('GET', '/v1/session' + (args.account ? `?account=${encodeURIComponent(args.account)}` : '')), note: 'Read-only. No credits spent.' };
  if (name === 'list_accounts') return api('GET', '/v1/accounts');
  if (name === 'credit_usage') {
    const q = new URLSearchParams({ limit: String(args.limit || 100) });
    if (args.all) q.set('all', '1');
    if (args.account) q.set('account', args.account);
    const [credits, usage] = await Promise.all([api('GET', '/v1/credits?' + q), api('GET', '/v1/usage?' + q)]);
    return { credits, usage };
  }
  if (name === 'sign_in') {
    const avail = signInAvailable();
    if (!avail.ok) throw new Error(avail.error);
    const job = startSignIn({ id: args.account || null, label: args.label || null });
    return { id: job.id, status: job.status, message: job.message,
      note: 'A browser window is open. The user signs in to Google themselves; call sign_in_status to follow it.' };
  }
  if (name === 'sign_in_status') {
    const job = jobs.get(args.id);
    if (!job) throw new Error(`unknown sign-in id ${args.id}`);
    return { id: job.id, account: job.account, status: job.status, message: job.message,
      ...(job.status === 'done' ? { note: 'The account is registered; generate_video with this account id works now.' } : {}) };
  }
  if (name === 'generation_result') {
    const job = await api('GET', `/v1/videos/${encodeURIComponent(args.id)}`);
    return waitFor(job, args.wait_seconds, args.path);
  }
  if (name === 'generate_video') {
    const job = await api('POST', '/v1/videos', args);
    return waitFor(job, args.wait_seconds, args.path);
  }
  throw new Error(`unknown tool ${name}`);
}

async function mcpLoop() {
  const { stdin } = process;
  let buf = '';
  const reply = (id, result, error) => {
    const msg = error ? { jsonrpc: '2.0', id, error: { code: -32000, message: error } }
      : { jsonrpc: '2.0', id, result };
    process.stdout.write(JSON.stringify(msg) + '\n');
  };
  for await (const chunk of stdin) {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let req; try { req = JSON.parse(line); } catch { continue; }
      if (req.id == null) continue; // notifications get no answer
      try {
        if (req.method === 'initialize') reply(req.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'magpie-video', version: '1' } });
        else if (req.method === 'ping') reply(req.id, {});
        else if (req.method === 'tools/list') reply(req.id, { tools: TOOLS });
        else if (req.method === 'tools/call') {
          const r = await callTool(req.params?.name, req.params?.arguments || {});
          reply(req.id, { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], isError: false });
        } else reply(req.id, null, `method not found: ${req.method}`);
      } catch (e) { reply(req.id, null, e.message); }
    }
  }
}

// Streamable-HTTP MCP. Pi opens one connection per server, so this removes the
// three extra `server.mjs mcp` Node processes (~70 MB RSS each).
async function rpc(req) {
  if (req.method === 'initialize') return {
    protocolVersion: req.params?.protocolVersion || '2025-06-18',
    capabilities: { tools: {} }, serverInfo: { name: 'magpie-video', version: '1' },
  };
  if (req.method === 'ping') return {};
  if (req.method === 'tools/list') return { tools: TOOLS };
  if (req.method === 'tools/call') {
    const r = await callTool(req.params?.name, req.params?.arguments || {});
    return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], isError: false };
  }
  if (req.method === 'resources/list') return { resources: [] };
  if (req.method === 'prompts/list') return { prompts: [] };
  throw new Error(`method not found: ${req.method}`);
}

async function mcpHttp(req, res, json, send) {
  // A JSON-only server has no SSE stream; 405 tells clients to stop asking.
  if (req.method === 'GET') return send(405, '', 'text/plain');
  if (req.method === 'DELETE') return json(200, {});
  if (req.method !== 'POST') return json(405, { error: { message: 'POST required' } });
  let payload;
  try { payload = JSON.parse(await readBody(req) || '{}'); } catch { return json(400, { error: { message: 'invalid JSON' } }); }
  const one = async (r) => {
    if (r.id == null) return null; // notifications get no response
    try { return { jsonrpc: '2.0', id: r.id, result: await rpc(r) }; }
    catch (e) { return { jsonrpc: '2.0', id: r.id, error: { code: -32000, message: e.message } }; }
  };
  const out = Array.isArray(payload)
    ? (await Promise.all(payload.map(one))).filter(Boolean) : await one(payload);
  if (out == null || (Array.isArray(out) && !out.length)) {
    res.writeHead(202, { 'Access-Control-Allow-Origin': '*' }); res.end(); return;
  }
  return json(200, out);
}

// ── CLI ────────────────────────────────────────────────────────────────────
async function check() {
  const id = process.argv[3] || null;
  const { accounts } = loadAccounts();
  const a = id ? accounts.find((x) => x.id === id || x.label === id) : accounts[0];
  if (!a) throw new Error(`unknown account ${id} — see node server.mjs accounts`);
  const i = accounts.indexOf(a);
  const b = new FlowClient(accountConfig(a, i));
  try {
    await b.open();
    const w = await b.wiz();
    console.log(JSON.stringify({ account: a.id, label: a.label, ...w, cookiesFile: a.cookiesFile }, null, 2));
    try {
      const t = await b.call(RPC.credits, creditsEnvelope());
      console.log(`credits: ${JSON.stringify(readCredits(firstPayload(t, RPC.credits)))}`);
    } catch (e) { console.log(`credits: ${e.message}`); }
    try {
      const t = await b.call(RPC.operation, operationEnvelope(crypto.randomUUID()));
      console.log(`read RPC: HTTP 200, ${parseEnvelope(t).length} envelope row(s)`);
    } catch (e) { console.log(`read RPC: ${e.message}`); }
    try {
      const c = await b.mintCaptcha(CAPTCHA_VIDEO);
      console.log(`reCAPTCHA: OK (${c.token.length} chars, ${c.source}, sitekey ${c.sitekey})`);
    } catch (e) { console.log(`reCAPTCHA: ${e.message}`); }
    if (!w.at) console.log(a.cookiesFile.endsWith('.sqlite')
      ? '\nNO AT TOKEN — this Waterfox jar has no signed-in Flow session. Sign in to flow.google.com in Waterfox, then run check again (cookies are read live).'
      : `\nNO AT TOKEN — cookies are stale for Flow. Run \`npm run login -- ${a.id}\` and sign in.`);
  } finally { b.close(); }
}

async function login() {
  const id = process.argv[3] || null;
  await signIn({ id, log: (m) => console.log(m) });
}

const mode = process.argv[2] || 'serve';
if (mode === 'accounts') console.log(JSON.stringify(loadAccounts(), null, 2));
else if (mode === 'models') {
  const q = new URLSearchParams({ refresh: '1', detail: '1' });
  if (process.argv[3]) q.set('account', process.argv[3]);
  const r = await request(BASE + '/v1/models?' + q);
  console.log(JSON.stringify(JSON.parse(r.text()), null, 2));
}
else if (mode === 'check') await check();
else if (mode === 'login') await login();
else {
  if (mode !== 'serve' && mode !== 'mcp') { console.error('usage: node server.mjs [serve|mcp|check|login|accounts|models] [account]'); process.exit(1); }
  const proxy = new Proxy();
  const server = await startHttp(proxy);
  if (!server && mode === 'serve') { console.error(`port ${config.port} is already in use`); process.exit(1); }
  if (!server) console.error(`[flow] reusing the proxy already on ${BASE}`);
  if (server) {
    // Google adds/removes model families without notice. Keep the cached catalog
    // warm so magpie's periodic /v1/models fetch sees a new family on its own.
    setInterval(() => proxy.catalog({ force: true }).catch(() => {}), 30 * 60 * 1000).unref();
    // Flow rotates SIDCC/*PSIDTS on each response. One cheap read per active
    // account keeps the jar fresh so a restart does not need a new sign-in.
    setInterval(() => {
      for (const id of proxy.browsers.keys()) proxy.credits(id, { force: true }).catch(() => {});
    }, 5 * 60 * 1000).unref();
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, async () => {
        await Promise.all([...proxy.browsers.values()].map((b) => b.persistCookies().catch(() => {})));
        process.exit(0);
      });
    }
  }
  if (mode === 'mcp') await mcpLoop();
}
