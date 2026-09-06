#!/usr/bin/env python3
"""Install the pinned Linux browser with the fork's local theme overlays."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import time
import zipfile

VERSION = '148.0.7966.97'
PACKAGE_SHA256 = 'bfdda9be19ab0ec69602156a5c8aba3bd163351ca89539ecfda2761596b4dc7b'
AGENT_ID = 'bflpfmnmnokmjhmgnolecpppdbdophmk'


def backup(path, backup_root):
    if path.exists():
        target = backup_root / path.relative_to(Path.home())
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('package', type=Path)
    parser.add_argument('--set-default', action='store_true')
    args = parser.parse_args()
    digest = hashlib.file_digest(args.package.open('rb'), 'sha256').hexdigest()
    if digest != PACKAGE_SHA256:
        raise SystemExit('Package checksum does not match the pinned official download.')
    source = Path(__file__).resolve().parent
    home = Path.home()
    root = home / '.local/share/yatima-browser'
    release = root / 'releases' / VERSION
    binary = release / 'usr/lib/browseros/browseros'
    if not binary.exists():
        release.mkdir(parents=True, exist_ok=False)
        archive = subprocess.run(['bsdtar', '-xOf', str(args.package), 'data.tar.zst'], check=True, capture_output=True).stdout
        subprocess.run(['bsdtar', '-xf', '-', '-C', str(release)], input=archive, check=True)
    addons = root / 'addons'
    addons.mkdir(parents=True, exist_ok=True)
    for name in ('theme', 'start-page'):
        shutil.copytree(source / name, addons / name, dirs_exist_ok=True)
    crx = binary.parent / 'browseros_extensions' / f'{AGENT_ID}.crx'
    agent = addons / 'assistant'
    agent.mkdir(exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(crx.read_bytes())) as archive:
        for entry in archive.infolist():
            target = (agent / entry.filename).resolve()
            if not target.is_relative_to(agent.resolve()):
                raise SystemExit('Unsafe path in bundled extension.')
        archive.extractall(agent)
    manifest = json.loads((agent / 'manifest.json').read_text())
    if manifest.get('version') != '0.0.117.0' or not manifest.get('key'):
        raise SystemExit('Unexpected bundled Assistant identity.')
    styles = list((agent / 'assets').glob('app-*.css'))
    if len(styles) != 1:
        raise SystemExit('Expected exactly one Assistant application stylesheet.')
    with styles[0].open('a') as output:
        output.write('\n/* Yatima fork theme overlay */\n')
        output.write((source / 'theme/assistant.css').read_text())
    backups = root / 'backups' / time.strftime('%Y%m%dT%H%M%S')
    backups.mkdir(parents=True, mode=0o700)
    launcher = home / '.local/bin/yatima-browser'
    desktop = home / '.local/share/applications/yatima-browser.desktop'
    for path in (launcher, desktop, home / '.config/mimeapps.list'):
        backup(path, backups)
    profile = home / '.config/yatima-browser'
    profile.mkdir(parents=True, mode=0o700, exist_ok=True)
    default = profile / 'Default'
    default.mkdir(mode=0o700, exist_ok=True)
    preferences = default / 'Preferences'
    if not preferences.exists():
        # Chromium enum 3 is kVibrant; enum 2 is kNeutral.
        preferences.write_text(json.dumps({'browser': {'theme': {'color_scheme2': 2, 'user_color2': int('ffb7ff00', 16) - 2**32, 'color_variant2': 3}}, 'extensions': {'theme': {'id': 'user_color_theme_id'}}}))
        preferences.chmod(0o600)
    launcher.parent.mkdir(parents=True, exist_ok=True)
    command = [str(binary), f'--user-data-dir={profile}', '--class=yatima-browser', '--force-dark-mode',
               '--browseros-cdp-port=43082', '--browseros-proxy-port=43080', '--browseros-server-port=43083',
               '--load-extension=' + ','.join(str(addons / name) for name in ('assistant', 'start-page'))]
    native_launcher = root / 'launch-native'
    native_launcher.write_text('#!/bin/sh\n# Yatima Browser: dedicated profile; Chromium sandbox stays enabled.\n'
                        + 'if ! /usr/bin/systemctl is-active --quiet yatima-browser-network-guard.service; then\n'
                        + '  echo "Yatima Browser requires its local-control network guard." >&2\n  exit 1\nfi\n'
                        + 'exec ' + shlex.join(command) + ' -- "$@"\n')
    native_launcher.chmod(0o755)
    launcher.write_text('#!/bin/sh\n# Use the desktop user manager even from an agent with an isolated HOME.\n'
                       + f'export XDG_RUNTIME_DIR=/run/user/{os.getuid()}\n'
                       + f'export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{os.getuid()}/bus\n'
                       + 'exec /usr/bin/systemd-run --user --quiet --collect --property=Type=exec -- '
                       + shlex.quote(str(native_launcher)) + ' "$@"\n')
    launcher.chmod(0o755)
    browser_unit = home / '.config/systemd/user/yatima-browser.service'
    backup(browser_unit, backups)
    browser_unit.parent.mkdir(parents=True, exist_ok=True)
    browser_unit.write_text('[Unit]\nDescription=Yatima Browser for local harness agents\n'
                            '[Service]\nType=exec\nExecStart=' + str(native_launcher) + '\n'
                            'TimeoutStopSec=20\nKillMode=control-group\n')
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
    desktop.parent.mkdir(parents=True, exist_ok=True)
    # Desktop Exec has its own quoting grammar, distinct from shell quoting.
    desktop_exec = str(launcher).replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$')
    if any(char.isspace() for char in desktop_exec):
        desktop_exec = '"' + desktop_exec + '"'
    desktop.write_text('[Desktop Entry]\nVersion=1.0\nType=Application\nName=Yatima Browser\n'
                       'Comment=The Yatima-themed BrowserOS fork\n'
                       f'Exec={desktop_exec} %U\nTerminal=false\nCategories=Network;WebBrowser;\n'
                       f'Icon={addons / "start-page/icon.svg"}\nStartupWMClass=yatima-browser\n'
                       'MimeType=text/html;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;\n')
    subprocess.run(['update-desktop-database', str(desktop.parent)], check=True)
    if args.set_default:
        subprocess.run(['xdg-settings', 'set', 'default-web-browser', desktop.name], check=True)
        for mime in ('text/html', 'application/xhtml+xml', 'x-scheme-handler/http', 'x-scheme-handler/https'):
            subprocess.run(['xdg-mime', 'default', desktop.name, mime], check=True)
    receipt = {'version': VERSION, 'package_sha256': digest, 'upstream': 'https://github.com/browseros-ai/BrowserOS',
               'fork': 'https://github.com/ssynesthesiagit/yatima-browser', 'binary': str(binary),
               'launcher': str(launcher), 'profile': str(profile), 'backup': str(backups),
               'distribution': 'Official native binary with local fork theme and unpacked Assistant CSS overlay',
               'sandbox_disabled': False, 'default_requested': args.set_default}
    (root / 'INSTALLATION.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
