"use strict";

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { createHash, randomUUID } = require("node:crypto");
const manifest = require("./overlay.json");
const protocol = "evejs_launcher_mod_v1";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 2 || !process.argv[index + 1]) throw new Error(`Missing ${name}.`);
  return process.argv[index + 1];
}

function stat(file) {
  return fs.lstatSync(file, { throwIfNoEntry: false });
}

function safePath(root, relative) {
  const pieces = relative.split("/");
  let file = root;
  for (const [index, piece] of pieces.entries()) {
    if (!/^[\w.-]+$/.test(piece) || piece === "." || piece === "..") {
      throw new Error(`Invalid integration path: ${relative}.`);
    }
    file = path.join(file, piece);
    const item = stat(file);
    if (!item) continue;
    if (item.isSymbolicLink() || (index === pieces.length - 1 ? !item.isFile() : !item.isDirectory())) {
      throw new Error(`Expected an ordinary integration path: ${relative}.`);
    }
  }
  return file;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function hash(file) {
  return stat(file) ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null;
}

function isPreviousNative(entry, digest) {
  return typeof digest === "string" &&
    (entry.previousNative === digest || entry.olderNative?.includes(digest));
}

function atomicWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, "wx");
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function assertGameStopped(root) {
  const file = safePath(root, "config/server.json");
  const network = readJson(file).network;
  const port = Number(network?.serverPort ?? 26000);
  const host = network?.gameServerBindHost || "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Set a valid Game port before changing the Playerbots source integration.");
  }
  return new Promise((resolve, reject) => {
    const check = net.createServer();
    check.once("error", (error) => {
      reject(new Error(`Stop Game before changing Playerbots. Could not reserve the Game socket at ${host}:${port} (${error.code}).`));
    });
    check.listen({ port, host, exclusive: true }, () => check.close(resolve));
  });
}

const stateName = "_local/playerbots-native/overlay-state.json";
const backupName = "_local/playerbots-native/stock";
const bootFile = "server/bootstrap.js";
const tcpFile = "server/src/network/tcp/index.js";

function tcpVariant(root, state) {
  if (state && state.status !== "stock") return state.tcpVariant ?? "stock";
  const current = hash(safePath(root, tcpFile));
  return current === manifest.multicore.tcp.stock ? "multicore" : "stock";
}

function entriesFor(root, state, variant) {
  const records = Object.entries(manifest.files);
  records.sort(([a], [b]) => Number(a === bootFile) - Number(b === bootFile));
  if (variant === "multicore") {
    for (const dependency of manifest.multicore.dependencies) {
      if (!stat(safePath(root, dependency))) {
        throw new Error(`Restore the missing multicore component before changing Playerbots: ${dependency}.`);
      }
    }
  }
  return records.map(([relative, stockRecord]) => {
    if (!relative.startsWith("server/")) throw new Error("Invalid server overlay manifest.");
    const combinedTcp = variant === "multicore" && relative === tcpFile;
    const record = combinedTcp ? manifest.multicore.tcp : stockRecord;
    const target = safePath(root, relative);
    const source = safePath(__dirname, `${combinedTcp ? "multicore" : "payload"}/${relative}`);
    const backup = safePath(root, `${backupName}${combinedTcp ? "-multicore" : ""}/${relative}`);
    const current = hash(target);
    if (hash(source) !== record.native) throw new Error(`Playerbots package integrity check failed: ${relative}.`);
    if (!state && current !== record.stock) {
      throw new Error(`Playerbots requires the original EveJS ${manifest.version} file: ${relative}. Restore it or use a separate stock installation.`);
    }
    const priorPackage = state && ["active", "installing", "restoring"].includes(state.status) &&
      isPreviousNative(record, current);
    if (state && current !== record.stock && current !== record.native && !priorPackage) {
      throw new Error(`Playerbots found a local edit and preserved it: ${relative}. Review this file before retrying.`);
    }
    const saved = hash(backup);
    const needsBackup = saved === null && record.stock !== null &&
      (!state || state.status === "stock" || record.adoptVerifiedStock === true) && current === record.stock;
    if (!needsBackup && saved !== record.stock) {
      throw new Error(`Playerbots cannot verify the original backup for ${relative}.`);
    }
    return { target, source, backup, current, needsBackup, ...record };
  });
}

function apply(entries, active) {
  for (const entry of entries) {
    const expected = active ? entry.native : entry.stock;
    const current = hash(entry.target);
    if (current === expected) continue;
    if (current !== entry.native && current !== entry.stock && !isPreviousNative(entry, current)) {
      throw new Error(`A server file changed during the transaction: ${entry.target}.`);
    }
    if (expected === null) fs.unlinkSync(entry.target);
    else atomicWrite(entry.target, fs.readFileSync(active ? entry.source : entry.backup));
    if (hash(entry.target) !== expected) throw new Error(`Could not verify the change to ${entry.target}.`);
  }
}

async function run(request) {
  if (request.protocol !== protocol || request.runtime?.backend !== "native" || request.profile !== null ||
      !["install", "prepare_disable", "prepare_remove", "recover"].includes(request.action) ||
      request.mod?.id !== "evejs-playerbots-native") {
    throw new Error("Expected a Native EVEJS Launcher Playerbots lifecycle request.");
  }
  if (Number(process.versions.node.split(".")[0]) < 26) throw new Error("Playerbots requires Node.js 26 or later.");
  const root = fs.realpathSync(request.runtime.evejsRoot);
  const stateFile = safePath(root, stateName);
  const state = stat(stateFile) ? readJson(stateFile) : null;
  if (state && (state.schema !== 1 || state.version !== manifest.version ||
      !["stock", "multicore"].includes(state.tcpVariant ?? "stock") ||
      !["active", "stock", "installing", "restoring"].includes(state.status))) {
    throw new Error("Unrecognized Playerbots overlay state. Review the backup before retrying.");
  }
  const active = request.action === "install" ||
    (request.action === "recover" && ["active", "installing"].includes(state?.status));
  if (!active && (!state || state.status === "stock")) return "Playerbots is already disabled.";
  if (readJson(safePath(root, "config/version.json")).evejsVersion !== manifest.version) {
    throw new Error(`This Playerbots package requires EveJS ${manifest.version}.`);
  }
  const variant = tcpVariant(root, state);
  const entries = entriesFor(root, state, variant);
  if (active) {
    require("./payload/server/playerbots-native/native.cjs").readOptions(root);
    if (state?.status === "active" && entries.every((entry) => entry.current === entry.native)) {
      return "Playerbots is already installed.";
    }
  }
  await assertGameStopped(root);
  // The launcher holds its per-installation lifecycle lease throughout this helper.
  // Keep verified stock bytes outside the mod folder so removal and undo share them.
  for (const entry of entries) {
    if (!entry.needsBackup) continue;
    if (hash(entry.target) !== entry.stock) throw new Error(`Server file changed: ${entry.target}.`);
    atomicWrite(entry.backup, fs.readFileSync(entry.target));
    if (hash(entry.backup) !== entry.stock) throw new Error(`Could not verify backup: ${entry.backup}.`);
  }
  const record = (status) => atomicWrite(stateFile, JSON.stringify({
    schema: 1, version: manifest.version, status, tcpVariant: variant,
  }) + "\n");
  const wasActive = state?.status === "active";
  // An upgrade may start with previously installed, trusted native bytes.
  // Keep those exact bytes for rollback rather than silently upgrading on
  // failure. No game DB, settings, and stock backups are modified here.
  const priorFiles = entries.filter((entry) => isPreviousNative(entry, entry.current))
    .map((entry) => ({ entry, bytes: fs.readFileSync(entry.target) }));
  record(active ? "installing" : "restoring");
  try {
    apply(entries, active);
    record(active ? "active" : "stock");
  } catch (error) {
    try {
      apply(entries, wasActive);
      for (const { entry, bytes } of priorFiles) atomicWrite(entry.target, bytes);
      record(wasActive ? "active" : "stock");
    } catch (rollbackError) {
      throw new Error(`${error.message} Recovery needs attention: ${rollbackError.message}`);
    }
    throw error;
  }
  return active ? "Windows Playerbots installed. Start Game, then open its local dashboard." :
    "EveJS source restored. Playerbots configuration and saved bot data were retained.";
}

async function main() {
  const request = readJson(argument("--request"));
  let reply;
  try {
    reply = { success: true, state: "ready", message: await run(request) };
  } catch (error) {
    reply = { success: false, state: "failed", message: String(error.message).slice(0, 4096) };
  }
  fs.writeFileSync(argument("--result"), JSON.stringify({
    protocol, requestId: request.requestId, ...reply, restartRequired: [],
    contributions: [], environment: {}, arguments: [],
  }), { flag: "wx" });
}

void main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
