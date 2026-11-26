# EveJS Playerbots

**A living population for your EveJS server.** Playerbots are real EveJS
characters, in real corporations, who play the game on their own. They mine,
build, trade, run planetary colonies, patrol, fight wars and claim space, and
they will join your corporation or fleet and fly with you when asked.

The add-on is a companion process that sits next to your EveJS server. The
server stays in charge of every character, wallet, ship, market order and
item; the add-on only decides what each bot should do next, through a private
API, and never opens the game database itself. It runs with **Docker
Compose**, or on Windows as a mod for **EVEJS Launcher** with no Docker.

| | |
| --- | --- |
| **Version** | 0.2.152 (native package 0.2.152.17), experimental test build |
| **Works with** | EveJS `261125.3`, with Docker Compose, or natively with EVEJS Launcher 1.0.91+ or `StartServer.bat` |
| **Dashboard** | `http://127.0.0.1:8080` on the server machine |
| **License** | AGPL-3.0-only |

**Contents:** [Quick start](#quick-start) · [What the bots do](#what-the-bots-do) ·
[Running it](#running-it) · [The dashboard](#the-dashboard) ·
[Chat commands](#chat-commands) · [Settings](#settings) ·
[Your data and safety](#your-data-and-safety) · [More documentation](#more-documentation) ·
[Credits](#credits)

---

## Quick start

Unpack `dist/evejs-playerbots-addon-v0.2.152.zip` (or clone this repository),
then run the installer from that folder and answer its questions:

```sh
python3 install.py
```

On Windows, double-click `install.cmd`, or run `python install.py`.

It asks for your EveJS folder and how you run EveJS:

1. **Docker Compose**
2. **Native**: Node.js on this PC, through EVEJS Launcher or `StartServer.bat`

Every route checks your EveJS version and every file it will replace before
writing anything, backs up what it replaces, and never touches the game
database. **Upgrading** is the same: run the new release's installer. It
recognises what the last install wrote and only asks about server files
someone changed by hand.

### Docker

You need EveJS **261125.3** set up with Docker, **Docker** with the Compose
v2 plugin, **Python 3.10+**, and EveJS's **Market** service running
(EveJS's own tools build the market; see `doc/SETUP.md` in EveJS).

The installer copies the add-on in, writes a private API token into `.env`,
rebuilds the EveJS image, starts the server, waits until it is healthy, and
starts the bots. Without questions:

```sh
python3 install.py /path/to/evejs --start
```

Add `--dry-run` for a report without changes. Using EVEJS Launcher's Docker
mode or Server Panel? Give the installer your extra Compose files once; see
[Other Compose setups](GUIDE.md#other-compose-setups).

### Native: EVEJS Launcher or StartServer.bat (no Docker)

You need EveJS **261125.3** run natively with **Node.js 26.13+** (what EveJS 261125.3 requires), and Python
3.10+ for the installer. The native package is
`evejs-playerbots-windows-v0.2.152.17.zip`, built from the same source as the
Docker add-on and carrying the Luna update by @xrizonx.

- **Through EVEJS Launcher (1.0.91+), recommended if you use it.** The
  installer shows you the package; in the launcher stop Game and Market,
  open **Mods → Import**, choose it, turn on **Playerbots**, set it up under
  **Configure**, then **Start Stack**. Without questions:
  `python3 install.py /path/to/evejs --native`
- **Directly, for `StartServer.bat` setups.** Stop Game, then let the
  installer apply the package the same way the launcher would:
  `python3 install.py /path/to/evejs --native --method direct`. Start Game as
  usual; the bots start with it. Settings are in
  `config/playerbots-native.json`. To undo, run it again with `--remove`.

Then open the dashboard at `http://127.0.0.1:8080`. The roster grows toward
500 pilots, a few at a time, once the server has taken two load readings.
More: [Native installs](GUIDE.md#native-installs) and
[`windows-native/README.md`](windows-native/README.md).

---

## What the bots do

**A population that grows on its own.** The roster grows to the size you
choose, from 30 up to 15,000 pilots, a few at a time, and pauses whenever the
server is busy. Pilots are born across the four empires with names from
their race and work from their empire's trade hub. Only some are online at
once (300 by default); the rest take turns. Each has a **specialty**
(industry, trade, planetary, security, piracy or sovereignty) and joins a bot
corporation for it. New corporations take famous sci-fi company names and
random emblems, or names from your own name library.

**Work they do without being told.** A director gives idle pilots useful
work every few minutes, a limited number at a time so the server stays
responsive. Work is saved as it goes and resumes after a restart.

- **Fleets:** bot corporations form their own mining, combat and escort
  fleets; the commander waits for its pilots at every undock and gate.
- **Home base:** pilots live around their corporation's Upwell headquarters,
  fly home between jobs when they stray beyond 5 jumps, and mine and rat
  near it, in low- and null-sec too when the risk tolerance allows.
- **Mining:** belt mining, refining and selling, or delivery to the
  corporation's headquarters, with security escorts when rats are about.
- **Corporation hangars:** deposits go into the corporation's office hangar
  at headquarters (1 Mining, 2 Planetary, 3 Industry, 4 Trade, 5 Combat),
  where players can see them, not into Corporation Deliveries. Bots in any
  corporation, yours included, may use hangars 1-5; a bot corporation's CEO
  rents the office.
- **Industry:** manufacturing paid from a personal or corporation wallet,
  with spending limits.
- **Planetary interaction:** a small share of pilots sets up colonies and
  collects their output in the background.
- **Trade:** buying and selling, standing buy and sell rules, courier
  contracts, and mineral buy orders that give hubs outside Jita a real
  market.
- **Alliances:** the first run founds one alliance of two or more bot
  corporations; after that corporations ally against shared enemies (or by
  empire), under famous science-fiction names. Set up your own, with a logo,
  on the dashboard's Alliances page.
- **Grievances and gate camps:** repeated attacks on a corporation's pilots
  mark the aggressor hostile and then bring a war; security pilots camp their
  headquarters' gates against war targets, criminals and (in low and null)
  hostiles. The dashboard's Reputation page tracks it all.
- **Trade haulers:** traders climb their race's hauler line up to the Jump
  Freighter (trained for it and topped up to 20B ISK once), keep their hub
  stocked with fittings, minerals and fuel bought in Jita or a cheaper hub,
  and fly Freighters and Jump Freighters with an escort of combat corpmates.
  Pilots buying upgrades shop at their own hub first.
- **Ships:** upgrading along a ladder for their role, from 5,353 bundled
  community fits.
- **Combat:** security patrols and combat sites, pirate roams, war patrols
  and null-sec conflict.
- **Agent missions:** fitted security, trade and industry pilots take level 1
  Security, Mining and Distribution missions from high-security agents within
  10 jumps, at most 12 at a time across the server.
- **Corporations and alliances:** corporations build a headquarters, declare
  wars and fund their fleets; CEOs found alliances. Bots pay part of their
  profit to their corporation (75% of net profit to a human-led one, 35% of
  each profitable job to a bot-led one).
- **Structures and sovereignty:** Upwell structures in null-sec, neutral hub
  captures and sovereignty campaigns.

Some large systems are built but still need proof on a live server: the full
ore-to-ships industry chain, advanced planetary products and sovereignty
results.

**Things you can do with them.** Invite bots to your corporation or fleet
and have them follow, escort or attack your target. Order any bot you
control to mine, haul, travel, fit a ship from your saved fittings, run
industry or trade. Recall a whole corporation home and hold it there, even
across restarts. Recruit bots into your own corporation.

**Optional extras.** *Local defense* (off by default): chosen bots respond
when chosen systems are attacked. *Wildfire Protocol* (on): after a roster
reset, about one pilot in a hundred is born a pirate that hunts human systems
and says "burn" in Local when it opens fire. *Bots fighting bots* (on):
pirate and war patrols can target other bots.

**Built to keep the server healthy.** A steadier space tick, a log of any
tick that holds the server for a second or more, slower upkeep in systems
nobody is watching, batched saves, small per-task saves instead of rewriting
the whole task queue, and a Performance page showing where time goes. On a clean test server, 500 bots held online at once in about 3 GiB of
server memory.

---

## Running it

**Native installs** need no commands: the bots start and stop with Game, in
EVEJS Launcher or `StartServer.bat`. For **Docker**, run these from your
EveJS folder (`python` instead of `python3` on Windows). They remember your
Compose setup, always start the server before the bots, and never touch
Market.

| To | Run |
| --- | --- |
| Start everything | `python3 addons/playerbots/playerbots.py start` |
| Stop the bots, keep the server up for players | `python3 addons/playerbots/playerbots.py stop` |
| Restart cleanly | `python3 addons/playerbots/playerbots.py restart` |
| Apply an update or code change | `python3 addons/playerbots/playerbots.py rebuild` |
| Check state / read the log | `python3 addons/playerbots/playerbots.py status` / `logs -f` |
| Check the install matches the release | `python3 verify.py /path/to/evejs` (from the release folder, read-only) |
| Undo the latest install | `python3 rollback.py /path/to/evejs`, then rebuild ([Rolling back](GUIDE.md#rolling-back)) |

To let a big roster seed before the bots start working, switch **Autonomous
work** off on the Settings page, and back on when seeding is done.

| I want to | Where |
| --- | --- |
| See what every bot is doing, and why idle ones are idle | Dashboard → **Activity** |
| Recall a corporation home and hold it there | **Corporations** → the corporation → **Recall all**, or `/bots corp recall` |
| Send it back to work | **Send to work**, or `/bots corp work` |
| Change roster size or online limit | **Settings** (no restart needed) |
| Start over with a new roster | **Settings** → **Delete all bots** |
| Fix a problem | [Troubleshooting](GUIDE.md#troubleshooting) |

---

## The dashboard

Open `http://127.0.0.1:8080` on the server machine. There is no login,
because the dashboard can command every bot; that is why it only listens on
the local machine by default. From another computer, use an SSH tunnel, or
see `DASHBOARD_BIND` below and only on a network you trust.

It is black by default, with an optional white mode, and works on a phone.
The menu on the left groups the pages by what you are doing:

| Page | What you get |
| --- | --- |
| **Activity** | How many pilots are online, in space and working, with trend lines; how many are working, travelling, holding, queued, paused, standing by, idle or offline; what they are doing; why the others are not; a searchable pilot list with CSV export. |
| **Pilot panel** | Click any pilot: what it is doing and why, its location, ship, current job step by step, recent jobs with ISK in and out, and orders (pause, resume, stop, recall, mine, colony, patrol, upgrade). Pin it to keep it in the watch panel. |
| **Corporations** | Every bot corporation, with a filter; a page each with tabs for an overview (whole-corporation orders, headquarters, where goods go, work priorities), its pilots and per-pilot orders, a picture logo and the order log. |
| **Alliances** | Every bot alliance and alliance plan with its logo, founder, allies and progress, and a form to set up your own (name, ticker, description, founder, allies, logo). |
| **Fleets** | Every fleet with bots in it. The fleet commander picks the kind of fleet (mining, combat, hauling or escort) and a fitting; the bots fit up, dock and undock with the FC, follow the FC in warp and do the job on grid. Mining, combat and escort fleets the bot corporations form on their own are shown too, read-only. |
| **Reputation** | Grievances between corporations (attacks today and in total), who is hostile or at war, with Mark hostile, Declare war and Forgive, and the bots' security status. |
| **History** | Every finished and running job, with filters, a step-by-step timeline and CSV export. |
| **World** | Systems, territory (fleets, wars, structures, sovereignty) and the killboard. |
| **Performance** | Server load, director timing and long server ticks. |
| **Settings** | Autonomous work, seeding, population and work limits, timings, headquarters (home range, risk tolerance, alliance mode), bot fleets, the name library, Delete all bots. |
| **Guide** | Plain-language help for every page and command, built in. |

Across every page:

- **Search** with <kbd>Ctrl</kbd> <kbd>K</kbd>: pilots by name or ID,
  corporations, pages, guide topics and dashboard commands in one box.
- **Keyboard shortcuts**: <kbd>G</kbd> then a letter goes to a page,
  <kbd>R</kbd> refreshes, <kbd>L</kbd> pauses live updates, <kbd>T</kbd>
  switches black and white mode, <kbd>?</kbd> lists them all.
- **Live updates** every 15 seconds, which you can pause or slow down, and a
  bell that keeps every order and answer from this visit.
- **Watch panel** on wide screens: the server at a glance, your pinned pilots
  and the latest operations.

**Alliance logos.** On the **Alliances** page, any picture you give an
alliance plan is cropped to a 128 px PNG in the browser and stored in EveJS's
alliance image folder once the alliance exists in game.

**Corporation logos.** On a corporation's page, the **Logo** tab takes a
PNG, JPEG, WebP or GIF, makes square PNGs from 32 to 1024 pixels in the
browser, and stores them in EveJS's image folder
(`<runtime images>/Corporation/<id>_<size>.png`). The logo then shows next to
the corporation's name across the dashboard. In game, the client keeps
drawing the emblem unless the separate
[corporation-logo add-on](https://github.com/ubermidas/evejs-corporation-logos) is installed on the server; with it, players
see the logo from their next login. That add-on also sets logos without
Playerbots, from the command line.

---

## Chat commands

Type these in game chat; `/bots` is short for `/playerbots`, and `<bot>` is a
bot's name or character ID. You can command bots in your own corporation or
fleet; staff can command any bot. Every command, with examples:
[Chat commands](GUIDE.md#chat-commands).

| Command | What it does |
| --- | --- |
| `/playerbots status` | Roster size, target and corporation counts |
| `/playerbots inspect <bot>` | Where a bot is, its wallet, ships and current job |
| `/botlocal` | Which bots are in your system (`/botlocal all` for everywhere) |
| `/playerbots invite <bot>` / `fleet add <bot>` | Invite a bot into your corporation / fleet |
| `/follow`, `/escort`, `/attack` | In fleet chat: follow you, escort you, attack your target |
| `/playerbots mine <bot>` | Send a bot mining |
| `/playerbots pause <bot>` / `resume <bot>` | Stop or restart one bot's own decisions |
| `/bots corp recall` / `corp work` | Recall your corporation home / send it back to work |
| `/bots corp inviteall` | Invite every eligible bot into the recruitment corporation |

---

## Settings

### On the dashboard

Most things are on the **Settings** page. Changes apply at once, survive
restarts, and win over `.env`. On EVEJS Launcher, values saved under
**Configure** win instead and show as locked.

| Setting | Default | Allowed |
| --- | --- | --- |
| Autonomous work | on | on / off |
| Gradual roster seeding | on | on / off |
| Roster target | 500 | 30 – 15,000 |
| Roster ceiling | 1,500 | 30 – 15,000 |
| Most pilots online at once | 300 | 1 – 5,000 |
| Online rotation | 8 hours | 5 minutes – 7 days |
| Most bots per system | 30 | 1 – 300 |
| Work slots | 5,000 | 1 – 5,000 |
| Relocations at once | 100 | 1 – 1,000 |
| PI colony setups at once | 10 | 1 – 500 |
| Stay within (jumps of HQ) | 5 | 0 – 30 (0 lets pilots roam) |
| Risk tolerance | 2 | 0 high-sec, 1 low-sec, 2 null-sec |
| Alliance mode | 1 | 0 dashboard only, 1 karma, 2 population |
| Bot fleets | on | on / off |
| Bot fleets at once | 20 | 0 – 1,000 |
| Pilots per bot fleet | 5 | 2 – 10 |

<details>
<summary><strong>Advanced settings</strong></summary>

| Setting | Default | Allowed |
| --- | --- | --- |
| Director think time, min / max | 90 s / 210 s | 15 s – 1 h |
| Director initial spread | 90 s | 1 s – 1 h |
| Director slice budget | 8 ms | 0 – 100 ms (0 never yields) |
| Bot steps in parallel | 16 | 1 – 100 (lowered automatically under load) |
| Cycle interval | 300 s | 30 s – 24 h |
| Delay per bot | 0 ms | 0 – 5,000 ms |
| EveJS request timeout | 120 s | 10 s – 10 min |
| Seed batch size | 5 | 1 – 10 |
| Time between seed batches | 15 s | 5 s – 5 min |
| Pause seeding above event-loop p95 | 100 ms | 25 – 250 ms |
| Pause seeding above server CPU | 85% | 25 – 900% (100% is one CPU core) |
| Slowest allowed pilot creation | 1,000 ms | 25 – 1,000 ms |

</details>

**Limits no setting can raise:** 15,000 pilots, 5,000 online, 300 per system;
seeding at most 10 pilots per batch, pausing above 250 ms event-loop p95 or
900% CPU, and skipping any pilot that takes over a second to create.

### In `.env` (Docker) or Configure (Windows)

Server-level switches live in EveJS's `.env` and apply when the services are
recreated (`playerbots.py restart`). On Windows they are fields under
**Configure** and apply at the next Game start. Names below start with
`EVEJS_PLAYER_BOTS_` unless written in full. The dashboard settings above can
also be given starting values here (`TARGET`, `MAX_ONLINE`, `MAX_PER_SYSTEM`
and so on; see [Roster and population](GUIDE.md#roster-and-population)).

| Variable | Default | What it does |
| --- | --- | --- |
| `RECRUITMENT_CORPORATION` | empty | Player corporation that `/bots corp inviteall` and automatic recruitment fill (name or ticker) |
| `AUTO_RECRUIT_CORPORATION` | `0` | `1` recruits eligible bots continuously |
| `RECRUITMENT_BATCH_SIZE` | 4 | Bots per recruitment batch (1–16) |
| `PLAYER_CORPORATION_MEMBER_LIMIT` | 15000 | Seats in a human-led corporation; `0` uses EveJS's skill-based limit |
| `PLAYER_CORPORATION_BOT_LIMIT` | 1000 | Most bots one human-led corporation can hold |
| `PLAYER_CORP_PROFIT_SHARE_PERCENT` | 75 | Share of a bot's net profit paid to its human-led corporation |
| `BOT_CORP_OPERATION_SHARE_PERCENT` | 35 | Share of each profitable job paid to a bot-led corporation |
| `CORP_MIN_PROFIT_SHARE_ISK` | 1 | Smallest corporation payout |
| `AGENT_MISSIONS_ENABLED` | `1` | `0` stops giving pilots level 1 agent missions |
| `MAX_AGENT_MISSIONS` | 12 | Most agent missions running at once (0–32; `0` lets running ones finish) |
| `MAP_SAVE_SECONDS` | 60 | How often jump and visit statistics are saved (2–120 s); a clean stop saves them too |
| `VERBOSE_TRACE_FILES` | `0` | `1` writes EveJS's detailed trace files (sync ledger, movement, warp, jump timing and similar); use briefly while diagnosing |
| `REFRESH_EXISTING_PORTRAITS` | `1` | `0` keeps existing portraits instead of refreshing them once |
| `SCIFI_CORPORATION_NAMES` | `1` | `0` names new corporations after their specialty |
| `CORPORATION_EMBLEMS` | `1` | `0` keeps EveJS's default emblem for new corporations |
| `DASHBOARD_BIND` | `127.0.0.1` | `0.0.0.0` opens the dashboard to your network (no login: trusted networks only) |
| `DASHBOARD_PORT` | `8080` | Dashboard port on the host |
| `ADDON_TOKEN` | generated | Private key the server and add-on share; never post it |
| `ADDON_MODE` | `auto` | `disabled` runs the bot cycle inside EveJS instead (no dashboard) |

<details>
<summary><strong>All other variables</strong></summary>

| Variable | Default | What it does |
| --- | --- | --- |
| `AUTOWORK` | on | `0` starts with autonomous work off |
| `AUTOSTART` | on | `0` turns off seeding at startup |
| `STARTUP_SEED_BATCH_SIZE` | off | 1–25: create that many pilots while starting |
| `STARTING_CAPITAL` | 1,000,000,000 | ISK each new pilot starts with |
| `TRADER_CAPITAL` | 20,000,000,000 | A trader with less is topped up once to this, for its freighters; `0` turns it off |
| `ALLIANCE_MODE` | 1 | 0 dashboard alliances only, 1 corporations sharing an enemy ally, 2 each empire bands together at start |
| `RISK_TOLERANCE` | 2 | 0 keeps headquarters miners in high-sec, 1 lets them into low-sec, 2 into null-sec |
| `BOT_FLEETS` / `MAX_BOT_FLEETS` / `BOT_FLEET_SIZE` | on / 20 / 5 | Bot-led fleets, how many at once, pilots in each |
| `HOME_RANGE_JUMPS` | 5 | Pilots more jumps than this from their corporation HQ fly home between jobs; `0` turns it off |
| `ORDER_RESTORE_DELAY_MS` | 60000 | Wait after start-up before saved corporation orders are re-issued |
| `BOT_VERSUS_BOT` | on | Pirate and war patrols may target bots |
| `ENGAGEMENT` | on | Bot combat handling; `0` uses EveJS's original combat paths |
| `ENGAGEMENT_FAST_MS` / `ENGAGEMENT_FAST_SLOTS` | 2000 / 12 | How often, and how many, bots in a fight get a quick update |
| `WILDFIRE` | on | Wildfire Protocol after a roster reset |
| `MARKET_MAKING` | on | Trade pilots keep mineral orders outside Jita |
| `PATROL_ROTATION` | on | Pirates spread across destinations |
| `SITE_PRUNE` | on | Clear sites from long-unvisited systems |
| `UNOBSERVED_SITE_TICK_MS` | 10000 | Site upkeep interval where no human is in space; `0` = every tick |
| `WAR_TEST_CORPORATION_ID` | empty | Testing only: favour this human-led corporation for the first war |
| `DASHBOARD_HOST` / `DASHBOARD_CONTAINER_PORT` | `0.0.0.0` / 8080 | Where the dashboard listens inside its container |
| `DASHBOARD_API_TIMEOUT_MS` | 30000 | Dashboard read timeout (10–30 s) |
| `ADDON_API_HOST` / `ADDON_API_PORT` | `0.0.0.0` / 26004 | The server's private API, inside the Docker network only |
| `ADDON_URL` | `http://server:26004` | Where the add-on finds that API |
| `IMAGE_SERVER_URL` | `http://server:26001/` | Where the dashboard gets portraits |
| `EVEJS_IMAGE_SERVER_BIND_HOST` | `0.0.0.0` | EveJS image server address |
| `TICK_STALL_WATCH` / `TICK_STALL_MS` | on / 1000 | Log space ticks longer than this |
| `TELEMETRY_FILE` | off | `1` also writes telemetry to a file |
| `TELEMETRY_QUEUE_SCAN` | off | `1` adds a task-queue scan to telemetry |
| `TELEMETRY_BACKLOG_INTERVAL_MS` | 60000 | How often the backlog is sampled |
| `EVEJS_SPACE_TICK_SCHEDULER` | `deadline` | `interval` brings back the old tick timer |
| `EVEJS_SCHEDULER_MAX_CONCURRENT_DISPATCH` | 24 | Scheduler parallelism (max 128) |
| `EVEJS_SCHEDULER_DEAD_LETTER_ATTEMPTS` | 25 | Retries before a scheduled job is set aside |

</details>

---

## Your data and safety

- **Install, upgrade and rollback never touch the game database.** The
  installer changes only source files and `.env`, checks every file against
  known versions first, and keeps everything it replaces in a dated
  `.playerbots-install-backup-*` folder.
- **Nothing starts on its own.** Services start only when you run `--start`
  or `playerbots.py start`, never at machine boot, and the installer never
  creates pilots itself.
- **Bot data lives with your game data**: pilots, jobs, corporation orders
  and the name library are in the EveJS game store. Back them up together.
- **Keep the token private.** The API token in `.env` lets anything on the
  Docker network command the server's bots.
- **Keep the dashboard local** unless your network is trusted. It has no
  login by design.

---

## More documentation

| Document | What's in it |
| --- | --- |
| [GUIDE.md](GUIDE.md) | The operator's handbook: running the server, roster sizing, every chat command, how the bots behave, performance, troubleshooting, the fitting catalog |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each release, newest first |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Repository layout, design rules, tests and building releases |
| [PLAYERBOTS_ROADMAP.md](PLAYERBOTS_ROADMAP.md) | The project's long-form roadmap: shared rules, phases, and dated evidence from test servers |
| [windows-native/README.md](windows-native/README.md) | The EVEJS Launcher package in detail |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Sources and licenses of EveJS code and the fittings |

---

## Credits

Built for the original EveJS server and its game services. EveJS news and
community support: the [official EveJS Discord](https://discord.gg/qrdfam8Mz).

The bundled fittings come from the EveJS Discord post "[EveJS v12.3.1] 400+
Saved Fittings", attributed by the maintainer to John Elysian (exact display
name not verified), converted into 5,353 usable fits. See
[Community fittings](GUIDE.md#community-fittings).

Playerbots and the Living Universe project share code in both directions.
Playerbots adapts Living Universe's performance helpers, patrol rotation,
space tick timer and stall watch, and Living Universe builds on parts of
Playerbots. Thanks to them for the collaboration.

**Contributors:** [@gzy40347](https://github.com/gzy40347),
[@ChaosRemnant](https://github.com/ChaosRemnant),
[@ubermidas](https://github.com/ubermidas) (dashboard overhaul, corporation
headquarters, housekeeping), [@xrizonx](https://github.com/xrizonx) (Luna
update: corporation recruitment, corporation income, portrait repair,
performance work and the Windows launcher package)

**License:** AGPL-3.0-only (see `LICENSE`). Source and license notes for
EveJS and the fittings are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
