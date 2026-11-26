"use strict";

// Builds the Windows launcher package into a temporary folder and checks it
// the way EVEJS Launcher's helper will: every payload file matches
// overlay.json, the launcher fields match the native settings schema, and the
// 0.2.152.10 release can be upgraded in place.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const repo = path.join(__dirname, "..");
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "playerbots-windows-"));
execFileSync("python3", [path.join(repo, "tools/playerbots/build-windows-native.py"), "--unpacked", path.join(out, "pkg")], { stdio: "pipe" });
const pkg = path.join(out, "pkg");
const overlay = JSON.parse(fs.readFileSync(path.join(pkg, "overlay.json"), "utf8"));
const previous = JSON.parse(fs.readFileSync(path.join(repo, "windows-native/history/overlay-0.2.152.10.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(repo, "integration/manifest.json"), "utf8"));

test("every payload file and the multicore TCP file match overlay.json", () => {
  for (const [relative, entry] of Object.entries(overlay.files)) {
    assert.equal(hash(path.join(pkg, "payload", relative)), entry.native, relative);
  }
  assert.equal(hash(path.join(pkg, "multicore/server/src/network/tcp/index.js")), overlay.multicore.tcp.native);
});

test("the payload carries every server file the Docker add-on installs, with the same stock hashes", () => {
  for (const [relative, record] of Object.entries(manifest.files)) {
    if (!relative.startsWith("server/")) continue;
    assert.ok(overlay.files[relative], relative);
    assert.equal(overlay.files[relative].stock, record.baseSha256 ?? null, relative);
    assert.equal(overlay.files[relative].native, record.overlaySha256, relative);
  }
});

test("0.2.152.10 installs are recognised for an in-place upgrade", () => {
  for (const [relative, entry] of Object.entries(previous.files)) {
    const next = overlay.files[relative];
    assert.ok(next, `${relative} was dropped; Disable could no longer remove it`);
    // Stock hashes only carry over while the package targets the same EveJS
    // release; after an EveJS update the updater has already restored stock.
    if (overlay.version === previous.version) assert.equal(next.stock, entry.stock, relative);
    const known = [next.native, next.previousNative, ...(next.olderNative || [])];
    assert.ok(known.includes(entry.native), `${relative}: 0.2.152.10 bytes not recognised`);
  }
  assert.deepEqual(overlay.multicore, previous.multicore);
});

test("launcher fields match the native settings schema and the driver loads", () => {
  const mod = JSON.parse(fs.readFileSync(path.join(pkg, "evejs-launcher.mod.json"), "utf8"));
  const settings = JSON.parse(fs.readFileSync(path.join(pkg, "payload/server/playerbots-native/settings.json"), "utf8"));
  assert.deepEqual(mod.settings.fields.map((field) => field.id).sort(), Object.keys(settings).sort());
  for (const field of mod.settings.fields) {
    assert.equal(field.default, settings[field.id].default, field.id);
  }
  const native = require(path.join(pkg, "payload/server/playerbots-native/native.cjs"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playerbots-config-"));
  fs.mkdirSync(path.join(root, "config"));
  fs.writeFileSync(path.join(root, "config/playerbots-native.json"), JSON.stringify({ rosterTarget: 700, recruitmentCorporation: "Example" }));
  const options = native.readOptions(root);
  assert.equal(options.effective.rosterTarget, 700);
  assert.deepEqual(Object.keys(options.overrides), ["rosterTarget"]);
});
