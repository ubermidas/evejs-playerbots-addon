# Playerbots 0.2.152.17 for native EveJS (EVEJS Launcher)

This package runs Playerbots inside a native Windows EveJS server managed by
EVEJS Launcher, with no Docker. It carries the Luna update by
[@xrizonx](https://github.com/xrizonx) (corporation recruitment, corporation
income, portrait repair, level 1 agent missions, Windows multicore support,
fewer disk writes and other performance work) together with the overhauled
operator dashboard from this repository.

You need EveJS **261125.3**, EVEJS Launcher **1.0.91** or later and
**Node.js 26.13** or later. This is @xrizonx's *Playerbots 0.2.152.16 (Windows,
Luna)*, carried forward to EveJS 261125.3: the server files it installs are
merged onto the 261125.3 versions of the same files.

The multicore TCP variant is recorded against the multicore build for EveJS
261115.2. Until that mod is published for 261125.3, the package installs the
stock TCP file variant; a multicore TCP file it does not recognise stops the
install and is named.

No launcher? Servers started with `StartServer.bat` can install this package
with the repository's installer instead: run `python install.py` and choose
**Native**, then **Directly** (see the main README).

## Install

1. Stop **Game** and **Market** in EVEJS Launcher. If Game was started outside
   the launcher, stop it from its own console. Back up your EveJS folder and
   its `_local` data, as before any server mod.
2. Open **Mods → Import** and choose this ZIP (or the extracted folder that
   contains `evejs-launcher.mod.json`).
3. Turn on **Playerbots (Windows, Luna Update)**. The installer checks the
   EveJS version and every file it replaces. It detects the supported
   multicore TCP file by itself. If another mod changed one of the same files,
   it stops and names the file.
4. Open **Configure** to set the roster size, online limit, seeding, bot
   behaviour, recruitment, corporation income, portraits and local ports.
   Save, then **Start Stack** (or start Market, then Game).
5. Open **http://127.0.0.1:8080/** on the server PC (or your configured
   port). The dashboard and the private API (port 26004) listen on this PC
   only, and the bot driver starts and stops with Game.

Settings saved in the launcher apply at the next Game start. The dashboard
shows them locked with the note "Set in EVEJS Launcher"; everything else on
the dashboard's Settings page still works there.

## Upgrade an existing installation

Update EveJS to 261125.3 first (its updater replaces the server files an
earlier package installed). Then stop Game and Market. Keep a copy of
`config/playerbots-native.json`. In
**Mods**, disable and remove the previous Playerbots entry, import this ZIP
and turn it on. Restore your settings copy if the launcher changed it, or
re-enter the settings in **Configure**, then **Start Stack**. Leave your
multicore files in place.

The installer recognises the files earlier packages installed, including
both builds named 0.2.152.11 (Luna and the ubermidas fork) and @xrizonx's
0.2.152.13 to 0.2.152.16, and replaces them; it stops on anything else.

Bot tasks move to a new storage layout on the first task change after this
upgrade. Take your usual GameStore backup with Game stopped first: an older
Playerbots release cannot read the new layout, so going back needs that
backup.

## What's included

- **The new dashboard**: Activity, Corporations (with whole-corporation and
  per-pilot orders), History, World, Performance and Settings, plus a
  built-in **Guide** that explains every page and command in plain words.
- **Corporation recruitment** into a player corporation, by command or
  automatically (below).
- **Corporation income** settings (below).
- **Portrait repair** for existing and new bots (below).
- **Windows multicore support**, with the multicore TCP file detected at
  install.
- **Corporation names and emblems**: new bot corporations take famous sci-fi
  company names and random in-game emblems. Both can be turned off under
  **Configure → New corporations**.
- **Agent missions**: fitted pilots take level 1 Security, Mining and
  Distribution missions from high-security agents within 10 jumps. Turn off
  or cap them under **Configure → Agent missions** (12 at once by default,
  at most 32).
- **Fewer disk writes**: bot tasks are saved one row each, bot and scheduler
  saves are written once, map statistics are saved every 60 seconds
  (**Configure → Disk writes**, 2–120), and EveJS's verbose trace files are
  off unless you turn on **Write verbose diagnostic files**.
- **Lighter server load**: buffered combat progress saves, cheaper task
  claims and roster lookups, reused drone and roster indexes in combat,
  reused mining targets, and no full-roster scans for corporation counts.
- **Roster seeding CPU threshold** from 25% to 900% (100% is one CPU core;
  default 85%) under **Configure → Population**.

## Recruit bots into your corporation

1. In **Mods → Playerbots → Configure → Corporation recruitment**, enter the
   exact **Target corporation** name or ticker. If a name and a ticker match
   different corporations, write `name:Example Corporation` or
   `ticker:EXAMP`. Save and restart Game.
2. As the corporation's CEO, a director or a personnel manager, type
   `/bots corp inviteall` in chat. Invitations are sent and accepted in
   batches. `/bots corp inviteall status` shows progress and
   `/bots corp inviteall cancel` stops it.
3. To recruit continuously, turn on **Automatically recruit eligible bots**.
   The server checks the roster from time to time, including new bots, and
   invites as the corporation's current CEO. Clear **Target corporation** to
   turn both off.

Bots are recruited from NPC corporations or their own specialist corporation.
At least five pilots stay in each specialist corporation, departure and
corporation size rules are respected, and bots already in another player
corporation are left alone.

| Setting | Default | Allowed |
| --- | --- | --- |
| Player corporation member limit | 15,000 seats (`0` = the CEO's skill limit) | 0 – 15,000 |
| Player corporation bot limit | 1,000 | 1 – 15,000 |
| Bots processed per recruitment batch | 4 | 1 – 16 |

Lowering a limit stops new members joining above it; nobody is removed.

## Corporation income

In **Configure → Corporation income** (restart Game after saving):

| Setting | Default | What it is |
| --- | --- | --- |
| Player corporation bot profit share | 75% | Share of a bot's total net profit paid to a human-led corporation. Starting capital and top-ups don't count. |
| Bot-led corporation operation share | 35% | Share of each profitable job paid to a bot-led corporation. |
| Minimum corporation payout | 1 ISK | Smaller amounts are held until they reach it. |

Payouts are wallet transfers, so they depend on real profit and available
ISK. Profit tracking and combat progress are saved about once a minute and on
a clean shutdown; a crash can lose the last minute of those two.

## Portraits

On the first Game start after upgrading, every existing bot gets one of 32
bundled portraits, and its old portraits are backed up to
`_local/gameStore/images/PlayerBotPortraitBackup-v1` (`refresh.log` there
records progress). Human portraits are untouched. To keep current bot
portraits, turn off **Refresh existing bot portraits once** under
**Configure → Portraits** before starting Game. Missing portraits are repaired
in small batches afterwards, more slowly when the server is busy. If the EVE
client shows an old cached portrait, reconnect.

## Disable, remove or recover

Stop Game and Market first. Turning the mod off restores the exact original
EveJS files; **Remove** also archives the mod. Bot and player data stay in
the game store. Before an EveJS server update, disable the mod and wait for a
version that supports the new server.

If an operation is interrupted, keep Game stopped and retry the same action.
Original files are backed up in `_local/playerbots-native/stock` (and
`stock-multicore` for the multicore TCP file); unexpected edits are kept and
named.

## Building this package

From the repository root:

```sh
python tools/playerbots/build-windows-native.py
```

This writes `dist/evejs-playerbots-windows-v<version>.zip` from the same
server files the Docker add-on installs, plus the native driver in
`windows-native/`. Earlier releases' `overlay.json` files live in
`windows-native/history/` so the installer can upgrade from them.
