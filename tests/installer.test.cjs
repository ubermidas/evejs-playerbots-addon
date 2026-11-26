"use strict";

// Runs install.py and playerbots.py against a throwaway EveJS folder with a
// stand-in `docker` command, to check the parts operators rely on:
// - upgrading over files the installer wrote last time needs no extra flag,
// - files changed by hand since then still stop the install,
// - --start starts the server, waits until it is healthy, then starts the bots,
// - Compose settings given once are remembered by playerbots.py.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const repo = path.join(__dirname, "..");
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function copyPackage(into) {
  // The repository root has the same layout as the release ZIP.
  for (const name of ["install.py", "compose.override.yaml", "integration", "addons"]) {
    fs.cpSync(path.join(repo, name), path.join(into, name), { recursive: true });
  }
  return into;
}

function fakeEveJS(root) {
  fs.mkdirSync(path.join(root, "server"), { recursive: true });
  fs.mkdirSync(path.join(root, "docker"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "261125.3" }));
  fs.writeFileSync(path.join(root, "server/package.json"), JSON.stringify({ version: "261125.3" }));
  fs.writeFileSync(path.join(root, "docker/entrypoint.sh"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(root, "compose.yaml"), "services: {}\n");
  return root;
}

function fakeDocker(bin, log) {
  fs.mkdirSync(bin, { recursive: true });
  const script = path.join(bin, "docker");
  fs.writeFileSync(script, `#!/usr/bin/env python3
import json, sys
args = sys.argv[1:]
with open(${JSON.stringify(log)}, "a") as stream:
    stream.write(" ".join(args) + "\\n")
if "ps" in args and "json" in args:
    service = args[-1]
    print(json.dumps([{"Service": service, "State": "running", "Health": "healthy"}]))
`);
  fs.chmodSync(script, 0o755);
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playerbots-install-"));
  const pkg = copyPackage(path.join(root, "package"));
  const evejs = fakeEveJS(path.join(root, "evejs"));
  const log = path.join(root, "docker.log");
  fakeDocker(path.join(root, "bin"), log);
  const env = { ...process.env, PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}` };
  const python = (script, args) => spawnSync("python3", [script, ...args], { env, encoding: "utf8" });
  return { root, pkg, evejs, log, python, calls: () => fs.readFileSync(log, "utf8").trim().split("\n") };
}

// A stock EveJS checkout is not available here, so the first install accepts
// the missing stock files the way an operator would after reviewing them.
function firstInstall(t) {
  const first = t.python(path.join(t.pkg, "install.py"), [t.evejs, "--replace-conflicts"]);
  assert.equal(first.status, 0, first.stderr);
  return first;
}

function nextRelease(t, relative) {
  const next = copyPackage(path.join(t.root, `package-next-${crypto.randomUUID()}`));
  const file = path.join(next, "integration/server", relative);
  fs.appendFileSync(file, "\n// next release\n");
  const manifestPath = path.join(next, "integration/manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.files[relative].sourceSha256 = manifest.files[relative].overlaySha256 = sha(file);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return next;
}

const DIRECTOR = "server/src/services/playerbots/playerBotDirectorRuntime.js";
const STRUCTURE = "server/src/services/playerbots/playerBotStructureRuntime.js";

test("an upgrade over the previous install needs no --replace-conflicts", () => {
  const t = setup();
  firstInstall(t);
  const next = nextRelease(t, DIRECTOR);
  const upgrade = t.python(path.join(next, "install.py"), [t.evejs]);
  assert.equal(upgrade.status, 0, upgrade.stderr);
  assert.equal(sha(path.join(t.evejs, DIRECTOR)), sha(path.join(next, "integration/server", DIRECTOR)));
  assert.match(upgrade.stdout, /python3 addons\/playerbots\/playerbots.py rebuild/);
});

test("a file edited by hand since the last install still stops the upgrade", () => {
  const t = setup();
  firstInstall(t);
  fs.appendFileSync(path.join(t.evejs, STRUCTURE), "\n// local hand patch\n");
  const next = nextRelease(t, DIRECTOR);
  const upgrade = t.python(path.join(next, "install.py"), [t.evejs]);
  assert.equal(upgrade.status, 2);
  assert.match(upgrade.stderr, /changed by hand/);
  assert.match(upgrade.stderr, /playerBotStructureRuntime\.js/);
  assert.doesNotMatch(upgrade.stderr, /playerBotDirectorRuntime\.js/);
  assert.notEqual(sha(path.join(t.evejs, DIRECTOR)), sha(path.join(next, "integration/server", DIRECTOR)),
    "nothing was written");
});

test("--start builds, starts the server, waits for healthy, then starts the bots", () => {
  const t = setup();
  const result = t.python(path.join(t.pkg, "install.py"), [t.evejs, "--replace-conflicts", "--start"]);
  assert.equal(result.status, 0, result.stderr);
  const calls = t.calls();
  const index = (pattern) => calls.findIndex((line) => pattern.test(line));
  const build = index(/ build init$/);
  const server = index(/ up -d --no-deps --force-recreate server$/);
  const health = calls.findIndex((line, i) => i > server && / ps --all --format json server$/.test(line));
  const bots = index(/ up -d --no-deps --force-recreate playerbots-addon$/);
  assert.ok(build >= 0 && build < server && server < health && health < bots, calls.join("\n"));
  assert.match(result.stdout, /Dashboard: http:\/\/127\.0\.0\.1:8080/);
});

test("Compose settings given at install are reused by playerbots.py", () => {
  const t = setup();
  fs.writeFileSync(path.join(t.evejs, "launcher.yaml"), "services: {}\n");
  const result = t.python(path.join(t.pkg, "install.py"),
    [t.evejs, "--replace-conflicts", "--compose-file", "launcher.yaml", "--project-name", "evejs-test"]);
  assert.equal(result.status, 0, result.stderr);
  fs.writeFileSync(t.log, "");
  const status = t.python(path.join(t.evejs, "addons/playerbots/playerbots.py"), ["status", t.evejs]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(t.calls()[0],
    /^compose --project-name evejs-test -f compose\.yaml -f launcher\.yaml -f addons\/playerbots\/compose\.override\.yaml ps --all market server playerbots-addon$/);
});

test("the installed folder carries playerbots.py but not the package-only tools or old guides", () => {
  const t = setup();
  fs.mkdirSync(path.join(t.evejs, "addons/playerbots"), { recursive: true });
  fs.writeFileSync(path.join(t.evejs, "addons/playerbots/OPERATIONS.md"), "old guide\n");
  firstInstall(t);
  const installed = path.join(t.evejs, "addons/playerbots");
  assert.ok(fs.existsSync(path.join(installed, "playerbots.py")));
  for (const name of ["install.py", "rollback.py", "verify.py", "OPERATIONS.md"]) {
    assert.ok(!fs.existsSync(path.join(installed, name)), name);
  }
});
