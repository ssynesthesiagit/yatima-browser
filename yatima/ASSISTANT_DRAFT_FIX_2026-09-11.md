# Assistant draft interruption fix — 2026-09-11

Fixed and applied to the running Yatima Browser Assistant side panel.

## Cause

The browser document was not navigating or reloading. `ChatLayoutContent`
returned a full-screen spinner whenever the chat context reported `isLoading`,
unmounting `Chat` and its locally stored input draft. Live inspection showed
the selected provider remained available, five provider choices remained
present, and `canSend` remained true while the loading flag repeatedly toggled.
The original panel's textarea disappeared during these loading intervals.

## Change

Keep the existing chat subtree mounted whenever a selected provider exists.
Continue showing the initial spinner when no provider exists. Existing send
readiness checks still apply. No model settings, credentials, theme, browser
network controls, or provider routing were changed.

- Source: `packages/browseros-agent/apps/app/components/layout/ChatLayout.tsx`.
- Pinned installed-bundle patch: `yatima/assistant_draft_patch.py`.
- Installer integration: `yatima/install-linux.py`.
- Focused regression checks: `yatima/test_assistant_draft_patch.py`.

The patcher validates Assistant version 0.0.117.0 and the exact bundle hash,
rejects unexpected edits, writes atomically and accepts its exact patched form
without rewriting it. Future runs of the pinned installer apply the repair.
Existing unrelated local changes were preserved. This report records the
September 11 repair; the source was prepared for publication on September 12.

Installed bundle:
`~/.local/share/yatima-browser/addons/assistant/chunks/sidepanel--B9uzaEL.js`.

- Before SHA-256: `f13ee5b4e15479334426d891758b677e66cd19a5503d3e644f0f7a70ec5a7799`.
- After SHA-256: `b727eb857dbaa651b2fa51b037a1a57f54b6858a91a6024c90f883fa9ccd37e0`.
- Original backup: `~/.local/share/yatima-browser/backups/20260911-assistant-draft-repair/sidepanel--B9uzaEL.js`.

## Verification

1. Reproduced the original panel's input disappearing while its document time
   origin stayed unchanged. Captured loading=true with a valid selected provider.
2. Twelve focused patch/onboarding tests passed, including the actual compiled
   layout's behavior for loading/ready and missing/present provider combinations,
   exact idempotence, unknown-bundle rejection and partial-patch rejection.
3. Refreshed only the original Assistant panel after confirming it had no
   draft, conversation messages or active turn. The browser was not restarted.
4. After the fix, observed the original panel for 18 one-second samples:
   **zero missing/replaced inputs**, including **11 loading=true samples**.
5. In a separate Assistant test tab, a 44-character unsent draft and keyboard
   focus survived all 18 samples; the same textarea remained connected.
6. Installed JavaScript syntax and `git diff --check` passed. Closed only the
   temporary test tab; left the user's side panel and existing tabs open.

An initial in-page polling probe timed out because background-page timers were
throttled. The successful final observation sampled from an external diagnostic
timer using read-only CDP queries. No test message or model request was sent.

The repair prevents background-loading transitions from destroying the draft;
it does not disable background discovery or claim to fix every possible cause
of a loading-state transition.
