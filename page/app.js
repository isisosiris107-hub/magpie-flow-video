// The Flow page inside magpie's window.
//
// A plugin page is sandboxed (connect-src 'none') and may not touch the
// network, so this page only uses the two reads a page can be granted
// (usage:summary, providers:list) plus its own options. Flow's own credit
// balance lives behind the proxy, so the page points at the tools for that
// and asks for sign-ins through the same options channel.
(async () => {
  await magpie.ready;
  const $ = (id) => document.getElementById(id);
  const opts = (await magpie.options.get().catch(() => ({}))) || {};
  const setPill = (el, text, tone) => { el.textContent = text; el.dataset.tone = tone || ''; };
  const isFlow = (m) => /^(flow-video|flow)\//.test(m) || /^(abra_|veo_|omni_|macaron_)/.test(m);

  // --- is the proxy installed? -----------------------------------------
  let provider = null;
  try {
    provider = (await magpie.read('providers:list')).find((p) => p.id === 'flow-video') || null;
  } catch {}
  setPill($('proxy'), provider ? 'proxy running' : 'proxy not added', provider ? 'ok' : 'warn');
  $('accnote').textContent = provider
    ? 'Each Google account is one cookie jar. Signing in opens a normal Chrome window; nothing is read from a browser you did not open.'
    : 'This plugin adds its provider on first load. If it is still missing, reopen magpie, then come back to this page.';

  // --- what went through magpie in the last 30 days --------------------
  let mine = [];
  try {
    const s = await magpie.read('usage:summary', { period: '30d' });
    mine = s.models.filter((m) => isFlow(m.model));
    const calls = mine.reduce((n, m) => n + m.calls, 0);
    $('calls').textContent = String(calls);
    $('tok').textContent = mine.reduce((n, m) => n + m.output, 0).toLocaleString();
    $('models').textContent = mine.length ? String(mine.length) : '—';
    $('modelnote').textContent = mine.length
      ? `${mine.length} Flow model${mine.length === 1 ? '' : 's'} in the last 30 days.`
      : 'No Flow generation has gone through magpie yet.';
  } catch (e) {
    $('modelnote').textContent = `magpie's usage read is unavailable: ${e.message}`;
  }

  // --- models used ------------------------------------------------------
  const box = $('models');
  for (const m of mine.slice(0, 12)) {
    const row = document.createElement('div');
    row.className = 'item';
    const name = document.createElement('span');
    name.textContent = m.model.replace(/^[^/]*\//, '');
    const n = document.createElement('b');
    n.textContent = `${m.calls} call${m.calls === 1 ? '' : 's'}`;
    row.append(name, n);
    box.append(row);
  }
  if (!mine.length) $('models').hidden = true;

  // --- sign-in ----------------------------------------------------------
  // A page cannot start a process. It can set the plugin's options, and
  // magpie reloads the plugin when they change; the plugin starts one window
  // for a loginRequest id it has not acted on before.
  $('signin').onclick = async () => {
    const label = $('label').value.trim();
    const request = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, label: label || null };
    setPill($('proxy'), 'opening Chrome…', 'warn');
    $('loginmsg').textContent = 'A Chrome window is opening. Sign in to Google with the account that has Flow access, leave it open until it reaches flow.google.com, then reload this page.';
    try {
      await magpie.options.set({ ...opts, loginRequest: request });
    } catch (e) {
      setPill($('proxy'), 'sign-in blocked', 'warn');
      $('loginmsg').textContent = `Could not ask for a sign-in: ${e.message}`;
    }
  };
})().catch((e) => { document.body.textContent = `Google Flow panel: ${e.message}`; });
