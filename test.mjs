// test.mjs — assert-free-of-network golden checks for the wire format.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import {
  RPC, CAPTCHA_SLOT, normalizeParams, buildVideoRequest, buildEnvelope,
  parseEnvelope, firstPayload, readVideoSubmit, readOperation, findMediaIds,
  listingMediaIds, mediaUrls, publicErrors, createProjectEnvelope, uploadEnvelope,
  operationEnvelope, projectMediaEnvelope, mediaEnvelope, creditsEnvelope, readCredits,
  peopleEnvelope, readPerson,
  modelsEnvelope, parseModelCatalog, resolveFamilyModel, familyModels, modelAliases,
  DURATIONS, MODELS, resolveModel,
} from './flow.mjs';
import { loadAccounts, accountConfig } from './accounts.mjs';
import fs from 'node:fs';

let n = 0;
const ok = (name) => console.log(`  ok ${++n} — ${name}`);
const uuidRe = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const canon = (v, projectId) => JSON.parse(JSON.stringify(v, (k, x) =>
  typeof x === 'string' && x === projectId ? '<project>' : typeof x === 'string' && uuidRe.test(x) ? '<uuid>' : x));

console.log('flow.mjs wire format');

// 1. The golden text-to-video envelope captured by crisng95/flowkit.
{
  const projectId = '11111111-2222-3333-4444-555555555555';
  const p = normalizeParams({ prompt: 'a cat walks', duration: 8, aspect_ratio: 1, audio_pref: 2 });
  const r = buildVideoRequest(p, { projectId });
  assert.equal(r.rpcid, RPC.text);
  assert.equal(r.model, 'abra_t2v_8s');
  assert.equal(r.itemCount, 1);
  const inner = JSON.parse(JSON.parse(r.envelope)[0][0][1]);
  const golden = [
    [[[null, null, [[['a cat walks']]]], 'abra_t2v_8s', 1, null,
      [null, null, null, null, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']]],
    [null, 22, null, null, null, projectId, null, null, null, null, [CAPTCHA_SLOT, 1]],
    ['00000000-0000-4000-8000-000000000003', 2],
  ];
  assert.deepEqual(canon(inner, projectId), canon(golden, projectId));
  assert.ok(r.envelope.includes(CAPTCHA_SLOT), 'a single-use captcha slot must survive to the browser');
  ok('text-to-video envelope matches the captured golden payload');
}

// 2. "4x" is four repeated request items, not a numeric field.
{
  const p = normalizeParams({ prompt: 'waves', output_count: 4, seconds: '10s', size: '16:9' });
  const r = buildVideoRequest(p, { projectId: 'p' });
  assert.equal(r.itemCount, 4);
  assert.equal(r.model, 'abra_t2v_10s');
  assert.equal(p.aspect, 2);
  assert.equal(JSON.parse(r.envelope)[0][0][0], RPC.text);
  const inner = JSON.parse(JSON.parse(r.envelope)[0][0][1]);
  assert.equal(inner[0].length, 4);
  ok('output_count 4 → four variants; 10s → abra_t2v_10s; 16:9 → aspect 2');
}

// 3. 360p encodes BOTH in the model key and in a trailing option slot.
{
  const p = normalizeParams({ prompt: 'x', duration: 6, resolution: '360p' });
  const r = buildVideoRequest(p, { projectId: 'p' });
  assert.equal(r.model, 'abra_t2v_6s_360p');
  const item = JSON.parse(JSON.parse(r.envelope)[0][0][1])[0][0];
  assert.equal(item.length, 8);
  assert.deepEqual(item[7], [4]);
  ok('360p → _360p model and the resolution slot at index 7');
}

// 4. Every mode maps to its own rpcid and gets the right image slots.
{
  const cases = [
    [{ start_frame: 'a.png' }, 'first_frame', RPC.firstFrame],
    [{ start_frame: 'a.png', end_frame: 'b.png' }, 'first_last', RPC.firstLast],
    [{ reference_images: ['a.png', 'b.png'] }, 'references', RPC.references],
    [{ video_media_id: 'media-1', mode: 'extend' }, 'extend', RPC.extend],
    [{ video_media_id: 'media-1', mode: 'upsample' }, 'upsample', RPC.upsample],
  ];
  for (const [args, mode, rpcid] of cases) {
    const p = normalizeParams({ prompt: 'x', ...args });
    assert.equal(p.mode, mode);
    assert.equal(buildVideoRequest(p, { projectId: 'p', mediaIds: { 'a.png': 'M-A', 'b.png': 'M-B' } }).rpcid, rpcid);
  }
  ok('mode inference and all five generation rpcids');
}

// 5. Aliases from magpie's OpenAI-shaped /videos body.
{
  const p = normalizeParams({ prompt: 'x', seconds: '8', size: '1280x720', input_reference: { image_url: 'data:image/png;base64,AAAA' }, reference_images: ['data:image/png;base64,BBBB'], n: 2, negative_prompt: 'blur' });
  assert.equal(p.duration, 8);
  assert.equal(p.aspect, 2);
  assert.equal(p.outputCount, 2);
  assert.equal(p.startFrames.length, 1);
  assert.equal(p.references.length, 1);
  assert.ok(p.prompt.includes('Do not include: blur'));
  ok('magpie aliases (seconds, size, input_reference, reference_images, n, negative_prompt)');
}

// 6. Validation at the boundary.
{
  assert.throws(() => normalizeParams({ prompt: 'x', output_count: 5 }), /1 to 4/);
  assert.throws(() => normalizeParams({ prompt: 'x', resolution: '8K' }), /resolution must be/);
  assert.throws(() => normalizeParams({ prompt: 'x', aspect_ratio: 'golden' }), /unknown aspect_ratio/);
  assert.throws(() => normalizeParams({ prompt: 'x', audio_pref: 9 }), /audio_pref/);
  assert.throws(() => normalizeParams({}), /prompt is required/);
  ok('rejects out-of-range variants, resolutions, aspects, audio_pref and empty prompts');
}

// 7. Response envelope parsing, including the )]}' sentinel and error rows.
{
  const text = ")]}'\n\n" +
    JSON.stringify([['wrb.fr', RPC.text, JSON.stringify({ a: 1 }), null, null, null, [8]]]) + '\n' +
    JSON.stringify([['di', 11]]) + '\n' +
    JSON.stringify([['af.httprm', 10, '6339505060543713464', 25]]);
  assert.deepEqual(firstPayload(text, RPC.text), { a: 1 });
  assert.equal(parseEnvelope(text).length, 1);
  const err = ")]}'\n\n" + JSON.stringify([['er', null, null, null, null, 401, null, null, null, 16], ['di', 11]]);
  assert.throws(() => firstPayload(err, RPC.text), /no YhhmEf envelope/);
  ok("batchexecute )]}' sentinel, wrb.fr rows and error rows");
}

// 8. Readers for submit / poll / listing / signed media URLs.
{
  const opId = 'AAAAAAAA-AAAA-4AAA-AAAA-AAAAAAAAAAAA';
  const projId = 'BBBBBBBB-BBBB-4BBB-BBBB-BBBBBBBBBBBB';
  const mediaId = 'CCCCCCCC-CCCC-4CCC-CCCC-CCCCCCCCCCCC';
  const submit = readVideoSubmit([null, null, null, [[opId, projId, mediaId, 1]]]);
  assert.equal(submit.records[0].operationId, opId);
  assert.equal(submit.records.length, 1);
  assert.deepEqual(readOperation([null, null, [[opId, projId, null, 'CAE']]]), { operationId: opId, projectId: projId, status: 'CAE', done: true, complaint: null });
  const listing = [null, [['asset-1', 'folder', null, ['title', 1, true, null, mediaId, opId, true], projId]]];
  assert.equal(findMediaIds(listing, [opId]).get(opId.toLowerCase()), mediaId);
  const url = `https://flow-content.google/video/${mediaId}?Expires=1&Signature=x`;
  assert.deepEqual(mediaUrls([null, [url]]), [{ mediaId, url }]);
  assert.deepEqual(publicErrors([null, ['PUBLIC_ERROR_UNUSUAL_ACTIVITY']]), ['PUBLIC_ERROR_UNUSUAL_ACTIVITY']);
  ok('submit / operation / project-listing / media-url / public-error readers');
}

// 8b. Live Flow build: completion sits in the listing detail, not record[3].
{
  const projectId = '02123e79-7896-4799-a036-1963f0d880a6';
  const sceneId = '8e801ba4-c844-4f8e-8558-4f57ba3b3a3d';
  const mediaId = 'd94aa6e3-7cb4-4ea5-a4ac-9c6f03bf8fd5';
  const detail = [[1793978277, 133765000], 'a red kite', null, null, null, 'poster', null, null, [3], 1, 'poster', null, null, 2234661];
  const poll = [null, 1043, [[mediaId, projectId, sceneId, null, null, detail, null, [[null, 636721]]]]];
  assert.equal(readOperation(poll).done, true, 'live poll must report done');
  assert.equal(readOperation(poll).complaint, null);
  const listing = [null,
    [[sceneId, null, null, ['Red paper kite', [1793978277, 0], null, null, mediaId, '1A813EC4-030E-4DEA-8C59-93749AAEA46B', [1793978280, 0]], projectId]],
    [[mediaId, projectId, sceneId, null, null, detail, null, [[mediaId]]]],
    [['achernar', 3, 'Achernar']]];
  assert.deepEqual(listingMediaIds(listing, 1793978270), [mediaId]);
  assert.deepEqual(listingMediaIds(listing, 1793978290), [], 'older generations must be ignored');
  assert.equal(findMediaIds(listing, ['1A813EC4-030E-4DEA-8C59-93749AAEA46B']).get('1a813ec4-030e-4dea-8c59-93749aaea46b'), mediaId);
  ok('live-build poll outcome [3] and timestamped project-listing media rows');
}

// 9. The read/write helper envelopes stay captcha-free except uploads.
{
  assert.ok(!createProjectEnvelope('t').includes(CAPTCHA_SLOT));
  assert.ok(!operationEnvelope('op').includes(CAPTCHA_SLOT));
  assert.ok(!projectMediaEnvelope('p').includes(CAPTCHA_SLOT));
  assert.ok(!mediaEnvelope('m').includes(CAPTCHA_SLOT));
  assert.ok(uploadEnvelope('p', 'AAAA').includes(CAPTCHA_SLOT));
  ok('only generation and upload envelopes carry the single-use captcha slot');
}

// 10. The MCP tool really exposes all of Flow's parameters (stdio handshake).
{
  const child = spawn(process.execPath, ['server.mjs', 'mcp'], { cwd: import.meta.dirname, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  let buf = '';
  const waiting = [];
  const queue = [];
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (waiting.length) waiting.shift()(msg); else queue.push(msg);
    }
  });
  const waitLine = () => new Promise((resolve, reject) => {
    if (queue.length) return resolve(queue.shift());
    const t = setTimeout(() => reject(new Error('MCP response timed out')), 10000);
    waiting.push((msg) => { clearTimeout(t); resolve(msg); });
  });
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    assert.equal((await waitLine()).result.serverInfo.name, 'magpie-video');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    const tools = (await waitLine()).result.tools;
    const g = tools.find((t) => t.name === 'generate_video');
    assert.ok(g, 'generate_video tool missing');
    const props = g.inputSchema.properties;
    for (const k of ['output_count', 'duration', 'seconds', 'resolution', 'aspect_ratio', 'size', 'model', 'seed', 'start_frame', 'end_frame', 'reference_images', 'video_media_id', 'audio_pref', 'project_id', 'path', 'wait_seconds', 'negative_prompt', 'mode', 'captcha_action', 'account'])
      assert.ok(props[k], `missing parameter ${k}`);
    assert.equal(props.output_count.maximum, 4);
    for (const name of ['list_accounts', 'credit_usage']) assert.ok(tools.find((t) => t.name === name), `missing tool ${name}`);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_models', arguments: {} } }) + '\n');
    const r = (await waitLine()).result;
    assert.deepEqual(JSON.parse(r.content[0].text).durations, DURATIONS);
    ok('stdio MCP handshake, all Flow parameters, account switching and credit tools');
  } finally { child.kill('SIGKILL'); }
}

// 11. The CREDITS read RPC captured live from Flow's own page.
{
  assert.equal(RPC.credits, 'nzlxg');
  assert.deepEqual(JSON.parse(creditsEnvelope()), [[['nzlxg', '[]', null, 'generic']]]);
  assert.ok(!creditsEnvelope().includes(CAPTCHA_SLOT), 'a balance read must not mint a captcha');
  const live = ")]}'\n\n" + JSON.stringify([
    ['wrb.fr', 'nzlxg', '[1006,1,2,2,null,1006,[1795957700,725058000]]', null, null, null, 'generic'],
    ['di', 190], ['af.httprm', 189, '7274525955991042572', 15],
  ]);
  const c = readCredits(firstPayload(live, RPC.credits));
  assert.equal(c.total, 1006);
  assert.equal(c.subscription, 1006);
  assert.equal(c.top_up, 0);
  assert.equal(c.service_tier, 1);
  assert.ok(c.refresh_at.startsWith('2026-'));
  ok('nzlxg credits read parses the live balance reply and needs no captcha');
  const person = ")]}'\n\n" + JSON.stringify([
    ['wrb.fr', 'o30O0e', JSON.stringify([[['me', 1, ['123456789012345678901', null, 1793483384618223, ['person@example.com']]]]]), null, null, null, 'generic'],
  ]);
  assert.deepEqual(readPerson(firstPayload(person, RPC.people)), { id: '123456789012345678901', email: 'person@example.com' });
  assert.ok(!peopleEnvelope().includes(CAPTCHA_SLOT));
  ok('o30O0e identifies the Google account so duplicate windows are counted once');
}

// 12. Every account gets its own Chromium port/profile so sessions never mix.
{
  const reg = loadAccounts();
  assert.ok(reg.accounts.length >= 1);
  assert.ok(reg.accounts.some((a) => a.id === reg.default));
  const a = { id: 'second', cookiesFile: '/tmp/second.json' };
  const c0 = accountConfig({ id: 'first', cookiesFile: '/tmp/first.json' }, 0);
  const c1 = accountConfig(a, 1);
  assert.equal(c0.debugPort, c1.debugPort - 1);
  assert.notEqual(c0.userDataDir, c1.userDataDir);
  assert.equal(c1.cookiesFile, a.cookiesFile);
  const live = reg.accounts.find((x) => x.debugPort);
  if (live) assert.equal(accountConfig(live, 0).debugPort, live.debugPort);
  ok('accounts are discovered, and each gets an isolated browser session');
}

// 13. The live HTrJv model catalog: families, prices, and future models.
{
  assert.equal(RPC.models, 'HTrJv');
  assert.deepEqual(JSON.parse(modelsEnvelope()), [[['HTrJv', '[]', null, 'generic']]]);
  assert.ok(!modelsEnvelope().includes(CAPTCHA_SLOT), 'a catalog read must not mint a captcha');
  const live = fs.readFileSync(new URL('./fixtures/HTrJv.json', import.meta.url), 'utf8');
  const c = parseModelCatalog(live);
  assert.equal(c.families.length, 8);
  assert.equal(c.families.reduce((n, f) => n + f.models.length, 0), 99);
  assert.deepEqual(modelAliases('Omni 1.1 Flash', 'abra'), ['omni-flash-1-1', 'omni-1-1-flash', 'abra']);
  assert.equal(c.families[0].preferred, 'omni-flash-1-1');
  const omni = c.families[0].models.find((m) => m.id === 'abra_t2v_4s');
  assert.equal(omni.credits['1'], 7); // exactly the 7 credits a live 4s clip cost
  assert.equal(omni.duration, 4);
  const selectable = familyModels(c).map((m) => m.id);
  for (const id of ['flow-video', 'omni-flash-1-1', 'veo-3-1-fast', 'veo-3-1-quality'])
    assert.ok(selectable.includes(id), `missing family ${id}`);
  assert.ok(familyModels(c).every((m) => m.kind === 'video'));
  ok('HTrJv live catalog parses 8 families / 99 keys with real credit prices');
}

// 14. A friendly family name picks the right wire key; a brand-new key survives.
{
  const c = parseModelCatalog(fs.readFileSync(new URL('./fixtures/HTrJv.json', import.meta.url), 'utf8'));
  const t2v = { mode: 'text', duration: 4, resolution: '720p' };
  assert.equal(resolveFamilyModel(c, 'omni-flash-1-1', t2v), 'abra_t2v_4s');
  assert.equal(resolveFamilyModel(c, 'flow-video/veo-3-1-fast'.split('/')[1], t2v), 'veo_3_1_t2v_fast_4s');
  assert.equal(resolveFamilyModel(c, 'veo-3-1-quality', { ...t2v, duration: 8 }), 'veo_3_1_t2v');
  const lite = c.families.find((f) => f.id === 'veo_3_1_lite');
  assert.equal(lite.models.find((m) => m.id === 'veo_3_1_t2v_lite_4s').credits['1'], null);
  assert.equal(lite.models.find((m) => m.id === 'veo_3_1_t2v_lite').credits['1'], 10);
  assert.equal(resolveFamilyModel(c, 'veo-3-1-lite', { ...t2v, tier: 1 }), 'veo_3_1_t2v_lite');
  assert.equal(resolveFamilyModel(c, 'omni-flash-1-2', t2v), 'omni-flash-1-2');
  assert.equal(resolveFamilyModel(c, 'abra_t2v_8s', t2v), 'abra_t2v_8s');
  const p = normalizeParams({ prompt: 'x', model: 'omni-flash-1-1', seconds: '4' });
  assert.equal(buildVideoRequest({ ...p, model: resolveFamilyModel(c, p.model, p) }, { projectId: 'p' }).model, 'abra_t2v_4s');
  ok('family aliases resolve to wire keys, and unknown/new keys pass through');
}

// 14b. Omni 1.2 Flash (macaron_cookie) — captured live from HTrJv. Its new
// 3..15s lengths must survive normalisation, not snap to the 1.1 four.
{
  const live = parseModelCatalog(fs.readFileSync(new URL('./fixtures/HTrJv-1.2.json', import.meta.url), 'utf8'));
  assert.equal(live.families.length, 9);
  assert.equal(live.families.reduce((n, f) => n + f.models.length, 0), 211);
  assert.deepEqual(modelAliases('Omni 1.2 Flash', 'macaron_cookie'),
    ['omni-flash-1-2', 'omni-1-2-flash', 'macaron-cookie']);
  const f = live.families.find((x) => x.id === 'macaron_cookie');
  assert.equal(f.preferred, 'omni-flash-1-2');
  assert.equal(f.models.length, 112);
  assert.deepEqual(DURATIONS, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.equal(f.models.find((m) => m.id === 'macaron_cookie_i2v_fl_8s').mode, 'first_last');
  assert.ok(familyModels(live).some((m) => m.id === 'omni-flash-1-2'));
  assert.ok(MODELS.some((m) => m.id === 'macaron_cookie_t2v_15s'), 'offline fallback needs 1.2 keys');
  for (const d of [3, 5, 9, 10]) {
    const p = normalizeParams({ prompt: 'x', model: 'omni-flash-1-2', duration: d });
    assert.equal(p.duration, d);
    assert.equal(resolveFamilyModel(live, p.model, { ...p, tier: 1 }), `macaron_cookie_t2v_${d}s`);
  }
  // Tier 1 has no 11..15s key, so it falls back to the nearest usable length
  // instead of asking Flow for a key that answers MODEL_ACCESS_DENIED.
  assert.equal(resolveFamilyModel(live, 'omni-flash-1-2',
    { mode: 'text', duration: 15, resolution: '720p', tier: 1 }), 'macaron_cookie_t2v_10s');
  assert.equal(resolveFamilyModel(live, 'omni-flash-1-2',
    { mode: 'first_last', duration: 8, resolution: '720p', tier: 1 }), 'macaron_cookie_i2v_fl_8s');
  // No explicit model: still the Omni 1.1 default, snapped to its four keys.
  assert.equal(resolveModel(normalizeParams({ prompt: 'x', duration: 15 })), 'abra_t2v_10s');
  ok('Omni 1.2 Flash: 112 live keys, 3..15s, first/last frames, tier fallback');
}

// 17. The running proxy uses node:http, not undici: fetch() pulls in llhttp-wasm
// and adds ~20 MB RSS, which breaks the 100 MB budget.
{
  const { request, cookieHeader, mergeSetCookies } = await import('./flowhttp.mjs');
  for (const f of ['server.mjs', 'flowhttp.mjs'])
    assert.ok(!/\bfetch\s*\(/.test(fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8')),
      `${f} must not load undici`);
  const jar = [
    { name: 'SID', value: 'a', domain: '.google.com', path: '/', expires: -1 },
    { name: 'X', value: 'b', domain: 'other.example', path: '/', expires: -1 },
  ];
  assert.equal(cookieHeader(jar, 'flow.google.com', '/'), 'SID=a');
  const merged = mergeSetCookies(jar, ['SIDCC=rotated; Domain=.google.com; Path=/; Secure; HttpOnly'], 'flow.google.com');
  assert.equal(merged.find((c) => c.name === 'SIDCC').value, 'rotated');
  const s = http.createServer((_q, res) => { res.setHeader('set-cookie', 'A=1'); res.end('pong'); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const r = await request(`http://127.0.0.1:${s.address().port}/x`);
  assert.equal(r.status, 200);
  assert.equal(r.text(), 'pong');
  assert.equal(r.headers.getSetCookie()[0], 'A=1');
  s.close();
  ok('node:http transport: no undici fetch, cookies scoped and rotated');
}

console.log(`\n${n} checks passed`);
