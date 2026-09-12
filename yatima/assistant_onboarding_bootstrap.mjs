const APP_MODULE = "/chunks/app-DJAEj3Y2.js";

function isOnboardingRoot(location) {
  return (
    location?.hash === "#/onboarding" ||
    location?.hash === "#/onboarding/" ||
    location?.pathname === "/onboarding" ||
    location?.pathname === "/onboarding/"
  );
}

export async function start({
  storage = globalThis.chrome?.storage?.local,
  location = globalThis.location,
  history = globalThis.history,
  tabs = globalThis.chrome?.tabs,
  loadApp = () => import(APP_MODULE),
} = {}) {
  if (isOnboardingRoot(location)) {
    try {
      const state = await storage.get({ onboardingCompleted: false });
      if (state?.onboardingCompleted === true) {
        // The pinned browser can append onboarding after restoring a session.
        // Remove only this redundant welcome tab; keep a sole tab usable.
        try {
          const current = await tabs?.getCurrent();
          if (Number.isInteger(current?.id) && Number.isInteger(current?.windowId)) {
            const siblings = await tabs.query({ windowId: current.windowId });
            const hasUsableSibling = siblings.some((tab) => {
              if (tab.id === current.id || !tab.url) return false;
              try {
                const url = new URL(tab.url);
                return !/^#\/onboarding(?:\/|$)/.test(url.hash) &&
                  !/^\/onboarding(?:\/|$)/.test(url.pathname);
              } catch {
                return false;
              }
            });
            if (hasUsableSibling) {
              const fresh = await tabs.get(current.id);
              if (fresh.windowId === current.windowId && fresh.url &&
                  isOnboardingRoot(new URL(fresh.url)) && isOnboardingRoot(location)) {
                await tabs.remove(current.id);
                return;
              }
            }
          }
        } catch {
          // If tab cleanup fails, show home in this tab instead.
        }
        if (isOnboardingRoot(location)) history.replaceState(null, "", "#/home");
      }
    } catch {
      // Storage or route failures must leave the normal app available.
    }
  }
  if (globalThis.chrome?.runtime?.getURL) {
    try {
      const { configureLocalProviders } = await import(chrome.runtime.getURL("yatima-local-providers.js"));
      await configureLocalProviders();
    } catch {
      console.warn("Yatima local provider setup unavailable; existing providers retained.");
    }
  }
  return loadApp();
}

if (typeof document !== "undefined") {
  void start();
}
