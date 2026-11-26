"use strict";

// The interactive installer and its native (EVEJS Launcher / StartServer.bat)
// routes. A stand-in `docker` and `node` on PATH record what the installer
// runs, so no EveJS server, Docker or Node.js 26 is needed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

const repo = path.join(__dirname, "..");

function tool(bin, name, body) {
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!/usr/bin/env python3\n${body}`);
  fs.chmodSync(file, 0o755);
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playerbots-native-"));
  const evejs = path.join(root, "evejs");
  for (const dir of ["server", "docker", "config"]) fs.mkdirSync(path.join(evejs, dir), { recursive: true });
  fs.writeFileSync(path.join(evejs, "package.json"), JSON.stringify({ version: "261125.3" }));
  fs.writeFileSync(path.join(evejs, "server/package.json"), JSON.stringify({ version: "261125.3" }));
  fs.writeFileSync(path.join(evejs, "docker/entrypoint.sh"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(evejs, "compose.yaml"), "services: {}\n");
  fs.writeFileSync(path.join(evejs, "config/version.json"), JSON.stringify({ evejsVersion: "261125.3" }));
  fs.writeFileSync(path.join(evejs, "config/server.json"), JSON.stringify({ network: { serverPort: 26000 } }));
  const log = path.join(root, "calls.log");
  const bin = path.join(root, "bin");
  tool(bin, "docker", `import json, sys
args = sys.argv[1:]
open(${JSON.stringify(log)}, "a").write("docker " + " ".join(args) + "\\n")
if "ps" in args and "json" in args:
    print(json.dumps([{"Service": args[-1], "State": "running", "Health": "healthy"}]))
`);
  // Stand-in for Node.js 26 running a package's helper.cjs: it records the
  // request and answers like the real helper, updating the overlay state.
  tool(bin, "node", `import json, os, sys
args = sys.argv[1:]
if args == ["--version"]:
    print("v26.13.1"); sys.exit(0)
request = json.load(open(args[args.index("--request") + 1]))
open(${JSON.stringify(log)}, "a").write("node " + args[0] + " " + request["action"] + "\\n")
open(${JSON.stringify(path.join(root, "request.json"))}, "w").write(json.dumps(request))
package = os.path.dirname(args[0])
version = json.load(open(os.path.join(package, "evejs-launcher.mod.json")))["version"]
state = os.path.join(request["runtime"]["evejsRoot"], "_local", "playerbots-native", "overlay-state.json")
os.makedirs(os.path.dirname(state), exist_ok=True)
status = "active" if request["action"] == "install" else "stock"
json.dump({"schema": 1, "version": version, "status": status}, open(state, "w"))
json.dump({"success": True, "message": request["action"] + " ok " + version}, open(args[args.index("--result") + 1], "w"))
`);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const install = (args, input = "") => spawnSync("python3", [path.join(repo, "install.py"), ...args],
    { env, input, encoding: "utf8" });
  return { root, evejs, log, install, calls: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [] };
}

function fakePackage(root, version) {
  const zip = path.join(root, `evejs-playerbots-windows-v${version}.zip`);
  const made = spawnSync("python3", ["-I", "-c", `
import sys, zipfile, json
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr("evejs-playerbots-native/helper.cjs", "// stand-in")
    z.writestr("evejs-playerbots-native/evejs-launcher.mod.json", json.dumps({"version": sys.argv[2]}))
`, zip, version], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  return zip;
}

test("asked questions, the Docker route installs, asks before replacing files, and starts in order", () => {
  const t = setup();
  // folder, Docker, replace the (missing-stock) files, start now
  const result = t.install([], `${t.evejs}\n1\ny\ny\n`);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /How do you run EveJS\?/);
  assert.match(result.stdout, /Replace them\?/);
  const calls = t.calls();
  const build = calls.findIndex((line) => / build init$/.test(line));
  const bots = calls.findIndex((line) => / up -d --no-deps --force-recreate playerbots-addon$/.test(line));
  assert.ok(build >= 0 && bots > build, calls.join("\n"));
});

test("declining to replace hand-edited files changes nothing", () => {
  const t = setup();
  const result = t.install([], `${t.evejs}\n1\nn\n`);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Nothing was changed/);
  assert.ok(!fs.existsSync(path.join(t.evejs, "addons/playerbots")));
});

test("the launcher route points to the package to import and changes nothing", () => {
  const t = setup();
  const zip = fakePackage(t.root, "0.2.152.13");
  const result = t.install([], `${t.evejs}\n2\n1\n`);
  // The wizard finds the repository's own package; use --package for a known one.
  const explicit = t.install([t.evejs, "--native", "--package", zip]);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.match(explicit.stdout, /Mods -> Import/);
  assert.ok(explicit.stdout.includes(zip));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /evejs-playerbots-windows-v\d+\.\d+\.\d+\.\d+\.zip/);
  assert.ok(!fs.existsSync(path.join(t.evejs, "_local/playerbots-native")));
});

test("the direct route runs the package helper like EVEJS Launcher, then upgrades and removes", () => {
  const t = setup();
  const first = t.install([t.evejs, "--native", "--method", "direct", "--package", fakePackage(t.root, "0.2.152.12")]);
  assert.equal(first.status, 0, first.stderr);
  const request = JSON.parse(fs.readFileSync(path.join(t.root, "request.json"), "utf8"));
  assert.equal(request.protocol, "evejs_launcher_mod_v1");
  assert.equal(request.action, "install");
  assert.equal(request.profile, null);
  assert.deepEqual(request.runtime, { backend: "native", evejsRoot: t.evejs });
  assert.deepEqual(request.mod, { id: "evejs-playerbots-native" });
  const home = path.join(t.evejs, "_local/playerbots-native/package");
  assert.ok(fs.existsSync(path.join(home, "helper.cjs")));

  const upgrade = t.install([t.evejs, "--native", "--method", "direct", "--package", fakePackage(t.root, "0.2.152.13")]);
  assert.equal(upgrade.status, 0, upgrade.stderr);
  const helperCalls = t.calls().filter((line) => line.startsWith("node "));
  assert.deepEqual(helperCalls.map((line) => line.split(" ").pop()), ["install", "prepare_remove", "install"],
    "the old version restores the stock files before the new one installs");
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "evejs-launcher.mod.json"), "utf8")).version, "0.2.152.13");

  const removed = t.install([t.evejs, "--native", "--remove", "--package", fakePackage(t.root, "0.2.152.13")]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /prepare_remove ok 0\.2\.152\.13/);
});

test("the direct route refuses to upgrade over a launcher-managed install", () => {
  const t = setup();
  fs.mkdirSync(path.join(t.evejs, "_local/playerbots-native"), { recursive: true });
  fs.writeFileSync(path.join(t.evejs, "_local/playerbots-native/overlay-state.json"),
    JSON.stringify({ schema: 1, version: "0.2.152.11", status: "active" }));
  const result = t.install([t.evejs, "--native", "--method", "direct", "--package", fakePackage(t.root, "0.2.152.13")]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /installed through EVEJS Launcher/);
  assert.deepEqual(t.calls(), []);
});

test("the real launcher helper accepts the installer's request", () => {
  // Run windows-native/helper.cjs in a sandbox that reports Node.js 26, with
  // the request install.py builds. It must get past its protocol check and
  // stop on the fake folder's missing EveJS files instead.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playerbots-helper-"));
  fs.mkdirSync(path.join(root, "evejs/config"), { recursive: true });
  fs.writeFileSync(path.join(root, "evejs/config/version.json"), JSON.stringify({ evejsVersion: "261125.3" }));
  const requestFile = path.join(root, "request.json");
  const resultFile = path.join(root, "result.json");
  fs.writeFileSync(requestFile, JSON.stringify({
    protocol: "evejs_launcher_mod_v1", requestId: "test", action: "install", profile: null,
    runtime: { backend: "native", evejsRoot: path.join(root, "evejs") }, mod: { id: "evejs-playerbots-native" },
  }));
  const overlay = { version: "261125.3", files: {}, multicore: { tcp: {}, dependencies: [] } };
  const helper = path.join(repo, "windows-native/helper.cjs");
  const sandboxRequire = (id) => (id === "./overlay.json" ? overlay : require(id));
  const fakeProcess = { argv: ["node", helper, "--request", requestFile, "--result", resultFile],
    versions: { node: "26.13.1" }, exitCode: 0 };
  return new Promise((resolve, reject) => {
    vm.runInNewContext(fs.readFileSync(helper, "utf8"), {
      require: sandboxRequire, process: fakeProcess, console, __dirname: path.dirname(helper),
    }, { filename: helper });
    const deadline = Date.now() + 5000;
    (function poll() {
      if (fs.existsSync(resultFile)) {
        try {
          const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
          assert.equal(result.protocol, "evejs_launcher_mod_v1");
          assert.doesNotMatch(result.message, /Expected a Native EVEJS Launcher Playerbots lifecycle request/);
          // It reached the EveJS folder checks: the fake folder has no server files.
          assert.match(result.message, /config|server|EveJS/);
          resolve();
        } catch (error) { reject(error); }
      } else if (Date.now() > deadline) reject(new Error("the helper did not answer"));
      else setTimeout(poll, 20);
    })();
  });
});
