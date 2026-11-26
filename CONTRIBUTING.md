# Contributing

This repository holds the Playerbots add-on, the EveJS server files it
installs, its installer, and the release ZIPs. It does not hold the EveJS
server itself. Operator documentation is in the [README](README.md) and the
[GUIDE](GUIDE.md); release notes are in the [CHANGELOG](CHANGELOG.md), and the
project's long-form plan and test evidence in
[PLAYERBOTS_ROADMAP.md](PLAYERBOTS_ROADMAP.md).

## What lives where

| Path | What it is |
| --- | --- |
| `addons/playerbots/index.js` | The add-on process that drives the bots |
| `addons/playerbots/dashboard-server.js`, `dashboard/` | The dashboard: plain HTML, CSS and ES modules, no build step |
| `addons/playerbots/playerbots.py` | Start, stop, rebuild, status and logs for Docker installs; installed into the EveJS folder |
| `addons/playerbots/install.py`, `verify.py`, `rollback.py` | Installer (Docker and native, interactive when run without options), checker and rollback; copied to the package root at build time |
| `install.cmd` | Double-click launcher for the installer on Windows |
| `install.py`, `verify.py`, `rollback.py`, `compose.override.yaml` | The same files at the repository root, so a git checkout installs like an unpacked ZIP. Keep them identical to `addons/playerbots/`; a test checks this. |
| `integration/server/` | The EveJS server files the add-on installs over a stock 261125.3 tree |
| `integration/manifest.json` | Stock and installed SHA-256 for every managed file, and the add-on file hashes |
| `windows-native/` | The EVEJS Launcher package: mod manifest, installer helper, native driver, multicore TCP file, release history |
| `tools/playerbots/` | Package builders |
| `tests/` | Node test suites |
| `dist/` | The release ZIPs |

## Design rules

These keep the bots honest players of the same game as humans:

- Every bot action goes through EveJS's own wallet, market, inventory,
  industry, planetary, ship, war, Crimewatch, structure and sovereignty
  authorities. No free items, wallet top-ups, skipped timers or assumed war
  rights.
- A task counts as done only when the game's authoritative state shows the
  result. Durable work must reconcile safely after a restart and show its
  status to operators. An uncertain purchase, launch or listing stops for
  review; it is never repeated blindly.
- The 1 billion ISK starting grant is seed capital, not earned profit.
- Jita is only a seed market. Bots never sell or list there, and buy there
  only when the region has no other seller. Never invent seed data or edit
  other markets to make a bot workflow look successful.
- Unsold output is listed outside Jita for 90 days without placement fees;
  an open listing is inventory, not revenue.
- Keep six specialist corporations, filled to about 250 bots and never more
  than 300. Owned assets never move between bots to get work done.
- Large rosters must stay cheap per tick: read roster and structure data
  through the indexes and read-only views (`getBotByCharacterID`,
  `hasBotProfile`, `getPlanningRoster`, `peekStructures`), not by copying
  every record.

## Tests

```sh
node --test tests/*.test.cjs
```

Most suites load single server files with stubbed dependencies and need
nothing else. A few need a stock EveJS 261125.3 checkout and report as
skipped without one:

- Local defense: set `EVEJS_ROOT` to a compatible checkout. To run only that
  suite, use `node tests/run-local-defense.cjs`.
- The engagement host contract: set `EVEJS_SOURCE_ROOT` to a checkout with
  the add-on installed.

`tests/installer.test.cjs` and `tests/installer-native.test.cjs` run
`install.py` and `playerbots.py` against a throwaway folder with stand-in
`docker` and `node` commands, so they need Python 3.10+ but no Docker or
Node.js 26. They cover the interactive questions, both native routes, and
check that the real launcher helper accepts the installer's request.

## Changing server files

Edit the file under `integration/server/`, then refresh its hashes in
`integration/manifest.json` (`sourceSha256` and `overlaySha256`; `baseSha256`
stays the stock file's hash, or `null` for a file the add-on adds). The
Windows package test fails until the manifest matches. Files the add-on adds
need a manifest entry with `"subsystem"` set as in `verify.py`.

## Building releases

Both packages build from this repository alone.

```sh
python3 tools/playerbots/build-windows-native.py     # dist/evejs-playerbots-windows-v<version>.zip
python3 tools/playerbots/build-addon-package.py      # dist/evejs-playerbots-addon-v<version>.zip
```

Build the native package first: the release ZIP carries it, so the
installer's native choice works from one download.

The Docker ZIP takes its version from `addons/playerbots/manifest.json`, the
Windows package from `windows-native/evejs-launcher.mod.json`. Before raising
the Windows version, copy the released package's `overlay.json` into
`windows-native/history/overlay-<version>.json`; the launcher helper uses that
history to upgrade earlier installs in place. Commit the rebuilt ZIPs with the
source change, and don't call a source-only commit an installable release.

`build-addon-package.py --compat-root <stock EveJS 261125.3>` still works as
before. It re-reads every stock hash from that checkout instead of trusting
the manifest; use it when moving to a new EveJS version.

## Validation on a real server

Unit tests stub the game. Before calling a feature finished, run it on a
disposable EveJS server built from a stock checkout with the add-on
installed. Use copied test data, never a player's save. Record what was run
and what it proves in the pull request. Earlier native validation notes (PRs
#2–#6 and local defense) are in the git history.
