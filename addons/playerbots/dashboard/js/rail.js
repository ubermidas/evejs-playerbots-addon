// The right-hand column on wide screens: the server at a glance, what pilots
// just did, and the pilots the operator pinned.

import { getJSON } from "./api.js";
import { $, esc, num, when, portrait, sparkline, corpLogo } from "./ui.js";
import { icon } from "./icons.js";
import { prefs, togglePin } from "./prefs.js";
import { openPilot } from "./drawer.js";

const FEED_MS = 30_000;
const PINNED_MS = 30_000;
const MAX_PINNED_SHOWN = 6;
let feed = { rows: [], at: 0, error: "" };
let pinned = { rows: new Map(), at: 0, key: "" };
let wired = false;
let drawing = null;

async function loadFeed() {
  if (Date.now() - feed.at < FEED_MS) return;
  feed.at = Date.now();
  try {
    const data = await getJSON("/api/operations?offset=0&limit=6");
    feed = { rows: data.rows || [], at: feed.at, error: "" };
  } catch (error) {
    feed = { rows: feed.rows, at: feed.at, error: error.message };
  }
}

async function loadPinned() {
  const list = prefs().pinned.slice(0, MAX_PINNED_SHOWN);
  const key = list.map((entry) => entry.characterID).join(",");
  if (key === pinned.key && Date.now() - pinned.at < PINNED_MS) return;
  pinned.at = Date.now();
  pinned.key = key;
  const rows = new Map();
  // Pinned pilots load together rather than one after another.
  await Promise.all(list.map(async (entry) => {
    try {
      rows.set(entry.characterID, await getJSON(`/api/bot?characterID=${entry.characterID}`));
    } catch (error) {
      rows.set(entry.characterID, { characterID: entry.characterID, characterName: entry.characterName, missing: error.status === 404, error: error.message });
    }
  }));
  pinned.rows = rows;
}

const STATE_COLOUR = { working: "--st-working", travelling: "--st-travelling", holding: "--st-holding", queued: "--st-queued", cooling: "--st-cooling", paused: "--st-paused", standby: "--st-standby", idle: "--st-idle", offline: "--faint" };

function feedIcon(kind) {
  const text = String(kind || "").toLowerCase();
  if (/mine|mining/.test(text)) return "ore";
  if (/colony|planet/.test(text)) return "planet";
  if (/combat|security|patrol|war|pira/.test(text)) return "target";
  if (/upgrade/.test(text)) return "upgrade";
  if (/mission|agent/.test(text)) return "briefcase";
  if (/industry|manufact/.test(text)) return "cpu";
  if (/haul|transport|reloc|route/.test(text)) return "ship";
  return "activity";
}

function serverSection(store) {
  const s = store.summary;
  if (!s) return `<section class="watch-section"><h2>Server</h2><div class="watch-empty">Waiting for EveJS…</div></section>`;
  const roster = s.roster || {};
  const auto = s.botActivity?.autowork || {};
  const seeding = auto.seeding || {};
  const trend = store.trend;
  const working = (s.botActivity?.states || []).find((state) => state.id === "working");
  const kpi = (label, value, series, accent, href) => `<a class="watch-kpi" href="${href}" style="--stat-accent:${accent}"><b>${esc(value)}</b><span>${esc(label)}</span>${sparkline(series, { width: 110, height: 18 })}</a>`;
  const seedPct = Math.min(100, Math.round((Number(seeding.rosterCount) || 0) * 100 / (Number(seeding.target) || 1)));
  return `<section class="watch-section" aria-label="Server at a glance">
    <h2>Server <a href="#performance">Performance</a></h2>
    <div class="watch-kpis">
      ${kpi("Pilots", num(roster.total), trend.total, "var(--accent)", "#activity")}
      ${kpi("Online", num(roster.online), trend.online, "var(--good)", "#activity")}
      ${kpi("In space", num(roster.inSpace), trend.inSpace, "var(--violet)", "#world")}
      ${kpi("Working", num(working ? working.count : 0), trend.working, "var(--warn)", "#activity")}
    </div>
    <a class="watch-line" href="#settings">${icon(auto.enabled === false ? "pause" : "bolt")}<span>Autonomous work ${auto.enabled === false ? "<strong>off</strong>" : "<strong>on</strong>"}</span></a>
    ${seeding.active ? `<a class="watch-line" href="#settings" title="${num(seeding.rosterCount)} of ${num(seeding.target)} pilots created">${icon("users")}<span>Seeding</span><span class="bar"><i style="width:${seedPct}%"></i></span><span class="muted">${seedPct}%</span></a>` : ""}
    ${Number(roster.connectedHumans) ? `<a class="watch-line" href="#world">${icon("user")}<span>${num(roster.connectedHumans)} capsuleer${Number(roster.connectedHumans) === 1 ? "" : "s"} online, ${num(roster.humansInSpace)} in space</span></a>` : ""}
  </section>`;
}

function pinnedSection() {
  const list = prefs().pinned.slice(0, MAX_PINNED_SHOWN);
  return `<section class="watch-section" aria-label="Pinned pilots">
    <h2>Pinned pilots</h2>
    ${list.map((entry) => {
      const p = pinned.rows.get(entry.characterID) || entry;
      const name = p.characterName || entry.characterName || `Pilot ${entry.characterID}`;
      return `<div class="watch-row" role="button" tabindex="0" data-rail-pilot="${entry.characterID}" aria-label="Open ${esc(name)}">
        ${portrait(entry.characterID, 64)}
        <span><strong>${esc(name)}</strong><small>${p.missing ? "No longer a playerbot" : p.error ? esc(p.error) : esc(p.doing || "")}</small></span>
        ${p.state ? `<span class="dot" style="background:var(${STATE_COLOUR[p.state] || "--muted"})" title="${esc(p.stateLabel || p.state)}"></span>` : ""}
        <span class="unpin" role="button" tabindex="0" data-rail-unpin="${entry.characterID}" title="Unpin" aria-label="Unpin ${esc(name)}">${icon("close", { size: 14 })}</span>
      </div>`;
    }).join("") || `<div class="watch-empty">Pin a pilot from its details to keep it in view here.</div>`}
  </section>`;
}

function feedSection() {
  const rows = feed.rows || [];
  return `<section class="watch-section" aria-label="Latest operations">
    <h2>Latest operations <a href="#history">All</a></h2>
    <div class="watch-feed">
    ${rows.map((op) => `<button class="watch-row" type="button" data-rail-pilot="${op.characterID}">
      <span class="feed-icon">${icon(feedIcon(op.kind), { size: 15 })}</span>
      <span><strong>${esc(op.kindLabel || op.kind)}</strong><small>${corpLogo(op.corporationID, 12, "corp-logo inline")}${esc(op.characterName || `Pilot ${op.characterID}`)} · ${when(op.updatedAt)}</small><small title="${esc(op.lastAction || op.lastError || "")}">${esc(op.lastAction || op.lastError || op.status || "")}</small></span>
    </button>`).join("") || `<div class="watch-empty">${feed.error ? esc(feed.error) : "Operations appear here as pilots start work."}</div>`}
    </div>
  </section>`;
}

function footer() {
  return `<div class="watch-foot">
    <a href="#" data-rail="shortcuts">${icon("keyboard", { size: 14 })}Keyboard shortcuts</a>
    <a href="https://github.com/ubermidas/evejs-corporation-logos" target="_blank" rel="noopener noreferrer">${icon("image", { size: 14 })}Corporation logos add-on ${icon("external", { size: 12 })}</a>
    <a href="https://github.com/kroryan/evejs-playerbots-addon" target="_blank" rel="noopener noreferrer">${icon("link", { size: 14 })}Playerbots on GitHub ${icon("external", { size: 12 })}</a>
  </div>`;
}

function wire(ctx) {
  if (wired) return;
  wired = true;
  $("siderail").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target.closest("[data-rail-unpin], [role='button'][data-rail-pilot]");
    if (!target) return;
    event.preventDefault();
    target.click();
  });
  $("siderail").addEventListener("click", (event) => {
    const unpin = event.target.closest("[data-rail-unpin]");
    if (unpin) {
      event.stopPropagation();
      togglePin(Number(unpin.dataset.railUnpin));
      return;
    }
    const pilot = event.target.closest("[data-rail-pilot]");
    if (pilot) return void openPilot(Number(pilot.dataset.railPilot));
    const link = event.target.closest("[data-rail]");
    if (link && link.dataset.rail === "shortcuts") {
      event.preventDefault();
      ctx.showShortcuts();
    }
    if (link && link.dataset.rail === "hide") ctx.toggleWatch();
  });
}

// Hidden below 1320 px wide or when switched off; nothing is fetched then.
export async function renderRail(ctx) {
  const rail = $("siderail");
  if (!rail || getComputedStyle(rail).display === "none") return;
  if (drawing) return drawing;
  wire(ctx);
  drawing = (async () => {
    try {
      await Promise.all([loadFeed(), loadPinned()]);
      rail.innerHTML = `<div class="watch-inner"><div class="watch-head"><strong>Watch</strong><button class="close" type="button" data-rail="hide" title="Hide the watch panel (W)" aria-label="Hide the watch panel">${icon("close", { size: 16 })}</button></div>${serverSection(ctx.store)}${pinnedSection()}${feedSection()}${footer()}</div>`;
      rail.querySelectorAll("img").forEach((img) => img.addEventListener("error", () => { img.style.visibility = "hidden"; }, { once: true }));
    } finally {
      drawing = null;
    }
  })();
  return drawing;
}
