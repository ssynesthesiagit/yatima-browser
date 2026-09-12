"""Preserve the chat subtree during background loading in pinned Assistant."""

from __future__ import annotations

import hashlib
from pathlib import Path

from assistant_onboarding_patch import PatchError, _atomic_write, _validate_manifest


BUNDLE = "chunks/sidepanel--B9uzaEL.js"
PRISTINE_SHA256 = "f13ee5b4e15479334426d891758b677e66cd19a5503d3e644f0f7a70ec5a7799"
BEFORE = "const xt=()=>{const{providers:t,selectedProvider:s,handleSelectProvider:r,resetConversation:o,messages:n,isLoading:i}=M();return i||!s?"
AFTER = "const xt=()=>{const{providers:t,selectedProvider:s,handleSelectProvider:r,resetConversation:o,messages:n}=M();return !s?"


def transform(source: str) -> str:
    """Accept only the pinned release or its exact already-patched form."""
    if source.count(AFTER) == 1 and BEFORE not in source:
        original = source.replace(AFTER, BEFORE, 1)
        if hashlib.sha256(original.encode()).hexdigest() == PRISTINE_SHA256:
            return source
    if hashlib.sha256(source.encode()).hexdigest() != PRISTINE_SHA256:
        raise PatchError("Assistant draft patch: unrecognized bundle hash")
    if source.count(BEFORE) != 1 or AFTER in source:
        raise PatchError("Assistant draft patch: unexpected chat layout")
    return source.replace(BEFORE, AFTER, 1)


def patch_assistant_draft(agent: Path) -> bool:
    agent = Path(agent)
    _validate_manifest(agent / "manifest.json")
    bundle = agent / BUNDLE
    if bundle.is_symlink() or not bundle.is_file():
        raise PatchError("Assistant draft bundle must be a regular file")
    original = bundle.read_text(encoding="utf-8")
    patched = transform(original)
    if original == patched:
        return False
    _atomic_write(bundle, patched, bundle.stat().st_mode)
    return True


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("assistant", type=Path)
    args = parser.parse_args()
    print("patched" if patch_assistant_draft(args.assistant) else "already patched")
