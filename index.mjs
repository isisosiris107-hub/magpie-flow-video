// magpie plugin entry. Tools only: a `config` hook would create a second
// provider named flow-video and collide with the custom provider setup.mjs adds.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from './schema.mjs';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server.mjs');
const PORT = Number(process.env.FLOW_PORT || 8787);
const BASE = `http://127.0.0.1:${PORT}/v1`;
const BALANCE_PATH = 'Balance: credits_text; Used today: today_text; Used total: total_text; Accounts: accounts_text';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let starting = null;

async function reachable() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch { return false; }
}

// magpie's own PATH often has no `node`, so look for one before falling back
// to the host runtime (bun). The host patches spawn to non-inherited stdio.
function runtimes() {
  return [
    process.env.FLOW_VIDEO_NODE,
    path.join(os.homedir(), '.local/share/pi-node/current/bin/node'),
    '/usr/bin/node', '/usr/local/bin/node', 'node', process.execPath,
  ].filter(Boolean).filter((p) => p === 'node' || p === process.execPath || fs.existsSync(p));
}

async function spawnProxy() {
  for (const bin of runtimes()) {
    const child = spawn(bin, ['--expose-gc', '--max-old-space-size=64', '--max-semi-space-size=1', SERVER, 'serve'], {
      cwd: HERE, detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, NODE_USE_ENV_PROXY: '1', UV_THREADPOOL_SIZE: '1', MALLOC_ARENA_MAX: '1', FLOW_VIDEO_PARENT_PID: String(process.pid) },
    });
    const ok = await new Promise((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', () => resolve(false));
    });
    if (!ok) continue;
    child.unref();
    return;
  }
  throw new Error('no Node runtime found — set FLOW_VIDEO_NODE to your node binary');
}

function ensureProxy() {
  return starting ??= (async () => {
    if (await reachable()) return;
    await spawnProxy();
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      if (await reachable()) return;
    }
    throw new Error(`the Flow proxy did not start on ${BASE} — see the README`);
  })().catch((e) => { starting = null; throw e; });
}

// balanceURL / balancePath / modelKinds are custom-provider settings with no
// plugin hook, so add them once, without touching anything the user configured.
function wire() {
  // magpie keeps its files in ~/.config/magpie on every platform (see
  // appdir.Config), honouring XDG_CONFIG_HOME when set.
  const dir = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'magpie')
    : path.join(os.homedir(), '.config', 'magpie');
  try {
    const pf = path.join(dir, 'providers.json');
    const p = JSON.parse(fs.readFileSync(pf, 'utf8'));
    p.providers ??= [];
    if (!p.providers.some((x) => x.id === 'flow-video')) {
      p.providers.push({
        id: 'flow-video', name: 'Google Flow', baseAPI: 'chat',
        chat: BASE, responses: BASE, models: ['flow-video'], refreshEvery: '6h',
        key: 'flow-video-local', balanceURL: `${BASE}/balance`, balanceMethod: 'GET',
        balancePath: BALANCE_PATH,
      });
      fs.writeFileSync(pf, JSON.stringify(p, null, 2) + '\n');
    }
    const sf = path.join(dir, 'settings.json');
    const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
    s.modelKinds ??= {};
    if (!s.modelKinds['flow-video/flow-video']) {
      s.modelKinds['flow-video/flow-video'] = 'video';
      fs.writeFileSync(sf, JSON.stringify(s, null, 2) + '\n');
    }
  } catch { /* magpie owns these files; setup.mjs wires them by hand */ }
}

async function api(method, p, body) {
  await ensureProxy();
  const r = await fetch(BASE.replace(/\/v1$/, '') + p, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error?.message || `HTTP ${r.status}`);
  return j;
}

async function job(id, seconds) {
  let j = await api('GET', `/v1/videos/${encodeURIComponent(id)}`);
  // plugin.RunTool has a 55s deadline; never wait longer than 45s here.
  const deadline = Date.now() + Math.min(Number(seconds ?? 40), 45) * 1000;
  while (j.status === 'queued' || j.status === 'in_progress') {
    if (Date.now() >= deadline) break;
    await sleep(2000);
    j = await api('GET', `/v1/videos/${encodeURIComponent(id)}`);
  }
  if (j.status === 'failed') throw new Error(j.error?.message || 'generation failed');
  return {
    id: j.id, status: j.status, progress: j.progress, account: j.account,
    model: j.model, seconds: j.seconds, credits_used: j.credits_used,
    outputs: j.outputs.map((o) => o.path).filter(Boolean),
    message: j.status === 'completed' ? undefined : 'Still generating — call generation_result again with this id.',
  };
}

async function run(name, a = {}) {
  switch (name) {
    case 'generate_video': {
      const j = await api('POST', '/v1/videos', a);
      return { id: j.id, status: j.status, account: j.account, model: j.model, message: 'Generation started. Call generation_result with this id.' };
    }
    case 'generation_result': return job(a.id, a.wait_seconds);
    case 'list_models': {
      const q = new URLSearchParams({ detail: '1' });
      if (a.refresh) q.set('refresh', '1');
      if (a.account) q.set('account', a.account);
      const m = await api('GET', '/v1/models?' + q);
      return {
        selectable: m.data.map((x) => x.id), live: m.live, catalog_at: m.catalog_at, tier: m.tier ?? null,
        families: (m.families || []).map((f) => ({ id: f.preferred, name: f.label, aliases: f.aliases,
          keys: f.models.length, available: f.available ?? f.models.length })),
        note: '`available` counts models this account\'s tier can use. Pass a family id or an exact Flow wire key as `model`. New keys pass through untouched; use refresh:true when Flow releases a model.',
      };
    }
    case 'session_status': return api('GET', '/v1/session' + (a.account ? `?account=${encodeURIComponent(a.account)}` : ''));
    case 'list_accounts': return api('GET', '/v1/accounts');
    case 'credit_usage': {
      const q = new URLSearchParams({ limit: String(a.limit || 100) });
      if (a.all) q.set('all', '1');
      if (a.account) q.set('account', a.account);
      const [credits, usage] = await Promise.all([api('GET', '/v1/credits?' + q), api('GET', '/v1/usage?' + q)]);
      return { credits, usage };
    }
    default: throw new Error(`unknown tool ${name}`);
  }
}

// A page cannot start a process, so it asks for a sign-in by setting the
// plugin's option `loginRequest` (magpie reloads the plugin when options
// change). Handled ids are remembered on disk, so the extra reloads magpie
// does for other reasons cannot open a second window for the same click.
function handledFile() {
  return path.join(os.homedir(), '.local/share/flow-video/login-handled.json');
}

async function watchLogin(options) {
  const req = options?.loginRequest;
  if (!req?.id) return;
  let done = [];
  try { done = JSON.parse(fs.readFileSync(handledFile(), 'utf8')); } catch {}
  if (done.includes(req.id)) return;
  try {
    await api('POST', '/v1/login', { account: req.account || null, label: req.label || null });
  } catch { return; } // no Chrome, or the proxy refused; the page reports it
  try {
    done.push(req.id);
    fs.mkdirSync(path.dirname(handledFile()), { recursive: true });
    fs.writeFileSync(handledFile(), JSON.stringify(done.slice(-20)));
  } catch {}
}

export default async function FlowVideoPlugin(input, options = {}) {
  wire();
  ensureProxy().catch(() => {}); // fire-and-forget: host load has a 20s deadline
  watchLogin(options).catch(() => {});
  return {
    tool: Object.fromEntries(TOOLS.map((t) => [t.name, {
      description: t.description,
      args: t.inputSchema,
      execute: (args) => run(t.name, args),
    }])),
  };
}
