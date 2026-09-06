# Yatima browser identity

This directory contains the bounded Yatima visual layer for the BrowserOS fork:

- `theme/manifest.json` is a permissionless Chromium theme using the Yatima
  palette for the frame, tabs, toolbar, bookmarks, and address bar.
- `theme/assistant.css` is the shared dark token sheet. The BrowserOS app imports
  it from `packages/browseros-agent/apps/app/styles/global.css`, so a native
  Assistant overlay can reuse the same source without rebuilding Chromium.
- `start-page/` is a permissionless Manifest V3 new-tab extension. It uses only
  local HTML, CSS, JavaScript, and inline SVG; it does not fetch data or load
  remote code or assets.

The palette is taken from the owner command-center source:

| Token | Value |
| --- | --- |
| Background | `#030705` |
| Panel | `#08110d` |
| Raised | `#0b1712` |
| Line | `#1d372d` |
| Text | `#e7f5ee` |
| Muted | `#86a496` |
| Lime | `#b7ff00` |
| Cyan | `#4df4d0` |
| Amber | `#ffc65c` |
| Red | `#ff677d` |

## Preview the start page

From the repository root, serve the static directory over ordinary HTTP:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory yatima/start-page
```

Open <http://127.0.0.1:4173/> in a browser or the in-app browser. The preview
uses no extension APIs; loading the directory as an unpacked extension at
`chrome://extensions` enables the `chrome://newtab` override.

## Install locally

The installer verifies the SHA-256 of the official Linux package before
extracting it into the user's data directory. No Chromium sandbox is disabled.

```sh
pkexec python3 yatima/install-network-guard.py
python3 yatima/install-linux.py /path/to/BrowserOS.deb --set-default
```

The pinned package comes from `https://files.browseros.com/download/BrowserOS.deb`:
version `148.0.7966.97`, SHA-256
`bfdda9be19ab0ec69602156a5c8aba3bd163351ca89539ecfda2761596b4dc7b`.
The moving upstream URL may later deliver a newer package; the installer will
reject it until the pin is reviewed and updated.

The installer seeds a dark, vibrant Chromium color preference for new profiles.
The pinned native build did not visibly apply the frame palette through these
preferences or command-line theme loading. The start page and Assistant use
the CSS palette above independently.

To activate the exact **Yatima Neon** native toolbar and tab palette, open
`chrome://extensions` in Yatima Browser, enable **Developer mode**, select
**Load unpacked**, and choose:

```text
~/.local/share/yatima-browser/addons/theme
```

This is a permissionless theme containing color configuration, with no
JavaScript or host permissions. Confirm the native toolbar has changed before
treating frame activation as complete. The theme's name is Yatima Neon; the
application launcher remains Yatima Browser.

The Assistant is extracted from the bundled signed archive into a separate
unpacked extension; only its stylesheet is overlaid. Its public extension key
is retained so BrowserOS can still locate its Assistant. The original archive
and vendor binaries are preserved. This is a themed upstream binary deployment,
not a claim that Chromium was rebuilt from the fork.

## Local network boundary

The native control listeners use fixed ports: HTTP proxy `43080`, sidecar
`43083`, and loopback CDP `43082`. The shipped HTTPS proxy uses `9001`.
`install-network-guard.py` installs a separate nftables input chain that rejects
traffic to those ports from non-loopback interfaces, including Tailscale. It
also covers the upstream default ports. Existing UFW rules remain in place.
The launcher refuses to start when the guard service is inactive and places
external arguments after `--` so URLs cannot override control-port flags.

The guard is enabled at boot. Do not enable unrestricted remote MCP access or
forward these ports on a router. Phone access would require a separately
authenticated private tunnel; it is not enabled by this installation.

Backups and an installation receipt are written under
`~/.local/share/yatima-browser/`. The browser profile is
`~/.config/yatima-browser/`; no existing browser credentials or profile are
imported. Restore a previous desktop default using `xdg-settings set
default-web-browser <previous-desktop-file>`.

The upstream BrowserOS application and its AGPL license remain authoritative;
these files add a local visual layer without changing its extension permissions
or upstream ownership.

## Connect the Yatima harnesses

This setup targets the existing per-user Yatima Prime and DeepSeek deployments.
It preserves their other providers, credentials, and sessions. Node.js must be
on PATH. After installing the browser and network guard above:

```sh
python3 yatima/configure-services.py
node yatima/configure-prime.mjs
uv pip install --python "$HOME/.local/share/yatima-prime-development/home/.prime/agent/kernel-venv/bin/python" -r yatima/prime-skill/requirements.txt
systemctl --user enable --now yatima-browser-bridge.service
```

DeepSeek needs the harness launcher supporting `YATIMA_BROWSER_MCP_PATCH`.
The setup writes an owner-only overlay and service drop-in; restart
`yatima-harness-console.service` when its sessions are idle to activate it.
Prime's launcher must forward the optional `BROWSER` executable through its
sanitized environment; restart `yatima-prime-host.service` when idle after
installing that launcher change and its generated browser drop-in.
Prime receives a `yatima-browser` skill, a local MCP server entry, and a local
credential through its native settings/auth locks. Start a fresh Prime session
to load the skill. A rebuilt Prime Python kernel may need the pinned MCP
dependency reinstalled using the command above.

The bridge binds only `127.0.0.1:43180`, requires a private bearer credential,
rejects browser Origin headers, and starts the native browser on demand. It
forwards MCP to the local native server; it never forwards the bridge credential
upstream. Keep its token and generated harness configuration out of Git.

DeepSeek exposes `mcp__yatima_browser__*` tools; Prime uses `McpIntegration` in
its Python kernel as described in the installed skill. Their default-browser
instructions prefer this separate browser. This does not add a Command Center
mode or remove another browser requested explicitly by the owner.
