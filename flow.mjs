// flow.mjs — Flow's batchexecute wire format, with no network access.
//
// Reversed from flow.google.com's own bundles (AiSandboxAngularFrontend,
// build boq_labs-ai-sandbox-frontend_20261104.10_p1) and cross-checked against
// live captures published by crisng95/flowkit (golden tests) and
// TheSmallHanCat/flow2api. Fields are protobuf-ish sparse JSON arrays: field N
// lives at index N-1. Nothing here spends credits; callers issue the envelope.
import crypto from 'node:crypto';

export const BATCH_PATH = '/_/AiSandboxAngularFrontend/data/batchexecute';
export const FLOW_ORIGIN = 'https://flow.google.com';
export const CAPTCHA_SLOT = '__CAPTCHA__';
export const CAPTCHA_VIDEO = 'VIDEO_GENERATION';
export const CAPTCHA_IMAGE = 'IMAGE_GENERATION';
export const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
export const SURFACE_ID = 22;
export const FULL_FRAME_CROP = [null, null, 1, 1];
export const MEDIA_HOST = 'flow-content.google';

export const RPC = Object.freeze({
  text: 'YhhmEf',
  firstFrame: 'eb1hJf',
  firstLast: 'nprQif',
  references: 'MZZa6b',
  extend: 'fZytfe',
  upsample: 'p0UkFb',
  operation: 'jwpduf',
  projectMedia: 'Zzl0ze',
  media: 'as29s',
  createProject: 'jHPbke',
  uploadImage: 'maseQ',
  image: 'ogiZ0b',
  imageUpscale: 'SPrCad',
  credits: 'nzlxg',
  models: 'HTrJv',
  people: 'o30O0e',
});

// Flow's video aspect slot does NOT share the image encoding: 1 = 9:16,
// 2 = 16:9 (measured 720x1280 / 1280x720 in flowkit captures).
export const ASPECTS = Object.freeze({
  '9:16': 1, portrait: 1, 'video_aspect_ratio_portrait': 1, '3:4': 1,
  '16:9': 2, landscape: 2, 'video_aspect_ratio_landscape': 2, '4:3': 2,
  '1:1': 0, square: 0, // shortcut: square 0 comes from flow2api, unverified on the current UI
});

// Flow's own bundle IO(): 4 -> 360p, 1 -> 720p, 2 -> 1080p, 3 -> 4K.
export const RESOLUTION_CODES = Object.freeze({ '360p': 4, '720p': 1, '1080p': 2, '4k': 3 });
// Omni 1.2 Flash (macaron_cookie) exposes every integer length 3..15s; the
// older Omni 1.1 family only has 4/6/8/10, so defaultModel snaps to those.
export const DURATIONS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const OMNI1_DURATIONS = [4, 6, 8, 10];

// Model keys seen on the wire. `model` accepts any string, so a newly exposed
// Flow key works before it is listed here. The live HTrJv catalog is the source
// of truth; these are only the keys advertised when Flow cannot be reached.
export const MODELS = Object.freeze([
  { id: 'abra_t2v_4s', mode: 'text', duration: 4 },
  { id: 'abra_t2v_6s', mode: 'text', duration: 6 },
  { id: 'abra_t2v_8s', mode: 'text', duration: 8 },
  { id: 'abra_t2v_10s', mode: 'text', duration: 10 },
  { id: 'veo_3_1_t2v', mode: 'text' },
  { id: 'veo_3_1_t2v_fast', mode: 'text' },
  { id: 'veo_3_1_t2v_fast_ultra', mode: 'text' },
  { id: 'veo_3_1_i2v_lite', mode: 'first_frame' },
  { id: 'veo_3_1_i2v_lite_low_priority', mode: 'first_frame' },
  { id: 'veo_3_1_i2v_s_fast_ultra', mode: 'first_frame' },
  { id: 'veo_3_1_i2v_s', mode: 'first_frame' },
  { id: 'abra_i2v_4s', mode: 'first_frame', duration: 4 },
  { id: 'abra_i2v_6s', mode: 'first_frame', duration: 6 },
  { id: 'abra_i2v_8s', mode: 'first_frame', duration: 8 },
  { id: 'abra_i2v_10s', mode: 'first_frame', duration: 10 },
  { id: 'abra_r2v_8s', mode: 'references', duration: 8 },
  { id: 'abra_r2v_4s', mode: 'references', duration: 4 },
  { id: 'abra_r2v_6s', mode: 'references', duration: 6 },
  { id: 'abra_r2v_10s', mode: 'references', duration: 10 },
  { id: 'omni_flash_i2v_8s_first_last', mode: 'first_last', duration: 8 },
  { id: 'omni_flash_i2v_4s_first_last', mode: 'first_last', duration: 4 },
  { id: 'omni_flash_i2v_6s_first_last', mode: 'first_last', duration: 6 },
  { id: 'omni_flash_i2v_10s_first_last', mode: 'first_last', duration: 10 },
  { id: 'veo_3_1_extend_fast_ultra', mode: 'extend' },
  { id: 'veo_3_1_upsampler_1080p', mode: 'upsample' },
  { id: 'veo_3_1_upsampler_4k', mode: 'upsample' },
  // Omni 1.2 Flash: Flow lists 112 keys (t2v/i2v/i2v_fl/r2v, 360p and 720p).
  ...DURATIONS.map((duration) => ({ id: `macaron_cookie_t2v_${duration}s`, mode: 'text', duration })),
]);

export function uuid() { return crypto.randomUUID().toUpperCase(); }

function seededUuid(seed, salt) {
  const h = crypto.createHash('sha256').update(`${seed}:${salt}`).digest('hex').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-A${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const clientUuid = (seed, salt) => (seed == null ? uuid() : seededUuid(seed, salt));
const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export function buildEnvelope(rpcid, inner) {
  return JSON.stringify([[[rpcid, JSON.stringify(inner), null, 'generic']]]);
}

// batchexecute answers with a )]}' sentinel followed by JSON chunks whose
// length prefixes lie once escapes are involved, so scan instead of trusting
// the prefix.
export function parseEnvelope(text) {
  if (!text) return [];
  const body = text.startsWith(")]}'") ? text.slice(text.indexOf('\n') + 1) : text;
  const out = [];
  let i = 0;
  while ((i = body.indexOf('[', i)) !== -1) {
    let depth = 0, quoted = false, escaped = false, end = -1;
    for (let j = i; j < body.length; j++) {
      const c = body[j];
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') { quoted = !quoted; continue; }
      if (quoted) continue;
      if (c === '[') depth++;
      else if (c === ']' && --depth === 0) { end = j + 1; break; }
    }
    if (end === -1) break;
    let chunk;
    try { chunk = JSON.parse(body.slice(i, end)); } catch { i++; continue; }
    i = end;
    for (const e of Array.isArray(chunk) ? chunk : []) {
      if (!Array.isArray(e) || e[0] !== 'wrb.fr') continue;
      const rpcid = e[1];
      if (e[2] == null) { out.push({ rpcid, payload: null, error: e[5] ?? true }); continue; }
      try { out.push({ rpcid, payload: typeof e[2] === 'string' ? JSON.parse(e[2]) : e[2] }); }
      catch { out.push({ rpcid, payload: null, error: 'unparsable payload' }); }
    }
  }
  return out;
}

export function firstPayload(text, rpcid) {
  const rows = parseEnvelope(text);
  const hit = rows.find((r) => r.rpcid === rpcid);
  if (!hit) throw new Error(`no ${rpcid} envelope in response (${rows.length} others)`);
  if (hit.error) throw new Error(`${rpcid} failed: ${JSON.stringify(hit.error)}`);
  return hit.payload;
}

export function* walkStrings(node) {
  if (typeof node === 'string') yield node;
  else if (Array.isArray(node)) for (const v of node) yield* walkStrings(v);
  else if (node && typeof node === 'object') for (const v of Object.values(node)) yield* walkStrings(v);
}

export function* walkLists(node) {
  if (!Array.isArray(node)) return;
  yield node;
  for (const v of node) yield* walkLists(v);
}

export function mediaUrls(payload, kind = 'video') {
  const seen = new Set(), out = [];
  for (const s of walkStrings(payload)) {
    if (!s.startsWith('https://') || !s.includes(`${MEDIA_HOST}/${kind}/`)) continue;
    const id = s.split(`/${kind}/`)[1].split('?')[0];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ mediaId: id, url: s });
  }
  return out;
}

export function publicErrors(payload) {
  return [...new Set([...walkStrings(payload)].filter((s) => s.startsWith('PUBLIC_ERROR_')))];
}

export function readVideoSubmit(payload) {
  const records = [], seen = new Set();
  for (const node of walkLists(payload)) {
    if (node.length >= 3 && isUuid(node[0]) && isUuid(node[2]) && !seen.has(node[0])) {
      seen.add(node[0]);
      records.push({ operationId: node[0], projectId: node[1], mediaId: node[2], status: node[3] });
    }
  }
  return { records, direct: mediaUrls(payload) };
}

export function readOperation(payload) {
  const record = Array.isArray(payload) && Array.isArray(payload[2]) ? payload[2][0] : null;
  if (!Array.isArray(record)) throw new Error('operation payload carried no record');
  const detail = Array.isArray(record[5]) ? record[5] : [];
  const outcome = Array.isArray(detail[8]) ? detail[8][0] : detail[8];
  const complaint = outcome === 4 ? [...walkStrings(detail[8])].find((s) => s) || null : null;
  return {
    operationId: record[0], projectId: record[1], status: record[3],
    done: record[3] === 'CAE' || outcome === 3 || detail[9] === 3, complaint,
  };
}

// Media rows live at payload[2]; row[5][0][0] is the creation time in seconds.
export function listingMediaIds(payload, sinceSec = 0) {
  const rows = Array.isArray(payload) && Array.isArray(payload[2]) ? payload[2] : [];
  const out = [];
  for (const row of rows) {
    if (!Array.isArray(row) || !isUuid(row[0])) continue;
    const detail = Array.isArray(row[5]) ? row[5] : [];
    const stamp = Array.isArray(detail[0]) ? Number(detail[0][0]) : 0;
    if (stamp && stamp < sinceSec) continue;
    out.push(row[0]);
  }
  return out;
}

// Scene rows carry [title, ts, isVideo, null, mediaId, opId, done] at node[3].
export function findMediaIds(payload, operationIds) {
  const wanted = new Set(operationIds.map((s) => String(s).toLowerCase()));
  const found = new Map();
  for (const node of walkLists(payload)) {
    const detail = node[3];
    if (!Array.isArray(detail) || typeof detail[4] !== 'string') continue;
    const keys = [node[0], detail[5]];
    for (const k of keys) if (typeof k === 'string' && wanted.has(k.toLowerCase())) found.set(k.toLowerCase(), detail[4]);
  }
  return found;
}

export const readCreatedProject = (payload) => {
  if (!Array.isArray(payload) || typeof payload[0] !== 'string' || !payload[0]) throw new Error('project create response carried no project id');
  return payload[0];
};
export const readUploadedMediaId = (payload) => {
  const id = Array.isArray(payload) && Array.isArray(payload[0]) ? payload[0][0] : null;
  if (typeof id !== 'string' || !id) throw new Error('upload response carried no media id');
  return id;
};

// ── payload pieces ───────────────────────────────────────────────────────────
const context = (projectId, captcha = CAPTCHA_SLOT, assetId = null) =>
  [null, SURFACE_ID, null, null, assetId, projectId, null, null, null, null, [captcha, 1]];
const promptMessage = (text) => [null, null, [[[text]]]];
const metadata = (seed, salt) => [null, null, null, null, clientUuid(seed, `a${salt}`), clientUuid(seed, `b${salt}`)];
const frame = (mediaId) => [null, mediaId, null, null, null, FULL_FRAME_CROP];
const ref = (mediaId) => [null, mediaId];

// ── parameter normalisation ─────────────────────────────────────────────────
function asImages(v) {
  if (v == null) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.map((x) => (typeof x === 'string' ? x : x?.image_url ?? x?.url ?? '')).filter(Boolean);
}

function durationOf(v) {
  const n = Number(String(v ?? 8).replace(/s$/i, ''));
  if (!Number.isFinite(n)) return 8;
  return DURATIONS.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));
}

function aspectOf(v) {
  if (v == null || v === '') return 2;
  if (typeof v === 'number') return v;
  const s = String(v).trim().toLowerCase();
  if (ASPECTS[s] !== undefined) return ASPECTS[s];
  if (/^\d+x\d+$/i.test(s)) { const [w, h] = s.split('x').map(Number); return w >= h ? 2 : 1; }
  const allowed = Object.keys(ASPECTS).join(', ');
  throw new Error(`unknown aspect_ratio ${JSON.stringify(v)} — use one of ${allowed} or 0/1/2`);
}

function resolutionOf(v) {
  if (v == null || v === '') return '720p';
  const s = String(v).trim().toLowerCase();
  if (s === '2160p') return '4k';
  if (!(s in RESOLUTION_CODES)) throw new Error(`resolution must be 360p, 720p, 1080p or 4K, not ${JSON.stringify(v)}`);
  return s;
}

/** Validate and normalise every parameter the MCP tool and the OpenAI-shaped
 *  proxy accept. OpenAI-shaped callers use `seconds`, `size`, `input_reference`
 *  and `reference_images`; those are aliases of the Flow names. */
export function normalizeParams(raw = {}) {
  const p = { ...raw };
  const prompt = String(p.prompt ?? '').trim();
  const negative = String(p.negative_prompt ?? p.negative ?? '').trim();
  const fullPrompt = negative ? `${prompt}\nDo not include: ${negative}` : prompt;

  const startFrames = asImages(p.start_frame ?? p.image ?? p.input_reference);
  const endFrames = asImages(p.end_frame ?? p.last_frame);
  const references = asImages(p.reference_images ?? p.references);
  const videoMediaId = String(p.video_media_id ?? p.video ?? '');
  let mode = String(p.mode ?? 'auto').toLowerCase();
  if (mode === 'auto' || mode === '') {
    mode = videoMediaId ? 'extend'
      : endFrames.length && startFrames.length ? 'first_last'
      : startFrames.length ? 'first_frame'
      : references.length ? 'references' : 'text';
  }
  if (!['text', 'first_frame', 'first_last', 'references', 'extend', 'upsample'].includes(mode))
    throw new Error(`unknown mode ${JSON.stringify(mode)}`);

  const count = Number(p.output_count ?? p.n ?? p.variants ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error('output_count must be a whole number from 1 to 4');
  const duration = durationOf(p.duration ?? p.seconds);
  const sizeToken = String(p.size ?? '').toLowerCase();
  const sizeIsResolution = /^(360p|720p|1080p|4k|2160p)$/.test(sizeToken);
  const resolution = resolutionOf(p.resolution ?? (sizeIsResolution ? sizeToken : null));
  const aspect = aspectOf(p.aspect_ratio ?? (sizeIsResolution ? null : p.size));
  const audioPref = Number(p.audio_pref ?? (p.audio === false ? 1 : 2));
  if (![0, 1, 2].includes(audioPref)) throw new Error('audio_pref must be 0, 1 or 2');
  if (!fullPrompt && mode !== 'extend' && mode !== 'upsample') throw new Error('prompt is required');

  return {
    prompt: fullPrompt,
    mode,
    model: p.model ? String(p.model) : null,
    duration,
    resolution,
    aspect,
    outputCount: count,
    seed: p.seed == null ? null : String(p.seed),
    audioPref,
    startFrames,
    endFrames,
    references,
    videoMediaId,
    projectId: p.project_id ? String(p.project_id) : null,
    projectTitle: String(p.project_title ?? 'magpie-flow-video'),
    captchaAction: String(p.captcha_action ?? CAPTCHA_VIDEO),
    path: p.path ? String(p.path) : null,
    seconds: String(duration),
  };
}

function defaultModel(p) {
  // The default is Omni 1.1, which only has 4/6/8/10s keys. An explicit
  // `model: omni-flash-1-2` keeps the requested 3..15s length.
  const d = OMNI1_DURATIONS.reduce((a, b) => (Math.abs(b - p.duration) < Math.abs(a - p.duration) ? b : a));
  switch (p.mode) {
    case 'text': return `abra_t2v_${d}s`;
    case 'first_frame': return `abra_i2v_${d}s`;
    case 'first_last': return `omni_flash_i2v_${d}s_first_last`;
    case 'references': return `abra_r2v_${d}s`;
    case 'extend': return 'veo_3_1_extend_fast_ultra';
    case 'upsample': return p.resolution === '4k' ? 'veo_3_1_upsampler_4k' : 'veo_3_1_upsampler_1080p';
  }
}

export function resolveModel(p) {
  let m = p.model || defaultModel(p);
  // 360p is encoded in BOTH the model key and a trailing option slot.
  if (p.resolution === '360p' && !m.endsWith('_360p')) m += '_360p';
  if (p.resolution !== '360p' && m.endsWith('_360p')) m = m.slice(0, -5);
  return m;
}

// Resolution slot position differs per RPC (Flow's JS sets field 8/10/12).
// Pad the request out to its captured slot, then append the resolution enum.
const RES_PAD = { text: 3, first_frame: 4, references: 6 };

export function buildVideoRequest(p, { projectId, mediaIds = {} }) {
  const model = resolveModel(p);
  const start = (p.startFrames[0] && (mediaIds[p.startFrames[0]] || p.startFrames[0])) || '';
  const end = (p.endFrames[0] && (mediaIds[p.endFrames[0]] || p.endFrames[0])) || '';
  const refs = p.references.map((r) => mediaIds[r] || r);
  const resCode = RESOLUTION_CODES[p.resolution];

  const items = [];
  let rpcid = RPC.text;
  for (let i = 0; i < p.outputCount; i++) {
    const meta = metadata(p.seed, i);
    let req;
    switch (p.mode) {
      case 'first_frame':
        rpcid = RPC.firstFrame;
        req = [promptMessage(p.prompt), model, p.aspect, null, frame(start), meta];
        break;
      case 'first_last':
        rpcid = RPC.firstLast;
        req = [promptMessage(p.prompt), model, p.aspect, null, frame(start), frame(end), meta];
        break;
      case 'references':
        rpcid = RPC.references;
        req = [promptMessage(p.prompt), refs.map(ref), model, p.aspect, null, meta];
        break;
      case 'extend':
        rpcid = RPC.extend;
        req = [[null, p.videoMediaId], promptMessage(p.prompt), model, p.aspect, null, meta, null, null, null, resCode];
        break;
      case 'upsample':
        rpcid = RPC.upsample;
        req = [[null, p.videoMediaId], null, p.aspect, crypto.randomInt(1, 2147483647), meta, null, resCode, null];
        req = req.concat(Array(31 - req.length).fill(null), model);
        break;
      default:
        rpcid = RPC.text;
        req = [promptMessage(p.prompt), model, p.aspect, null, meta];
    }
    // shortcut: 1080p/4K generation is still 720p + upsample in Flow's UI;
    // only 360p has a verified inline resolution slot, so leave the rest out.
    if (p.resolution === '360p' && RES_PAD[p.mode]) {
      req = req.concat(Array(RES_PAD[p.mode] - 1).fill(null), [[resCode]]);
    }
    items.push(req);
  }
  const inner = [items, context(projectId), [clientUuid(p.seed, 'batch'), p.audioPref]];
  return { rpcid, model, envelope: buildEnvelope(rpcid, inner), itemCount: items.length };
}

export const createProjectEnvelope = (title) => buildEnvelope(RPC.createProject,
  ['projects/*', [null, [String(title).slice(0, 160) || 'Flow project']], [null, SURFACE_ID]]);
export const uploadEnvelope = (projectId, base64, mime = 'image/jpeg', name = 'upload.jpg') =>
  buildEnvelope(RPC.uploadImage, [context(projectId), base64, mime, 1, null, null, null, null, name, null, uuid(), uuid()]);
export const operationEnvelope = (operationId) => buildEnvelope(RPC.operation, [null, null, [[operationId]]]);
export const projectMediaEnvelope = (projectId) => buildEnvelope(RPC.projectMedia, [`projects/${projectId}`, null, null, null, [1]]);
export const mediaEnvelope = (mediaId) => buildEnvelope(RPC.media, [mediaId]);
export const creditsEnvelope = () => buildEnvelope(RPC.credits, []);
export const modelsEnvelope = () => buildEnvelope(RPC.models, []);
// o30O0e: the signed-in person's numeric gaia id and email. Two windows can be
// the same Google account; counting their balances twice would overstate credits.
export const peopleEnvelope = () => buildEnvelope(RPC.people, [['me'], [[['person.photo', 'person.name', 'person.email', 'person.metadata']], null, [1, 7, 10]]]);
export function readPerson(payload) {
  const strings = [...walkStrings(payload)];
  return {
    id: strings.find((s) => /^\d{15,25}$/.test(s)) || null,
    email: strings.find((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) || null,
  };
}

// nzlxg: [total, serviceTier, sku, userPaygateTier, null, subscriptionCredits,
// [refreshSeconds, nanos]]. Some tiers cost 0 credits, and free credits refresh
// daily, so a before/after delta is an observation, not a price table.
export function readCredits(payload) {
  const p = Array.isArray(payload) ? payload : [];
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const refresh = Array.isArray(p[6]) ? n(p[6][0]) : null;
  return {
    total: n(p[0]), subscription: n(p[5]),
    top_up: n(p[0]) != null && n(p[5]) != null ? Math.max(0, n(p[0]) - n(p[5])) : null,
    service_tier: n(p[1]), sku: n(p[2]), user_paygate_tier: n(p[3]),
    refresh_at: refresh ? new Date(refresh * 1000).toISOString() : null,
  };
}

// ── live model catalog (HTrJv) ──────────────────────────────────────────────
// A captcha-free read with an empty payload. Its payload[0][4] holds the video
// families: [displayName, [modelConfigs], enabled, familyId, ...]. Each config
// is [wireKey, …, costsByTier, …, durationSeconds, …]. Reading the families
// from Flow is what makes a model released later show up after a refetch.
const normAlias = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function modelAliases(label, id) {
  // The first alias is the canonical, friendly id: "Omni 1.1 Flash" -> omni-flash-1-1,
  // "Veo 3.1 - Fast" -> veo-3-1-fast. Only the clean Word Version Word pattern
  // gets reordered; a leading "-" in the label keeps the natural slug.
  const out = [];
  const m = String(label).match(/^([A-Za-z]+)\s+([\d.]+)\s+([A-Za-z][A-Za-z0-9 ]*)$/);
  if (m) out.push(normAlias(`${m[1]}-${m[3]}-${m[2]}`));
  out.push(normAlias(label), normAlias(id));
  return [...new Set(out.filter(Boolean))];
}

function modeOfModel(key) {
  if (/upsampler/.test(key)) return 'upsample';
  if (/extend|extension/.test(key)) return 'extend';
  if (/first_last|_fl_/.test(key)) return 'first_last';
  if (/r2v|reference/.test(key)) return 'references';
  if (/i2v/.test(key)) return 'first_frame';
  if (/edit|interpolat/.test(key)) return 'other';
  return 'text';
}

function firstNumber(node) {
  if (typeof node === 'number' && Number.isFinite(node)) return node;
  if (Array.isArray(node)) for (const x of node) { const n = firstNumber(x); if (n !== null) return n; }
  return null;
}

export function parseModelCatalog(text) {
  const p = firstPayload(text, RPC.models);
  const top = Array.isArray(p) && Array.isArray(p[0]) ? p[0] : null;
  if (!top || !Array.isArray(top[4])) throw new Error('model catalog response carried no video families');
  const families = [];
  for (const f of top[4]) {
    if (!Array.isArray(f) || !Array.isArray(f[1])) continue;
    const label = String(f[0] || '');
    const id = String(f[3] || normAlias(label));
    const models = [];
    for (const c of f[1]) {
      if (!Array.isArray(c) || typeof c[0] !== 'string') continue;
      const costs = {};
      for (const row of Array.isArray(c[4]) ? c[4] : []) {
        // A tier with no price at all means the account on that tier cannot use
        // the model (Flow answers PUBLIC_ERROR_MODEL_ACCESS_DENIED). Keep null
        // distinct from a real 0-credit model.
        if (Array.isArray(row)) costs[String(row[0])] = firstNumber(row[1]);
      }
      models.push({
        id: c[0], mode: modeOfModel(c[0]),
        duration: typeof c[16] === 'number' ? c[16] : null,
        resolution: c[0].endsWith('_360p') ? '360p' : '720p',
        credits: costs,
      });
    }
    const aliases = modelAliases(label, id);
    families.push({ id, label, aliases, preferred: aliases[0], models });
  }
  if (!families.length) throw new Error('model catalog was empty');
  return { at: Date.now(), families };
}

/** Pick the wire key a family name means for these parameters. An exact wire
 *  key (or a brand-new key Flow just exposed) is passed through untouched. */
export function resolveFamilyModel(catalog, name, p) {
  if (!name || !catalog?.families) return name || null;
  const key = normAlias(name);
  const fam = catalog.families.find((f) => f.id === name || f.aliases.includes(key));
  if (!fam) return name;
  const wantRes = p.resolution || '720p';
  const score = (m) => {
    let s = 0;
    if (m.mode !== p.mode) s += 100;
    // Prefer the nearest available length, not just any mismatch: a tier that
    // cannot run 15s should get 10s, not the alphabetically first key.
    if (m.duration && m.duration !== p.duration) s += 10 + Math.abs(m.duration - p.duration);
    if (m.resolution !== wantRes) s += 5;
    s += (m.id.match(/_(portrait|landscape|ultra|fl|low_priority|relaxed)/g) || []).length;
    s += m.id.length / 1000;
    return s;
  };
  const usable = fam.models.filter((m) => m.mode === p.mode);
  const tier = p.tier != null ? String(p.tier) : null;
  const open = tier ? usable.filter((m) => m.credits[tier] != null) : usable;
  const list = open.length ? open : (usable.length ? usable : fam.models);
  list.sort((a, b) => score(a) - score(b));
  return list[0]?.id || name;
}

/** The short list magpie's /models fetch sees: one id per family, plus the
 *  default. New families appear here as soon as HTrJv is refetched. */
export function familyModels(catalog) {
  const seen = new Set(['flow-video']);
  const out = [{ id: 'flow-video', object: 'model', kind: 'video', owned_by: 'google-flow' }];
  for (const f of catalog?.families || []) {
    const id = f.preferred || f.aliases[0] || normAlias(f.label);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, object: 'model', kind: 'video', owned_by: 'google-flow',
      metadata: { family: f.label, family_id: f.id, models: f.models.length } });
  }
  return out;
}
