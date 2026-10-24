"use strict";

// ---------- small utils ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const todayStr = () => ymd(new Date());
const mondayOf = (s) => { const d = parseYmd(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); };
const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
const num = (v, max = 1) => Number(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: max });
const fmtKg = (v) => num(v, 2);
const fmtVolume = (v) => (v >= 10000 ? `${num(v / 1000, 1)} t` : `${num(v, 0)} kg`);
const shortDate = (d) => parseYmd(d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const setText = (w, r) => (w > 0 ? `${fmtKg(w)} kg × ${r}` : `${r} reps`);
const agoText = (d) => {
  const n = daysBetween(d, todayStr());
  return n <= 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`;
};

function prettyDate(s, { long = false } = {}) {
  const t = todayStr();
  if (s === t) return "Today";
  if (s === addDays(t, -1)) return "Yesterday";
  const d = parseYmd(s);
  return d.toLocaleDateString(undefined, long
    ? { weekday: "long", day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }
    : { weekday: "short", day: "numeric", month: "short" });
}

const CAT_VAR = {
  "Legs": "--c-legs", "Arms & Shoulders": "--c-arms", "Pull": "--c-pull", "Push": "--c-push", "Abs": "--c-abs",
};
const catVar = (c) => (CAT_VAR[c] ? `var(${CAT_VAR[c]})` : "var(--muted)");
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const catHex = (c) => cssVar(CAT_VAR[c] || "--muted");

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

let toastTimer;
function toast(msg, kind = "", ms = 2200) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
const toastErr = (e) => toast(e.message || String(e), "err", 3000);

// ---------- state ----------
const state = {
  categories: DB.categories,
  exercises: [],
  cat: store.get("gl_cat") || "Legs",
  selectedEx: null,
  date: todayStr(),
  daySets: [],
  editMode: false,
  historyBefore: null,
  liftCat: "All",
  openLift: null,
  charts: {},
  progress: null,
};

const goals = {
  get() {
    return { workouts: Number(store.get("gl_goal_workouts")) || 4, sets: Number(store.get("gl_goal_sets")) || 10 };
  },
  set(g) { store.set("gl_goal_workouts", g.workouts); store.set("gl_goal_sets", g.sets); },
};

function showView(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${name}`));
  window.scrollTo(0, 0);
  if (name === "history") loadHistory(true);
  if (name === "stats") loadProgress();
  if (name === "log") loadDay();
}

// =====================================================================
// LOG
// =====================================================================
function loadExercises() {
  state.exercises = DB.listExercises();
  if (state.selectedEx && !state.exercises.find((x) => x.id === state.selectedEx.id)) state.selectedEx = null;
  renderExercises();
}

function renderCats() {
  $("#cats").innerHTML = state.categories.map((c) =>
    `<button class="chip ${c === state.cat ? "active" : ""}" style="--cat:${catVar(c)}" data-cat="${esc(c)}">${esc(c)}</button>`
  ).join("");
}

function renderExercises() {
  const list = state.exercises.filter((x) => x.category === state.cat);
  $("#ex-list").innerHTML = list.map((x) =>
    `<button class="chip ${state.selectedEx?.id === x.id ? "active" : ""}" data-ex="${x.id}">${esc(x.name)}${state.editMode ? `<span class="x" aria-label="Delete">✕</span>` : ""}</button>`
  ).join("") + `<button class="chip add" id="new-ex">＋ New exercise</button>`;
  $("#edit-ex-toggle").textContent = state.editMode ? "Done" : "Edit";
  $("#entry").hidden = !state.selectedEx || state.selectedEx.category !== state.cat;
}

function selectExercise(id, { scroll = true } = {}) {
  const ex = state.exercises.find((x) => x.id === id);
  if (!ex) return;
  state.selectedEx = ex;
  renderExercises();
  $("#entry-name").textContent = ex.name;

  const todays = state.daySets.filter((s) => s.exercise_id === id);
  const last = DB.lastSession(id, state.date);
  const parts = [];

  if (todays.length) {
    // Mid-workout: continue from the last set you did, one set at a time.
    const l = todays[todays.length - 1];
    setStepper("sets", 1);
    setStepper("reps", l.reps);
    setStepper("weight", l.weight);
    parts.push(`${todays.length} set${todays.length > 1 ? "s" : ""} done`);
  } else if (last.date) {
    // Start of this exercise: copy last session's top set.
    const top = last.sets.reduce((a, b) => (b.weight > a.weight ? b : a), last.sets[0]);
    setStepper("sets", last.sets.length);
    setStepper("reps", top.reps);
    setStepper("weight", top.weight);
  }
  if (last.date) parts.push(`Last (${prettyDate(last.date)}): ${summarizeSets(last.sets)}`);
  if (last.best) parts.push(`Best: ${setText(last.best.weight, last.best.reps)}`);
  if (!last.date && !todays.length) parts.push("First time: pick a starting weight");
  $("#entry-last").textContent = parts.join(" · ");
  if (scroll) $("#entry").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// "3×8 @ 60 kg" when all sets match, else "60×8, 60×8, 62.5×6"
function summarizeSets(sets) {
  if (!sets.length) return "";
  const same = sets.every((s) => s.weight === sets[0].weight && s.reps === sets[0].reps);
  if (same) return sets[0].weight > 0 ? `${sets.length}×${sets[0].reps} @ ${fmtKg(sets[0].weight)} kg` : `${sets.length}×${sets[0].reps}`;
  return sets.map((s) => (s.weight > 0 ? `${fmtKg(s.weight)}×${s.reps}` : `${s.reps}`)).join(", ");
}

function setStepper(field, value) {
  $(`#in-${field}`).value = field === "weight" ? String(Math.round(value * 100) / 100) : String(value);
}

function stepperValue(field) {
  const el = $(`[data-field=${field}]`);
  const v = parseFloat($(`#in-${field}`).value.replace(",", "."));
  const min = Number(el.dataset.min), max = Number(el.dataset.max);
  return Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));
}

function onStep(btn) {
  const wrap = btn.closest(".stepper");
  const field = wrap.dataset.field;
  let v = stepperValue(field) + Number(wrap.dataset.step) * Number(btn.dataset.dir);
  if (field === "weight") v = Math.round(v / 0.25) * 0.25;
  setStepper(field, Math.min(Number(wrap.dataset.max), Math.max(Number(wrap.dataset.min), v)));
}

async function addSets() {
  if (!state.selectedEx) return;
  const count = Math.round(stepperValue("sets"));
  const reps = Math.round(stepperValue("reps"));
  const weight = stepperValue("weight");
  const btn = $("#add-sets");
  btn.disabled = true;
  try {
    const { pr } = await DB.addSets({
      exercise_id: state.selectedEx.id, date: state.date,
      sets: Array.from({ length: count }, () => ({ weight, reps })),
    });
    if (pr) {
      const gain = pr.bodyweight ? `+${pr.reps - pr.previous_reps} reps` : `est. 1RM ${num(pr.e1rm, 1)} kg (+${num(pr.e1rm - pr.previous_e1rm, 1)})`;
      toast(`🏆 New PR! ${setText(pr.weight, pr.reps)} · ${gain}`, "pr", 4000);
      navigator.vibrate?.([40, 60, 40]);
    } else {
      toast(`Added ${count} × ${reps}${weight > 0 ? ` @ ${fmtKg(weight)} kg` : ""}`);
      navigator.vibrate?.(30);
    }
    loadDay();
    loadExercises();
    selectExercise(state.selectedEx.id, { scroll: false });
  } catch (err) {
    toastErr(err);
  } finally {
    btn.disabled = false;
  }
}

function renderDate() {
  const t = todayStr();
  $("#day-label").textContent = prettyDate(state.date, { long: true });
  $("#day-next").disabled = state.date >= t;
  $("#day-title").textContent = state.date === t ? "Today's sets" : `Sets on ${prettyDate(state.date)}`;
}

function loadDay() {
  renderDate();
  state.daySets = DB.listSets(state.date);
  renderDay();
}

function renderDay() {
  const groups = new Map();
  for (const s of state.daySets) {
    if (!groups.has(s.exercise_id)) groups.set(s.exercise_id, { name: s.exercise, category: s.category, sets: [] });
    groups.get(s.exercise_id).sets.push(s);
  }
  if (!groups.size) {
    $("#day-log").innerHTML = `<div class="empty">Nothing logged ${state.date === todayStr() ? "yet today" : "on this day"}.<br>Pick a category and exercise above.</div>`;
    return;
  }
  $("#day-log").innerHTML = [...groups.values()].map((g) => {
    const vol = g.sets.reduce((a, s) => a + s.weight * s.reps, 0);
    return `<div class="ex-block">
      <div class="ex-block-head" style="--cat:${catVar(g.category)}">
        <strong>${esc(g.name)}</strong>
        <span class="muted small">${g.sets.length} sets${vol ? ` · ${fmtVolume(vol)}` : ""}</span>
      </div>${g.sets.map((s) => `
      <button class="set-row" data-set="${s.id}">
        <span class="set-no">Set ${s.set_number}</span>
        <span class="set-val">${setText(s.weight, s.reps)}</span>
        <span class="set-edit">edit</span>
      </button>`).join("")}
    </div>`;
  }).join("");
}

function changeDay(delta) {
  const next = addDays(state.date, delta);
  if (next > todayStr()) return;
  state.date = next;
  loadDay();
  if (state.selectedEx) selectExercise(state.selectedEx.id, { scroll: false });
}

// ---------- exercise & set dialogs ----------
function openNewExercise() {
  const f = $("#form-exercise");
  f.reset();
  $("#new-ex-cat").innerHTML = state.categories.map((c) => `<option ${c === state.cat ? "selected" : ""}>${esc(c)}</option>`).join("");
  $("#ex-error").textContent = "";
  $("#dlg-exercise").showModal();
  f.name.focus();
}

async function onExerciseSubmit(e) {
  e.preventDefault();
  if (e.submitter?.value === "cancel") return $("#dlg-exercise").close();
  const f = e.target;
  try {
    const ex = await DB.createExercise({ name: f.name.value, category: f.category.value });
    $("#dlg-exercise").close();
    state.cat = ex.category;
    store.set("gl_cat", state.cat);
    renderCats();
    loadExercises();
    selectExercise(ex.id);
  } catch (err) {
    $("#ex-error").textContent = err.message;
  }
}

async function deleteExercise(id) {
  const ex = state.exercises.find((x) => x.id === id);
  const warn = ex.sessions ? `\n\nThis also deletes ${ex.sessions} logged session${ex.sessions > 1 ? "s" : ""} of it.` : "";
  if (!confirm(`Delete "${ex.name}"?${warn}`)) return;
  try {
    await DB.deleteExercise(id);
    if (state.selectedEx?.id === id) state.selectedEx = null;
    loadExercises();
    loadDay();
    toast("Exercise deleted");
  } catch (err) {
    toastErr(err);
  }
}

let editingSet = null;
function openSet(id) {
  editingSet = state.daySets.find((s) => s.id === id);
  if (!editingSet) return;
  const f = $("#form-set");
  $("#set-title").textContent = `${editingSet.exercise} · set ${editingSet.set_number}`;
  f.weight.value = editingSet.weight;
  f.reps.value = editingSet.reps;
  $("#set-error").textContent = "";
  $("#dlg-set").showModal();
}

async function onSetSubmit(e) {
  e.preventDefault();
  const action = e.submitter?.value;
  const f = e.target;
  if (action === "cancel") return $("#dlg-set").close();
  try {
    if (action === "delete") {
      await DB.deleteSet(editingSet.id);
      toast("Set deleted");
    } else {
      await DB.updateSet(editingSet.id, { weight: parseFloat(f.weight.value.replace(",", ".")), reps: parseInt(f.reps.value, 10) });
      toast("Set updated");
    }
    $("#dlg-set").close();
    loadDay();
    if (state.selectedEx) selectExercise(state.selectedEx.id, { scroll: false });
  } catch (err) {
    $("#set-error").textContent = err.message;
  }
}

// =====================================================================
// HISTORY
// =====================================================================
function loadHistory(reset) {
  if (reset) { state.historyBefore = null; $("#history-list").innerHTML = ""; }
  const workouts = DB.listWorkouts({ limit: 20, before: state.historyBefore });
  if (reset && !workouts.length) {
    $("#history-list").innerHTML = `<div class="empty">No workouts yet. Your sessions will show up here.</div>`;
  }
  $("#history-list").insertAdjacentHTML("beforeend", workouts.map((w) => `
    <button class="hist" data-date="${w.date}">
      <div class="hist-top">
        <span class="hist-date">${prettyDate(w.date, { long: true })}</span>
        <span class="muted small">${w.sets} sets</span>
      </div>
      <div class="hist-meta">${w.exercises} exercise${w.exercises > 1 ? "s" : ""}</div>
      <div class="tags">${w.categories.map((c) => `<span class="tag" style="--cat:${catVar(c)}">${esc(c)}</span>`).join("")}</div>
    </button>`).join(""));
  if (workouts.length) state.historyBefore = workouts[workouts.length - 1].date;
  $("#history-more").hidden = workouts.length < 20;
}

// =====================================================================
// PROGRESS
// =====================================================================

// Turn per-session best sets into per-lift progress: PRs, trend, and a status.
// Strength metric = estimated 1RM of the session's best set; bodyweight lifts use max reps.
function analyze(sessions) {
  const t = todayStr();
  const byLift = new Map();
  for (const s of sessions) {
    if (!byLift.has(s.id)) byLift.set(s.id, { id: s.id, name: s.name, category: s.category, sessions: [] });
    byLift.get(s.id).sessions.push({ ...s });
  }
  const lifts = [];
  const prs = [];
  for (const lift of byLift.values()) {
    const ss = lift.sessions;
    lift.bodyweight = ss.every((s) => !s.top_weight);
    let best = -Infinity;
    let lastPr = 0;
    ss.forEach((s, i) => {
      s.value = lift.bodyweight ? s.max_reps : e1rm(s.best_weight, s.best_reps);
      if (s.value > best + 1e-9) {
        if (i > 0) { s.pr = true; prs.push({ lift, s, gain: s.value - best }); }
        best = s.value;
        lastPr = i;
      }
    });
    lift.best = ss[lastPr];
    lift.latest = ss[ss.length - 1];
    lift.sinceLastPr = ss.length - 1 - lastPr;

    // Trend: best of the last 4 weeks vs best of the 4 weeks before that.
    const recent = ss.filter((s) => daysBetween(s.date, t) < 28);
    const before = ss.filter((s) => { const n = daysBetween(s.date, t); return n >= 28 && n < 56; });
    lift.trend = recent.length && before.length
      ? (Math.max(...recent.map((s) => s.value)) / Math.max(...before.map((s) => s.value)) - 1) : null;
    if (!Number.isFinite(lift.trend)) lift.trend = null;

    const dropPct = lift.best.value > 0 ? 1 - lift.latest.value / lift.best.value : 0;
    lift.status =
      ss.length < 3 ? "new" :
      dropPct >= 0.08 ? "down" :
      lift.sinceLastPr <= 1 ? "up" :
      lift.sinceLastPr <= 3 ? "hold" : "stalled";
    lifts.push(lift);
  }
  lifts.sort((a, b) => (a.latest.date === b.latest.date ? b.sessions.length - a.sessions.length : a.latest.date < b.latest.date ? 1 : -1));
  prs.sort((a, b) => (a.s.date === b.s.date ? b.gain - a.gain : a.s.date < b.s.date ? 1 : -1));
  return { lifts, prs };
}

const STATUS = {
  up: { label: "Improving", cls: "up" },
  hold: { label: "Holding", cls: "hold" },
  stalled: { label: "Stalled", cls: "warn" },
  down: { label: "Dropping", cls: "bad" },
  new: { label: "New", cls: "new" },
};

function statusTip(l) {
  const n = l.sinceLastPr;
  switch (l.status) {
    case "up": return n === 0 ? "New best last session. Keep the same plan." : "PR within the last 2 sessions. On track.";
    case "hold": return `No PR in ${n} sessions. Normal. Aim for one more rep on your top set next time.`;
    case "stalled": return `${n} sessions without a PR. Try adding 1–2 reps per set before adding weight, or drop ~10% and build back up.`;
    case "down": return `Latest session is ${num((1 - l.latest.value / l.best.value) * 100, 0)}% below your best. Check sleep, food and recovery, or take a lighter week.`;
    default: return `Log ${3 - l.sessions.length} more session${3 - l.sessions.length > 1 ? "s" : ""} to see a trend.`;
  }
}

function loadProgress() {
  const sessions = DB.progressSessions();
  state.progress = { sessions, ...analyze(sessions) };
  renderWeek();
  renderKpis();
  renderPrFeed();
  renderLiftFilter();
  renderLifts();
  renderHeatmap();
}

function renderWeek() {
  const { sessions } = state.progress;
  const g = goals.get();
  const t = todayStr();
  const mon = mondayOf(t);
  const sun = addDays(mon, 6);
  $("#week-range").textContent = `${shortDate(mon)} – ${shortDate(sun)}`;

  const week = sessions.filter((s) => s.date >= mon && s.date <= sun);
  const days = new Set(week.map((s) => s.date));
  $("#week-done").textContent = days.size;
  $("#week-goal").textContent = g.workouts;
  $("#week-days").innerHTML = ["M", "T", "W", "T", "F", "S", "S"].map((l, i) => {
    const d = addDays(mon, i);
    return `<span class="wd ${days.has(d) ? "done" : ""} ${d === t ? "today" : ""} ${d > t ? "future" : ""}">${l}</span>`;
  }).join("");

  const setsByCat = Object.fromEntries(state.categories.map((c) => [c, 0]));
  for (const s of week) setsByCat[s.category] = (setsByCat[s.category] || 0) + s.sets;
  const lastByCat = {};
  for (const s of sessions) if (!lastByCat[s.category] || s.date > lastByCat[s.category]) lastByCat[s.category] = s.date;

  $("#cat-week").innerHTML = state.categories.map((c) => {
    const n = setsByCat[c];
    const met = n >= g.sets;
    return `<div class="cw ${met ? "met" : ""}" style="--cat:${catVar(c)}">
      <div class="cw-top"><span class="cw-name">${esc(c)}</span>
        <span class="cw-n"><strong>${n}</strong>/${g.sets} sets${met ? " ✓" : ""}</span></div>
      <div class="track"><div class="fill" style="width:${Math.min(1, n / g.sets) * 100}%"></div></div>
      <div class="cw-last muted small">${lastByCat[c] ? `last trained ${agoText(lastByCat[c])}` : "not trained yet"}</div>
    </div>`;
  }).join("");

  // Next up: the category furthest behind its weekly target, longest since trained.
  const behind = state.categories.filter((c) => setsByCat[c] < g.sets)
    .sort((a, b) => (lastByCat[a] || "0000") < (lastByCat[b] || "0000") ? -1 : 1);
  const next = $("#next-up");
  if (!sessions.length) {
    next.hidden = true;
  } else if (!behind.length) {
    next.hidden = false;
    next.innerHTML = `<span class="next-k">This week</span> Every category has hit ${g.sets} sets. Great week.`;
  } else {
    const c = behind[0];
    next.hidden = false;
    next.style.setProperty("--cat", catVar(c));
    next.innerHTML = `<span class="next-k">Next up</span> <strong>${esc(c)}</strong>
      <span class="muted">· ${lastByCat[c] ? `last trained ${agoText(lastByCat[c])}` : "not trained yet"} · ${g.sets - setsByCat[c]} sets to go</span>`;
  }
}

function weekStreak(sessions) {
  const weeks = new Set(sessions.map((s) => mondayOf(s.date)));
  const thisMon = mondayOf(todayStr());
  let wk = weeks.has(thisMon) ? thisMon : addDays(thisMon, -7); // an empty current week doesn't break it yet
  let n = 0;
  while (weeks.has(wk)) { n++; wk = addDays(wk, -7); }
  return n;
}

function renderKpis() {
  const { sessions, lifts, prs } = state.progress;
  const cutoff = addDays(todayStr(), -29);
  const recentPrs = prs.filter((p) => p.s.date >= cutoff).length;
  const up = lifts.filter((l) => l.status === "up").length;
  const attention = lifts.filter((l) => l.status === "stalled" || l.status === "down").length;
  const tracked = lifts.filter((l) => l.status !== "new").length;
  $("#kpis").innerHTML = [
    [`${weekStreak(sessions)}`, "week streak", ""],
    [`${recentPrs}`, "PRs in 30 days", recentPrs ? "good" : ""],
    [`${up}<small>/${tracked}</small>`, "lifts improving", up ? "good" : ""],
    [`${attention}`, "need attention", attention ? "warn" : ""],
  ].map(([v, l, cls]) => `<div class="kpi ${cls}"><div class="kpi-val">${v}</div><div class="kpi-label">${l}</div></div>`).join("");
}

function renderPrFeed() {
  const { prs, sessions } = state.progress;
  const cutoff = addDays(todayStr(), -29);
  const list = prs.filter((p) => p.s.date >= cutoff).slice(0, 8);
  if (!list.length) {
    $("#pr-feed").innerHTML = `<div class="empty small">${sessions.length
      ? "No new bests in the last 30 days. Check the stalled lifts below."
      : "Log a few sessions and your new personal bests will show up here."}</div>`;
    return;
  }
  $("#pr-feed").innerHTML = list.map(({ lift, s, gain }) => `
    <div class="pr-row" style="--cat:${catVar(lift.category)}">
      <span class="pr-ico">🏆</span>
      <div class="pr-main"><strong>${esc(lift.name)}</strong>
        <span class="muted small">${setText(s.best_weight, s.best_reps)}</span></div>
      <div class="pr-side"><span class="pr-gain">${lift.bodyweight ? `+${gain} reps` : `+${num(gain, 1)} kg`}</span>
        <span class="muted small">${prettyDate(s.date)}</span></div>
    </div>`).join("");
}

function renderLiftFilter() {
  const cats = ["All", ...state.categories];
  $("#lift-filter").innerHTML = cats.map((c) =>
    `<button class="chip ${c === state.liftCat ? "active" : ""}" style="--cat:${c === "All" ? "var(--text)" : catVar(c)}" data-lcat="${esc(c)}">${esc(c)}</button>`
  ).join("");
}

function sparkline(lift) {
  const pts = lift.sessions.slice(-12);
  const W = 76, H = 30, P = 3;
  if (pts.length < 2) return `<svg class="spark" viewBox="0 0 ${W} ${H}"></svg>`;
  const vals = pts.map((p) => p.value);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const x = (i) => P + (i * (W - 2 * P)) / (pts.length - 1);
  const y = (v) => (hi === lo ? H / 2 : H - P - ((v - lo) * (H - 2 * P)) / (hi - lo));
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const dots = pts.map((p, i) => (p.pr ? `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="2.4" class="spark-pr"/>` : "")).join("");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <polyline points="${line}" fill="none" stroke="${catHex(lift.category)}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>${dots}</svg>`;
}

function renderLifts() {
  const { lifts } = state.progress;
  const shown = lifts.filter((l) => state.liftCat === "All" || l.category === state.liftCat);
  if (!shown.length) {
    $("#lifts").innerHTML = `<div class="empty small">${lifts.length ? "Nothing logged in this category yet." : "Your lifts will appear here once you log them."}</div>`;
    return;
  }
  $("#lifts").innerHTML = shown.map((l) => {
    const st = STATUS[l.status];
    const trend = l.trend == null ? "" :
      `<span class="trend ${l.trend > 0.005 ? "pos" : l.trend < -0.005 ? "neg" : ""}">${l.trend > 0 ? "+" : ""}${num(l.trend * 100, 0)}% vs prev 4 wk</span>`;
    const open = state.openLift === l.id;
    return `<div class="lift ${open ? "open" : ""}" style="--cat:${catVar(l.category)}">
      <button class="lift-main" data-lift="${l.id}" aria-expanded="${open}">
        <div class="lift-l">
          <div class="lift-name"><span class="dot"></span>${esc(l.name)}</div>
          <div class="lift-sub">Last ${setText(l.latest.best_weight, l.latest.best_reps)} · ${agoText(l.latest.date)}</div>
        </div>
        ${sparkline(l)}
        <div class="lift-r"><span class="badge ${st.cls}">${st.label}</span>${trend}</div>
      </button>
      ${open ? liftDetail(l) : ""}
    </div>`;
  }).join("");
  if (state.openLift) drawLiftChart(lifts.find((l) => l.id === state.openLift));
}

function liftDetail(l) {
  const b = l.best;
  const recent = l.sessions.slice(-5).reverse();
  return `<div class="lift-detail">
    <div class="lift-stats">
      <div><span class="muted small">Best set</span><strong>${setText(b.best_weight, b.best_reps)}</strong><span class="muted small">${shortDate(b.date)}</span></div>
      <div><span class="muted small">${l.bodyweight ? "Max reps" : "Est. 1RM"}</span><strong>${l.bodyweight ? b.value : `${num(b.value, 1)} kg`}</strong></div>
      <div><span class="muted small">Sessions</span><strong>${l.sessions.length}</strong></div>
    </div>
    <p class="tip">${esc(statusTip(l))}</p>
    ${l.sessions.length > 1 ? `<div class="chart-box"><canvas id="chart-lift"></canvas></div>` : ""}
    <div class="recent">${recent.map((s) => `
      <div class="recent-row"><span>${prettyDate(s.date)}</span><span>${s.sets} sets · best ${setText(s.best_weight, s.best_reps)}${s.pr ? " 🏆" : ""}</span></div>`).join("")}
    </div>
  </div>`;
}

function drawLiftChart(l) {
  if (!l || l.sessions.length < 2 || !$("#chart-lift")) return;
  const color = catHex(l.category);
  const muted = cssVar("--muted");
  const ss = l.sessions;
  drawChart("lift", {
    type: "line",
    data: {
      labels: ss.map((s) => shortDate(s.date)),
      datasets: l.bodyweight
        ? [{ label: "Max reps", data: ss.map((s) => s.max_reps), borderColor: color, backgroundColor: color, tension: 0.25,
          pointRadius: ss.map((s) => (s.pr ? 4 : 2)) }]
        : [
          { label: "Est. 1RM", data: ss.map((s) => Math.round(s.value * 10) / 10), borderColor: color, backgroundColor: color,
            tension: 0.25, pointRadius: ss.map((s) => (s.pr ? 4 : 2)) },
          { label: "Top weight", data: ss.map((s) => s.top_weight), borderColor: muted, backgroundColor: muted,
            borderDash: [4, 4], pointRadius: 0, tension: 0.25 },
        ],
    },
    options: {
      plugins: { legend: { labels: { boxWidth: 10, boxHeight: 2 } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw}${l.bodyweight ? "" : " kg"}` } } },
      scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0 } } },
    },
  });
}

function renderHeatmap() {
  const t = todayStr();
  const perDay = new Map();
  for (const s of state.progress.sessions) perDay.set(s.date, (perDay.get(s.date) || 0) + s.sets);
  const start = addDays(mondayOf(t), -15 * 7);
  const cells = [];
  for (let i = 0; i < 16 * 7; i++) {
    const d = addDays(start, i);
    const n = perDay.get(d) || 0;
    const lvl = d > t ? "future" : n === 0 ? "" : n < 10 ? "l1" : n < 20 ? "l2" : "l3";
    cells.push(`<div class="cell ${lvl} ${d === t ? "today" : ""}" title="${d}: ${n} sets"></div>`);
  }
  $("#heatmap").innerHTML = cells.join("");
}

function destroyChart(key) {
  state.charts[key]?.destroy();
  delete state.charts[key];
}

function drawChart(key, config) {
  destroyChart(key);
  if (!window.Chart) return;
  Chart.defaults.color = cssVar("--muted");
  Chart.defaults.borderColor = cssVar("--line");
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  config.options = { responsive: true, maintainAspectRatio: false, animation: { duration: 250 }, ...config.options };
  state.charts[key] = new Chart($(`#chart-${key}`), config);
}

function openGoals() {
  const g = goals.get();
  const f = $("#form-goals");
  f.workouts.value = g.workouts;
  f.sets.value = g.sets;
  $("#dlg-goals").showModal();
}

function onGoalsSubmit(e) {
  e.preventDefault();
  if (e.submitter?.value === "cancel") return $("#dlg-goals").close();
  const f = e.target;
  const workouts = Math.min(7, Math.max(1, parseInt(f.workouts.value, 10) || 4));
  const sets = Math.min(50, Math.max(1, parseInt(f.sets.value, 10) || 10));
  goals.set({ workouts, sets });
  $("#dlg-goals").close();
  loadProgress();
}

// =====================================================================
// BACKUP & EXPORT
// =====================================================================
const native = () => window.Capacitor?.isNativePlatform?.() === true;

// On Android: write to the app cache and open the share sheet (Drive, Gmail, Files, WhatsApp…).
// In a browser: plain download.
async function saveFile(filename, text, mime) {
  if (native()) {
    const { Filesystem, Share } = window.Capacitor.Plugins;
    const res = await Filesystem.writeFile({ path: filename, data: text, directory: "CACHE", encoding: "utf8" });
    try {
      await Share.share({ title: filename, files: [res.uri], dialogTitle: "Save or send your Gym Log export" });
    } catch (e) {
      if (!/cancel/i.test(String(e?.message || e))) throw e; // user closing the sheet isn't an error
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function openData() {
  const w = DB.listWorkouts({ limit: 100000 });
  const nSets = w.reduce((a, x) => a + x.sets, 0);
  $("#data-summary").textContent = w.length
    ? `${w.length} workouts · ${nSets} sets · since ${shortDate(w[w.length - 1].date)} ${parseYmd(w[w.length - 1].date).getFullYear()}`
    : "No workouts logged yet.";
  $("#data-error").textContent = "";
  $("#dlg-data").showModal();
}

async function onDataSubmit(e) {
  e.preventDefault();
  const action = e.submitter?.value;
  $("#data-error").textContent = "";
  try {
    if (action === "cancel") return $("#dlg-data").close();
    const stamp = todayStr();
    if (action === "json") {
      await saveFile(`gym-log-${stamp}.json`, JSON.stringify(DB.exportJSON(), null, 2), "application/json");
      store.set("gl_last_export", stamp);
    } else if (action === "csv") {
      await saveFile(`gym-log-${stamp}.csv`, DB.exportCSV(), "text/csv");
      store.set("gl_last_export", stamp);
    } else if (action === "import") {
      $("#import-file").value = "";
      $("#import-file").click();
    }
  } catch (err) {
    $("#data-error").textContent = err.message || String(err);
  }
}

async function onImportFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    let data;
    try { data = JSON.parse(await file.text()); } catch { throw new Error("That file isn't valid JSON"); }
    const n = Array.isArray(data?.sets) ? data.sets.length : 0;
    if (!confirm(`Replace everything on this phone with this backup (${n} sets)?\n\nYour current log will be overwritten.`)) return;
    const res = await DB.importJSON(data);
    $("#dlg-data").close();
    state.selectedEx = null;
    loadExercises();
    loadDay();
    toast(`Restored ${res.sets} sets, ${res.exercises} exercises`);
  } catch (err) {
    $("#data-error").textContent = err.message;
  }
}

// =====================================================================
// wiring
// =====================================================================
function wire() {
  $$(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));
  $("#data-btn").addEventListener("click", openData);

  $("#day-prev").addEventListener("click", () => changeDay(-1));
  $("#day-next").addEventListener("click", () => changeDay(1));
  $("#day-label").addEventListener("click", () => {
    const p = $("#day-picker");
    p.max = todayStr();
    p.value = state.date;
    try { p.showPicker(); } catch { p.click(); }
  });
  $("#day-picker").addEventListener("change", (e) => {
    if (!e.target.value || e.target.value > todayStr()) return;
    state.date = e.target.value;
    loadDay();
    if (state.selectedEx) selectExercise(state.selectedEx.id, { scroll: false });
  });

  $("#cats").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cat]");
    if (!b) return;
    state.cat = b.dataset.cat;
    store.set("gl_cat", state.cat);
    renderCats();
    renderExercises();
  });
  $("#ex-list").addEventListener("click", (e) => {
    if (e.target.closest("#new-ex")) return openNewExercise();
    const b = e.target.closest("[data-ex]");
    if (!b) return;
    const id = Number(b.dataset.ex);
    state.editMode ? deleteExercise(id) : selectExercise(id);
  });
  $("#edit-ex-toggle").addEventListener("click", () => { state.editMode = !state.editMode; renderExercises(); });

  $$(".step").forEach((b) => b.addEventListener("click", () => onStep(b)));
  $$(".stepper input").forEach((i) => i.addEventListener("focus", () => i.select()));
  $("#add-sets").addEventListener("click", addSets);
  $("#day-log").addEventListener("click", (e) => {
    const r = e.target.closest("[data-set]");
    if (r) openSet(Number(r.dataset.set));
  });

  $("#history-list").addEventListener("click", (e) => {
    const h = e.target.closest("[data-date]");
    if (!h) return;
    state.date = h.dataset.date;
    showView("log");
  });
  $("#history-more").addEventListener("click", () => loadHistory(false));

  $("#goals-btn").addEventListener("click", openGoals);
  $("#lift-filter").addEventListener("click", (e) => {
    const b = e.target.closest("[data-lcat]");
    if (!b) return;
    state.liftCat = b.dataset.lcat;
    renderLiftFilter();
    renderLifts();
  });
  $("#lifts").addEventListener("click", (e) => {
    const b = e.target.closest("[data-lift]");
    if (!b) return;
    const id = Number(b.dataset.lift);
    state.openLift = state.openLift === id ? null : id;
    destroyChart("lift");
    renderLifts();
  });

  $("#form-exercise").addEventListener("submit", onExerciseSubmit);
  $("#form-set").addEventListener("submit", onSetSubmit);
  $("#form-goals").addEventListener("submit", onGoalsSubmit);
  $("#form-data").addEventListener("submit", onDataSubmit);
  $("#import-file").addEventListener("change", onImportFile);

  // Android back button: close an open dialog, otherwise go back to Log, otherwise exit.
  window.Capacitor?.Plugins?.App?.addListener?.("backButton", () => {
    const open = $("dialog[open]");
    if (open) return open.close();
    if (!$("#view-log").hidden) return window.Capacitor.Plugins.App.exitApp();
    showView("log");
  });
}

async function boot() {
  wire();
  try {
    await DB.init();
  } catch (err) {
    document.body.innerHTML = `<p style="padding:24px">Couldn't open storage on this device: ${esc(err.message || err)}</p>`;
    return;
  }
  $("#app").hidden = false;
  if (!state.categories.includes(state.cat)) state.cat = state.categories[0];
  renderCats();
  loadExercises();
  loadDay();
}

boot();
