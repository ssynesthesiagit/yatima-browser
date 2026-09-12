// Import owner-configured local endpoints without replacing existing providers.
const STORAGE_KEY = "llm-providers";

function validateProvider(provider) {
  if (!provider || !["id", "name", "modelId", "baseUrl"].every(
    (key) => typeof provider[key] === "string" && provider[key].trim(),
  )) throw new Error("Invalid local provider configuration");
  const url = new URL(provider.baseUrl);
  const octets = url.hostname.split(".").map(Number);
  const ipv4 = octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  const privateHost = url.hostname === "localhost" || url.hostname === "[::1]" || (ipv4 && (
    octets[0] === 127 || octets[0] === 10 ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
  ));
  if (!["http:", "https:"].includes(url.protocol) || !privateHost || url.username || url.password) {
    throw new Error("Local providers require a private-network endpoint");
  }
  if (!Number.isInteger(provider.contextWindow) || provider.contextWindow < 1024) {
    throw new Error("Invalid local provider context window");
  }
  return {
    id: provider.id, name: provider.name, type: "openai-compatible",
    modelId: provider.modelId, baseUrl: provider.baseUrl, apiKey: "local",
    supportsImages: provider.supportsImages === true,
    contextWindow: provider.contextWindow, temperature: 0.2,
  };
}

export async function configureLocalProviders({
  storage = globalThis.chrome?.storage?.local,
  locks = globalThis.navigator?.locks,
  readConfig = async () => {
    const response = await fetch(chrome.runtime.getURL("yatima-local-providers.json"), {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    return response.json();
  },
  now = Date.now,
} = {}) {
  const config = await readConfig();
  if (config == null) return { added: 0 };
  if (config.version !== 1 || !Array.isArray(config.providers)) throw new Error("Unsupported local providers configuration");
  const providers = config.providers.map(validateProvider);
  if (new Set(providers.map((p) => p.id)).size !== providers.length) throw new Error("Duplicate local provider IDs");
  if (!locks?.request) throw new Error("Local provider setup requires Web Locks");
  return locks.request("yatima-local-provider-setup", async () => {
    const state = await storage.get({ [STORAGE_KEY]: [] });
    const existing = state[STORAGE_KEY];
    if (!Array.isArray(existing)) throw new Error("Existing provider storage is invalid; left unchanged");
    const ids = new Set(existing.map((p) => p.id));
    const timestamp = now();
    const additions = providers.filter((p) => !ids.has(p.id)).map((p) => ({
      ...p, createdAt: timestamp, updatedAt: timestamp,
    }));
    if (additions.length) await storage.set({ [STORAGE_KEY]: [...existing, ...additions] });
    return { added: additions.length };
  });
}
