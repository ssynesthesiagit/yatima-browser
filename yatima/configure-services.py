#!/usr/bin/env python3
"""Configure the authenticated local bridge and DeepSeek's optional overlay."""
from pathlib import Path
import os
import secrets
import shutil
import stat
import subprocess
import time

home = Path.home()
source = Path(__file__).resolve().parent
root = home / '.local/share/yatima-browser'
backup = root / 'backups' / ('services-' + time.strftime('%Y%m%dT%H%M%S'))
backup.mkdir(parents=True, mode=0o700)


def save(path, text):
    if path.exists():
        target = backup / path.relative_to(home)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        target.chmod(0o600)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(0o600)


token_path = root / 'bridge.token'
if not token_path.exists():
    fd = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(secrets.token_hex(32) + '\n')
if token_path.is_symlink() or not stat.S_ISREG(token_path.stat().st_mode) or token_path.stat().st_uid != os.getuid() or token_path.stat().st_mode & 0o077:
    raise SystemExit('Bridge token must be an owner-only regular file.')
token = token_path.read_text().strip()
if len(token) != 64 or any(c not in '0123456789abcdef' for c in token):
    raise SystemExit('Unexpected bridge token format.')

bridge_dir = root / 'bridge'
bridge_dir.mkdir(exist_ok=True)
shutil.copy2(source / 'bridge/bridge.mjs', bridge_dir / 'bridge.mjs')
node = shutil.which('node')
if not node:
    raise SystemExit('Node.js must be installed before configuring the local bridge.')
node = str(Path(node).resolve())
node_exec = '"' + node.replace('%', '%%').replace('\\', '\\\\').replace('"', '\\"') + '"'
save(home / '.config/systemd/user/yatima-browser-bridge.service', '''[Unit]
Description=Authenticated local browser bridge for Yatima harnesses
After=network.target

[Service]
Type=exec
ExecStart=''' + node_exec + ''' %h/.local/share/yatima-browser/bridge/bridge.mjs
Environment=YATIMA_BROWSER_BRIDGE_TOKEN_FILE=%h/.local/share/yatima-browser/bridge.token
UMask=0077
Restart=on-failure
RestartSec=2
TimeoutStopSec=10

[Install]
WantedBy=default.target
''')
patch = home / '.config/yatima-harness-console/browseros.patch.yml'
save(patch, '''# Local private configuration. Never publish this credential.
- insert:
    - id: yatima-browser
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: yatima_browser
        transport: streamable-http
        url: http://127.0.0.1:43180/mcp
        headers:
          Authorization: "Bearer ''' + token + '''"
        failOnStartupError: false
        toolCallTimeoutMs: 120000
        reconnect:
          enabled: true
          initialDelayMs: 1000
          maxDelayMs: 10000
          maxAttempts: 5
''')
save(home / '.config/systemd/user/yatima-harness-console.service.d/browser.conf',
     '[Service]\nEnvironment=YATIMA_BROWSER_MCP_PATCH=' + str(patch) + '\n'
     'Environment=BROWSER=' + str(home / '.local/bin/yatima-browser') + '\n')
save(home / '.config/systemd/user/yatima-prime-host.service.d/browser.conf',
     '[Service]\nEnvironment=BROWSER=' + str(home / '.local/bin/yatima-browser') + '\n')

preset = home / '.local/share/yatima-harness-console/.agent-presets/yatima/agent.cordis.yml'
if preset.exists():
    text = preset.read_text()
    instruction = 'External browsing: use the mcp__yatima_browser__ tools by default to open and operate the separate Yatima Browser. Respect an explicit user choice of another browser and normal action approvals; do not expose browser-control ports.'
    if instruction not in text:
        anchor = '    text: >-\n'
        if anchor not in text:
            raise SystemExit('Unexpected Yatima persona format; preserved preset without editing.')
        save(preset, text.replace(anchor, anchor + '      ' + instruction + '\n', 1))

subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
print('Bridge unit, private DeepSeek overlay, and default-browser instruction configured.')
print('Start the bridge after verification; activate the DeepSeek overlay with the updated harness launcher.')
print('Backups: ' + str(backup))
