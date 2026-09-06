#!/usr/bin/env node
// Configure the local browser using Prime's own credential/settings locks.
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const home = os.homedir();
const state = path.join(home, '.local/share/yatima-prime-development');
const config = path.join(state, 'config');
const core = path.join(state, 'install/lib/node_modules/prime-agent/dist/core');
const browser = path.join(home, '.local/share/yatima-browser');
const token = (await readFile(path.join(browser, 'bridge.token'), 'utf8')).trim();
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Expected the locally generated browser bridge token.');
const { AuthStorage } = await import(pathToFileURL(path.join(core, 'auth-storage.js')).href);
const { FileSettingsStorage } = await import(pathToFileURL(path.join(core, 'settings-manager.js')).href);
const backup = path.join(browser, 'backups', `prime-${Date.now()}`);
await mkdir(backup, { recursive: true, mode: 0o700 });
for (const name of ['settings.json', 'auth.json']) {
  await copyFile(path.join(config, name), path.join(backup, name));
  await chmod(path.join(backup, name), 0o600);
}
const auth = AuthStorage.create(path.join(config, 'auth.json'));
auth.set('mcp:yatima_browser', { type: 'api_key', key: token });
new FileSettingsStorage(state, config).withLock('global', (current) => {
  const settings = JSON.parse(current ?? '{}');
  settings.mcpServers ??= {};
  settings.mcpServers.yatima_browser = { type: 'http', url: 'http://127.0.0.1:43180/mcp' };
  return JSON.stringify(settings, null, 2) + '\n';
});
const skill = path.join(config, 'skills/yatima-browser');
await mkdir(skill, { recursive: true, mode: 0o700 });
const source = path.dirname(fileURLToPath(import.meta.url));
await copyFile(path.join(source, 'prime-skill/SKILL.md'), path.join(skill, 'SKILL.md'));
const instructions = path.join(config, 'AGENTS.md');
let text = '';
try { text = await readFile(instructions, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const marker = '<!-- YATIMA_BROWSER_DEFAULT -->';
if (!text.includes(marker)) {
  if (text) await writeFile(path.join(backup, 'AGENTS.md'), text, { mode: 0o600 });
  await writeFile(instructions, text + '\n' + marker + '\nUse the yatima-browser skill by default for external browser work. It opens and controls the separate Yatima Browser through the local authenticated bridge. Honor an explicit user request for another browser. Keep the browser-control ports local.\n', { mode: 0o600 });
}
console.log('Prime local MCP registration and browser skill configured; other settings and credentials preserved.');
console.log(`Backup: ${backup}`);
