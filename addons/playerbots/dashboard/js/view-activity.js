// Activity: what every pilot is doing right now and why the rest are not
// working.

import { getJSON } from "./api.js";
import { $, esc, num, rel, duration, stateBar, coalesce, replaceKeepingFocus, pageHead, notice, stat, sparkline, icon, emptyState, skeleton } from "./ui.js";
import { openPilot } from "./drawer.js";
import { createRoster, loadRoster, rosterHtml, bindRoster } from "./roster.js";

const roster = createRoster();
let activity = null;
let ctxRef = null;

function headerHtml(summary) {
  const autowork = activity.autowork || {};
  const seeding = autowork.seeding || {};
  const pill = autowork.enabled === false
    ? `<a class="pill warn" href="#settings">${icon("pause", { size: 16 })}Autonomous work off${seeding.active ? ` · seeding ${num(seeding.rosterCount)} / ${num(seeding.target)}` : ""}</a>`
    : `<a class="pill good" href="#settings">${icon("bolt", { size: 16 })}Autonomous work on</a>`;
  return pageHead("activity", "Activity", `What every pilot is doing right now, and why the rest are not working.`, pill);
}

function statsHtml(summary, trend) {
  const roster = summary.roster || {};
  const working = (activity.states || []).find((state) => state.id === "working");
  const target = Number(roster.target) || 0;
  return `<div class="stats">
    ${stat("Pilots", num(roster.total), target ? `target ${num(target)}` : "", "cyan", "users", sparkline(trend.total))}
    ${stat("Online", num(roster.online), `${num(roster.offline)} offline`, "green", "bolt", sparkline(trend.online))}
    ${stat("In space", num(roster.inSpace), `${num(Number(roster.dockedAtStation || 0) + Number(roster.dockedAtStructure || 0))} docked`, "violet", "ship", sparkline(trend.inSpace))}
    ${stat("Working", num(working ? working.count : 0), `${num(roster.connectedHumans)} capsuleer${Number(roster.connectedHumans) === 1 ? "" : "s"} online`, "amber", "briefcase", sparkline(trend.working))}
  </div>`;
}

// An icon for each kind of work or reason the API reports.
function jobIcon(id) {
  const text = String(id || "").toLowerCase();
  if (/mine|mining|ore|ice/.test(text)) return "ore";
  if (/colony|planet|pi\b|pi-/.test(text)) return "planet";
  if (/combat|security|patrol|war|pira|defen|escort|attack/.test(text)) return "target";
  if (/upgrade|ship|fit/.test(text)) return "upgrade";
  if (/mission|agent/.test(text)) return "briefcase";
  if (/haul|transport|route|travel|reloc|deliver/.test(text)) return "ship";
  if (/market|trade|sell|buy/.test(text)) return "hash";
  if (/industry|manufact|build|struct|hq/.test(text)) return "cpu";
  if (/cool|wait|retry|time/.test(text)) return "clock";
  if (/pause|hold|recall/.test(text)) return "pause";
  if (/offline|login|connect|rotation/.test(text)) return "bolt";
  if (/fail|error|block/.test(text)) return "alert";
  return "activity";
}

function noticesHtml(summary) {
  const notes = [];
  const autowork = activity.autowork || {};
  const seeding = autowork.seeding || {};
  if (autowork.enabled === false) {
    notes.push(notice(`<strong>Autonomous work is off.</strong> ${seeding.active
      ? `The roster is seeding (${num(seeding.rosterCount)} of ${num(seeding.target)}), so pilots stand by. Turn work on in <a href="#settings">Settings</a> when seeding finishes.`
      : `Pilots only run orders you give them. Turn it on in <a href="#settings">Settings</a>.`} Operations already running still finish.`));
  }
  const limit = Number(summary.systemCapacity?.autonomousBotsPerSystem) || 0;
  const crowded = (summary.systems || []).filter((s) => s.overAutonomousLimit);
  if (limit && crowded.length) {
    const extra = crowded.reduce((sum, s) => sum + Math.max(0, s.botCount - limit), 0);
    notes.push(notice(`<strong>${num(crowded.length)} systems hold more pilots than the per-system limit of ${num(limit)}</strong> (${num(extra)} over). New pilots are created in their race's starter system without checking the limit; the limit only stops pilots entering space there and makes the director move residents out when it assigns work. Expect the director to relocate about ${num(extra)} pilots, a batch at a time, once work starts. <a href="#world">See systems</a>.`, "info"));
  }
  if (activity.directorError) notes.push(notice(`<strong>Director error:</strong> ${esc(activity.directorError)}`, "error"));
  return notes.join("");
}

function breakdownHtml() {
  const activities = activity.activities || [];
  const reasons = activity.reasons || [];
  const cooldowns = activity.cooldownReasons || [];
  const top = Math.max(1, ...activities.map((a) => Number(a.count) || 0), ...reasons.map((r) => Number(r.count) || 0));
  const bar = (count) => `<span class="bd-bar"><i style="width:${Math.max(2, Math.round((Number(count) || 0) * 100 / top))}%"></i></span>`;
  return `<div class="grid-2 top">
    <div class="panel"><div class="panel-head"><div><h2>${icon("briefcase")}Working on</h2><p>Pilots working, travelling or holding, by job. Click one to list them.</p></div></div>
      <div class="panel-body breakdown">${activities.map((a) => `<button type="button" data-activity="${esc(a.id)}" class="${roster.activity === a.id ? "on" : ""}"><span class="bd-label">${icon(jobIcon(a.id), { size: 18 })}<span>${esc(a.label)}</span></span><b>${num(a.count)}</b>${bar(a.count)}</button>`).join("") || emptyState("briefcase", "No pilot is working right now")}</div></div>
    <div class="panel"><div class="panel-head"><div><h2>${icon("clock")}Why not working</h2><p>Everyone else, by reason. Click one to list them.</p></div></div>
      <div class="panel-body breakdown">${reasons.map((r) => `<button type="button" data-reason="${esc(r.id)}" class="${roster.reason === r.id ? "on" : ""}"><span class="bd-label">${icon(jobIcon(r.id), { size: 18 })}<span>${esc(r.label)}</span></span><b>${num(r.count)}</b>${bar(r.count)}${r.id === "cooldown" && cooldowns.length ? `<span class="sub">${cooldowns.slice(0, 4).map((c) => `${num(c.count)} × ${esc(c.label)}`).join("<br>")}</span>` : ""}</button>`).join("") || emptyState("check", "Every pilot is busy")}</div></div>
  </div>`;
}

function directorHtml(summary) {
  const work = summary.work || {};
  const cycle = work.currentCycle;
  const director = activity.director || {};
  const failures = activity.addonFailures || [];
  const parts = [
    cycle ? `<span>${icon("refresh", { size: 17 })}Pilot steps this cycle <b>${num(cycle.completedBots)} / ${num(cycle.expectedBots)}</b> · ${esc(duration(cycle.elapsedMs))}</span>` : `<span>${icon("refresh", { size: 17 })}Last cycle <b>${num(work.cycleCompletedBots)} / ${num(work.cycleExpectedBots)}</b> steps${work.lastCycleAt ? ` · ${esc(rel(work.lastCycleAt))}` : ""}</span>`,
    work.nextCycleAt ? `<span>${icon("clock", { size: 17 })}Next cycle <b>${esc(rel(work.nextCycleAt))}</b></span>` : "",
    `<span>${icon("sparkle", { size: 17 })}Director last pass <b>${num(director.assigned)}</b> started · <b>${num(director.failures)}</b> failed</span>`,
    `<span>${icon("alert", { size: 17 })}Step failures <b>${num(work.addonFailedBots)}</b></span>`,
  ].filter(Boolean);
  return `<div class="panel strip">${parts.join("")}</div>
    ${failures.length ? `<div class="panel"><div class="panel-head"><h2>${icon("alert")}Needs attention</h2></div><div class="panel-body">${failures.map((f) => `<div style="margin-bottom:6px"><a href="#" data-open-pilot="${f.characterID}" style="color:var(--accent);font-weight:700">${esc(f.characterName)}</a>: ${esc(f.message)}</div>`).join("")}</div></div>` : ""}`;
}

// One draw at a time; a filter click during a refresh runs right after it.
const draw = coalesce(async (reloadRoster) => {
  // The summary, the activity breakdown and the pilot list are independent
  // reads; asking for them together saves a full round trip per draw.
  const [summary, nextActivity] = await Promise.all([
    ctxRef.loadSummary(false), getJSON("/api/activity"), reloadRoster ? loadRoster(roster) : null,
  ]);
  activity = nextActivity;
  if (!$("act-roster")) return;
  $("act-head").innerHTML = headerHtml(summary) + statsHtml(summary, ctxRef.store.trend) + noticesHtml(summary);
  $("act-bar").innerHTML = `<div class="panel-head"><div><h2>${icon("layers")}State of every pilot</h2><p>Click a state to filter the list below</p></div></div><div class="panel-body">${stateBar(activity.states || [], { selected: [...roster.states] })}</div>`;
  $("act-breakdown").innerHTML = breakdownHtml();
  $("act-director").innerHTML = directorHtml(summary);
  const labels = {
    activity: (activity.activities || []).find((a) => a.id === roster.activity)?.label,
    reason: (activity.reasons || []).find((r) => r.id === roster.reason)?.label,
  };
  replaceKeepingFocus($("act-roster"), rosterHtml(roster, {
    corporations: summary.corporations || [],
    specialties: Object.keys(summary.roster?.bySpecialty || {}).sort(),
    labels,
  }));
});

function showRoster() {
  const element = $("act-roster");
  if (element) element.scrollIntoView({ behavior: "smooth", block: "start" });
}

export async function render(ctx) {
  ctxRef = ctx;
  if (ctx.fresh || !$("act-roster")) {
    $("view").innerHTML = `<div id="act-head">${skeleton(2)}</div><div id="act-bar" class="panel"></div><div id="act-breakdown"></div><div id="act-director"></div><div id="act-roster" class="panel"></div>`;
    bindRoster($("act-roster"), roster, (reload) => draw(reload));
    $("act-bar").addEventListener("click", (event) => {
      const button = event.target.closest("[data-state]");
      if (!button) return;
      const state = button.dataset.state;
      if (roster.states.size === 1 && roster.states.has(state)) roster.states.clear();
      else { roster.states.clear(); roster.states.add(state); }
      roster.page = 0;
      void draw(true).then(showRoster);
    });
    $("act-breakdown").addEventListener("click", (event) => {
      const a = event.target.closest("[data-activity]");
      const r = event.target.closest("[data-reason]");
      if (!a && !r) return;
      roster.states.clear();
      if (a) { roster.reason = ""; roster.activity = roster.activity === a.dataset.activity ? "" : a.dataset.activity; }
      if (r) { roster.activity = ""; roster.reason = roster.reason === r.dataset.reason ? "" : r.dataset.reason; }
      roster.page = 0;
      void draw(true).then(showRoster);
    });
    $("act-director").addEventListener("click", (event) => {
      const link = event.target.closest("[data-open-pilot]");
      if (!link) return;
      event.preventDefault();
      openPilot(Number(link.dataset.openPilot), () => draw(true));
    });
  }
  await draw(true);
}
