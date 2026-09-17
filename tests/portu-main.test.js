"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const portuMain = require("../content/brokers/portu-main.js");

const TOK = (c) => c.repeat(30);

test("finds token-shaped fields and orders them shallowest first", () => {
  const state = {
    auth: { accessToken: TOK("a") },
    deep: { deeper: { session: { idToken: TOK("b") } } },
  };
  assert.deepEqual(portuMain.scanTokenCandidates(state), [TOK("a"), TOK("b")]);
});

test("skips refresh tokens, short values and non-token keys", () => {
  const state = {
    auth: {
      refreshToken: TOK("r"),
      accessToken: "short",
      user: TOK("u"),
    },
  };
  assert.deepEqual(portuMain.scanTokenCandidates(state), []);
});

test("dedupes values, caps the list and survives cycles", () => {
  const state = { a: { accessToken: TOK("x") } };
  state.loop = state; // cycle must not hang the walk
  for (let i = 0; i < 12; i++) state[`m${i}`] = { token: TOK("x") }; // dupes
  for (let i = 0; i < 12; i++) state[`n${i}`] = { token: TOK(String.fromCharCode(97 + i)) };
  const out = portuMain.scanTokenCandidates(state);
  assert.equal(out.length, 8);
  assert.equal(new Set(out).size, out.length);
});

function fakeRoot(state) {
  const listeners = [];
  const posted = [];
  const root = {
    location: { origin: "https://app.portu.cz" },
    addEventListener: (type, fn) => { if (type === "message") listeners.push(fn); },
    postMessage: (data, origin) => posted.push({ data, origin }),
    $nuxt: state ? { $store: { state } } : undefined,
  };
  const deliver = (data, overrides = {}) => {
    for (const fn of listeners) {
      fn({ source: root, origin: root.location.origin, data, ...overrides });
    }
  };
  return { root, posted, deliver };
}

test("bridge answers a valid request with candidates from the store", () => {
  const { root, posted, deliver } = fakeRoot({ auth: { accessToken: TOK("a") } });
  assert.equal(portuMain.install(root), true);
  deliver({ channel: portuMain.BRIDGE_CHANNEL, type: "request", requestId: "r1", nonce: "n1" });
  assert.equal(posted.length, 1);
  const { data, origin } = posted[0];
  assert.equal(origin, root.location.origin);
  assert.equal(data.requestId, "r1");
  assert.equal(data.nonce, "n1");
  assert.deepEqual(data.result, { ok: true, candidates: [TOK("a")] });
});

test("bridge ignores replays, foreign sources and malformed requests", () => {
  const { root, posted, deliver } = fakeRoot({ auth: { accessToken: TOK("a") } });
  portuMain.install(root);
  const req = { channel: portuMain.BRIDGE_CHANNEL, type: "request", requestId: "r1", nonce: "n1" };
  deliver(req);
  deliver(req); // replay of the same requestId+nonce
  deliver({ ...req, requestId: "r2" }, { source: {} }); // not the window
  deliver({ ...req, requestId: "r3" }, { origin: "https://evil.example" });
  deliver({ channel: portuMain.BRIDGE_CHANNEL, type: "request", requestId: "", nonce: "n" });
  assert.equal(posted.length, 1);
});

test("bridge reports ok:false when the store is unreachable", () => {
  const { root, posted, deliver } = fakeRoot(null);
  portuMain.install(root);
  deliver({ channel: portuMain.BRIDGE_CHANNEL, type: "request", requestId: "r1", nonce: "n1" });
  assert.deepEqual(posted[0].data.result, { ok: false, candidates: [] });
});

test("install is idempotent per root", () => {
  const { root } = fakeRoot({});
  assert.equal(portuMain.install(root), true);
  assert.equal(portuMain.install(root), false);
});
