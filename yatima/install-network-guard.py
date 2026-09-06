#!/usr/bin/env python3
"""Install the host firewall boundary for Yatima Browser's local control API."""
import os
from pathlib import Path
import shutil
import subprocess
import time

RULES = '''destroy table inet yatima_browser
table inet yatima_browser {
  chain local_control_only {
    type filter hook input priority -20; policy accept;
    iifname != "lo" tcp dport { 9000, 9001, 9200, 43080, 43081, 43082, 43083 } counter reject with tcp reset comment "Yatima browser control is local only"
  }
}
'''
SERVICE = '''[Unit]
Description=Keep Yatima Browser control ports local to this computer
Before=network-pre.target
Wants=network-pre.target
After=local-fs.target
DefaultDependencies=no

[Service]
Type=oneshot
ExecStart=/usr/bin/nft -f /etc/nftables.d/yatima-browser.nft
ExecReload=/usr/bin/nft -f /etc/nftables.d/yatima-browser.nft
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
'''


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run with administrator authentication: pkexec python3 ' + __file__)
    rules = Path('/etc/nftables.d/yatima-browser.nft')
    unit = Path('/etc/systemd/system/yatima-browser-network-guard.service')
    for path in (rules, unit):
        if path.exists():
            shutil.copy2(path, path.with_name(path.name + '.backup-' + time.strftime('%Y%m%dT%H%M%S')))
        path.parent.mkdir(parents=True, exist_ok=True)
    rules.write_text(RULES)
    rules.chmod(0o644)
    subprocess.run(['/usr/bin/nft', '--check', '-f', str(rules)], check=True)
    unit.write_text(SERVICE)
    unit.chmod(0o644)
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'enable', 'yatima-browser-network-guard.service'], check=True)
    subprocess.run(['systemctl', 'restart', 'yatima-browser-network-guard.service'], check=True)
    subprocess.run(['/usr/bin/nft', 'list', 'table', 'inet', 'yatima_browser'], check=True)


if __name__ == '__main__':
    main()
