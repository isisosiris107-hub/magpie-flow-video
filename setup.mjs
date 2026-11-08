// setup.mjs — wire the proxy into magpie and register the magpie-video MCP.
// Idempotent; makes one .bak-flow-video backup per config file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const home = os.homedir();
const here = import.meta.dirname;
const mcpFile = path.join(home, '.pi/agent/mcp.json');
const providersFile = path.join(home, '.config/magpie/providers.json');
const settingsFile = path.join(home, '.config/magpie/settings.json');
const iconDir = path.join(home, '.config/magpie/icons');
// Streamable HTTP: one Node process serves both magpie and every MCP client.
// A stdio entry would spawn an extra ~70 MB Node child per connected agent.
const entry = { url: 'http://127.0.0.1:8787/mcp' };

// magpie shows a provider's own picture as "file:<sha16>.svg" and prunes
// anything unreferenced, so keep the file right next to providers.json.
const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#4285f4"/><stop offset=".55" stop-color="#9b72cb"/><stop offset="1" stop-color="#f6a5a0"/>
</linearGradient></defs>
<rect width="64" height="64" rx="16" fill="url(#g)"/>
<path d="M12 39c7-15 13 15 20 0s13-15 20 0" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>
<circle cx="47" cy="19" r="4" fill="#fff"/>
</svg>`;
const icon = `file:${crypto.createHash('sha256').update(mark).digest('hex').slice(0, 16)}.svg`;
fs.mkdirSync(iconDir, { recursive: true });
fs.writeFileSync(path.join(iconDir, icon.slice(5)), mark);

const provider = {
  id: 'flow-video', name: 'Google Flow', icon, baseAPI: 'chat',
  chat: 'http://127.0.0.1:8787/v1', responses: 'http://127.0.0.1:8787/v1',
  models: ['flow-video'],
  // New Flow families show up after the proxy refetches HTrJv; magpie re-reads /v1/models on this schedule.
  refreshEvery: '6h',
  // magpie's Usage page only asks a provider's balanceURL when it has a key.
  key: 'flow-video-local',
  balanceURL: 'http://127.0.0.1:8787/v1/balance',
  balanceMethod: 'GET',
  balancePath: 'Balance: credits_text; Used today: today_text; Used total: total_text; Accounts: accounts_text',
};

function patch(file, fn) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const before = JSON.stringify(d);
  fn(d);
  const after = JSON.stringify(d);
  if (before === after) { console.log(`unchanged  ${file}`); return; }
  const bak = `${file}.bak-flow-video`;
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  fs.writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
  console.log(`updated    ${file}  (backup ${bak})`);
}

patch(mcpFile, (d) => { d.mcpServers ??= {}; d.mcpServers['magpie-video'] = entry; });
patch(providersFile, (d) => {
  d.providers = (d.providers || []).filter((p) => p.id !== provider.id);
  d.providers.push(provider);
});
patch(settingsFile, (d) => {
  d.modelKinds ??= {};
  d.modelKinds['flow-video/flow-video'] = 'video';
});
console.log('\nStart the proxy on :8787 (the magpie plugin does this automatically); magpie reloads providers.json / settings.json on save.');
console.log('Then check the Usage page for the Flow Video balance card, and `npm run check` for the session.');
