// The panel at the end of magpie's Usage page: how much of the Flow traffic
// went through magpie. The credit balance itself is the provider's card above,
// read from the proxy's /v1/balance.
(async () => {
  await magpie.ready;
  const $ = (id) => document.getElementById(id);
  const isFlow = (m) => /^(flow-video|flow)\//.test(m) || /^(abra_|veo_|omni_|macaron_)/.test(m);
  try {
    const s = await magpie.read('usage:summary', { period: '7d' });
    const mine = s.models.filter((m) => isFlow(m.model));
    const calls = mine.reduce((n, m) => n + m.calls, 0);
    $('calls').textContent = calls ? `${calls} call${calls === 1 ? '' : 's'}` : 'none';
    $('models').textContent = mine.length ? String(mine.length) : '—';
    $('hint').textContent = calls
      ? 'Credits spent per clip are in the tool result (`credits_used`) and in the proxy’s /v1/usage ledger.'
      : 'Generate a clip with the Google Flow tools and it shows up here.';
  } catch (e) {
    $('hint').textContent = `magpie's usage read is unavailable: ${e.message}`;
  }
})().catch((e) => { document.body.textContent = e.message; });
