from __future__ import annotations

import json
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import sys

sys.path.insert(0, str(Path(__file__).parent))
from assistant_onboarding_patch import (  # noqa: E402
    APP_SCRIPT,
    BOOTSTRAP_SCRIPT,
    INSTALL_HANDLER,
    PATCHED_HANDLER,
    PatchError,
    patch_assistant_bundle,
    patch_assistant_background,
)

_INSTALLER_SPEC = importlib.util.spec_from_file_location(
    "yatima_install_linux", Path(__file__).with_name("install-linux.py")
)
assert _INSTALLER_SPEC and _INSTALLER_SPEC.loader
_INSTALLER = importlib.util.module_from_spec(_INSTALLER_SPEC)
_INSTALLER_SPEC.loader.exec_module(_INSTALLER)


SYNTHETIC_BUNDLE = """const $e={defineItem:(_name,_options)=>({getValue:async()=>{if(globalThis.storageFailure)throw new Error("storage");return globalThis.onboardingCompleted}})};
$e.defineItem("local:onboardingCompleted",{fallback:!1});
const _4=async()=>{globalThis.updateCalls=(globalThis.updateCalls||0)+1};
const PT=async()=>{globalThis.profileCalls=(globalThis.profileCalls||0)+1};
const chrome={runtime:{OnInstalledReason:{INSTALL:"install",UPDATE:"update"},getURL:value=>"chrome-extension://test/"+value,onInstalled:{addListener:handler=>{globalThis.handler=handler}}},tabs:{create:async details=>{globalThis.tabs.push(details)}}};
""" + INSTALL_HANDLER + ";"

MANIFEST = {"version": "0.0.117.0", "key": "test-extension-key"}
APP_HTML = f'''<!doctype html>
<html><head><script type="module" crossorigin src="/chunks/app-DJAEj3Y2.js"></script></head>
<body><div id="root"></div></body></html>
'''


class AssistantOnboardingPatchTests(unittest.TestCase):
    def write_fixture(self, directory: Path, source: str = SYNTHETIC_BUNDLE) -> tuple[Path, Path]:
        background = directory / "background.js"
        manifest = directory / "manifest.json"
        background.write_text(source, encoding="utf-8")
        manifest.write_text(json.dumps(MANIFEST), encoding="utf-8")
        os.chmod(background, 0o640)
        return background, manifest

    def test_transformed_handler_behavior(self):
        with tempfile.TemporaryDirectory() as temporary:
            background, manifest = self.write_fixture(Path(temporary))
            self.assertTrue(patch_assistant_background(background, manifest))
            transformed = background.read_text(encoding="utf-8")
            self.assertIn(PATCHED_HANDLER, transformed)
            self.assertNotIn(INSTALL_HANDLER, transformed)
            self.assertEqual(background.stat().st_mode & 0o777, 0o640)

            harness = f"""
{transformed}
async function exercise(value, reason, failure) {{
  globalThis.onboardingCompleted = value;
  globalThis.storageFailure = failure;
  globalThis.tabs = [];
  globalThis.updateCalls = 0;
  globalThis.profileCalls = 0;
  await globalThis.handler({{reason}});
  return {{
    tabs: globalThis.tabs.length,
    url: globalThis.tabs[0]?.url || null,
    updates: globalThis.updateCalls,
    profiles: globalThis.profileCalls
  }};
}}
const results = [];
results.push(await exercise(true, "install", false));
results.push(await exercise(false, "install", false));
results.push(await exercise(false, "install", true));
results.push(await exercise(false, "update", false));
console.log(JSON.stringify(results));
"""
            result = subprocess.run(
                ["node", "--input-type=module", "-e", harness],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                json.loads(result.stdout),
                [
                    {"tabs": 0, "url": None, "updates": 0, "profiles": 0},
                    {
                        "tabs": 1,
                        "url": "chrome-extension://test/app.html#/onboarding",
                        "updates": 0,
                        "profiles": 0,
                    },
                    {"tabs": 0, "url": None, "updates": 0, "profiles": 0},
                    {"tabs": 0, "url": None, "updates": 1, "profiles": 1},
                ],
            )

    def test_idempotence_and_unexpected_bundle_rejection(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            background, manifest = self.write_fixture(directory)
            self.assertTrue(patch_assistant_background(background, manifest))
            patched_bytes = background.read_bytes()
            self.assertFalse(patch_assistant_background(background, manifest))
            self.assertEqual(background.read_bytes(), patched_bytes)

            unexpected, unexpected_manifest = self.write_fixture(
                directory, SYNTHETIC_BUNDLE.replace(INSTALL_HANDLER, "unexpected-handler")
            )
            original = unexpected.read_bytes()
            with self.assertRaises(PatchError):
                patch_assistant_background(unexpected, unexpected_manifest)
            self.assertEqual(unexpected.read_bytes(), original)

            wrong_version, wrong_manifest = self.write_fixture(directory)
            wrong_manifest.write_text(
                json.dumps({"version": "0.0.116.0", "key": MANIFEST["key"]}),
                encoding="utf-8",
            )
            original = wrong_version.read_bytes()
            with self.assertRaises(PatchError):
                patch_assistant_background(wrong_version, wrong_manifest)
            self.assertEqual(wrong_version.read_bytes(), original)

    def test_app_entry_patch_is_atomic_and_idempotent(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            background, manifest = self.write_fixture(directory)
            app = directory / "app.html"
            app.write_text(APP_HTML, encoding="utf-8")
            os.chmod(app, 0o640)

            self.assertEqual(patch_assistant_bundle(background, app, manifest), (True, True))
            self.assertIn(BOOTSTRAP_SCRIPT, app.read_text(encoding="utf-8"))
            self.assertNotIn(APP_SCRIPT, app.read_text(encoding="utf-8"))
            background_bytes = background.read_bytes()
            app_bytes = app.read_bytes()
            self.assertEqual(patch_assistant_bundle(background, app, manifest), (False, False))
            self.assertEqual(background.read_bytes(), background_bytes)
            self.assertEqual(app.read_bytes(), app_bytes)
            self.assertEqual(app.stat().st_mode & 0o777, 0o640)

    def test_unexpected_app_rejects_without_partial_background_edit(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            background, manifest = self.write_fixture(directory)
            app = directory / "app.html"
            app.write_text(APP_HTML.replace(APP_SCRIPT, "unexpected-script"), encoding="utf-8")
            original_background = background.read_bytes()
            original_app = app.read_bytes()
            with self.assertRaises(PatchError):
                patch_assistant_bundle(background, app, manifest)
            self.assertEqual(background.read_bytes(), original_background)
            self.assertEqual(app.read_bytes(), original_app)

    def test_installer_stages_bootstrap_only_after_bundle_validation(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source = directory / "source"
            agent = directory / "agent"
            source.mkdir()
            agent.mkdir()
            bootstrap_source = source / "assistant_onboarding_bootstrap.mjs"
            bootstrap_source.write_text("new bootstrap", encoding="utf-8")
            background, manifest = self.write_fixture(agent)
            app = agent / "app.html"
            app.write_text(APP_HTML.replace(APP_SCRIPT, "unexpected-script"), encoding="utf-8")
            bootstrap = agent / "yatima-onboarding-bootstrap.js"
            bootstrap.write_text("existing bootstrap", encoding="utf-8")
            original_background = background.read_bytes()

            with self.assertRaises(SystemExit):
                _INSTALLER.prepare_assistant_bundle(source, agent)
            self.assertEqual(bootstrap.read_text(encoding="utf-8"), "existing bootstrap")
            self.assertEqual(background.read_bytes(), original_background)

            bootstrap.unlink()
            with self.assertRaises(SystemExit):
                _INSTALLER.prepare_assistant_bundle(source, agent)
            self.assertFalse(bootstrap.exists())

    def test_page_bootstrap_routes_before_app_import(self):
        module_uri = Path(__file__).with_name("assistant_onboarding_bootstrap.mjs").resolve().as_uri()
        harness = f"""
const {{ start }} = await import({json.dumps(module_uri)});
async function exercise(storageValue, route, failure, historyFailure = false) {{
  const replaced = [];
  let loads = 0;
  await start({{
    storage: {{get: async () => {{ if (failure) throw new Error("storage"); return {{onboardingCompleted: storageValue}}; }}}},
    location: {{hash: route.hash || "", pathname: route.pathname || "/app.html", replace: () => {{throw new Error("full navigation prohibited");}}}},
    history: {{replaceState: (_state, _title, url) => {{if (historyFailure) throw new Error("history"); replaced.push(url);}}}},
    loadApp: async () => {{ loads += 1; }}
  }});
  return {{loads, replaced}};
}}
console.log(JSON.stringify([
  await exercise(true, {{hash: "#/onboarding"}}, false),
  await exercise(true, {{hash: "#/home"}}, false),
  await exercise(true, {{hash: "#/settings"}}, false),
  await exercise(false, {{hash: "#/onboarding"}}, false),
  await exercise(false, {{hash: "#/onboarding"}}, true),
  await exercise(true, {{pathname: "/onboarding/"}}, false),
  await exercise(true, {{hash: "#/onboarding"}}, false, true),
  await exercise(true, {{hash: "#/onboarding/steps/1"}}, false)
]));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", harness],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            [
                {"loads": 1, "replaced": ["#/home"]},
                {"loads": 1, "replaced": []},
                {"loads": 1, "replaced": []},
                {"loads": 1, "replaced": []},
                {"loads": 1, "replaced": []},
                {"loads": 1, "replaced": ["#/home"]},
                {"loads": 1, "replaced": []},
                {"loads": 1, "replaced": []},
            ],
        )

    def test_completed_startup_tab_cleanup_is_scoped(self):
        module_uri = Path(__file__).with_name("assistant_onboarding_bootstrap.mjs").resolve().as_uri()
        harness = """
const { start } = await import(MODULE_URI);
async function exercise(done, hash, sibling, removalFails = false, navigated = false) {
  const removed = []; let loads = 0; let home = 0;
  await start({storage: {get: async () => ({onboardingCompleted: done})},
    location: {hash, pathname: '/app.html'},
    history: {replaceState: () => {home++;}},
    tabs: {getCurrent: async () => ({id: 7, windowId: 3}),
      get: async id => ({id, windowId: 3, url: navigated ? 'https://example.com/' : 'chrome-extension://test/app.html#/onboarding'}),
      query: async q => {if(q.windowId !== 3) throw Error('wrong window');
        return [{id: 7, url: 'chrome-extension://test/app.html#/onboarding'}, ...sibling];},
      remove: async id => {if(removalFails) throw Error('remove'); removed.push(id);}},
    loadApp: async () => {loads++;}});
  return {removed, loads, home};
}
const web = [{id: 8, url: 'https://example.com/'}];
console.log(JSON.stringify([
 await exercise(true, '#/onboarding', web),
 await exercise(false, '#/onboarding', web),
 await exercise(true, '#/home', web),
 await exercise(true, '#/onboarding', []),
 await exercise(true, '#/onboarding', [{id: 8, url: 'chrome://browseros/onboarding'}]),
 await exercise(true, '#/onboarding', web, true),
 await exercise(true, '#/onboarding/steps/1', web),
 await exercise(true, '#/onboarding', [{id: 8, url: 'chrome-extension://test/app.html#/onboarding/steps/1'}]),
 await exercise(true, '#/onboarding', web, false, true)
]));
""".replace("MODULE_URI", json.dumps(module_uri))
        result = subprocess.run(["node", "--input-type=module", "-e", harness], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [
            {"removed": [7], "loads": 0, "home": 0},
            {"removed": [], "loads": 1, "home": 0},
            {"removed": [], "loads": 1, "home": 0},
            {"removed": [], "loads": 1, "home": 1},
            {"removed": [], "loads": 1, "home": 1},
            {"removed": [], "loads": 1, "home": 1},
            {"removed": [], "loads": 1, "home": 0},
            {"removed": [], "loads": 1, "home": 1},
            {"removed": [], "loads": 1, "home": 1},
        ])

    def test_launcher_flags_are_generated_once(self):
        installer = Path(__file__).with_name("install-linux.py").read_text(encoding="utf-8")
        self.assertEqual(installer.count("'--no-first-run'"), 1)
        self.assertEqual(installer.count("'--restore-last-session'"), 1)

    def test_installed_launcher_flags_are_deployed_once(self):
        launcher = Path.home() / ".local/share/yatima-browser/launch-native"
        if not launcher.is_file():
            self.skipTest("Yatima Browser is not installed on this host")
        launcher_source = launcher.read_text(encoding="utf-8")
        self.assertEqual(launcher_source.count("--no-first-run"), 1)
        self.assertEqual(launcher_source.count("--restore-last-session"), 1)
        subprocess.run(["sh", "-n", str(launcher)], check=True)


if __name__ == "__main__":
    unittest.main()
