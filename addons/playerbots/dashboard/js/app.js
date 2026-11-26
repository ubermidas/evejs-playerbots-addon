// Dashboard shell: navigation, hash router, live updates, the summary every
// page shares, search, keyboard shortcuts, notifications and the theme.

import { getJSON } from "./api.js";
import { $, esc, rel, setCorporationLogos, notifications, toast } from "./ui.js";
import { icon, brandMark } from "./icons.js";
import { closeDrawer } from "./drawer.js";
import { prefs, setPref, onPrefs, applyTheme, effectiveTheme, REFRESH_CHOICES } from "./prefs.js";
import { openPalette, closePalette, paletteOpen } from "./palette.js";
import { renderRail } from "./rail.js";
import * as activity from "./view-activity.js";
import * as corporations from "./view-corporations.js";
import * as fleets from "./view-fleets.js";
import * as reputation from "./view-reputation.js";
import * as alliances from "./view-alliances.js";
import * as history from "./view-history.js";
import * as world from "./view-world.js";
import * as performance from "./view-performance.js";
import * as settings from "./view-settings.js";
import * as guide from "./view-guide.js";
import { PAGE_TOPICS } from "./guide-content.js";

const VIEWS = { activity, corporations, alliances, fleets, reputation, history, world, performance, settings, guide };
export const NAV = [
  { view: "activity", label: "Activity", icon: "activity", key: "a", group: "Monitor" },
  { view: "world", label: "World", icon: "world", key: "w", group: "Monitor" },
  { view: "history", label: "History", icon: "history", key: "h", group: "Monitor" },
  { view: "performance", label: "Performance", icon: "performance", key: "p", group: "Monitor" },
  { view: "corporations", label: "Corporations", icon: "corporations", key: "c", group: "Manage" },
  { view: "alliances", label: "Alliances", icon: "flag", key: "n", group: "Manage" },
  { view: "fleets", label: "Fleets", icon: "fleet", key: "f", group: "Manage" },
  { view: "reputation", label: "Reputation", icon: "shield", key: "r", group: "Manage" },
  { view: "settings", label: "Settings", icon: "settings", key: "s", group: "Manage" },
  { view: "guide", label: "Guide", icon: "guide", key: "g", group: "Help" },
];
const TITLES = Object.fromEntries(NAV.map((item) => [item.view, item.label]));
// Old hashes from earlier dashboards keep working.
const ALIASES = { help: "guide", docs: "guide", overview: "activity", pilots: "activity", operations: "history", priorities: "corporations", systems: "world", fleet: "fleets", karma: "reputation", alliance: "alliances", grievances: "reputation", wars: "reputation", territory: "world/territory", killboard: "world/killboard" };
const TREND_POINTS = 40;

export const store = {
  summary: null,
  summaryAt: 0,
  route: { view: "activity", param: "" },
  // Session history of a few numbers, for the small trend lines.
  trend: { at: [], online: [], inSpace: [], working: [], total: [] },
};

const refreshMs = () => prefs().refreshSeconds * 1000;

function parseHash() {
  let hash = decodeURIComponent(location.hash.replace(/^#/, "")) || "activity";
  const [head] = hash.split("/");
  if (ALIASES[head]) hash = ALIASES[head] + hash.slice(head.length);
  const [view, ...rest] = hash.split("/");
  return VIEWS[view] ? { view, param: rest.join("/") } : { view: "activity", param: "" };
}

export function setCrumbs(parts) {
  $("crumbs").innerHTML = parts.map((part, index) => index === parts.length - 1
    ? `<strong>${esc(part.label)}</strong>`
    : `<a href="${esc(part.href)}">${esc(part.label)}</a><span class="sep">${icon("chevron-right", { size: 16 })}</span>`).join("");
  const last = parts[parts.length - 1];
  document.title = last && last.label !== "Activity" ? `${last.label} · Playerbots` : "EveJS Playerbots";
}

function recordTrend(summary) {
  const at = Date.parse(summary.generatedAt) || Date.now();
  if (store.trend.at.length && store.trend.at[store.trend.at.length - 1] === at) return;
  const working = (summary.botActivity?.states || []).find((state) => state.id === "working");
  const add = (key, value) => {
    store.trend[key].push(Number(value) || 0);
    if (store.trend[key].length > TREND_POINTS) store.trend[key].shift();
  };
  add("at", at);
  add("online", summary.roster?.online);
  add("inSpace", summary.roster?.inSpace);
  add("working", working ? working.count : 0);
  add("total", summary.roster?.total);
  try { sessionStorage.setItem("playerbots.trend", JSON.stringify(store.trend)); } catch { /* optional */ }
}

function restoreTrend() {
  try {
    const saved = JSON.parse(sessionStorage.getItem("playerbots.trend") || "null");
    if (saved && Array.isArray(saved.at)) {
      for (const key of Object.keys(store.trend)) store.trend[key] = Array.isArray(saved[key]) ? saved[key].slice(-TREND_POINTS) : [];
    }
  } catch { /* optional */ }
}

function setConnection(ok, text, detail = "") {
  $("connection-dot").classList.toggle("down", !ok);
  $("connection-state").textContent = text;
  $("uptime").textContent = detail;
  drawLiveControl();
}

function uptimeText(seconds) {
  const s = Number(seconds) || 0;
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 60)}m`;
}

// Corporation logos change only when someone uploads one (which reloads them
// itself), so the list is read once and then every few minutes.
const LOGOS_MS = 5 * 60 * 1000;
let logosAt = 0;
let summaryRequest = null;

// The page, its view and the watch panel all ask for the summary; callers in
// the same moment share one request.
export function loadSummary(force = false) {
  if (!force && store.summary && Date.now() - store.summaryAt < refreshMs() - 500) return Promise.resolve(store.summary);
  if (summaryRequest) return summaryRequest;
  // Timed from when the request starts, so a slow answer does not make the
  // next refresh skip the summary and show numbers twice as old.
  const startedAt = Date.now();
  summaryRequest = (async () => {
    try {
      const wantLogos = Date.now() - logosAt >= LOGOS_MS;
      const [summary, logos] = await Promise.all([
        getJSON("/api/summary"),
        // Servers from before corporation logos answer 404; the pages then show none.
        wantLogos ? getJSON("/api/corporation-logos").catch(() => null) : null,
      ]);
      store.summary = summary;
      if (logos) { setCorporationLogos(logos); logosAt = Date.now(); }
      store.summaryAt = startedAt;
      recordTrend(summary);
      setConnection(true, "Connected to EveJS", `Server up ${uptimeText(summary.process?.uptimeSeconds)}`);
      $("updated-at").textContent = `Updated ${new Date(summary.generatedAt).toLocaleTimeString()}`;
      void renderRail(railContext());
    } catch (error) {
      const busy = error.status === 503;
      setConnection(false, busy ? "EveJS is busy" : "EveJS unreachable", busy ? "Showing the last data" : "Retrying…");
      $("updated-at").textContent = store.summary
        ? `Last update ${new Date(store.summary.generatedAt).toLocaleTimeString()}; ${error.message}`
        : `Last try failed: ${error.message}`;
      if (!store.summary) throw error;
    } finally {
      summaryRequest = null;
    }
    return store.summary;
  })();
  return summaryRequest;
}

function railContext() {
  return { store, loadSummary, openPalette: () => openPalette(paletteContext()), showShortcuts, toggleWatch };
}

function paletteContext() {
  return { store, nav: NAV, toggleTheme, setTheme, toggleLive, refreshNow, showShortcuts, toggleWatch };
}

// ------------------------------------------------------------- navigation

function drawNav() {
  $("brand-mark").innerHTML = brandMark(30);
  let group = "";
  $("navigation").innerHTML = NAV.map((item) => {
    const head = item.group !== group ? `<div class="nav-group">${esc(item.group)}</div>` : "";
    group = item.group;
    return `${head}<a class="nav-link" href="#${item.view}" data-view="${item.view}" title="${esc(item.label)} (G then ${item.key.toUpperCase()})">${icon(item.icon, { size: 18 })}<span>${esc(item.label)}</span><kbd>G ${item.key.toUpperCase()}</kbd></a>`;
  }).join("");
  $("search-icon").innerHTML = icon("search", { size: 16 });
  $("refresh").innerHTML = icon("refresh", { size: 18 });
  $("notifications").insertAdjacentHTML("afterbegin", icon("bell", { size: 18 }));
  $("guide-link").innerHTML = icon("guide", { size: 18 });
  $("panel-toggle").innerHTML = icon("panel", { size: 18 });
  drawThemeButton();
  drawWatchToggle();
}

function markNav(view) {
  document.querySelectorAll(".nav-link").forEach((link) => {
    const active = link.dataset.view === view;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

// ------------------------------------------------------------------ router

async function show(force = false) {
  const route = parseHash();
  const changed = route.view !== store.route.view || route.param !== store.route.param;
  store.route = route;
  markNav(route.view);
  if (changed || force) setCrumbs([{ label: TITLES[route.view] }]);
  // The top bar's Guide button opens the topic for the page being viewed.
  const help = $("guide-link");
  help.href = PAGE_TOPICS[route.view] ? `#guide/${PAGE_TOPICS[route.view]}` : "#guide";
  help.classList.toggle("hidden", route.view === "guide");
  const view = VIEWS[route.view];
  const fresh = changed || force;
  try {
    await view.render({ param: route.param, fresh, store, loadSummary, setCrumbs });
    if (!fresh) $("view").querySelector(".refresh-failed")?.remove();
  } catch (error) {
    // A missing pilot, corporation or operation will not appear by retrying.
    if (error.status === 404) {
      $("view").querySelector(".refresh-failed")?.remove();
      const back = route.param ? ` <a href="#${esc(route.view)}">Back to ${esc(TITLES[route.view])}</a>` : "";
      $("view").innerHTML = `<div class="notice error load-failed">${icon("alert")}<div>${esc(error.message)}${back}</div></div>`;
      return;
    }
    const message = `${error.message || String(error)} Retrying every ${prefs().refreshSeconds} seconds.`;
    // A failed background refresh keeps the page the operator is looking at.
    if (!fresh && $("view").children.length && !$("view").querySelector(".load-failed")) {
      let banner = $("view").querySelector(".refresh-failed");
      if (!banner) {
        banner = document.createElement("div");
        banner.className = "notice error refresh-failed";
        $("view").prepend(banner);
      }
      banner.innerHTML = `${icon("alert")}<div></div>`;
      banner.querySelector("div").textContent = `Could not refresh: ${message}`;
      return;
    }
    $("view").innerHTML = `<div class="notice error load-failed">${icon("alert")}<div>${esc(message)}</div></div>`;
  }
}

async function refreshNow() {
  store.summaryAt = 0;
  const button = $("refresh");
  button.classList.add("on");
  try {
    await show(true);
  } finally {
    button.classList.remove("on");
  }
}

// ----------------------------------------------------------- live updates

// One refresh at a time: the next starts a full interval after the last one
// finished. A timer that fired regardless stacked requests whenever EveJS
// answered slower than the interval, until the browser's six connections to
// the dashboard were all waiting and every page stopped loading.
let timer = null;
let refreshing = null;

async function tick() {
  timer = null;
  if (prefs().refreshPaused) return;
  // Hidden tabs do not poll; the page refreshes when it is shown again.
  if (document.hidden) return;
  // Views re-render on the timer unless the operator is typing or reading a dialog.
  const active = document.activeElement;
  const editing = active && ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName) && $("view").contains(active);
  if (!editing && !$("dialog").open && !paletteOpen() && !refreshing) {
    const view = VIEWS[store.route.view];
    refreshing = (view.autoRefresh === false ? loadSummary(false).catch(() => {}) : show(false))
      .finally(() => { refreshing = null; });
    await refreshing;
  }
  scheduleRefresh();
}

function scheduleRefresh() {
  clearTimeout(timer);
  timer = null;
  if (prefs().refreshPaused) return;
  timer = setTimeout(tick, refreshMs());
}

function drawLiveControl() {
  const p = prefs();
  const down = $("connection-dot").classList.contains("down");
  $("live-control").innerHTML = `<button class="live-toggle" id="live-toggle" type="button" aria-haspopup="menu" title="Live updates (L to pause)">
    <span class="live-dot${p.refreshPaused ? " paused" : down ? " down" : ""}"></span><span class="live-text">${p.refreshPaused ? "Paused" : `Live · ${p.refreshSeconds}s`}</span>${icon("chevron-down", { size: 14 })}</button>`;
  $("live-toggle").onclick = (event) => openLiveMenu(event.currentTarget);
}

function toggleLive() {
  setPref("refreshPaused", !prefs().refreshPaused);
  toast(prefs().refreshPaused ? "Live updates paused. Pages stay as they are until you refresh." : "Live updates on.");
}

function openLiveMenu(anchor) {
  const p = prefs();
  openPopover(anchor, `<h3>Live updates</h3>
    <button class="menu-row" type="button" data-live="toggle">${icon(p.refreshPaused ? "play" : "pause")}<span>${p.refreshPaused ? "Resume live updates" : "Pause live updates"}</span><kbd style="margin-left:auto">L</kbd></button>
    ${REFRESH_CHOICES.map((seconds) => `<button class="menu-row${seconds === p.refreshSeconds ? " on" : ""}" type="button" data-live="${seconds}">${icon("clock")}<span>Every ${seconds} seconds</span>${seconds === p.refreshSeconds ? `<span class="check-mark">${icon("check")}</span>` : ""}</button>`).join("")}`,
  (event) => {
    const row = event.target.closest("[data-live]");
    if (!row) return false;
    if (row.dataset.live === "toggle") toggleLive();
    else { setPref("refreshSeconds", Number(row.dataset.live)); setPref("refreshPaused", false); }
    return true;
  });
}

// --------------------------------------------------------------- popovers

let popoverCleanup = null;

function closePopover() {
  if (popoverCleanup) popoverCleanup();
  popoverCleanup = null;
  $("popover-root").innerHTML = "";
}

// onClick returns true when the popover should close.
function openPopover(anchor, html, onClick) {
  closePopover();
  const rect = anchor.getBoundingClientRect();
  const root = $("popover-root");
  root.innerHTML = `<div class="popover" role="menu">${html}</div>`;
  const pop = root.firstElementChild;
  const width = Math.min(380, window.innerWidth - 16);
  pop.style.width = `${width}px`;
  pop.style.top = `${Math.round(rect.bottom + 6)}px`;
  pop.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width)))}px`;
  pop.onclick = (event) => { if (onClick && onClick(event)) closePopover(); };
  const outside = (event) => { if (!pop.contains(event.target) && !anchor.contains(event.target)) closePopover(); };
  const escape = (event) => { if (event.key === "Escape") closePopover(); };
  setTimeout(() => document.addEventListener("click", outside), 0);
  document.addEventListener("keydown", escape);
  popoverCleanup = () => { document.removeEventListener("click", outside); document.removeEventListener("keydown", escape); };
  pop.querySelector("button")?.focus();
}

// ---------------------------------------------------------- notifications

let seenNotifications = 0;

function drawNotificationBadge() {
  const unread = Math.max(0, notifications.length - seenNotifications);
  const badge = $("notification-count");
  badge.textContent = unread > 9 ? "9+" : String(unread);
  badge.classList.toggle("hidden", unread === 0);
}

function openNotifications() {
  seenNotifications = notifications.length;
  drawNotificationBadge();
  openPopover($("notifications"), `<h3>This visit</h3>${notifications.map((note) => `<div class="note-row ${esc(note.kind)}">${icon(note.kind === "bad" ? "alert" : note.kind === "good" ? "check" : "info", { size: 18 })}<div>${esc(note.message)}<small>${esc(rel(note.at))}</small></div></div>`).join("") || `<div class="popover-empty">Orders you give and the server's answers appear here.</div>`}`, () => false);
}

// ------------------------------------------------------------------- theme

function drawWatchToggle() {
  const on = prefs().watchPanel !== false;
  document.body.classList.toggle("watch-off", !on);
  const button = $("panel-toggle");
  button.classList.toggle("on", on);
  button.setAttribute("aria-pressed", String(on));
}

function toggleWatch() {
  setPref("watchPanel", prefs().watchPanel === false);
}

function drawThemeButton() {
  const dark = effectiveTheme() === "dark";
  const button = $("theme-toggle");
  button.innerHTML = icon(dark ? "sun" : "moon", { size: 16 });
  button.title = dark ? "Switch to white mode (T)" : "Switch to black mode (T)";
  button.setAttribute("aria-label", button.title);
}

function setTheme(theme) {
  setPref("theme", theme);
}

function toggleTheme() {
  setTheme(effectiveTheme() === "dark" ? "light" : "dark");
}

// --------------------------------------------------------------- shortcuts

const SHORTCUTS = [
  [["Ctrl", "K"], "Search pilots, corporations, pages and commands"],
  [["/"], "Search"],
  ...NAV.map((item) => [["G", item.key.toUpperCase()], `Go to ${item.label}`]),
  [["R"], "Refresh now"],
  [["L"], "Pause or resume live updates"],
  [["T"], "Black or white mode"],
  [["W"], "Show or hide the watch panel"],
  [["?"], "Show these shortcuts"],
  [["Esc"], "Close a panel, dialog or search"],
];

function showShortcuts() {
  const dialog = $("dialog");
  dialog.className = "narrow";
  dialog.innerHTML = `<div class="dialog-head"><h2>Keyboard shortcuts</h2><button type="button" aria-label="Close" data-close>${icon("close")}</button></div>
    <div class="shortcut-list">${SHORTCUTS.map(([keys, label]) => `<div><span>${esc(label)}</span><span>${keys.map((key) => `<kbd>${esc(key)}</kbd>`).join("")}</span></div>`).join("")}</div>`;
  dialog.onclick = (event) => { if (event.target.closest("[data-close]")) dialog.close(); };
  dialog.oncancel = null;
  dialog.showModal();
}

let pendingG = 0;

function typing(target) {
  return target && (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));
}

function onKey(event) {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (paletteOpen()) closePalette();
    else openPalette(paletteContext());
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target) || paletteOpen() || $("dialog").open) return;
  const key = event.key;
  if (pendingG && Date.now() - pendingG < 1200) {
    pendingG = 0;
    const item = NAV.find((entry) => entry.key === key.toLowerCase()) || (key === "?" ? NAV.find((entry) => entry.view === "guide") : null);
    if (item) { event.preventDefault(); location.hash = `#${item.view}`; }
    return;
  }
  if (key === "g" || key === "G") { pendingG = Date.now(); return; }
  if (key === "/") { event.preventDefault(); openPalette(paletteContext()); return; }
  if (key === "?") { event.preventDefault(); showShortcuts(); return; }
  if (key === "r" || key === "R") { event.preventDefault(); void refreshNow(); return; }
  if (key === "l" || key === "L") { event.preventDefault(); toggleLive(); return; }
  if (key === "t" || key === "T") { event.preventDefault(); toggleTheme(); return; }
  if (key === "w" || key === "W") { event.preventDefault(); toggleWatch(); }
}

// ------------------------------------------------------------------- start

function start() {
  applyTheme();
  restoreTrend();
  drawNav();
  drawLiveControl();
  drawNotificationBadge();
  window.addEventListener("hashchange", () => { closeDrawer(); closePopover(); void show(true); $("view").focus({ preventScroll: true }); window.scrollTo(0, 0); });
  $("refresh").addEventListener("click", () => void refreshNow());
  $("open-palette").addEventListener("click", () => openPalette(paletteContext()));
  $("notifications").addEventListener("click", (event) => { event.stopPropagation(); if ($("popover-root").firstElementChild) closePopover(); else openNotifications(); });
  $("theme-toggle").addEventListener("click", toggleTheme);
  $("panel-toggle").addEventListener("click", toggleWatch);
  let resizeTimer = null;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => void renderRail(railContext()), 250); });
  document.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || prefs().refreshPaused) return;
    if (Date.now() - store.summaryAt >= refreshMs()) { clearTimeout(timer); void tick(); }
    else if (!timer) scheduleRefresh();
  });
  document.addEventListener("playerbots:notify", drawNotificationBadge);
  document.addEventListener("playerbots:open-palette", () => openPalette(paletteContext()));
  document.addEventListener("playerbots:shortcuts", showShortcuts);
  try {
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => { if (prefs().theme === "system") { applyTheme(); drawThemeButton(); } });
  } catch { /* older browsers */ }
  onPrefs(() => {
    applyTheme();
    drawThemeButton();
    drawWatchToggle();
    drawLiveControl();
    scheduleRefresh();
    void renderRail(railContext());
  });
  scheduleRefresh();
  setInterval(() => {
    if (store.summary) $("updated-at").title = `Generated ${rel(store.summary.generatedAt)}`;
  }, 5_000);
  void show(true);
}

start();
