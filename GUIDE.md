# Playerbots guide

The operator's handbook for the EveJS Playerbots add-on: running it, sizing the
roster, every chat command, how the bots behave, performance, and fixes for
common problems. Start with the [README](README.md) to install it. The
dashboard's built-in **Guide** page covers the same ground in shorter form.

**Contents:** [Running the server](#running-the-server) ·
[Roster and population](#roster-and-population) ·
[The dashboard](#the-dashboard) · [Chat commands](#chat-commands) ([command reference](#command-reference)) ·
[How the bots work](#how-the-bots-work) ·
[Recovery and safety](#recovery-and-safety) ·
[Performance and capacity](#performance-and-capacity) ·
[Troubleshooting](#troubleshooting) ·
[Community fittings](#community-fittings)

## Running the server

### Everyday commands

Run these from your EveJS folder. On Windows, type `python` instead of
`python3`. `playerbots.py` reads the Compose files and project that
`install.py` recorded, so the same short commands work on every setup. It
never starts or stops Market.

| To | Run |
| --- | --- |
| Start the server, wait until it is healthy, then start the bots | `python3 addons/playerbots/playerbots.py start` |
| Stop the bots and keep the server up for players | `python3 addons/playerbots/playerbots.py stop` |
| Stop the bots and the server | `python3 addons/playerbots/playerbots.py stop --all` |
| Restart the server cleanly, then the bots | `python3 addons/playerbots/playerbots.py restart` |
| Recreate only the bots, for example after editing `.env` | `python3 addons/playerbots/playerbots.py restart --bots-only` |
| Apply an update or a code change (rebuild, then restart) | `python3 addons/playerbots/playerbots.py rebuild` |
| See Market, server and bot state | `python3 addons/playerbots/playerbots.py status` |
| Read the bots' log (`-f` to follow, `--server` for EveJS) | `python3 addons/playerbots/playerbots.py logs` |

The server always starts first and the bots only once it reports healthy.
Starting both together can let the bots ask for work while EveJS is still
loading its game store. The services use `restart: "no"`, so nothing starts
when the machine boots.

The `playerbots-addon` log reports cycle ID, roster progress, completed bots,
failures, retry delays and shutdown. Stopping the add-on interrupts its
waits and in-flight requests, so it does not wait out its five-minute cycle.

### Native installs

On a native EveJS (Node.js, no Docker), Playerbots runs inside the game
server: the bots start and stop with Game, and the dashboard is at
`http://127.0.0.1:8080` while Game runs. Install it with `install.py` in
one of two ways (stop Game first):

- **EVEJS Launcher** (1.0.91 or later): `python3 install.py /path/to/evejs --native`
  shows the package to import under **Mods → Import**. The launcher then
  installs, disables, removes and recovers it, and its **Configure** page
  edits the settings.
- **Directly**, for servers started with `StartServer.bat` or `node`:
  `python3 install.py /path/to/evejs --native --method direct` runs the
  package's own helper exactly as the launcher would. The package is kept in
  `_local/playerbots-native/package`; settings are in
  `config/playerbots-native.json` (missing settings use their defaults);
  `--remove` restores the original EveJS files.

Either way the original EveJS files are backed up in
`_local/playerbots-native/stock` (and `stock-multicore` for the multicore TCP
file), a file someone edited by hand is kept and named rather than
overwritten, and bot data stays in the game store. To upgrade a direct
install, run the new release's installer the same way; it restores the old
version's files first. A launcher-managed install is upgraded through the
launcher. Settings, recruitment, income and portraits are described in
[`windows-native/README.md`](windows-native/README.md).

### Other Compose setups

If your EveJS uses more Compose files or a project name, give them to
`install.py` once; every later install and `playerbots.py` command reuses
them.

- **EVEJS Launcher's Docker mode** adds two Compose files and the project
  `evejs` (the prefix of container names such as `evejs-server-1`):

  ```sh
  python3 install.py /path/to/evejs --project-name evejs \
    --compose-file .evejs-launcher/compose.images.yaml \
    --compose-file .evejs-launcher/compose.mods.yaml
  ```

- **Server Panel** keeps its base file in a sibling `deploy` folder and needs
  the app's `.env` named explicitly. Read the project name from an existing
  container first; using the wrong one silently operates on an empty project.

  ```sh
  docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' evejs-playerbots-addon
  python3 install.py /path/to/evejs --base-compose ../deploy/compose.yaml \
    --project-name evejs-serverpanel --env-file .env
  ```

To run Compose yourself, use the same files in the same order, with the
add-on's override last:

```sh
docker compose -f compose.yaml -f addons/playerbots/compose.override.yaml ps server playerbots-addon
```

### Applying an update

Run the new release's `install.py` against the same EveJS folder, then
rebuild:

```sh
python3 install.py /path/to/evejs --start
```

The installer recognises every file it wrote last time, so an ordinary
upgrade needs no extra options. It stops only on server files someone changed
by hand since the last install, lists them, and replaces them (after backing
them up) when you re-run with `--replace-conflicts`. A release that changes
server files does nothing until the server image is rebuilt; `--start` and
`playerbots.py rebuild` do that.

Rebuilding never touches Market or the database volumes.

### Rolling back

Stop the bots and the server (`playerbots.py stop --all`), then run
`python3 rollback.py /path/to/evejs` from the release folder. Rolling back to
a release from before `playerbots.py` existed also removes that script, so
rebuild and start the restored version with Compose directly:

```sh
docker compose -f compose.yaml -f addons/playerbots/compose.override.yaml build init
docker compose -f compose.yaml -f addons/playerbots/compose.override.yaml up -d --no-deps server
docker compose -f compose.yaml -f addons/playerbots/compose.override.yaml up -d --no-deps playerbots-addon
```

Start the bots only once `ps server` shows it healthy. The
script restores the latest installer-managed source files and `.env` from the
matching timestamped backup. If any installed file changed after setup, it
stops and reports the conflict rather than replacing the new content.

For a manual rollback, restore the files listed in the install's
`.playerbots-install-state.json` from its `backupDirectory`, remove
`addons/playerbots/compose.override.yaml`, and remove the package files from
`addons/playerbots`. If the add-on generated the token and no longer needs to
run, remove only the `EVEJS_PLAYER_BOTS_ADDON_TOKEN` line from `.env`. Keep the
backup directory until the rollback is confirmed.

### Delete all bots and start over

**Delete all bots** at the bottom of the Settings page removes every playerbot.
Type `DELETE ALL BOTS` to confirm. Autonomous work and seeding switch off,
then pilots are removed five at a time: their market orders are cancelled (buy
order escrow returns to their wallet), their operation and industry cycle are
closed, they go off line, their roster entry is removed and their character
is deleted through the normal EveJS character deletion, which hands their
assets to their corporation. Bot corporations left without members keep their
record and assets but are not reused, so a new roster founds new
corporations. Human characters and corporations with human members are not
touched. With **Seed a new roster when the reset finishes** ticked, work and
seeding switch back on afterwards. A reset interrupted by a restart carries on
when the Settings page is opened again. It cannot be undone.

### Keeping the API private

The Compose override does not publish port `26004`. Confirm the rendered
configuration before deployment:

```sh
docker compose -f compose.yaml -f addons/playerbots/compose.override.yaml config --quiet
docker compose -f compose.yaml -f addons/playerbots/compose.override.yaml port server 26004
```

The second command should print no host binding. The API accepts bearer-token
requests only, except for its minimal internal health endpoint.

## Roster and population

### Roster size and online limit

A fresh install grows the roster gradually toward **500** pilots, keeps at
most **300** online at once and allows **30** bots per solar system. Change
these on the dashboard's **Settings** page; changes apply without a restart,
are saved in the game store, and win over `.env`. The code's hard limits are
15,000 pilots, 5,000 online and 300 per system; the larger values have not
been proven at sustained scale, so raise them in stages while the
Performance page stays healthy. On a four-core host with 500 bots online the
space tick ran about once a second instead of ten times, which is why the
online default is 300.

Bots above the online limit stay in the roster and take turns over the
connection rotation (8 hours by default). Human fleet control,
human-connected corporations and active work get priority within the limit.

Starting values can also be set in `.env` before the first start:

```dotenv
EVEJS_PLAYER_BOTS_TARGET=500
EVEJS_PLAYER_BOTS_ROSTER_CEILING=1500
EVEJS_PLAYER_BOTS_MAX_ONLINE=300
EVEJS_PLAYER_BOTS_MAX_PER_SYSTEM=30
EVEJS_PLAYER_BOTS_ROSTER_SEED_ENABLED=1
EVEJS_PLAYER_BOTS_CONNECTION_WINDOW_MS=28800000
EVEJS_PLAYER_BOTS_MAX_CONCURRENT_WORK=5000
EVEJS_PLAYER_BOTS_ADDON_CONCURRENCY=16
EVEJS_PLAYER_BOTS_DIRECTOR_THINK_MIN_MS=90000
EVEJS_PLAYER_BOTS_DIRECTOR_THINK_MAX_MS=210000
EVEJS_PLAYER_BOTS_DIRECTOR_INITIAL_SPREAD_MS=90000
EVEJS_SCHEDULER_MAX_CONCURRENT_DISPATCH=24
```

Recreate the services after editing `.env` (`playerbots.py restart`). The
[README](README.md#settings) lists every variable with its default.

### Seeding

The add-on creates pilots in small batches (5 every 15 seconds by default,
at most 10 per batch) after the server has taken two load samples. It yields
between pilots and pauses by itself above 250 ms event-loop p95, 900% server
CPU (100% is one CPU core; the default threshold is 85%), or when one pilot
takes over a second to create. Settings and `.env` can
make seeding more cautious but cannot raise those caps. The seeder never
removes bots; a roster above the target is reported and left alone.
`/playerbots seed <30-15000>` (staff) sets the target and switches seeding on;
it does not create pilots in one go. Startup seeding is off unless
`EVEJS_PLAYER_BOTS_STARTUP_SEED_BATCH_SIZE` (1–25) asks for one small batch.

To let a large roster seed before the bots start working, switch
**Autonomous work** off on the Settings page (or `/playerbots autowork off`)
and turn it back on when seeding is done.

### Corporations

Each pilot joins a corporation for its specialty: trade, industry, planetary,
security, piracy or sovereignty. Corporations are planned as shards of about
250 bots, at most 300; a new one opens as a specialty grows, and existing
shards are filled first. A human who takes the CEO seat of a bot corporation
counts as one extra member. Bot CEOs train the member-limit skills, and the
persisted member limit follows them.

Bots in a player-led corporation pay it 75% of their cumulative net profit
(wallet earnings minus business costs, with the 1 billion ISK starting grant
counted as capital, not loss). Bots in a bot-led corporation pay it 35% of
each profitable job.

### Work limits and director timing

The active-work ceiling defaults to 5,000, matching the online hard maximum, so
the connection scheduler does not leave connected pilots without an assignment
solely because of a lower work cap. The director resumes paused jobs and starts
new ones in waves of at most 20 per pass; this bounds the burst while the roster
fills. Set `EVEJS_PLAYER_BOTS_MAX_CONCURRENT_WORK` or the matching dashboard
setting below the online population only when intentionally queueing some
pilots behind a lower active-work ceiling.
The dashboard's add-on cycle interval controls both how long the sidecar waits
after a pass and when EveJS permits the next pass; lowering it takes effect
without waiting for an old five-minute deadline.
`EVEJS_PLAYER_BOTS_ADDON_CONCURRENCY` accepts 1–100 simultaneous per-pilot
steps during roster maintenance; its default is 16.
The three `EVEJS_PLAYER_BOTS_DIRECTOR_*` values control the independent
decision cadence. The minimum is clamped to 15,000 ms; the maximum is clamped
to at least the minimum; and the first-decision spread is clamped to 1,000 ms.
Set the minimum and maximum to the same value for a fixed recurring interval.
`EVEJS_SCHEDULER_MAX_CONCURRENT_DISPATCH` sets the durable scheduler's global
dispatch limit (1–128), including playerbot movement, mining, industry, and
other scheduled EveJS work. The add-on Compose override defaults it to 24.
Monitor overdue scheduler jobs and client response times after changing it;
return to 16 if client actions start taking longer.
The release ZIP overlays both the scheduler supervisor and its EveJS worker so
this setting reaches the process that dispatches jobs on the supported base.

`EVEJS_PLAYER_BOTS_ADDON_MODE=disabled`
turns off the API provider; stop `playerbots-addon` as well. Do not remove the
token if the server and add-on are expected to reconnect.

### Settings page defaults

Every field on the dashboard's Settings page shows its default underneath.
The default is the add-on's built-in value, or the installation's value when
it is set in the add-on environment file (`.env`). **Reset to defaults** puts
every field back to its default and saves, after a confirmation; the page
then reads the settings back and reports anything that was not applied.

The **Headquarters** panel holds Stay within (jumps of HQ, default 5),
Risk tolerance (default 2, null-sec) and Alliance mode (default 1, karma);
the **Bot fleets** panel holds Bot fleets on/off, Bot fleets at once (20) and
Pilots per bot fleet (5). Each is explained in its own section below.

### Where bots live

Each new bot gets a race, a bloodline of that race and one of the race's
starting schools; the school whose system holds the fewest bots is used, so a
seeding run spreads pilots over the eight starting systems of the four
empires. Names come from the bot's race, and the first name least used by the
roster is preferred. A bot sells, buys and builds from its empire's hub: New
Caldari (Caldari), Amarr (Amarr), Dodixie (Gallente) or Hek (Minmatar). Bots
created before 0.2.146 keep New Caldari. When a system is over its bot limit,
a relocating pilot takes the least crowded system within four jumps of the
nearest free one.

## The dashboard

### Pages and access

The add-on serves the playerbot dashboard without login on port
`8080`. Docker publishes it on `127.0.0.1:8080`; open `http://127.0.0.1:8080`
on the EveJS host, or use the SSH tunnel below. The dashboard can command
pilots and corporations, so publish it more widely
(`EVEJS_PLAYER_BOTS_DASHBOARD_BIND=0.0.0.0`) only on a trusted network.

The dashboard has ten pages, grouped in the menu as Monitor, Manage and Help. **Activity** shows one state per pilot (working,
travelling, holding, queued, cooling down, paused, standing by, idle,
offline), what each pilot is doing in plain words, and why the rest are not
working, with a pilot panel that gives per-pilot orders (pause, resume, stop
or resume an operation, mine, PI colony, combat patrol, ship upgrade, recall
to the corporation HQ). **Corporations** lists bot corporations and opens a
page per corporation with tabs: Overview (HQ, output deposit, priorities,
orders: recall, send to work, pause, resume, cancel), Pilots (a selectable
roster for orders to chosen pilots), Logo, and Command log. Recall and work orders, from the dashboard
or `/bots corp`, are saved and re-issued about a minute after a restart
(`EVEJS_PLAYER_BOTS_ORDER_RESTORE_DELAY_MS`). **Alliances** lists bot alliances and alliance plans and sets up new ones
(see [Bot alliances](#bot-alliances)). **Fleets** puts the bots in your
in-game fleet to work and shows the bots' own fleets (see
[Fleet duty](#fleet-duty-dashboard-fleets-page)). **Reputation** lists
grievances, hostility, wars and the bots' security status (see
[Grievances, hostility and war](#grievances-hostility-and-war)). **History**
is the operation archive, **World** holds systems, territory and the
killboard, and **Performance** and **Settings** are as described below.

The dashboard is black by default with an optional white mode, and works on a
phone. Across every page: <kbd>Ctrl</kbd> <kbd>K</kbd> searches pilots,
corporations, pages, guide topics and commands; <kbd>G</kbd> then a letter
opens a page (<kbd>A</kbd> Activity, <kbd>W</kbd> World, <kbd>H</kbd>
History, <kbd>P</kbd> Performance, <kbd>C</kbd> Corporations, <kbd>N</kbd>
Alliances, <kbd>F</kbd> Fleets, <kbd>R</kbd> Reputation, <kbd>S</kbd>
Settings, <kbd>G</kbd> Guide); <kbd>R</kbd> refreshes, <kbd>L</kbd> pauses
live updates, <kbd>W</kbd> shows or hides the watch panel, <kbd>T</kbd>
switches black and white mode and <kbd>?</kbd> lists every shortcut. The
watch panel on wide screens shows the server at a glance, pinned pilots and
the latest operations. The pilot list and History export the current filters
as CSV. Theme, refresh interval and pinned pilots are kept in the browser's
local storage; nothing is sent to the server.

Killboard ship renders are fetched from the official EVE image service by a
size-limited same-origin dashboard proxy. This avoids mixed-origin and
embedded-browser image restrictions; the add-on host needs outbound HTTPS to
`images.evetech.net`. Render responses are cached in memory for six hours.

To reach it from another computer without opening it to the network, use an SSH tunnel:

```sh
ssh -L 8080:127.0.0.1:8080 user@evejs-host
```

Then open `http://127.0.0.1:8080` on that computer. The private bearer token and
game database are not exposed. Operations are searchable and paginated across
active records and the durable terminal history. Open a record to inspect its
steps, locations, ship, results, and financial totals. The Settings page edits
bounded runtime values. The same page can enable or pause gradual roster
seeding, choose the bounded batch size and interval, and show batch history,
EveJS event-loop delay, and CPU load. Seeding runs from the separate add-on
process and uses an authenticated internal API. It waits for two load samples,
yields between pilots, and automatically backs off above hard caps of 250 ms
event-loop p95, 900% process CPU, or 1,000 ms for a single pilot creation.
Dashboard and environment values can lower these limits but cannot raise them.
The staff `/playerbots seed <target>` command enables this worker rather than
doing synchronous bulk work. Startup roster seeding is off by default; an
operator may opt into one explicit small startup batch with
`EVEJS_PLAYER_BOTS_STARTUP_SEED_BATCH_SIZE` (1–25).
The same event-loop and CPU measurements automatically reduce active addon
work to four, two, or one concurrent pilot step as the server crosses its
fixed load bands; raising the configured concurrency does not override them.
Keep roster seeding paused whenever game login, undocking, scene ticks, or
dashboard reads show material delay. A configured safety threshold is a
back-pressure trigger, not evidence that the server is responsive; resume in
small batches only after a live profile and player-facing latency checks pass.
Within each specialty the seeder fills already founded corporations first and
balances their growth by quota. It does not open another shard while an
existing one has planned bot seats. This applies to managed corporations whose
CEO is human as well; monitor the Corporation view to confirm existing corps
receive the growing roster.

Activity reports connected playerbots and human pilots separately from
actors in space. The Territory view summarizes fleets and bot/human membership,
active wars, structures missing Quantum Cores or running low-power, and claimed
sovereignty systems. Pilot tables are paginated at 100 rows per request, and
the aggregate snapshot is cached for 30 seconds. The dashboard refreshes live views every 15 seconds while visible.

### Corporation logos

Any player or bot corporation (ID 2,000,000 or above) can have a picture logo.
On the corporation's page, the **Logo** panel takes a PNG, JPEG, WebP or GIF
of up to 20 MB. The browser centres it on a transparent square and makes PNGs
at 32, 64, 128, 256, 512 and 1024 pixels; the server checks that each is a PNG
of the right size (at most 2 MB) and stores them where EveJS keeps runtime
images, as `Corporation/<corporationID>_<size>.png` beside the alliance logos.
**Remove logo** deletes all six files. Uploads go through the same
same-origin check and private API token as the other dashboard orders.

Logos show next to the corporation's name across the dashboard: the
corporation list and page, pilot rows, the pilot panel, History and the
killboard. The dashboard serves them through the add-on API, so this works
with or without anything else installed.

The game client is different: it always draws a player corporation from its
emblem layers and never asks the image server for a picture. The separate
[corporation-logo add-on](https://github.com/ubermidas/evejs-corporation-logos) (`evejs-corporation-logos`) adds a small
client patch to EveJS's login script so corporations with a PNG are drawn
from it, and makes sure the image server serves the stored PNGs. Install it
once per server with its `install.py`, then rebuild. With that add-on installed, the
Logo panel says so. A corporation's first logo shows from each player's next
login; a changed logo shows within an hour, when the client re-checks its
cached copy (clearing the client's `Pictures\Corporations` cache shows it at
once).

### Corporation and alliance name library

Open **Settings → Corporation and alliance names**, paste a name library and
press **Save name library**. **Load template** only fills the editor; it does
not save. Errors appear next to the buttons and leave the previous library
active. The basic template is `doc/name-library-template.json` in the source
repository. Each empire (`amarr`, `caldari`, `gallente`, `minmatar`) has just
two arrays, `corporations` and `alliances`, containing ASCII names.

Empty arrays keep original naming. Alliances founded automatically take
famous science-fiction names first (see [Bot alliances](#bot-alliances)) and
use the `alliances` arrays only when none of those are free. Nonempty arrays
are used in order when new organizations are founded, skipping occupied names and abbreviations.
If none remain, add more names; numeric suffixes are not added to custom
names. Existing organizations and pending alliance plans are left alone.
The founder's race selects the naming style; specialties, membership and
director work are unchanged. New descriptions use the existing English
specialty label, with `Sovereignty` for automatically founded alliances.

The game process saves one UTF-8 file, `playerbots-name-library.json`, under
its resolved persistent GameStore root. Preserve that file with the server's
data backups. Saving an empty template restores original naming for future
organizations. The dashboard uses its existing management access boundary;
this is not an anonymous public upload service.

### Fleet duty (dashboard Fleets page)

The person leading a fleet (the fleet commander, or FC) can put the fleet's
bots to work from the dashboard's **Fleets** page:

1. Form a fleet in game and add bots with `/playerbots fleet add <bot>`.
2. On **Fleets**, choose the kind of fleet: **Mining**, **Combat**,
   **Hauling** or **Escort**, and optionally a saved fitting for it.
3. Press **Start fleet duty** (tick bots first to use only some of them).

Each bot then:

| Step | What it does |
| --- | --- |
| Fit up | A bot whose ship cannot do the job fetches one: the FC's saved fitting if set, otherwise the built-in Playerbots fit (an owned hull is reused where possible). After two failed tries it follows the FC without working. |
| Meet the FC | Travels to the FC's system and docks where the FC is docked. |
| Undock | Undocks within a few seconds of the FC. |
| Warp | Recalls drones and warps to the FC once the FC lands. |
| Work | **Mining:** lasers and mining drones; a hold over 90% full goes into the FC's fleet hangar (the FC must allow fleet access), otherwise into a jet can next to the FC. **Combat:** the FC's locked target, then every rat on grid, with drones, fighters and guns. **Hauling:** empties fleet members' jet cans and delivers to the FC's fleet hangar, in space or docked together. **Escort:** stays within 2.5 km of the FC and fights rats within 30 km. |
| Stay alive | A badly damaged bot docks at the nearest station, repairs and rejoins. |

Bots on fleet duty get no director work, are never queued for work capacity,
and stay connected. **Stand down** ends the duty for every bot; it also ends
when a bot leaves the fleet or the FC has been offline for 15 minutes. **Call
in busy bots** stops the bots' own work so they join now. The FC's choices are
saved per FC and apply to the next fleet they lead. Fleets do not survive a
server restart, so form the fleet again after one.

### Bot-led fleets

Bot corporations also form fleets on their own. About once a minute, a bot
already mining from a station or ratting (security patrol) in a system becomes
fleet commander and brings in up to four corpmates: other miners working from
the same station, and idle corpmates docked in that system with a ship for the
job. The corpmates fly fleet duty behind the commander as above. The commander
waits for its pilots before undocking (up to 2 minutes) or warping off (up to 1
minute). Without a fleet hangar, full miners stay with the commander and unload
into their own hangars when the fleet docks. A fleet breaks up when the
commander's job ends, it is offline for 5 minutes, its pilots leave, or after
about three hours. The dashboard shows these fleets read-only.

**Escorts for capital haulers.** A trader flying a Freighter or Jump Freighter
that sets off on a haul (a trade run, an order delivery, a sale, a haul or a
courier contract) leads an escort fleet: up to four combat corpmates, first
idle ones docked within three jumps, then security pilots on their way to a
patrol, who drop it. The hauler waits for its escort to dock with it before
undocking (up to 5 minutes) and, in each system on the route, for the escort
to catch up before it takes the next gate (up to 90 seconds). Bot-led mining
and combat fleets wait at gates too, for up to a minute.

## Chat commands

This guide covers the commands exposed by the EveJS Playerbots add-on. Commands
are entered in EVE chat. Replace values in angle brackets with the relevant
bot name, character ID, item ID, type ID, station ID, solar-system ID, or task
ID. A bot name containing spaces is accepted where `<bot>` is shown.

Managed pilots are ordinary EveJS character records controlled by the server.
They have no player login account. Commands can control a bot in your
corporation or fleet; staff/admin can control any managed bot. Market actions
use the bot's own wallet and inventory unless a command explicitly selects
corporation assets. The initial 1,000,000,000 ISK grant is protected from
manual fitting and structure spending.

The web dashboard is available at `http://127.0.0.1:8080` on the EveJS host
without a login. Activity shows what every pilot is doing and why the rest are
not working; Corporations gives recall, work, HQ, deposit, priority and
per-pilot orders; History, World (systems, territory, killboard), Performance
and Settings cover the rest. See [The dashboard](#the-dashboard).

### Command reference

Every chat command in one place, grouped as on the dashboard's Guide page.
`<bot>` is a bot's name or character ID. Commands that change a bot work on
bots in your corporation or fleet; staff can command any bot. Commands marked
CEO/staff or staff need that authority. The sections after this one explain
each group in detail. Fleet duty, bot alliances and reputation are run from
the dashboard (Fleets, Alliances and Reputation pages) and have no chat
command; trade hauler upgrades and gate camps use `upgrade ... trade` and
`combat ... gate-camp`.

**Roster and status**

| Command | What it does |
| --- | --- |
| `/playerbots status` | Roster size, target and corporation counts |
| `/playerbots list [filter]` | Pilots with specialty and corporation |
| `/playerbots inspect <bot>` | Everything about one bot (e.g. `/playerbots inspect Zara Vex`) |
| `/playerbots ops [page]` | Live roster, 10 pilots per page (e.g. `/playerbots ops 1`) |
| `/playerbots ops systems [page]` | Totals per solar system |
| `/playerbots ops [page] system <systemID>` | Pilots in one system (e.g. `/playerbots ops 1 system 30000142`) |
| `/playerbots tasks [queued\|leased\|completed\|failed\|canceled]` | Saved work tasks |
| `/playerbots orders` | Player buy orders bots can fill |
| `/botlocal [all]` | Bots in your system, or everywhere |
| `/playerbots seed [30-15000]` | Set the roster target and start seeding (staff) (e.g. `/playerbots seed 1000`) |

**Directing work**

| Command | What it does |
| --- | --- |
| `/playerbots autowork [status\|on\|off]` | Show or switch automatic work (on/off: staff) |
| `/playerbots pause <bot>` | Pause one bot |
| `/playerbots resume <bot>` | Resume one bot |
| `/playerbots corp pause` | Pause the bots in your corporation |
| `/playerbots corp resume` | Resume the bots in your corporation |
| `/playerbots op status\|stop\|resume <bot>` | Check, stop or resume a bot's current job (e.g. `/playerbots op status Zara Vex`) |
| `/playerbots mine <bot> [trips] [station <id>] [norefine] [nosell]` | Go mining (e.g. `/playerbots mine Zara Vex 3`) |
| `/playerbots colony <bot>` | Set up a PI colony |
| `/playerbots haul <bot> <itemID\|typeID> <from> <to> [quantity]` | Move goods between stations |
| `/playerbots upgrade <bot> [mining\|logistics\|security\|piracy\|sovereignty\|trade] [force]` | Buy and fit the next ship on a ladder (trade: the hauler line up to the Jump Freighter) (e.g. `/playerbots upgrade Zara Vex mining`) |
| `/playerbots route <bot> <system>` | Travel by stargate (e.g. `/playerbots route Zara Vex Dodixie`) |
| `/playerbots undock <bot>` | Undock |
| `/playerbots warp <bot> <entityID>` | Warp to something nearby |
| `/playerbots dock <bot> <stationID>` | Dock at a station |
| `/playerbots task cancel\|retry <taskID>` | Cancel a queued task or retry a failed one |

**Corporations**

| Command | What it does |
| --- | --- |
| `/bots corp recall [corpID] [station\|structure <id>]` | Everyone home and hold (e.g. `/bots corp recall`) |
| `/bots corp work [corpID] [auto\|mine\|pi\|director] [trips <n>]` | Lift the hold and start work (e.g. `/bots corp work mine trips 3`) |
| `/bots corp status [corpID]` | Who is home, held, travelling or working |
| `/bots corp hq [corpID] [list \| set <id> \| clear]` | Show or change headquarters (CEO/staff) |
| `/bots corp deposit [corpID] [status\|on\|off\|auto\|deliveries\|hangar <1-7>]` | Where mined and PI goods go (CEO/staff) (e.g. `/bots corp deposit hangar 2`) |
| `/bots corp inviteall [status\|cancel]` | Recruit eligible bots into the target corporation (e.g. `/bots corp inviteall`) |
| `/bots corp help` | Corporation help in game |

**Fleets and fittings**

| Command | What it does |
| --- | --- |
| `/playerbots invite <bot>` | Invite a bot to your corporation |
| `/playerbots join <bot>` | Ask a bot's corporation to invite you |
| `/playerbots fleet add <bot>` | Add a bot to your fleet |
| `/playerbots fleet join <bot>` | Ask a bot to invite you to its fleet |
| `/follow [me\|<name>\|stop]` | Fleet chat: follow you or someone else (e.g. `/follow`) |
| `/escort [me\|<name>\|stop]` | Fleet chat: security bots escort (e.g. `/escort`) |
| `/attack [all\|<bot>]` | Fleet chat: attack your latest locked target (e.g. `/attack`) |
| `/attack stop [all\|<bot>]` | Fleet chat: call off the attack (e.g. `/attack stop`) |
| `/playerbots fit <bot> <fittingID\|link> [maxISK]` | Fit a bot from a saved fitting |
| `/fitbot <fittingID\|link> [maxISK]` | The same, in a private chat with the bot |
| `/playerbots fund <bot> <ISK>` | Give a bot some of your ISK (max 1B per transfer) |

**Industry, PI and trade**

| Command | What it does |
| --- | --- |
| `/playerbots industry cycle start <bot> <blueprintTypeID> <runs> <maxISK> [station <id>] [floor <ISK>] [corp <hangar> <wallet>]` | Run a manufacturing cycle |
| `/playerbots industry cycle status\|stop\|resume <bot>` | Manage the cycle |
| `/playerbots industry list\|blueprints\|jobs <bot>` | Blueprints and jobs |
| `/playerbots industry auto set <bot> <blueprintItemID> <runs> <maxISK>` | Automatic in-place manufacturing |
| `/playerbots industry auto status\|off <bot>` | Check or stop it |
| `/playerbots task pi <bot>` | Queue PI extractor upkeep |
| `/playerbots pi export set <bot> <planetID> <maxUnits> <maxTaxISK>` | Recurring PI exports |
| `/playerbots pi export status\|off <bot> <planetID>` | Check or stop exports |
| `/playerbots trade quote <bot> <typeID>` | Best local prices (e.g. `/playerbots trade quote Zara Vex 34`) |
| `/playerbots trade buy <bot> <typeID> <qty> <maxUnitPrice>` | Buy now |
| `/playerbots trade sell <bot> <itemID> [qty] <minUnitPrice>` | Sell now |
| `/playerbots trade autosell set <bot> <typeID> <minUnitPrice> <maxUnits>` | Keep selling |
| `/playerbots trade autobuy set <bot> <typeID> <maxUnitPrice> <targetStock> <maxSpendPerCycle>` | Keep restocking |
| `/playerbots trade autosell\|autobuy status\|off <bot>` | Check or stop a trade rule |
| `/playerbots courier post <issuer> <carrier> <from> <to> <itemID> <qty> <reward> <collateral>` | Courier contract between two bots |

**Combat and territory**

| Command | What it does |
| --- | --- |
| `/playerbots combat <bot> [security\|war\|piracy\|nullsec-conflict\|gate-camp]` | Combat patrol; gate-camp holds a gate in the HQ system (e.g. `/playerbots combat Zara Vex security`) |
| `/playerbots sovereignty <bot>` | Sovereignty work |
| `/playerbots build <bot> <structurePackageItemID> [nullSystemID]` | Deploy a structure in null-sec |
| `/playerbots alliance found <CEO bot>` | Found an alliance |
| `/playerbots defense status\|events\|set <json>\|off\|cancel <id>` | Optional local defense (staff) (e.g. `/playerbots defense status`) |

### Inspect the roster and work

| Command | Use |
| --- | --- |
| `/playerbots` or `/playerbots status` | Show the roster target, total, and specialty corporation counts. |
| `/bots` | Alias for `/playerbots`. |
| `/playerbots list [filter]` | List pilots, specialties, and corporations; an optional filter narrows the results. |
| `/playerbots inspect <bot>` | Show a bot's corporation, fleet, location, wallet, ships/items, PI colonies, current operation, queued work, and last completed task. |
| `/playerbots ops` | Show the saved autonomy summary and first live roster page. Each row includes character ID, system and system ID, station/structure, ship, wallet, work, and operation stage. |
| `/playerbots ops <page>` | Show another roster page (10 bots per page). |
| `/playerbots ops systems [page]` | Page through system totals, including connected, in-space, docked, and inactive actors. |
| `/playerbots ops system <solarSystemID>` | Show bots in one solar system. |
| `/playerbots ops <page> system <solarSystemID>` | Show a page of bots within a system. |
| `/playerbots tasks [queued|leased|completed|failed|canceled]` | Inspect durable work tasks; omit the filter to show the default queue view. |
| `/playerbots orders` | List player buy orders the bots can fulfill and the bot assigned to each. |
| `/botlocal` or `/botlocali` | Count and locate bots in your current system. |
| `/botlocal all` | Summarize bot locations across systems. |

The `idle` roster label does not mean the bot has no director work. Use
`/playerbots ops`, `/playerbots tasks`, and `/playerbots op status <bot>` to see
the actual assignment and durable operation state.

### The operations overview

`/playerbots ops` returns the compact saved automation overview as one chat
message. It avoids reading every character, wallet, operation, and solar-system
location before replying. Use `/playerbots ops 1` for the live bot roster,
`/playerbots ops systems 1` for the paged system distribution, and
`/playerbots ops system <solarSystemID>` to inspect bots in one system. Roster
pages retain current character, corporation, system, ship, wallet, and work
details. The server log records each overview request and its response time so
remote chat delivery can be checked without guessing at host load.

### Autonomous work and operation control

| Command | Use |
| --- | --- |
| `/playerbots autowork` or `status` | Show the autonomous director state. |
| `/playerbots autowork on` / `off` | Enable or disable the director (staff/admin only). Startup default is on; `EVEJS_PLAYER_BOTS_AUTOWORK=0` disables it at startup. |
| `/playerbots pause <bot>` / `/playerbots resume <bot>` | Pause or resume one bot's autonomous work. |
| `/playerbots corp pause` / `/playerbots corp resume` | Pause or resume controlled bots in your current corporation. |
| `/playerbots op status <bot>` | Inspect the bot's current durable operation. |
| `/playerbots op stop <bot>` / `resume <bot>` | Stop or resume its current operation. Check wallet and inventory first if it is in `review`. |
| `/playerbots mine <bot> [trips] [station <stationID>] [norefine] [nosell]` | Mine from asteroid belts, return when full or after the trip limit, unload and optionally refine/sell. `norefine` retains ore; `nosell` retains output for industry or later work. |
| `/playerbots colony <bot>` | Set up a passive PI colony. Once setup completes, the pilot returns to normal work; scheduled PI collection/export can be done independently. |
| `/playerbots haul <bot> <itemID|typeID> <fromStation> <toStation> [quantity]` | Haul personal hangar goods through the ship cargo hold, obeying capacity and route rules. |
| `/playerbots upgrade <bot> [mining|logistics|security|piracy|sovereignty|trade] [force]` | Buy and fit the next role-appropriate ship (`trade`: the hauler line up to the Jump Freighter; see [Trade haulers](#trade-haulers)). The old hull stays in the hangar. `force` bypasses the normal minimum wallet threshold, but purchases still use the bot wallet. |
| `/playerbots route <bot> <systemID|exact system name>` | Queue a durable stargate route; the bot undocks as needed and retries travel stages. |
| `/playerbots undock <bot>` | Undock a bot you control. |
| `/playerbots warp <bot> <entityID>` | Order a local warp to an entity. |
| `/playerbots dock <bot> <stationID>` | Order a dock using normal access and docking checks. |

Mining, hauling, sales, PI, industry, combat, and travel operations persist
their stages across restarts. A `holding` or `review` state is visible in
`/playerbots ops` and `/playerbots op status`; the server does not blindly
repeat an unconfirmed purchase.

#### Mining and belt security

Miners lock an ore asteroid before activating their mining lasers. While in a
belt, they scan pirate NPC ships visible in their current grid within 250 km.
If the scan finds no rats, they keep mining without requesting or waiting for
an escort. If rats are visible, a security bot with a complete, online combat
fit for that system's risk is sent toward the belt while mining continues. The
required fit tier rises as system security falls; unknown system security
requires the strongest tier. The same corporation is preferred, then the
strongest fit that meets the requirement. A recent rat request takes priority
when a suitable security bot finishes its current operation; an insufficient
fit is upgraded first only when its skills, wallet, and profit allow it. A
missing eligible escort does not stop mining.
An empty belt is normal: belt rats are rolled on arrival by EveJS when enabled,
with a 25% default chance in high security. The scan reports current visible
rats; it does not create rats or treat an empty belt as a threat.

Stale armour/hull damage and NPCs outside the visible grid do not count as an
attack. During a mining trip, hostile activity causes a retreat only after the
mining ship or its assigned escort is destroyed. A full ore hold and the
normal trip time limit still send the miner home. `/playerbots op status
<bot>` reports the latest visible rat count and escort fit tier; its history
shows the asteroid approach, lock, laser activation, and cargo yield.

### Give a bot a saved fitting

The bot must be in your corporation or fleet, unless you are staff/admin. Save
the fit in the EVE fitting window or use a public community fitting, then send
one of these in a private chat with the bot:

```text
/fitbot <fittingID|fitting-link> [maxISK]
```

You can also send the fitting ID by itself, or a chat link containing
`fitting:<ID>` / `fittingID=<ID>`. From another chat, use:

```text
/playerbots fit <bot> <fittingID|fitting-link> [maxISK]
```

The fitting must be public, owned by you, or owned by a corporation/alliance
you share with the bot. The bot checks its trained skills and saved slot
assignments before buying anything, travels to safe market stock, acquires the
hull and missing fit items, then boards and fits the ship. The optional
`maxISK` caps spending. The bot will not spend its initial 1B ISK grant; only
wallet balance above that reserve is available for the fit. Modules, drones,
fighters, and fitting ammunition that fits in the standard cargo hold are
handled. Fitting ammunition is moved to the hull's standard cargo hold,
including charges saved in a weapon slot; load it into weapons through the
normal ship UI after delivery. A fitting that requires untrained skills or
unsupported item locations is rejected before purchase.

### Fleets and corporations

| Command | Use |
| --- | --- |
| `/playerbots invite <bot>` | Invite the bot to your corporation. Normal corporation permissions and roster limits apply; the bot accepts eligible invitations. |
| `/playerbots join <bot>` | Ask that bot's specialist corporation to invite you. Accept the invitation in the client. |
| `/playerbots fleet add <bot>` | Add the bot to your fleet; the bot accepts. |
| `/playerbots fleet join <bot>` | Ask the bot to form/join a fleet and invite you. Accept in the client. |

In fleet chat, issue movement orders to the managed bots that are members of
that fleet:

| Fleet-chat command | Use |
| --- | --- |
| `/follow` or `/follow me` | Follow your ship; all eligible playerbots in the fleet receive a durable order. |
| `/follow <exact fleet character>` | Follow another online human member of the same fleet. |
| `/follow stop` | Stop the bots' follow orders and return them to director-assigned work. |
| `/escort` or `/escort me` | Have fitted security-specialty bots follow your ship at close range. |
| `/escort <exact fleet character>` | Escort another online human member of the same fleet. |
| `/escort stop` | Stop only the escort orders. |
| `/attack` or `/attack all` | Order every fitted playerbot in your fleet to attack the most recently acquired target lock on your ship. |
| `/attack <exact bot name>` | Order one fitted fleet bot to attack your most recently acquired target lock. |
| `/attack stop` or `/attack stop all` | Recall drones and withdraw all attack orders you issued in this fleet. |
| `/attack stop <exact bot name>` | Recall drones and withdraw one of your attack orders. |

Follow orders route through stargates to the target's current system, then use
normal warp, approach, and docking authorities. The order tracks the target as
they move. If the fleet dissolves or no human remains, the order ends and the
bot returns to autonomous work. Mining can be stopped with its cargo preserved;
an industry cycle, combat withdrawal, courier package, or unresolved purchase
is allowed to reach a safe checkpoint before that bot accepts the movement
order. `/escort` only selects security bots with a validated combat fit; it
does not start an attack by itself. Fleet `/attack` uses the last target in your
lock sequence because EveJS does not expose a separate selected-target field
to chat commands. It accepts only a ship, never a capsule. Every bot must have
a validated security or piracy fit, and its own war, null-sec conflict, pirate
NPC and Crimewatch policy must allow that target; an illegal target is refused.
Bots approach or warp to the target, lock it through EveJS targeting, and engage
their fitted combat drones through the drone service. A disconnected commander,
dissolved fleet, changed/docked target, or revoked target legality triggers a
drone recall and return to the bot's home station. `/attack stop` withdraws only
orders issued by you. Other active mining/industry/combat work is not replaced
by a Fleet attack; mining can stop with cargo preserved.

When a human leaves or disconnects and only bots remain, a bot-only fleet is
dissolved and its members return to autonomous work. Ordinary fleet commands do
not cancel durable bot work; `/follow` and `/escort` are explicit movement
orders with the safe-interruption rules above.

### Corporation-wide orders

`/bots corp` (also `/playerbots corp`) gives orders to every playerbot in a
corporation. Members of the corporation and staff can use it; only the CEO or
staff can change the saved HQ.

```text
/bots corp recall [corporationID] [station|structure <id>]
/bots corp work   [corporationID] [auto|mine|pi|director] [trips <n>]
/bots corp status [corporationID]
/bots corp hq     [corporationID] [list | set <structureOrStationID> | clear]
/bots corp deposit [corporationID] [status | on | off | auto | deliveries | hangar <1-7>]
```

`recall` stops each pilot's work, sends it to the corporation HQ and pauses it
once docked. Recall to an NPC station uses the durable relocation operation;
recall to a corporation structure pauses the pilot at once and steps it there,
without its usual threat responses, so use it in safe space. A pilot whose
structure trip fails is released back to the director. `work` releases the
corporation and starts mining around the HQ (or the nearest safe belts) and
PI setup, or leaves the pilots to the director. `deposit` (CEO or staff)
sends finished mining and PI output to the HQ instead of the market, into the
corporation hangar for the work (see [Corporation hangars](#corporation-hangars)),
one chosen `hangar <1-7>` division, or `deliveries` (Corporation Deliveries,
which EveJS does not show). Recall and work orders, from chat or
the dashboard's Corporations page, are saved in the game store and re-issued
about a minute after the server starts; a recall holds the corporation until
it is sent to work, resumed or the order is cancelled. `status` lists held
pilots that are not at the HQ. Saved HQs are stored in the game store.

### Industry and production

| Command | Use |
| --- | --- |
| `/playerbots industry cycle start <bot> <blueprintTypeID> <runs> <maxISK> [station <stationID>] [floor <ISK>]` | Run a durable personal-wallet manufacturing cycle. The spend cap includes blueprint, inputs, and job fees; the floor defaults to estimated break-even price. |
| `/playerbots industry cycle start <bot> <blueprintTypeID> <runs> <maxISK> [station <stationID>] [floor <ISK>] corp <hangarDivision 1-7> <walletDivision 1-7>` | Run a corp cycle with the selected shared hangar and wallet divisions. It uses stocked inputs only and checks normal Factory Manager, Take, and Trader roles. |
| `/playerbots industry cycle status <bot>` | Show stage, inputs, job, spend, output, proceeds, and history. |
| `/playerbots industry cycle stop <bot>` / `resume <bot>` | Stop or resume a cycle; installed jobs and inventory remain in place. |
| `/playerbots industry list <bot>` or `blueprints <bot>` | List the bot's blueprint assets. |
| `/playerbots industry jobs <bot>` | List the bot's industry jobs. |
| `/playerbots industry auto set <bot> <blueprintItemID> <runs 1-100> <maxISK per job>` | Enable the narrower in-place policy. It requires blueprint, materials, and funds already in personal hangar/wallet. |
| `/playerbots industry auto status <bot>` | Inspect its automatic industry policy. |
| `/playerbots industry auto off <bot>` | Disable the automatic policy. |

Eligible sale output is sold into accessible buy orders or listed outside Jita
when no buyer is available. Bot listings run for the maximum 90 days, have no
playerbot broker/SCC placement fee, and pay transaction tax only when filled.
Jita is the seed market for purchases; new playerbot sell orders are never
placed there.

### Planetary interaction

| Command | Use |
| --- | --- |
| `/playerbots task pi <bot>` | Queue PI extractor maintenance for the bot's own colonies. |
| `/playerbots pi export set <bot> <planetID> <maxUnits> <maxTaxISK>` | Enable recurring exports from an existing colony's command center. The bot pays normal export tax from its wallet. |
| `/playerbots pi export status <bot> <planetID>` | Inspect an export policy. |
| `/playerbots pi export off <bot> <planetID>` | Disable an export policy. |

The colony setup is a finite operation. Once planted, the bot can mine,
manufacture, haul, or sell while the colony produces; it need not wait at the
planet for the production cycle.

### Trade and market policies

| Command | Use |
| --- | --- |
| `/playerbots trade quote <bot> <typeID>` | Show accessible best local buy/sell quotes. |
| `/playerbots trade buy <bot> <typeID> <quantity> <maxUnitPrice>` | Buy immediately from local stock, capped at 100,000 units and 1B ISK per call (one Freighter or Jump Freighter hull may cost up to 20B). |
| `/playerbots trade sell <bot> <itemID> [quantity] <minUnitPrice>` | Sell personal hangar inventory into accessible local buy orders. This does not create a standing order or sell ships. |
| `/playerbots trade autosell set <bot> <typeID> <minUnitPrice> <maxUnits>` | Enable recurring sales of that type from the bot's current hangar. Unsold stock is listed for 90 days at the chosen floor; listing fees are waived. |
| `/playerbots trade autosell status <bot>` / `off <bot>` | Inspect or disable the auto-sale policy. |
| `/playerbots trade autobuy set <bot> <typeID> <maxUnitPrice> <targetStock> <maxSpendPerCycle>` | Enable recurring local restocking under the price ceiling, stock target, wallet, and per-cycle budget. It buys immediately and leaves no open buy order. |
| `/playerbots trade autobuy status <bot>` / `off <bot>` | Inspect or disable the auto-buy policy. |
| `/playerbots fund <bot> <ISK>` | Transfer your own ISK to a bot you control (up to 1B ISK per transfer). |
| `/playerbots courier post <issuerBot> <carrierBot> <startStation> <endStation> <itemID> <quantity> <rewardISK> <collateralISK>` | Publish a private courier contract from the issuer's personal hangar to the named carrier in the same corporation or alliance. The contract authority holds package, reward, and collateral. |

Auto-sale and export tasks reconcile their saved results before retrying after
a restart. If a task reports an uncertain outcome, inspect wallet, hangar,
market orders, and PI launch state before scheduling another one.

### Combat, sovereignty, structures, and alliances

| Command | Use |
| --- | --- |
| `/playerbots combat <bot> [security|war|piracy|nullsec-conflict|gate-camp]` | Start a durable combat assignment in the selected mode. `gate-camp` holds a stargate in the corporation's HQ system against lawful targets (see [Grievances, hostility and war](#grievances-hostility-and-war)). |
| `/playerbots sovereignty <bot>` | Start sovereignty work for an eligible pilot and corporation. |
| `/playerbots build <bot> <structurePackageItemID> [nullSystemID]` | Carry an owned Upwell structure package to a reachable claimable null-sec system and deploy through the normal structure authorities. |
| `/playerbots alliance found <CEO bot>` | Start alliance founding for a corporation's eligible bot CEO. Skill, wallet reserve, and founding fee checks apply. |

Structure anchoring uses ordinary EveJS placement, corporation role, item
consumption, and timer rules. If the current grid is blocked, the carrier
warps beyond a celestial warp-in exclusion zone and retries after checking the
live placement rules. A deployed structure still needs its quantum core,
services, fuel, and online configuration through the relevant game systems.

An eligible first war uses the normal billable corporation-war timer. Its bot
corporations receive the one-time 5B ISK grant; up to five combat pilots can
receive ship stipends from that grant. A funded corporation first cross-trains
safe members already on its roster, then recruits security bots from bot-only
donor corporations if it still needs pilots. Ordinary sale, mining, PI, and
industry work continues while combat skills train. The director waits for the
current work to finish before buying and fitting the strongest hull the pilot
can currently fly and afford. Training progresses from Algos to Vexor,
Myrmidon, and Dominix. `/playerbots ops` shows funded stipends and
cross-mobilized pilots; `/playerbots op status <bot>` shows an individual ship
purchase, fitting, or patrol operation.

### Durable task controls

| Command | Use |
| --- | --- |
| `/playerbots task cancel <taskID>` | Cancel a queued or leased task you control. |
| `/playerbots task retry <taskID>` | Requeue a failed task you control, after checking any saved inventory/wallet reconciliation state. |
| `/playerbots seed [30-15,000]` | Staff/admin: set the target and enable safe gradual seeding within `EVEJS_PLAYER_BOTS_ROSTER_CEILING`; creation runs as bounded background batches. |

For installation, service lifecycle, API configuration, and rollback, see
the [README](README.md) and [Running the server](#running-the-server).

## How the bots work

### Planetary interaction as background work

Planetary work runs in the background so it does not take over the roster.
About one pilot in eight collects launches from colonies, and about one in
twenty sets up new colonies; which pilots is fixed by character ID. Any pilot
still collects its own launches once they are three days old, two days before
a launch container decays, so colonies set up earlier never lose their
output.

### Corporation headquarters

A bot corporation with no dockable structure makes building one its first
priority. Its CEO, directors or delegated caretaker buy an Upwell citadel
(an Astrahus when the specialty has no preferred type), haul it to space and
anchor it before returning to normal work. While a corporation has no
headquarters, those managers stop docked work that is not combat,
sovereignty, alliance courier or fleet work to start the build. The anchored
structure is marked as the corporation's headquarters and gets a randomized
name. It becomes the corporation's mining base and the depot for its
deposits, and its caretaker keeps it fuelled and powered first, then every
other structure the corporation owns.

### Home base

Like players in a corporation, bots live and work around their headquarters.
Home is, in order:

1. a structure chosen with `/bots corp hq set` or on the dashboard;
2. the structure the corporation's bots built and marked as headquarters;
3. an NPC station chosen the same way, only for a corporation with no
   headquarters structure.

A corporation with none of these has no home, and its pilots roam as before.
An HQ nobody can dock at (docking service offline) is no home.

- A docked pilot with no job, more jumps from home than the home range, flies
  home before taking the next one. Traders follow the markets instead.
- Miners base their trips at the headquarters when its system has asteroid
  belts, is high-security (0.45 or better) and, for a structure, the structure
  has a quantum core. Otherwise they use the nearest high-security station
  with belts within range of home.
- Combat pilots look for anomalies starting from home.

| Setting | Default | Environment variable |
| --- | --- | --- |
| Stay within (jumps of HQ) | 5 | `EVEJS_PLAYER_BOTS_HOME_RANGE_JUMPS` (0 to 30; 0 turns home base off) |

### Corporation hangars

Corporation goods go into the corporation's office hangar at headquarters,
where players can open them, not into Corporation Deliveries, which EveJS does
not show. Each kind of work has its own division:

| Division | Name (bot corporations) | Filled by |
| --- | --- | --- |
| 1 | Mining | Ore and minerals from mining deposits |
| 2 | Planetary | PI goods from collection deposits |
| 3 | Industry | Corporation industry cycles, unless a division is given |
| 4 | Trade | Corporation trade orders, unless a division is given |
| 5 | Combat | Reserved for combat work |

Every bot, in a bot-run or a player-run corporation, is given the roles to
view and take from divisions 1-5 and from deliveries, and nothing more (no
director, wallet or other division roles); people's roles are never changed.
A bot-run corporation's CEO rents the office at headquarters the first time
it is docked there with goods to deposit, paid from the corporation wallet,
and the divisions are named as above (names already chosen are kept). A
player corporation rents its own office; until there is one, deposits fall
back to Corporation Deliveries. `/bots corp deposit hangar <n>` sends
everything to one division instead, and `/bots corp deposit deliveries` back
to Deliveries.

### Bot alliances

Bot corporations form alliances through the game's own alliance authority:
the founding corporation's CEO creates the alliance (the add-on trains it in
Empire Control and hands over the 1B ISK fee as an operator grant), the other
CEOs apply, the executor accepts, and membership takes effect after 24 hours.
**Alliance mode** (Settings → Headquarters, `EVEJS_PLAYER_BOTS_ALLIANCE_MODE`):

| Mode | What happens |
| --- | --- |
| 0 | Only the alliances you set up on the dashboard |
| 1 (default) | Karma: corporations hostile to, or at war with, the same corporation, and with no grudge between them, ally (up to six); later allies join the existing alliance |
| 2 | Population: each empire's bot corporations band together at once, four per alliance |

Unless the mode is 0, the first director pass after installing founds one
alliance of two to four bot corporations (same empire first), whose members
join at once instead of after 24 hours, so the world starts with an alliance.
Automatic alliances take famous science-fiction names. The dashboard's
**Alliances** page lists every plan and its progress, and sets up your own:
name, ticker, description, founding corporation, allies and a logo (any
picture, saved as a 128 px PNG and given to the alliance in game).

### Grievances, hostility and war

Bot corporations answer violence the way player corporations do. Every attack
on a bot by another corporation's pilot, bot or person, is an incident (at
most one per attacker and victim every two minutes; NPCs, corpmates and
alliance mates never count). Two incidents in 24 hours mark the aggressor's
corporation hostile for seven days; three bring a war declaration through the
normal war authority, bill and 24-hour timer, when the corporation has a
structure to serve as war headquarters (one attempt every 30 minutes across
the server). Piracy pilots hunting cargo-carrying ships, bots included, start
most of these feuds.

While a corporation is at war or has hostiles, up to three of its security
pilots camp the stargates of its headquarters system, 20 minutes at a time.
They engage war targets and criminal or suspect pilots anywhere, and hostile
corporations only in low and null security space, where it is no crime.

The dashboard's **Reputation** page lists every grievance with its attacks
today and in total, whether the aggressor is hostile or at war, and the bots'
security status. Mark hostile, Declare war and Forgive change a pairing by
hand; Forgive stops further hostility and war from those incidents.

**Risk tolerance** (Settings → Headquarters, `EVEJS_PLAYER_BOTS_RISK_TOLERANCE`,
default 2) sets how far into dangerous space pilots work around their
headquarters: 0 high-sec only, 1 low-sec, 2 null-sec.

### Trade haulers

Trade pilots fly haulers, not mining ships. Each climbs its own race's line,
one step at a time, when it has the ISK:

| Step | Caldari | Minmatar | Amarr | Gallente | Wallet needed |
| --- | --- | --- | --- | --- | --- |
| T1 industrial (Expanded Cargohold IIs) | Tayra | Mammoth | Bestower | Iteron Mark V | 10M |
| Deep Space Transport | Bustard | Mastodon | Impel | Occator | 250M |
| Freighter | Charon | Fenrir | Providence | Obelisk | 2.5B |
| Jump Freighter | Rhea | Nomad | Ark | Anshar | 12B to 14B |

Traders are trained for their whole line and topped up once to 20B ISK
(`EVEJS_PLAYER_BOTS_TRADER_CAPITAL`; 0 turns the top-up off). The top-up
counts as outside capital, not profit, so no share of it goes to the
corporation. Jump Freighters use gates like everyone else.

A trader with a hauler and nothing else to do runs goods to its trade hub
(at most once every 30 minutes). It picks the modules, drones and charges bot
pilots fit to their ships that the hub has less than half of ten fits' worth
of, buys them at the Jita seed market with up to a quarter of its wallet (2B
ISK at most), hauls them to the hub and lists them at the Jita price plus 15%.
Pilots upgrading at that hub then buy there instead of flying to Jita. Items
already sold elsewhere in the region are skipped, since Jita is only the
fallback market. Hubs also keep minerals (for builders) and fuel blocks (for
structure caretakers) in stock, and a trader buys at another empire hub when
that hub undercuts Jita, so goods move between hubs too. Pilots buying ship
upgrades use their own hub whenever it stocks the whole fit.

| Setting | Default | Environment variable |
| --- | --- | --- |
| Bot fleets on/off | on | `EVEJS_PLAYER_BOTS_BOT_FLEETS=0` turns them off |
| Bot fleets at once | 20 | `EVEJS_PLAYER_BOTS_MAX_BOT_FLEETS` (0 to 1,000) |
| Pilots per bot fleet | 5 | `EVEJS_PLAYER_BOTS_BOT_FLEET_SIZE` (2 to 10) |

No new bot fleets form while autonomous work is off.

### Markets and Jita

- The seeded market exists only in Jita (every Jita station, 10,000 units of
  every type, sell and buy). Every other market starts empty and forms from
  what bots and players trade.
- Bots never sell or list in Jita (enforced by the trade runtime). Jita is the
  seed market: a bot buys there only after checking the accessible regional
  market and finding no non-Jita sell order. If the regional quote cannot be
  verified, the purchase pauses without spending ISK. Production and fulfilment
  routes travel to a live non-Jita source before considering Jita.
- Each bot works from its empire's trade hub (see
  [Where bots live](#where-bots-live)); bots created before 0.2.146 keep New
  Caldari. Miners mine near their hub and sell there, industry bots build
  there, buy inputs there first and fetch them from the best available
  non-Jita station (using Jita only when the regional market has no stock),
  and list unsold output there. When a non-Jita regional buy order can cover the
  sale floor, miners, PI collectors, industry cycles, and autonomous sellers
  route to its high-security station and sell into it; otherwise they list at
  the hub using the regional price reference. A listing earns nothing until a
  buyer fills it. Playerbot sell orders run for 90 days, have no broker or SCC
  placement charge, and still pay the transaction tax on fills. Player order
  fulfilment follows the same source priority. Every bot receives Trade V,
  Retail V, Wholesale V, and Tycoon V for EveJS's full 305 open-order slots;
  the normal station `Stack All` action merges duplicate hangar stacks before
  a sale. Sell-price references ignore
  playerbot-owned orders and Jita seed orders: a non-bot local ask wins, then a
  non-bot regional ask; independent buy orders and type base price are the
  fallback. This prevents bots from repeatedly undercutting one another's asks.
- A player buy order anywhere outside Jita gets a bot: industry bots build it
  if its blueprint uses only minerals and deliver it into the order;
  otherwise a bot sources it from a non-Jita regional market when available,
  uses Jita only if the region has no other stock, couriers it to the order's
  station and sells into the order only when the source price is covered (an
  order that does not pay is retried after an hour).
  `/playerbots orders` lists the orders bots see and who is handling each.

To reseed the market this way after a full rebuild: stop `server` and
`market`, back up with `market-tools backup`, delete `seed_stock` and
`seed_buy_orders` rows outside system 30000142, set Jita's `quantity` and
`initial_quantity` to 10000, and run `market-seed rebuild-summaries`.

Each production step persists its marker before a market or industry call.
After a restart a cycle adopts an already-installed job instead of installing
another, reconciles an interrupted sale from hangar and wallet, and stops for
operator review instead of repeating an unconfirmed purchase.

Bots can be controlled when they are in your corporation or fleet; staff/admin
can control any managed bot. Warp and dock orders use the normal ship services,
including Crimewatch, structure access, and destination checks. Route steps use
the ordinary stargate jump command and its range, movement, timer, and ship
restrictions. Route planning weights high-security systems ahead of low/null
security, and `/playerbots route` reports unavoidable low/null-security systems.
It does not model gate camps, fleets, kill reports, or changing local threats.

`/bots` is an alias for `/playerbots`.

Space control uses a server-owned actor session that is not registered as a
connected retail client. Actors already in space are reattached after restart;
commands for a bot are accepted from its corporation or fleet members, or from
staff/admin.

### Market orders from trade pilots

A trade pilot docked outside Jita keeps one standing buy order for each
mineral at its station, at 90% of the Jita price, paid from its own wallet
into market escrow (at most 25 million ISK per order and a quarter of its
funds in escrow). What those orders buy is listed for sale at the Jita price.
Miners sell into these bids through the normal market. Eight traders are
handled per add-on cycle. Set `EVEJS_PLAYER_BOTS_MARKET_MAKING=0` and restart
`server` to stop placing new orders; existing orders stay until they fill or
expire.

### Mining belt safety and escort fits

Mining safety checks use the pirate NPC ships in the miner's observer-visible
grid, limited to 250 km. When the belt scan finds zero rats, no escort is
assigned and the miner continues its asteroid cycle. When rats are visible,
the runtime searches available security specialists for a complete, online
combat fit whose validated site tier meets the system-security tier. It
prefers the miner's corporation, then the strongest fitting ship, and starts
a durable security operation for that exact belt. If all suitable pilots are
busy, the recent rat sighting stays in the director queue and takes priority
when a security pilot finishes its current operation. The director upgrades
an insufficient combat fit first only when the normal skill, wallet, and
profit gates allow it. The miner keeps mining while the escort becomes
available and travels. A missing suitable ship is reported in operation
history and does not cause an empty-belt wait or a retreat.

System security requires fit tier 1 at 0.8 and above, tier 2 from 0.6, tier 3
from 0.45, tier 4 below 0.45 but above zero, and tier 5 at zero or below. If
static system data is missing, tier 5 is required. For a mining trip, only loss
of the miner's ship or destruction of its assigned escort triggers a security
retreat; full cargo and trip-time limits still send it back for routine work.
The scan count, escort name, actual fit tier, and required tier appear in
`/playerbots op status <bot>`.
An empty belt is a valid result: EveJS rolls belt rats on arrival when enabled
(`EVEJS_ASTEROID_BELT_NPC_RATS_ENABLED`, default `true`), with a default 25%
chance for a normal group in high security
(`EVEJS_ASTEROID_BELT_NPC_RAT_HIGHSEC_CHANCE`). A zero scan reports that the
miner currently sees no rats; it does not spawn them.

Mining state and cargo are checked every 15 seconds, matching the basic
Miner I module cycle. Faster polling cannot shorten that cycle and adds
scheduler jobs for the full mining roster.

### Combat repair fallback

If a patrol returns to an Upwell structure without an online repair service,
the pilot searches reachable NPC stations through EveJS's station service
authority for one that provides both repair and market services. This lookup
does not depend on the optional `stationOperations` SDE catalog. It saves that
destination, travels there through the normal navigation task, and repairs
before continuing to its sale or next patrol. Startup reconciliation also
resumes legacy combat returns blocked by
`REPAIR_OFFLINE` when such a station is available. If the route or service
cannot be verified, the operation remains blocked at a safe location; it does
not re-enter combat with a damaged ship. The detour does not grant structure
docking rights and does not bypass the NPC station's ordinary market and
repair authorities.

Combat operations also recheck their stored Upwell home and market destinations
before returning or settling loot. If corporation/alliance docking access has
since been removed, the ship replaces the stale destination with a reachable
NPC station that provides both repair and market service. It does not repeat a
docking command against the restricted structure.

### Combat anomalies and live-site recovery

An anomaly is complete only when dungeon authority records its completed
lifecycle state. If that authority removes a selected site before the bot
enters or while it is fighting, the bot recalls its drones, returns to station,
and closes the attempt as incomplete. It may sell loot already recovered, but
it never counts the anomaly as cleared. If the site remains active after a
safe retreat, the pilot repairs, sells recovered loot, and returns to that same
site to continue its remaining waves. Anomaly difficulty starts at tier 1 and
advances one tier only after Dungeon authority confirms a clear; this record is
durable and independent of the seeded wallet. `/playerbots ops` shows the
current site, tier, clear state, and recovery stage. If the current ship is
missing a required module or drone, the bot reserves the active site while it
buys and fits only the missing parts for the same hull, then resumes that exact
site. It makes one safe retry after that return. After a second safe failure,
it releases the still-active site for another eligible pilot, records the
attempt as incomplete, and moves on; it never claims a clear or monopolizes a
site in an endless loop. If replacement parts are unavailable, the operation
stays in `holding` and retries; its status reports the preserved site and last
market result.

After an authoritative clear, the pilot continues collecting accessible site
wrecks when its combat drones or weapons are no longer available, as long as
the ship still meets its shield, capacitor, and hull safety limits. Before it
travels back to a public station, it clears and persists its private dungeon
tracker. This lets the station accept docking and keeps a failed scope save in
a visible retry state instead of repeatedly issuing a rejected dock command.
Combat-site proceeds are handled at the site's local base. The regional sale
planner redirects actual cargo only when another non-Jita station has a better
buyer, so empty or unmarketable holds do not create a long round trip to the
central market.

### Combat between bots

Piracy and war patrols may target other playerbots under the same rules as
human targets: corporation, alliance and fleet mates are never targets, and
Crimewatch, war status and security space decide legality. A bot attacked by
another bot defends itself. A bot-run corporation that owns a structure (its
war headquarters) may declare a normal war on another bot-run corporation
whose pilots work in the same systems, at most one attempt an hour and two
such wars at a time; the usual war bill and 24-hour start apply. Set
`EVEJS_PLAYER_BOTS_BOT_VERSUS_BOT=0` and restart `server` to turn both off.
Repeated attacks also lead to hostility and war on their own, for bots and
people alike; see [Grievances, hostility and war](#grievances-hostility-and-war).

### Patrol rotation

Piracy pilots choose among up to eight pirate systems within six jumps of the
nearest one. The choice weighs distance, patrols already assigned to each
system, and deployments in the last six hours. Each corporation rotates on its
own period of 45 to 180 minutes, at most six patrols share a system, and a
corporation that deployed to the same system in three consecutive periods
moves elsewhere while another system is available. A pilot with no system
below the patrol limit receives other work. Target legality is still decided
by Crimewatch, war status and the combat safety checks.

Set `EVEJS_PLAYER_BOTS_PATROL_ROTATION=0` and restart `server` to return to
nearest-system selection.

### Human-led fleets

Managed playerbots accept ordinary fleet invitations from their online actor
sessions. A human-led fleet stays intact while at least one human member remains.
When the last human leaves or disconnects, explicitly disbands the fleet, or
declines an invitation to a bot-created fleet, EveJS dissolves the remaining
bot-only fleet and clears the members' fleet session state. Fleet membership
does not cancel or pause their durable work, so they continue their normal
mining, PI, industry, trade, or other assigned operation.

Fleet-chat `/follow [me|human character|stop]` gives every managed bot in the
fleet a durable order to follow an online human fleet member across systems.
`/escort` uses only security-specialty bots with a validated combat fit and
keeps them at closer range. Fleet-chat `/attack [all|exact bot name]` captures
the commander's most recently acquired target lock and gives fitted fleet bots
a durable attack order. The bot revalidates the live target against its own
war, null-sec conflict, pirate NPC and Crimewatch rules, then approaches or
warps, locks through the targeting authority, and engages fitted combat drones
through the drone authority. Capsules, friendly ships, illegal targets, and
bots without complete combat fits are refused. `/attack stop [all|exact bot
name]` safely recalls drones and returns the selected orders to their home
stations. A changed or docked target, offline commander or dissolved fleet
triggers withdrawal. Mining with cargo can be safely stopped; an industry
cycle, combat withdrawal, accepted courier package, or unresolved authority
action is not interrupted for a new attack order. When the commanded fleet
dissolves or has no human members, follow and attack operations withdraw and
the bots resume director-assigned work.

Roster maintenance advances up to 16 pilot steps concurrently by default.
Each pilot retains a durable director-think scheduler job, while overlapping
idle-pilot decisions are coalesced into one roster-wide assignment pass at a
15-second minimum interval. A completed operation immediately requests the
pilot's next assignment. Capacity relocation is allowed for the whole
100-pilot roster, so a group spawned in one system can spread out without
waiting for repeated batches. Quantum Core commissioning bypasses ordinary
work-slot saturation, requires the bot's persisted CEO, Director, or Station
Manager authority, and leaves the commissioning pilot in the structure's
system after installation. Use `/playerbots ops` to inspect operation stages
and current activity. The roster's `idle` status does not indicate whether the
autonomous director has active work for that pilot. Operations reports active
operations and production cycles separately from pending planetary setup
queues; queued work includes its blocking reason and is not counted as active.

### Structure investments

Only a bot with persisted CEO, Director, or Station Manager authority can
purchase a structure for its corporation or deploy its personally owned
package. Structure anchoring accepts the same three authorities through
EveJS's persisted corporation membership checks. The director limits
autonomous procurement to one medium structure per corporation (its
headquarters: specialty-appropriate, or an Astrahus), only in neutral or
allied claimable nullsec. It first uses
realized reinvestable profit when that covers the complete market package and
transport (with a 250M ISK minimum profit gate). If profit has not reached that
gate, a bot can bootstrap the purchase from its own wallet when the full
package, logistics budget, and protected working reserve are affordable.
This seed-capital fallback does not count the initial grant as profit and does
not use the corporation wallet. The market package includes the structure
hull and its type-required Quantum Core, must be available at one station, and
is capped at 1B ISK. The director prefers safe non-Jita supply and uses Jita
only when no such supply exists. The 75% cumulative net-profit share for bots in
corporations with a human CEO is unchanged.

An 8,000 m³ package uses a Tayra fitted with four Expanded Cargohold II modules.
Playerbot provisioning raises Caldari Hauler to V and Hull Upgrades to IV, and
the live inventory broker confirms capacity before the package is loaded. If
the bot does not have that cargo capacity, it can buy the logistics fit using
realized profit or its personal balance above the protected reserve. Larger
packages require a suitable active
ship and enough live cargo capacity. `/playerbots build` requires the matching
Quantum Core in the same hangar or cargo hold, then uses EveJS's normal
placement, persisted CEO/Director/Station Manager permission, item-consumption,
and anchoring
authorities. If the arrival grid has no legal anchor location, the carrier
warps to a clear point beyond a celestial warp-in exclusion zone and validates
the live position again before submitting deployment. Autonomous procurement
carries the required core with the hull and returns it to the home hangar after
anchoring. A newly anchored structure can display `Core absent` while EveJS's
structure authority advances its anchor and onlining states. The core stays in
the bot's custody until the structure reaches the authoritative dockable
`ONLINING_VULNERABLE` state; then a bot with persisted structure-management
authority receives a durable core-install operation. A human CEO alone does
not block that operation.
The director then assigns separate durable operations to install the
type-correct Quantum Core and, for
an eligible Raitaru, acquire and fit its basic manufacturing service module
and compatible fuel through the normal market, inventory, and structure
authorities. It confirms the service is online and accessible before assigning
manufacturing there. A separate structure-maintenance assignment now covers
every bot corporation that owns a dockable, core-powered structure, including
corporations with a human CEO. If no bot already has CEO, Director, or Station
Manager authority, one deterministic bot receives the Station Manager bit only
in its playerbot actor session; persisted corporation member roles are not
changed. That caretaker restores low-power structures with a compatible
service module, then replenishes online service fuel before it falls below one
day. It buys from non-Jita markets first and may use the bot's seeded wallet
only while preserving a 150M ISK working reserve. All null-sec structures now
resolve public docking and tethering policies to owner-alliance access; this
permits the owner corporation and its alliance and denies unaffiliated pilots.
Other security bands keep their configured access policy.

### Structure Quantum Core transport

A caretaker checks the Quantum Core volume against the active ship's free cargo
space before loading it. If the core does not fit, the operation uses an owned
Badger or Tayra in a reachable NPC hangar. If the pilot owns no suitable
hauler, it may buy a trained hull within a protected 25 million ISK logistics
budget. Market selection prefers safe stock outside Jita, and the market
authority verifies regional supply before any Jita seed purchase. The former
ship remains safely in the station hangar while the hauler carries the core.
The operation still installs and reconciles the exact core through EveJS's
inventory and structure authorities; it does not grant structure access.

If the combat hull is destroyed, capsule recovery takes a safe settlement
path. The capsule leaves any combat or site-entry stage, reaches a station,
sells recovered loot outside Jita, and releases a still-incomplete anomaly to
the shared site pool without recording a clear. The completed combat operation
then frees its work slot for the director to buy and fit a skill-eligible
replacement hull. Old capsule operations whose market or home destination is
Jita are retargeted to a reachable non-Jita station with both repair and
market services. If none is reachable, the capsule remains in `holding`; it
does not route to Jita to sell.

### Null-sec structure rivalries and wars

The global director pass checks authoritative structure ownership in each
claimable null-sec system. Two different, non-allied player corporations with
bot members and structures can become a rivalry; one side must have an active
security bot with a valid fitted combat ship, and the director prefers that
armed side to declare. The declaring corporation needs a persisted bot CEO or
Director with normal war authority and must cover the normal 100M ISK war bill
while retaining a 100M ISK corporate reserve. If required, a bot may contribute
only wallet funds above its 200M ISK working reserve through the account
authority. EveJS records a regular corporation war and its 24-hour spool-up;
combat assignments wait for the war authority to mark the war active. A human
CEO does not stop autonomous corporate operations, while a bot under direct
human control is excluded from autonomous war decisions. Null-sec open-combat
rules remain available independently of formal war status.

### Null-sec war mobilization

When two eligible corporations own structures in the same null-sec system, the
director can declare a normal billable corporation war from that real strategic
conflict. It does not hold the declaration until both sides have finished
fitting. The ordinary 24-hour spool-up is used to recruit and equip security
pilots. Recruitment uses EveJS's regular invitation and applicant-acceptance
handlers. The runtime does not edit affiliation directly, recruit humans, or
exceed the target corporation's member limit. It queues normal combat skills
for safe local members without stopping their current sale, mining, PI, or
industry work; the director waits for that work to finish before it takes them
to buy and fit a combat ship. External recruitment only moves idle security
bots from bot-only donor corporations and leaves at least three fitted security
pilots in each donor. An idle bot is never automatically removed from a mixed
corporation with a human member.

Each eligible bot-only corporation receives an exact 5B ISK grant on its first
war. Set `EVEJS_PLAYER_BOTS_WAR_TEST_CORPORATION_ID=<corporationID>` only when a
human-CEO test corporation should receive the same one-time grant. The Compose
override passes this optional `.env` setting to the server; leave it unset for
ordinary mixed corporations. The grant appears in the corporation journal as a
GM Cash Transfer and uses a durable idempotency receipt. Up to five eligible
combat pilots can receive up to 1B ISK each through the standard corporate wallet
transfer authority so they can buy the best ship their skills and the market
allow. Unfit security pilots are prioritized, including pilots in capsule
recovery. A 200M reserve stays with the corporation, and all unused funds
remain in its wallet. Grant and stipend receipts prevent duplicate transfers
after a restart. A pending transfer is checked against both corporation and
character wallet journals before retrying, so a completed transfer is not paid
twice if its receipt was not saved. If only one journal shows the old transfer,
it is held for operator review instead of being debited a second time. Extra
completed legacy stipend pairs are returned to the corporation through a
keyed character-to-corporation wallet transfer before that pilot can reserve
more war upgrade funds. The returned corporation and character balances
confirm that refund; retries use the same key if the service reports its
normal balance-pair response.
If capsule recovery supersedes an upgrade after the stipend was reserved, the
runtime releases that orphan only when the complete character market history
proves that no purchase followed the reservation. A later transaction,
incomplete history, pending spend, or review operation keeps the budget locked
for inspection rather than risking a duplicate or unaccounted ship purchase.
Reconciliation runs when the capsule-recovery path replaces work and again
before a security upgrade spends the war budget, so recovery does not depend on
the replaced operation receiving another scheduled step.
Capsule recovery is a finite market visit and may enter a system at its
autonomous population limit so the pilot can replace its lost ship. Once fitting
finishes, ordinary capacity planning resumes and relocates the pilot if the
system remains over limit. Routine upgrades still wait for a free arrival slot.
When this test setting is present, the director prioritizes a genuine eligible
structure rivalry that includes that corporation, so the human-CEO grant path
is exercised against a real war opponent.

For a funded first-war corporation, the director fills a five-pilot roster
from safe members already in that corporation before considering outside
recruits. It leaves the human CEO, officers, corporation membership, and
passive PI colonies alone. Each member's current durable operation continues
while combat skills train; the ship-upgrade operation starts after the current
work finishes. If the local roster cannot reach five, it can recruit idle
security bots through EveJS's normal invitation and applicant-acceptance flow;
source corporations keep at least three fitted security pilots.

Cross-trained pilots learn the Algos, Vexor, Myrmidon, and Dominix fit
requirements in that order through EveJS's normal skill queue. The director can
start fitting the strongest currently eligible hull while later levels keep
training. When a required skill is not injected, the pilot buys it through
EveJS's ordinary skill-purchase authority using its wallet. The pilot receives
its capped, idempotent first-war ship stipend before it needs to buy those
books; this is part of the corporation's existing 5B first-war grant, not an
additional grant. Up to five pilots can draw from the grant, with 200M left in
the corporation reserve. Queue and purchase retries do not duplicate skill
levels, books, or wallet transfers. `/playerbots ops` shows the in-corp
mobilization and training counts.

The normal 24-hour war start timer still applies. `/playerbots ops` shows the
active mobilized war count and the grant, stipend, and recruitment totals.
Recruitment attempts are recorded in the server log; `/playerbots op status
<bot>` shows a recruited pilot's travel and ship-upgrade work.

### Alliance founding and sovereignty access

A sovereignty-specialist playerbot can use persisted CEO authority or a
persisted Director role to found an alliance for its corporation. The
Director path is available only to the server-created playerbot actor session;
human clients still need to be CEO. EveJS rechecks live membership and the
Director role when settling the request. Empire Control V, the normal 1B ISK
founding fee, and a 1B ISK retained seed reserve are required. One pending or
active founding operation reserves the corporation's founder slot, so a
second bot cannot spend the fee concurrently. After the alliance is confirmed,
sovereignty specialists may pursue eligible neutral Hub captures or active
campaign command nodes through the normal Entosis, fuel, timer, and safety
authorities. Other corporations join only through the standard application and
approval flow. Alliances also form without a sovereignty founder; see
[Bot alliances](#bot-alliances).

### Agent missions

Since Luna 0.2.152.14 (by @xrizonx), idle pilots can run level 1 missions for
EveJS's own agents: **Security** (combat sites) for security pilots, **Mining**
for industry pilots and **Distribution** (courier) for trade pilots. A pilot
takes a mission only from a high-security agent (0.45 or better) within 10
jumps, and only missions the bot can finish and check through the game:
placeholder, important and epic-arc missions are skipped, and a courier offer
whose cargo does not fit the hold is declined. Mission rewards come from the
agent through the normal wallet journal, and the bot's corporation share is
paid once per mission even if the server restarts mid-turn-in. Human-controlled
pilots are never assigned missions.

`EVEJS_PLAYER_BOTS_AGENT_MISSIONS_ENABLED=0` (Windows: **Configure → Agent
missions**) stops new assignments. `EVEJS_PLAYER_BOTS_MAX_AGENT_MISSIONS`
(default 12, at most 32) caps how many run at once across the server, with at
most four new ones per director pass; `0` lets running missions finish without
starting new ones.

### Local defense (optional)

Local defense is an opt-in, same-system responder service for managed Playerbots. It coalesces authoritative player or managed-bot attacks into persistent incidents, reserves eligible responders, navigates them to the victim and uses native drone and Crimewatch authorities. Ordinary pirate NPC attacks keep their normal defensive behavior; they do not recruit this service.

#### Enable deliberately

The shipped defaults are `enabled: false`, `aggressive: false`, empty `systemIDs`, empty `responderIDs`, and no explicit cooperation agreements. Installing this feature does not select pilots or enable rescue. Existing fitting/target-accounting correctness fixes still apply.

Administrator commands:

```
/playerbots defense status
/playerbots defense events
/playerbots defense set {"systemIDs":[30000145],"responderIDs":[YOUR_RESPONDER_CHARACTER_ID],"enabled":true,"aggressive":true}
/playerbots defense off
/playerbots defense cancel LD1
```

Replace the responder placeholder with a real positive character ID before submitting valid JSON. The system ID is an example, not an automatically enabled location. Configuration patches merge with current settings and are validated before persistence.

`miningRescue` and `generalRescue` independently control victim categories. Defaults are two responders per incident, four per system, four globally and two reserved player-origin slots. Configurable maxima are five, eight and twelve responders respectively; `playerReserve` is 1–4. A player slot reservation is capacity priority, not guaranteed assistance. At most 128 incidents are retained by the coordinator.

Same corporation, alliance or configured `agreements` allow assistance consideration. War enemies are excluded. Every responder separately requires a legal native Crimewatch engagement with no criminal consequence. A victim's bilateral limited engagement does not transfer to its helpers. Managed attackers are considered only in the live incident context; ordinary bot-versus-bot targeting restrictions remain.

Responders must be connected, in the same system and interaction scope, fitted for supported drone combat and available for preemption. Pilots with unresolved industrial transactions, blocking task leases, routes, incompatible operations or existing rescue ownership are excluded. A responder's counterattack cannot start a chain of opposing rescue recruitment.

#### Defensive behavior

Native ship attributes, current combat role and both bay and own deployed drones determine readiness. Drones controlled by another ship do not satisfy the fit. Adaptive policy is used only when local defense and aggressive mode are enabled for the system. Policy considers observed health, capacitor, legal targets, on-grid support and narrowly estimated arrival of an already warping responder. En-route ships do not inflate on-grid strength.

Policy parameters include entry/retreat/critical/reengagement shield thresholds, armor and hull limits, active-fit capacitor floor, sustained-low-shield interval, observed strength ratio and a bounded wait for credible help. Invalid or unsafe ordering is rejected. Unknown arrival time is not treated as immediate support.

Threat expiry, target loss, legal-right loss, disabling and operator cancellation request disengagement. The native drone service recalls drones and reservations release before ordinary work resumes. Critical evacuation is not delayed indefinitely by recall. Turning the service off does not promise that every ship has already reached safety.

#### Persistence and interruption safety

The feature stores settings, incidents, leases, decision memory and interruption mailboxes through the existing GameStore owner APIs. It does not import or replace player data. Economic commits settle before a pending emergency takes ownership; uncertain purchases remain under the existing review protection. Cancellable reads use generation and operation checks so late responses cannot restart abandoned work. Original work IDs remain available for resumption. Recovery expires stale evidence; it is not a guarantee of zero-loss power failure recovery or seamless combat continuation.

#### Scope

This feature does not implement cross-system dispatch, turret/missile/capital combat controllers, automatic war declarations or unrestricted PvP. It uses the existing native authorities and does not change their damage rules.

#### Disabled-mode compatibility

With no configured incidents, disabled local defense does not dispatch responders, queue rescue callbacks or write rescue state. Disabling miningRescue preserves the existing mining/escort threat path; disabling aggressive mode preserves the upstream repeated-NPC assessment cache. Shared correctness fixes (owned deployed-drone readiness, current combat-role attributes, native wreck accounting), atomic wake and interruption ownership still apply when rescue is off. This is not a promise of byte-identical behavior to unpatched upstream. Existing reservations must still drain safely when an enabled service is turned off.

## Recovery and safety

### Planetary export recovery

Automatic PI export creates a durable collection operation only after the bot
reaches the colony system and confirms cargo space for the selected commodities.
The server saves an attempt key before calling the normal PlanetMgr launch and
wallet authorities. Retries first check the persisted launch receipt, then
reuse its launch and physical container. They do not create a second launch or
charge a second export tax for the same attempt. If no launch was committed and
the original tax debit was fully refunded, the bot starts a fresh keyed attempt.
If the wallet, colony stock, launch receipt, or physical container disagree,
the operation stays in `review` rather than repeating an uncertain export.

Use `/playerbots op status <bot>` to inspect an export or collection operation
and `/playerbots tasks` to inspect queued PI policy work. Do not remove or move
a launch container while its owner has an active PI collection operation.
Some legacy operations in `review` have no durable attempt receipt and remain
there until their launch, wallet, and source-stock evidence can be reconciled.
The current code has one narrowly-scoped recovery for the known
`storedLaunchID is not defined` failure: it requires an
exact matching tax debit, no launch or durable receipt (including deleted
launches), and a keyed wallet refund. It resumes the operation only after the
refund is confirmed. Other ambiguous exports remain in `review` and are never
retried automatically.

### Industry listing recovery

Before placing a playerbot sell order, the cycle persists its inventory,
wallet, transaction, and existing-order snapshot. If a listing response times
out, the cycle checks the market and wallet authorities again. It retries only
after two snapshots, at least 15 seconds apart and at least 60 seconds after
the attempt, prove that inventory, wallet, transactions, and every existing
order stayed unchanged. If any value moved or cannot be read, the cycle stays
in `review` and never submits a duplicate listing.

Before listing, a market run uses the bound station inventory's normal
`Stack All` command to consolidate identical stackable goods. This reduces the
number of orders consumed by PI and manufacturing output; market items already
in escrow are untouched. If the inventory authority refuses stacking, sale
continues from the separate stacks.

All bot profiles provide Trade V, Retail V, Wholesale V, and Tycoon V, giving
each pilot the full 305 open market-order slots under EveJS's skill rules.
Existing orders are preserved during the raise-only skill-profile upgrade.
If the market authority
rejects a listing, the cycle includes the wrapped market error detail in its
visible holding reason, including details carried in EveJS `UserError`
responses. Unsold output remains in the hangar until an order is accepted.
When a later retry succeeds, the cycle clears any rejection recorded by an
earlier attempt; completed listings also hide such legacy stale errors from
the status summary. A completed sale rejected specifically because the pilot
has no free order slot is deferred for one five-minute director interval; the
pilot remains eligible for other work while the market capacity recovers.

Market matching skips a playerbot's own personal sell orders and corporate
sell orders paid from the same corporation wallet. The guard applies to both
immediate purchases and crosses triggered by changing a buy-order price. This
prevents a bot from manufacturing taxable turnover by buying its own stock.

Ship-kit purchases with an uncertain market response stay in review until the
wallet journal, market transactions, and station/cargo inventory resolve the
outcome. The director confirms a delivered purchase or a fully refunded one;
it retries a no-effect purchase only after a 60-second grace period and a
complete wallet-journal balance chain proves that no debit or inventory change
occurred. Missing or inconsistent evidence leaves the operation in review for
an operator instead of risking a duplicate charge. After confirming a
purchase, refund, or no-effect result, recovery wakes the bot's durable step
job so it continues without waiting for an unrelated assignment.
Each add-on roster visit also checks that a pilot with active mining, PI,
hauling, combat, or manufacturing work still has a durable step scheduled. A
missing step is recreated without duplicating an already scheduled or running
job. When a completed step assigns replacement work, the current scheduler
job creates its successor before it acknowledges itself.

## Performance and capacity

### What has been measured

On a clean test server (4 vCPUs, 7.7 GiB), 500 pilots were seeded and all 500
held online at once in 2.6–3.2 GiB of server memory, with event-loop p95
between 96 and 426 ms after the ramp. Each large connection or restart wave
spiked p95 to about 18 seconds. That proves 500 online sessions for a short
run, not sustained latency or the 5,000-session limit. Keep four numbers apart
when judging load: the persistent roster, registered online sessions, ships
actually in space, and pilots with active work.

### The Performance page

Open **Performance** in the dashboard, or read the same data from the private
API (`GET /v1/dashboard/telemetry`, bearer token required). Telemetry is
read-only and adds no host port.

| Section | What it reports |
| --- | --- |
| Event loop | Delay in the last five-second sample (mean, p50, p95, p99, longest) and across the last ten minutes. |
| CPU | EveJS process CPU, its main thread alone, the remainder on other threads, and how busy the host is. Percentages are of one CPU core. |
| Memory and garbage collection | Resident memory, heap against its limit, and the duration of recent collections. |
| Scheduler | How late playerbot jobs start and how many dispatch slots are in use; optionally the number scheduled, running and due. |
| Subsystem work | Duration of director passes and their stages, per-pilot autonomy steps, scheduled jobs by type, and the dashboard summary. |
| Space tick | The tick timer in use, slots skipped after late ticks, and each tick that held the server for a second or longer with its slowest systems. |
| Scene load | Bot ships in space, the systems they occupy, how many are in systems with no human pilot in space, and the site-upkeep cadence used there. |

The event-loop state uses the same boundaries as the add-on's load guard:

| p95 delay | State | What the add-on does |
| --- | --- | --- |
| up to 50 ms | Healthy | Runs the configured number of bot steps in parallel. |
| up to 100 ms | Constrained | Runs at most four bot steps in parallel. |
| up to 250 ms | Degraded | Runs at most two bot steps in parallel. |
| above 250 ms | Overloaded | Runs one bot step at a time and pauses roster seeding. |

When delay stays high, find the largest entry under **Work by subsystem** and
reduce load in this order:

1. Lower **Bot steps in parallel** or raise **Delay per bot**.
2. Lengthen the director think interval.
3. Lower **General work slots**.
4. Lower **Maximum online bots**.

Do not raise the load-guard or seeding thresholds to make the page look
healthy. These numbers describe this server under its current load; they are
not a capacity guarantee for other hardware.

How late scheduled jobs start is always measured and costs nothing extra.
Counting scheduled, running and due jobs requires one listing of every
playerbot job. The scheduler process answers in milliseconds, but the reply
waits for EveJS's main thread, so on a saturated 500-pilot test server the
round trip took up to 15 seconds. That queue scan is therefore off by
default. Set `EVEJS_PLAYER_BOTS_TELEMETRY_QUEUE_SCAN=1` and restart `server`
to enable it; it then runs only when the page or endpoint is read, is reused
for 60 seconds (`EVEJS_PLAYER_BOTS_TELEMETRY_BACKLOG_INTERVAL_MS`), and a
request waits at most 1.5 seconds for it. Subsystem durations include time
spent waiting on the market or scheduler process; that wait is reported
separately and is not part of any held slice.
Set `EVEJS_PLAYER_BOTS_TELEMETRY_FILE=1` to also write a snapshot every minute
to `runtime-performance/playerbots-latest.json` under the EveJS data root.
Keep that file out of public source control.

### Systems with no human pilot in space

EveJS runs dungeon and incursion site upkeep once a second, and refreshes
incursion system effects on every 100 ms gameplay tick, in every loaded solar
system. With hundreds of bot ships spread over dozens of systems and no human
nearby, that upkeep was the largest single cost on the profiled 500-pilot
server. The add-on therefore runs both once every ten seconds in a system
where no human pilot is in space. Site logic is driven by timestamps, so
spawns, gates, hazards and completions are still decided by the same EveJS
site authorities; they are only noticed up to ten seconds later. As soon as
a human pilot is in space in a system, that system returns to the normal
cadence. Ship movement, weapons, NPC behaviour and Crimewatch are not slowed.

Set `EVEJS_PLAYER_BOTS_UNOBSERVED_SITE_TICK_MS` to another interval between
`1001` and `60000`, or to `0` to run every system at the normal cadence, and
restart `server`. The Performance page shows the interval in use and how many
upkeep passes were skipped.

### Space tick timing and long ticks

The 100 ms space tick runs on a fixed deadline grid. A tick that wakes late
does not move the following deadlines, slots that pass while a tick is still
running are skipped and never replayed, and after a very late tick the next
one starts at least 50 ms later. This only changes when ticks are dispatched;
gameplay still reads the real clock. Set `EVEJS_SPACE_TICK_SCHEDULER=interval`
and restart `server` to return to EveJS's plain interval timer.

Every space tick that holds the server for one second or longer is recorded
with its duration, how late it started, and the five solar systems that took
the most time, with their entity, bot and human counts. **Long space ticks**
on the Performance page lists the last twenty and the totals since start, and
EveJS logs at most one warning a minute. Time outside any one system is
structure upkeep, hazard recovery and system collection. Change the threshold
with `EVEJS_PLAYER_BOTS_TICK_STALL_MS` (at least `100`) or switch the watch
off with `EVEJS_PLAYER_BOTS_TICK_STALL_WATCH=0`.

### Director slice budget

A director pass walks the whole online roster. **Director slice budget**
(Settings, or `EVEJS_PLAYER_BOTS_DIRECTOR_SLICE_BUDGET_MS`, default `8`) is the
longest the pass runs before it hands control back to EveJS and continues
afterwards. A pilot that started other work while the pass was waiting is
skipped for that pass. Assignment rules, attempt limits and capacity limits are
unchanged. When EveJS is already overloaded each hand-back returns late, so a
pass stops yielding after two seconds of accumulated waiting and finishes in
one go; the Performance page counts those passes. Set the budget to `0` to run
each pass in one slice, as earlier releases did; the pass is still measured.

### Disk writes

Luna 0.2.152.15 (by @xrizonx) cut the server's routine disk writes:

- **Bot tasks are saved one row each.** Earlier releases rewrote the whole
  task queue, history included, on every task change; a busy server wrote
  hundreds of kilobytes per change. The first task change after upgrading
  moves the queue into per-task rows in one transaction. A downgrade to an
  older Playerbots needs the GameStore backup taken before the upgrade,
  because older releases cannot read the new rows.
- **Bot, scheduler and map saves are written once.** On the synchronous save
  path these tables commit straight to SQLite in one owner-checked
  transaction, instead of also copying the same data into the recovery
  journal. Wallet, inventory, dungeon and mining saves keep their existing
  safeguards.
- **Map statistics are checkpointed.** Jump and visit statistics stay in
  memory and are saved every `EVEJS_PLAYER_BOTS_MAP_SAVE_SECONDS` (default
  60, 2–120) even while the map is busy, and on a clean stop. A crash can
  lose up to that many seconds of statistics; `2` restores the old
  save-after-two-quiet-seconds behaviour.
- **Verbose trace files are off.** `EVEJS_PLAYER_BOTS_VERBOSE_TRACE_FILES=0`
  (the default) stops EveJS's detailed sync-ledger, movement, warp,
  jump-timing, NPC combat, undock, inventory, session-change and ball debug
  files, which reached hundreds of megabytes. The main server log, server
  health and lifecycle logs still write. Set it to `1` for a short
  diagnostic session.

To see what is still writing on Windows, open `resmon.exe` → **Disk** during
five representative minutes and sort **Write (B/sec)**; count
`gamestore.sqlite-wal` and `gamestore.sqlite` together, and `_local\logs`
separately.

## Troubleshooting

### The dashboard does not open on port 8080

The dashboard binds to `127.0.0.1:8080` by default (`EVEJS_PLAYER_BOTS_DASHBOARD_BIND`) and does not require a login. Check
`docker compose ps playerbots-addon`, the sidecar log for
`PlayerBotsDashboard`, and the host port mapping. Operation records are loaded
through a paginated API; settings updates require a same-origin request. The
private server API token is never sent to the browser.

### The dashboard says EveJS does not offer a feature yet

The message "The EveJS server does not offer this dashboard feature yet"
means the add-on container runs a newer dashboard than the EveJS server. The
server answers the new pages' requests with `PLAYERBOTS_ADDON_ROUTE_NOT_FOUND`
until it is rebuilt with the same release's integration files. Rebuild and
restart both, for example:

```sh
docker compose -f compose.yaml -f addons/playerbots/compose.override.yaml build init
docker compose -f compose.yaml -f addons/playerbots/compose.override.yaml up -d --no-deps --force-recreate server playerbots-addon
```

The page recovers by itself on its next refresh once the server is back.

### The dashboard or bot driver stops answering

Recreate only the bots container; the game server and Market keep running:

```sh
python3 addons/playerbots/playerbots.py restart --bots-only
```

Then check that `http://127.0.0.1:8080/api/seed-status` answers and read
`playerbots.py logs`. This also applies edits to the add-on's own `.env`
settings. Settings of the `server` service (such as the online or per-system
limits) need `playerbots.py restart`, which restarts the game. If you
installed without telling `install.py` about your launcher's Compose files,
see [Other Compose setups](#other-compose-setups). Thanks to Gordo for the
original command.

### The browser shows a cached login prompt

The current dashboard does not use login authentication. Clear the browser's
cached HTTP credentials for the host and reload the page.

### A bot has no profile portrait

New playerbots are not added to the roster until EveJS has a portrait available
at every supported client size. With the optional CCP agent portrait pool,
EveJS assigns unused faces first and deterministically reuses one after the
finite pool is exhausted. If the pool is absent, it generates an offline portrait. The
dashboard proxies portraits through `/api/character-portrait` to the EveJS
image service at `http://server:26001` on the Compose network. The server image
service must bind to the container network; the add-on Compose override sets
`EVEJS_IMAGE_SERVER_BIND_HOST=0.0.0.0` by default.

For a remote game client, check that EveJS's `imageServerUrl` points to an
address the client can reach and that the mapped image port is open. Test a
bot with:

```sh
curl -I "$EVEJS_IMAGE_SERVER_URL/Character/<characterID>_64.jpg"
```

If that request returns an image but the client still shows a blank portrait,
refresh the client session so it reloads the image URL.

### `/playerbots ops` is slow or appears blank

The bare command returns a one-message automation overview. Use
`/playerbots ops 1` for the first live roster page, or
`/playerbots ops systems 1` for system totals. If the command still produces no
chat reply, check the server log for `Playerbots ops request received` and
`Playerbots ops reply`; the latter includes response size and elapsed time. A
request line without a reply points to command processing, while a reply line
confirms the server generated and sent the response through its XMPP chat
connection.

### Installer says the EveJS version is unsupported

This release is pinned to EveJS `261125.3`. Confirm both root and
`server/package.json` versions. Do not bypass the check or force-copy the
overlay over a different checkout. Use a matching source archive or build a
new package with a reviewed compatibility manifest.

### Installer reports a source-file conflict

The installer found a managed file whose hash matches neither stock EveJS,
this release, nor what the last Playerbots install wrote: someone changed it
by hand. It makes no changes in this case. Preserve your
local edits, compare the reported file with `integration/server/<path>`, and
port the changes deliberately. Do not delete the conflict file to make the
installer proceed.

Upgrading to the release with Luna 0.2.152.16 adds
`server/src/gameStore/sqliteStore.js` to the managed files. If you hand-added
`customsInspectionCases: ["byCaseID"]` to it (the companion to the customs
change merged as PR #14), that line is already in the new file: check that
it is your only change, then run the install again with
`--replace-conflicts`. Your copy goes into the install backup.

### `docker compose config` fails

Run `python3 install.py --dry-run /path/to/evejs` from the release folder. Check
that Docker Compose v2 is installed, `.env` has valid `KEY=value` lines, and
the archive's `addons/playerbots/compose.override.yaml` exists. The installer
automatically restores files if Compose validation fails after copying.

### The add-on logs an authentication error

The server and sidecar must use the same
`EVEJS_PLAYER_BOTS_ADDON_TOKEN`. Confirm the `.env` file is loaded by Compose,
that the token has at least 32 characters, and that
`EVEJS_PLAYER_BOTS_ADDON_MODE` is not `disabled`. Recreate both runtime
services after changing `.env`:

```sh
docker compose -f compose.yaml -f addons/playerbots/compose.override.yaml up -d --no-deps server playerbots-addon
```

Do not paste the token into chat or issue trackers.

### The sidecar cannot reach the API

Confirm both services are on the same Compose project and network. The sidecar
uses `http://server:26004`; it must not use `127.0.0.1`, because that address
would refer to the sidecar itself. Check the server's startup log for
`Internal API listening on 0.0.0.0:26004` and the add-on log for its configured
API URL. Port `26004` is internal and must not be published.

### The API starts but there are no bots

The API reports the persisted roster. Open Settings, set the target and ceiling,
and enable gradual seeding. The separate add-on creates batches of at most ten
pilots after two server load samples. The server pauses them above its hard
event-loop, CPU, or per-pilot creation caps. Staff can also run
`/playerbots seed <target>` to enable the same gradual worker. Check the seed
status panel and server/add-on logs for progress and backoff. The command never
resets or shrinks the database roster.

### The driver repeatedly reports cycle failures

Read both service logs. Server-side steps report the affected character and
operation; the add-on reports the cycle and per-character HTTP failure. Check
that Market is healthy and that the server can reach its configured game data
and normal EveJS services. The sidecar does not connect to or repair databases.
Do not rebuild, reseed, or delete a database as a troubleshooting shortcut.

### The Performance page shows high event-loop delay

Read **Work by subsystem** first: the entry with the largest p95 is where the
EveJS main thread spends its time. A director pass with a long **Longest
slice** and no yields means the slice budget is `0`; set it back to `8` in
Settings. High process CPU with low main-thread CPU points to garbage
collection or other threads, so check the memory card. A growing **Oldest
overdue** value means scheduled work is falling behind; follow the reduction
order in [The Performance page](#the-performance-page).

### `verify.py` reports files that do not match

Exit code `1` lists each file as `missing`, `modified`, or `original`. Files
marked `original` were never replaced; run `install.py` again. Files marked
`modified` were changed after installation; compare them with the release
before reinstalling with `--replace-conflicts`, which backs each one up first.

### Undo installation

See [Rolling back](#rolling-back). Rollback restores only files whose hash
still matches what was installed, and never touches database files.

## Community fittings

EveJS serves the public community ship-fitting library through
`corpFittingMgr.GetCommunityFittings`. The public owner is corporation ID
`1000282`; players can read the library without joining a corporation or
receiving fitting-manager roles. The endpoint remains read-only for community
data. Character, corporation, and alliance fitting libraries keep their normal
owner and role checks.

The bundled FitALL catalog is stored in `server/assets/fittings/fitall.json`.
It contains 5,353 usable fits imported from the XML collection shared in the
EveJS Discord post **“[EveJS v12.3.1] 400+ Saved Fittings,”** attributed to
**John Elysian** by the maintainer; the exact Discord display name and spelling
have not been independently verified. The Discord message permalink and a
separate data license were not included with the source files available for
this package. Eleven source entries marked missing or lacking a usable fit
were omitted. Each imported record contains the ship type, fitting name and
description, and the module, charge, drone, or cargo item tuples used by the
client fitting protocol. No FitALL launcher, batch file, PowerShell script, or
Python application is required by the server; the JSON catalog is static data
loaded by the fitting store.

The official EveJS community Discord is <https://discord.gg/qrdfam8Mz>.

This is a data-source credit, separate from the add-on code credits in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). The catalog is bundled so the installer does not
depend on a developer's Discord download or external files.

The fitting store combines these bundled records with community fittings saved
through the server's existing community fitting authority. The static IDs use a
reserved range so they do not collide with IDs allocated to saved fittings.
