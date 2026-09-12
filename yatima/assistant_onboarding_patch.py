"""Fail-closed compatibility patch for the pinned Assistant bundle."""

from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import tempfile


EXPECTED_VERSION = "0.0.117.0"
STORAGE_DEFINITION = '$e.defineItem("local:onboardingCompleted",{fallback:!1});'
STORAGE_BINDING = (
    'const yatimaOnboardingCompleted=$e.defineItem('
    '"local:onboardingCompleted",{fallback:!1});'
)
INSTALL_HANDLER = (
    'chrome.runtime.onInstalled.addListener(e=>{'
    'e.reason===chrome.runtime.OnInstalledReason.INSTALL&&'
    'chrome.tabs.create({url:chrome.runtime.getURL("app.html#/onboarding")}),'
    'e.reason===chrome.runtime.OnInstalledReason.UPDATE&&'
    '(_4().catch(()=>null),PT().catch(()=>null))})'
)
PATCHED_HANDLER = (
    'chrome.runtime.onInstalled.addListener(async e=>{'
    'if(e.reason===chrome.runtime.OnInstalledReason.INSTALL){'
    'try{const t=await yatimaOnboardingCompleted.getValue();'
    't===!1&&await chrome.tabs.create({'
    'url:chrome.runtime.getURL("app.html#/onboarding")})'
    '}catch{}}else e.reason===chrome.runtime.OnInstalledReason.UPDATE&&'
    '(_4().catch(()=>null),PT().catch(()=>null))})'
)
APP_SCRIPT = '<script type="module" crossorigin src="/chunks/app-DJAEj3Y2.js"></script>'
BOOTSTRAP_SCRIPT = (
    '<script type="module" crossorigin src="/yatima-onboarding-bootstrap.js"></script>'
)
LEGACY_BOOTSTRAP_SCRIPT = (
    '<script type="module" crossorigin src="/yatima-onboarding-bootstrap.mjs"></script>'
)


class PatchError(RuntimeError):
    """The extracted bundle did not match the pinned compatibility shape."""


def _count(source: str, fragment: str) -> int:
    return source.count(fragment)


def _validate_manifest(manifest_path: Path) -> None:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as exc:
        raise PatchError(f"could not read Assistant manifest: {exc}") from exc
    if manifest.get("version") != EXPECTED_VERSION or not manifest.get("key"):
        raise PatchError(f"unexpected Assistant identity in {manifest_path}")


def _transform(source: str) -> str | None:
    binding_count = _count(source, "const yatimaOnboardingCompleted=")
    patched_storage_count = _count(source, STORAGE_BINDING)
    patched_handler_count = _count(source, PATCHED_HANDLER)
    unbound_storage_count = _count(source.replace(STORAGE_BINDING, "", 1), STORAGE_DEFINITION)
    if patched_storage_count or patched_handler_count or binding_count:
        if (
            patched_storage_count == 1
            and patched_handler_count == 1
            and binding_count == 1
            and unbound_storage_count == 0
            and _count(source, INSTALL_HANDLER) == 0
        ):
            return None
        raise PatchError("Assistant bundle contains a partial or conflicting onboarding patch")
    if _count(source, STORAGE_DEFINITION) != 1:
        raise PatchError("expected one onboarding storage definition")
    if _count(source, INSTALL_HANDLER) != 1:
        raise PatchError("expected one exact onboarding install handler")
    source = source.replace(STORAGE_DEFINITION, STORAGE_BINDING, 1)
    return source.replace(INSTALL_HANDLER, PATCHED_HANDLER, 1)


def _transform_app(source: str) -> str | None:
    bootstrap_count = _count(source, BOOTSTRAP_SCRIPT)
    app_count = _count(source, APP_SCRIPT)
    legacy_count = _count(source, LEGACY_BOOTSTRAP_SCRIPT)
    if legacy_count:
        if legacy_count == 1 and bootstrap_count == 0 and app_count == 0:
            return source.replace(LEGACY_BOOTSTRAP_SCRIPT, BOOTSTRAP_SCRIPT, 1)
        raise PatchError("Assistant app entry contains conflicting bootstrap scripts")
    if bootstrap_count or app_count > 1:
        if bootstrap_count == 1 and app_count == 0:
            return None
        raise PatchError("Assistant app entry contains a partial or conflicting bootstrap patch")
    if app_count != 1:
        raise PatchError("expected one exact Assistant app script tag")
    return source.replace(APP_SCRIPT, BOOTSTRAP_SCRIPT, 1)


def _atomic_write(path: Path, source: str, mode: int) -> None:
    temporary_path = None
    temporary_fd = None
    try:
        temporary_fd, temporary_path = tempfile.mkstemp(
            prefix=f".{path.name}.",
            dir=path.parent,
        )
        os.fchmod(temporary_fd, stat.S_IMODE(mode))
        with os.fdopen(temporary_fd, "w", encoding="utf-8", newline="") as output:
            temporary_fd = None
            output.write(source)
        os.replace(temporary_path, path)
        temporary_path = None
    except (OSError, UnicodeError) as exc:
        raise PatchError(f"could not atomically write {path}: {exc}") from exc
    finally:
        if temporary_fd is not None:
            os.close(temporary_fd)
        if temporary_path is not None:
            try:
                os.unlink(temporary_path)
            except OSError:
                pass


def patch_assistant_background(
    background_path: Path,
    manifest_path: Path | None = None,
) -> bool:
    """Patch one validated pinned bundle; return False when already patched."""
    background_path = Path(background_path)
    manifest_path = manifest_path or background_path.with_name("manifest.json")
    _validate_manifest(Path(manifest_path))
    if background_path.is_symlink() or not background_path.is_file():
        raise PatchError(f"Assistant background is not a regular file: {background_path}")
    try:
        file_stat = background_path.stat()
        source = background_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise PatchError(f"could not read Assistant background: {exc}") from exc
    transformed = _transform(source)
    if transformed is None:
        return False
    _atomic_write(background_path, transformed, file_stat.st_mode)
    return True


def _read_regular_file(path: Path, description: str) -> tuple[os.stat_result, str]:
    if path.is_symlink() or not path.is_file():
        raise PatchError(f"{description} is not a regular file: {path}")
    try:
        return path.stat(), path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise PatchError(f"could not read {description}: {exc}") from exc


def patch_assistant_bundle(
    background_path: Path,
    app_path: Path,
    manifest_path: Path | None = None,
) -> tuple[bool, bool]:
    """Validate and patch the background/app pair before either runtime write."""
    background_path = Path(background_path)
    app_path = Path(app_path)
    manifest_path = manifest_path or background_path.with_name("manifest.json")
    _validate_manifest(Path(manifest_path))
    background_stat, background_source = _read_regular_file(background_path, "Assistant background")
    app_stat, app_source = _read_regular_file(app_path, "Assistant app entry")
    background_transformed = _transform(background_source)
    app_transformed = _transform_app(app_source)
    if background_transformed is not None:
        _atomic_write(background_path, background_transformed, background_stat.st_mode)
    if app_transformed is not None:
        _atomic_write(app_path, app_transformed, app_stat.st_mode)
    return background_transformed is not None, app_transformed is not None
