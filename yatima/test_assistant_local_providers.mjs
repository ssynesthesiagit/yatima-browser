import test from "node:test";
import assert from "node:assert/strict";
import { configureLocalProviders } from "./assistant_local_providers.mjs";

const granite = { id: "granite", name: "Granite", modelId: "granite-test", baseUrl: "http://127.0.0.1:11442/v1", contextWindow: 65536 };
const qwen = { ...granite, id: "qwen", name: "Qwen", modelId: "qwen-test", baseUrl: "http://100.64.0.2:11436/v1" };
function fixture(initial = []) {
  let state = { "llm-providers": initial, "default-provider-id": "owner-cloud", "other-setting": "preserved" };
  let writes = 0;
  let pending = Promise.resolve();
  const locks = { request: (_name, fn) => { const next = pending.then(fn); pending = next.catch(() => {}); return next; } };
  const storage = {
    get: async () => structuredClone(state),
    set: async (patch) => { state = { ...state, ...structuredClone(patch) }; writes++; },
  };
  const run = (providers = [granite, qwen]) => configureLocalProviders({ storage, locks, readConfig: async () => ({ version: 1, providers }), now: () => 100 });
  return { run, storage, locks, state: () => state, writes: () => writes };
}

test("adds both local models without changing existing provider secrets or defaults", async () => {
  const original = { id: "owner-cloud", apiKey: "owner-secret-fixture", custom: { preserve: true } };
  const f = fixture([original]);
  assert.deepEqual(await f.run(), { added: 2 });
  assert.deepEqual(f.state()["llm-providers"][0], original);
  assert.equal(f.state()["default-provider-id"], "owner-cloud");
  assert.equal(f.state()["other-setting"], "preserved");
  assert.equal(f.state()["llm-providers"][1].type, "openai-compatible");
  assert.equal(f.state()["llm-providers"][1].supportsImages, false);
});

test("repeat and concurrent page loads are idempotent", async () => {
  const f = fixture();
  await Promise.all([f.run(), f.run(), f.run()]);
  assert.equal(f.writes(), 1);
  assert.equal(f.state()["llm-providers"].length, 2);
});

test("owner edits to an installed local provider are retained", async () => {
  const edited = { ...granite, name: "Owner rename", temperature: 0.7 };
  const f = fixture([edited]);
  await f.run();
  assert.deepEqual(f.state()["llm-providers"][0], edited);
});

test("invalid and public endpoints reject before writes", async () => {
  for (const baseUrl of ["https://api.example.com/v1", "http://100.128.0.1/v1", "file:///tmp/model", "http://user:password@127.0.0.1/v1"]) {
    const f = fixture();
    await assert.rejects(f.run([granite, { ...qwen, baseUrl }]));
    assert.equal(f.writes(), 0);
  }
});

test("malformed existing storage and duplicate IDs are preserved", async () => {
  const f = fixture({ invalid: true });
  await assert.rejects(f.run());
  assert.equal(f.writes(), 0);
  const g = fixture();
  await assert.rejects(g.run([granite, granite]));
  assert.equal(g.writes(), 0);
});

test("missing configuration is a no-op", async () => {
  const f = fixture();
  assert.deepEqual(await configureLocalProviders({ storage: f.storage, locks: f.locks, readConfig: async () => null }), { added: 0 });
  assert.equal(f.writes(), 0);
});
