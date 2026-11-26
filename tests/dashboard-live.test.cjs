"use strict";

// The dashboard under load: shared reads, abandoned reads, snapshot freshness
// and the page's refresh loop.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createDashboardServer } = require("../addons/playerbots/dashboard-server");
const { createPlayerBotAddonApiRuntime } = require("../integration/server/server/src/services/playerbots/playerBotAddonApiRuntime");
const { createPlayerBotDashboardRuntime } = require("../integration/server/server/src/services/playerbots/playerBotDashboardRuntime");

const TOKEN = "dashboard-live-test-token-".repeat(2);

function fakeUpstream(handler) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  return { calls, fetch };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function startDashboard(t, options) {
  const dashboard = createDashboardServer({ host: "127.0.0.1", port: 0, token: TOKEN, apiURL: "http://evejs.invalid", ...options });
  await dashboard.start();
  t.after(() => dashboard.shutdown());
  return `http://127.0.0.1:${dashboard.getDiagnostics().port}`;
}

test("identical dashboard reads share one EveJS request and carry a deadline", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const upstream = fakeUpstream(async () => { await gate; return jsonResponse({ generatedAt: "now" }); });
  const url = await startDashboard(t, { fetch: upstream.fetch });
  const before = Date.now();
  const reads = Promise.all([1, 2, 3].map(() => fetch(`${url}/api/summary`)));
  // Let all three reach the dashboard before EveJS answers.
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  const responses = await reads;
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200]);
  assert.equal(upstream.calls.length, 1);
  const deadline = Number(upstream.calls[0].init.headers["x-playerbots-deadline"]);
  assert.ok(deadline >= before + 10_000 && deadline <= Date.now() + 30_000, `deadline ${deadline}`);
  // A read right after is answered from the short cache.
  assert.equal((await fetch(`${url}/api/summary`)).status, 200);
  assert.equal(upstream.calls.length, 1);
});

test("failed reads are not reused and an order clears cached reads", async (t) => {
  const upstream = fakeUpstream(async (url, init, count) => {
    if (init.method === "POST") return jsonResponse({ success: true });
    return count === 1 ? jsonResponse({ error: "x" }, 500) : jsonResponse({ count });
  });
  const url = await startDashboard(t, { fetch: upstream.fetch });
  assert.equal((await fetch(`${url}/api/fleets`)).status, 500);
  assert.equal((await (await fetch(`${url}/api/fleets`)).json()).count, 2);
  assert.equal((await (await fetch(`${url}/api/fleets`)).json()).count, 2);
  const order = await fetch(`${url}/api/fleet-command`, {
    method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ commanderID: 1, action: "start" }),
  });
  assert.equal(order.status, 200);
  assert.equal((await (await fetch(`${url}/api/fleets`)).json()).count, 4);
});

test("a read EveJS cannot answer in time reports the server as busy", async (t) => {
  const upstream = fakeUpstream(async () => { throw new Error("The operation was aborted due to timeout"); });
  const url = await startDashboard(t, { fetch: upstream.fetch, logger: { info() {}, warn() {} } });
  const response = await fetch(`${url}/api/summary`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "PLAYERBOTS_DASHBOARD_BUSY");
});

test("EveJS skips a dashboard read whose deadline has passed", async (t) => {
  let snapshots = 0;
  const work = [];
  const api = createPlayerBotAddonApiRuntime({
    host: "127.0.0.1", port: 0, token: TOKEN, corporationLogos: {},
    playerBots: {}, autonomy: {}, configuration: { getSettings: () => ({}) }, director: {},
    dashboard: { getSnapshot: () => { snapshots += 1; return { generatedAt: "now" }; } },
    logger: { info() {}, warn() {} }, telemetry: { start() {}, stop() {}, recordWork: (name) => work.push(name) },
  });
  t.after(() => api.shutdown());
  await api.start();
  const apiURL = `http://127.0.0.1:${api.getDiagnostics().port}`;
  const read = (deadline) => fetch(`${apiURL}/v1/dashboard/summary`, {
    headers: { authorization: `Bearer ${TOKEN}`, ...(deadline ? { "x-playerbots-deadline": String(deadline) } : {}) },
  });
  const expired = await read(Date.now() - 1);
  assert.equal(expired.status, 503);
  assert.equal((await expired.json()).error, "PLAYERBOTS_DASHBOARD_REQUEST_EXPIRED");
  assert.equal(snapshots, 0);
  assert.ok(work.includes("dashboard.expired"));
  assert.equal((await read(Date.now() + 30_000)).status, 200);
  assert.equal((await read(0)).status, 200);
  assert.equal(snapshots, 2);
});

test("the dashboard snapshot stays fresh when it is cheap to build", (t) => {
  const roster = [{ characterID: 1, characterName: "Pilot One", corporationID: 98000001, specialty: "industry" }];
  // The snapshot reads a few EveJS modules directly; stand them in.
  const Module = require("node:module");
  const stand = {
    "./playerBotCapacityRuntime": { getMaxAutonomousBotsPerSystem: () => 30 },
    "./playerBotConnectionScheduleRuntime": { getMaxConnected: () => 300 },
    "../_shared/serviceHelpers": { currentFileTime: () => "133000000000000000" },
    "../structure/structureConstants": { STRUCTURE_UPKEEP_NAME_BY_ID: {}, STRUCTURE_STATE_NAME_BY_ID: {} },
  };
  const load = Module._load;
  Module._load = function (request) { return stand[request] || load.apply(this, arguments); };
  t.after(() => { Module._load = load; });
  const stub = (exports) => exports;
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  const dashboard = createPlayerBotDashboardRuntime({
    playerBots: { listBotProfiles: () => roster, getConfiguredTarget: () => 500, HARD_MAX: 15000 },
    characters: stub({ peekCharacterRecord: () => ({ corporationID: 98000001, solarSystemID: 30000142 }) }),
    corporations: { getCorporationRecord: () => ({ corporationName: "Corp" }), getAllianceRecord: () => null },
    factions: {},
    space: { getStatusSummary: () => ({}) },
    operations: { listOperations: () => [], listActiveOperationRecords: () => [] },
    industryCycles: { listActiveCycleRecords: () => [] },
    directorAssignments: { getBotDirectorAssignment: () => ({}) },
    tasks: { getDashboardTaskSummary: () => ({ total: 0, byStatus: {}, byKind: {}, byCharacter: {} }) },
    autonomy: { getAutonomySnapshot: () => ({}) },
    worldData: { getSolarSystemByID: () => ({ solarSystemName: "Jita", security: 0.9 }) },
    sessions: { getSessions: () => [] },
    fleetRuntime: { runtimeState: { fleets: new Map() } },
    warRuntime: { listAllWars: () => [] },
    structureState: { peekStructures: () => [] },
    sovereigntyState: { listAllSovereigntySystemStates: () => [] },
    killmailState: {},
    corporationPriorities: { getCorporationPriorities: () => ({ priorityIDs: [], priorities: [] }), listPriorityOptions: () => [] },
    configuration: { getSettings: () => ({}) },
    corpCommands: { listStandingRecalls: () => [] },
  });
  const first = dashboard.getSnapshot();
  assert.equal(first.cache.maxAgeMs, 5_000);
  assert.ok(first.cache.buildMs >= 0);
  now += 4_000;
  assert.equal(dashboard.getSnapshot(), first);
  // Previously a snapshot was reused for 30 s, twice the page's default refresh.
  now += 2_000;
  assert.notEqual(dashboard.getSnapshot(), first);
});

test("the page refreshes one request at a time and not while hidden", () => {
  const app = fs.readFileSync(path.join(__dirname, "../addons/playerbots/dashboard/js/app.js"), "utf8");
  assert.doesNotMatch(app, /setInterval\(\(\) => \{\s*\/\/ Views re-render/);
  assert.match(app, /timer = setTimeout\(tick, refreshMs\(\)\)/);
  assert.match(app, /if \(document\.hidden\) return;/);
  assert.match(app, /if \(summaryRequest\) return summaryRequest;/);
});
