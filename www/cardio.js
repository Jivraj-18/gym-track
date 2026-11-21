"use strict";
// Cardio tab: treadmill, cycle and other cardio sessions, with trends.
// One session = one entry: time (required) plus optional distance, speed, incline / resistance level,
// heart rate and calories. Uses helpers and DB from db.js / app.js (loaded before this file).

const Cardio = (() => {
  const ACTS = DB.cardioActivities;
  const actInfo = (name) => ACTS.find((a) => a.name === name) || ACTS[0];
  const COLORS = ["#ff9158", "#5cc8ff", "#c8f04a", "#4fe0b6", "#b48cff", "#ffd84a", "#ff7a90", "#8b939c"];
  const actColor = (name) => COLORS[Math.max(0, ACTS.findIndex((a) => a.name === name))];
  const PACE_ACTS = new Set(["Treadmill", "Outdoor run", "Walk"]); // also show min/km

  let date = todayStr();
  let activity = ACTS.some((a) => a.name === store.get("gl_cardio_act")) ? store.get("gl_cardio_act") : ACTS[0].name;
  let editingId = null;
  let anchor = "speed"; // which of speed / distance you typed last; the other one is derived
  let filter = "All";
  let metric = "speed";

  const form = () => $("#form-cardio").elements;
  const val = (name) => form()[name].value.trim().replace(",", ".");

  // "30" = 30 minutes; "30:00" = 30 min; "1:05:00" = 1 h 5 min. NaN if unreadable.
  function parseTime(str) {
    const s = String(str ?? "").trim().replace(",", ".");
    if (!s) return NaN;
    if (s.includes(":")) return parseDur(s);
    const m = Number(s);
    return Number.isFinite(m) && m > 0 ? Math.round(m * 60) : NaN;
  }

  const paceText = (c) => `${fmtDur(Math.round(c.duration / c.distance))}/km`;

  function summary(c) {
    const parts = [fmtDur(c.duration)];
    if (c.distance != null) parts.push(`${num(c.distance, 2)} km`);
    const sp = speedKmh(c);
    if (sp != null) parts.push(`${num(sp, 1)} km/h`);
    if (sp != null && PACE_ACTS.has(c.activity)) parts.push(paceText(c));
    if (c.incline) parts.push(`${num(c.incline, 1)}% incline`);
    if (c.level != null) parts.push(`level ${num(c.level, 1)}`);
    if (c.avg_hr) parts.push(`${c.avg_hr} bpm${c.max_hr ? ` (max ${c.max_hr})` : ""}`);
    else if (c.max_hr) parts.push(`max ${c.max_hr} bpm`);
    if (c.calories) parts.push(`${num(c.calories, 0)} kcal`);
    return parts.join(" · ");
  }

  const hoursText = (sec) => {
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? `${h}h ${pad(m)}m` : `${m}m`;
  };

  // ---------- entry form ----------
  function lastOf(act, exceptId = null) {
    const rows = DB.listCardio().filter((c) => c.activity === act && c.id !== exceptId);
    return rows.length ? rows[rows.length - 1] : null;
  }

  function renderActs() {
    $("#cardio-acts").innerHTML = ACTS.map((a) =>
      `<button type="button" class="chip ${a.name === activity ? "active" : ""}" style="--cat:${actColor(a.name)}" data-act="${esc(a.name)}">${esc(a.name)}</button>`
    ).join("");
  }

  function showFields() {
    const info = actInfo(activity);
    $$("#form-cardio [data-f]").forEach((el) => {
      const f = el.dataset.f;
      el.hidden = (f === "incline" && info.extra !== "incline") || (f === "level" && info.extra !== "level");
    });
  }

  // Recompute whichever of speed / distance you did not type last, from the time.
  function relink(changed) {
    const f = form();
    if (changed === "speed" || changed === "distance") anchor = changed;
    const other = anchor === "speed" ? f.distance : f.speed;
    const src = parseFloat(val(anchor));
    if (!Number.isFinite(src) || src <= 0) {
      if (changed === anchor) other.value = "";
      return;
    }
    const dur = parseTime(f.duration.value);
    if (!(dur > 0)) return;
    other.value = anchor === "speed"
      ? String(Math.round(src * (dur / 3600) * 100) / 100)
      : String(Math.round((src / (dur / 3600)) * 10) / 10);
  }

  // Fresh form for the chosen activity, starting from your last session of it (time, speed, incline/level).
  // Distance and heart rate start empty: they change every session.
  function resetForm() {
    editingId = null;
    const f = form();
    for (const el of $$("#form-cardio input")) el.value = "";
    const last = lastOf(activity);
    anchor = activity === "Treadmill" ? "speed" : "distance";
    if (last) {
      f.duration.value = fmtDur(last.duration);
      const sp = speedKmh(last);
      if (sp != null) f.speed.value = String(Math.round(sp * 10) / 10);
      if (last.incline != null) f.incline.value = last.incline;
      if (last.level != null) f.level.value = last.level;
      if (sp != null) { anchor = "speed"; relink("duration"); }
    }
    f.duration.placeholder = last ? "" : "e.g. 30";
    f.distance.placeholder = last?.distance != null ? `last ${num(last.distance, 2)}` : "optional";
    f.speed.placeholder = "optional";
    const lastHr = DB.listCardio().filter((c) => c.activity === activity && c.avg_hr).pop();
    f.avg_hr.placeholder = lastHr ? `last ${lastHr.avg_hr}` : "optional";
    f.max_hr.placeholder = lastHr?.max_hr ? `last ${lastHr.max_hr}` : "optional";
    f.calories.placeholder = "optional";
    f.incline.placeholder = "0 = flat";
    f.level.placeholder = "optional";
    $("#cardio-hint").textContent = last ? `Filled in from your last ${activity.toLowerCase()} (${prettyDate(last.date)}). Change what's different today.` : "";
    renderEntryChrome();
  }

  function renderEntryChrome() {
    $("#cardio-day-label").textContent = prettyDate(date, { long: true });
    $("#cardio-next").disabled = date >= todayStr();
    $("#cardio-save").textContent = editingId ? "Update" : "Save";
    $("#cardio-delete").hidden = !editingId;
    $("#cardio-cancel").hidden = !editingId;
    $("#cardio-error").textContent = "";
    renderActs();
    showFields();
  }

  function startEdit(id) {
    const c = DB.getCardio(id);
    if (!c) return;
    editingId = id;
    date = c.date;
    activity = c.activity;
    const f = form();
    f.duration.value = fmtDur(c.duration);
    f.distance.value = c.distance ?? "";
    const sp = speedKmh(c);
    f.speed.value = sp != null ? String(Math.round(sp * 10) / 10) : "";
    f.incline.value = c.incline ?? "";
    f.level.value = c.level ?? "";
    f.avg_hr.value = c.avg_hr ?? "";
    f.max_hr.value = c.max_hr ?? "";
    f.calories.value = c.calories ?? "";
    anchor = "distance";
    $("#cardio-hint").textContent = "Editing a saved session.";
    renderEntryChrome();
    renderDay();
    renderHistory();
    $("#view-cardio").scrollIntoView({ behavior: "smooth" });
  }

  // Short labels so the toast stays a readable pill
  function prLine(p) {
    return p.kind === "distance" ? `distance ${num(p.value, 2)} km`
      : p.kind === "speed" ? `speed ${num(p.value, 1)} km/h`
      : `time ${fmtDur(p.value)}`;
  }

  async function save(e) {
    e.preventDefault();
    const btn = $("#cardio-save");
    try {
      const duration = parseTime(form().duration.value);
      if (!Number.isFinite(duration)) throw new Error("Enter the time in minutes (30) or as m:ss (45:30)");
      if (val("speed") && !val("distance")) throw new Error("Speed needs the time to work out distance. Check the time.");
      btn.disabled = true;
      const wasEditing = editingId != null;
      const { prs } = await DB.saveCardio({
        id: editingId ?? undefined, date, activity, duration,
        distance: val("distance"), incline: val("incline"), level: val("level"),
        avg_hr: val("avg_hr"), max_hr: val("max_hr"), calories: val("calories"),
      });
      if (prs.length) {
        toast(`🏆 New ${activity.toLowerCase()} PR: ${prs.map(prLine).join(" · ")}`, "pr", 4500);
        navigator.vibrate?.([40, 60, 40]);
      } else {
        toast(wasEditing ? "Session updated" : "Session saved");
        navigator.vibrate?.(30);
      }
      resetForm();
      load();
    } catch (err) {
      $("#cardio-error").textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }

  async function remove() {
    if (editingId == null || !confirm("Delete this cardio session?")) return;
    try {
      await DB.deleteCardio(editingId);
      toast("Session deleted");
      resetForm();
      load();
    } catch (err) {
      $("#cardio-error").textContent = err.message;
    }
  }

  function setDate(d) {
    if (!d || d > todayStr()) return;
    date = d;
    editingId = null;
    resetForm();
    renderDay();
    renderHistory();
  }

  // ---------- lists ----------
  function row(c, { showDate }) {
    return `<button class="cardio-row ${c.id === editingId ? "current" : ""}" style="--cat:${actColor(c.activity)}" data-id="${c.id}">
      <div class="cr-top"><span><span class="dot"></span>${esc(c.activity)}</span><span class="muted small">${showDate ? prettyDate(c.date) : "edit"}</span></div>
      <div class="cr-sub">${esc(summary(c))}</div>
    </button>`;
  }

  function renderDay() {
    $("#cardio-day-title").textContent = date === todayStr() ? "Today's cardio" : `Cardio on ${prettyDate(date)}`;
    const list = DB.listCardioOn(date);
    $("#cardio-day").innerHTML = list.length ? list.map((c) => row(c, { showDate: false })).join("")
      : `<div class="empty small">No cardio logged ${date === todayStr() ? "yet today" : "on this day"}.</div>`;
  }

  function renderHistory() {
    const list = DB.listCardio().reverse().slice(0, 30);
    $("#cardio-history").innerHTML = list.length ? list.map((c) => row(c, { showDate: true })).join("")
      : `<div class="empty small">Nothing logged yet.</div>`;
  }

  // ---------- progress ----------
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  const avg = (xs) => (xs.length ? sum(xs) / xs.length : null);

  function aggregate(rows) {
    const withDist = rows.filter((c) => c.distance != null);
    const hrs = rows.filter((c) => c.avg_hr);
    const km = sum(withDist.map((c) => c.distance));
    const distSec = sum(withDist.map((c) => c.duration));
    return {
      sessions: rows.length,
      seconds: sum(rows.map((c) => c.duration)),
      km: withDist.length ? km : null,
      speed: distSec ? km / (distSec / 3600) : null,
      hr: hrs.length ? avg(hrs.map((c) => c.avg_hr)) : null,
      days: new Set(rows.map((c) => c.date)).size,
    };
  }

  function renderProgress() {
    const all = DB.listCardio();
    const used = ACTS.map((a) => a.name).filter((n) => all.some((c) => c.activity === n));
    if (filter !== "All" && !used.includes(filter)) filter = "All";
    const filterBox = $("#cardio-filter");
    if (!all.length) {
      filterBox.innerHTML = "";
      $("#cardio-kpis").innerHTML = `<div class="empty small">Log a few sessions and your pace, distance and heart-rate trends show up here.</div>`;
      $("#cardio-insight").hidden = true;
      $("#cardio-metric").innerHTML = "";
      $("#cardio-chart-box").hidden = true;
      $("#cardio-bests").innerHTML = "";
      destroyChart("cardio");
      return;
    }
    filterBox.innerHTML = ["All", ...used].map((n) =>
      `<button class="chip ${n === filter ? "active" : ""}" style="--cat:${n === "All" ? "var(--text)" : actColor(n)}" data-filter="${esc(n)}">${esc(n)}</button>`
    ).join("");

    const rows = filter === "All" ? all : all.filter((c) => c.activity === filter);
    const t = todayStr();
    const days = (c) => daysBetween(c.date, t);
    const cur = aggregate(rows.filter((c) => days(c) < 30));
    const prev = aggregate(rows.filter((c) => days(c) >= 30 && days(c) < 60));
    const hasPrev = prev.sessions > 0;

    const d = (a, b, digits, unit) => {
      if (!hasPrev || a == null || b == null) return "";
      const diff = a - b;
      return `<div class="kpi-delta">${Math.abs(diff) < 10 ** -digits / 2 ? "±0" : `${diff > 0 ? "+" : "−"}${num(Math.abs(diff), digits)}`}${unit} vs prev 30 days</div>`;
    };
    const tiles = [
      [`${cur.sessions}`, "sessions", d(cur.sessions, prev.sessions, 0, "")],
      [cur.seconds ? hoursText(cur.seconds) : "—", "time", hasPrev && cur.seconds ? d(cur.seconds / 60, prev.seconds / 60, 0, " min") : ""],
    ];
    if (cur.km != null) tiles.push([`${num(cur.km, 1)}<small> km</small>`, "distance", d(cur.km, prev.km, 1, " km")]);
    if (filter === "All") tiles.push([`${cur.days}`, "active days", d(cur.days, prev.days, 0, "")]);
    else if (cur.speed != null) tiles.push([`${num(cur.speed, 1)}<small> km/h</small>`, "avg speed", d(cur.speed, prev.speed, 1, " km/h")]);
    if (filter !== "All" && cur.hr != null) tiles.push([`${num(cur.hr, 0)}<small> bpm</small>`, "avg heart rate", d(cur.hr, prev.hr, 0, " bpm")]);
    $("#cardio-kpis").innerHTML = `<div class="kpis tight">${tiles.map(([v, l, delta]) =>
      `<div class="kpi"><div class="kpi-val">${v}</div><div class="kpi-label">${l}</div>${delta}</div>`).join("")}</div>`;

    renderInsight(rows);
    renderCardioChart(rows);
    renderBests(rows);
  }

  // Heart-rate efficiency: compare your last few sessions with the ones before.
  function renderInsight(rows) {
    const el = $("#cardio-insight");
    el.hidden = true;
    if (filter === "All") return;
    const pts = rows.filter((c) => c.distance != null && c.avg_hr);
    if (pts.length < 4) {
      const n = rows.filter((c) => c.avg_hr).length;
      if (n && n < 4) { el.hidden = false; el.textContent = `Log heart rate on ${4 - pts.length} more session${4 - pts.length > 1 ? "s" : ""} with distance to see if you're getting fitter at the same effort.`; }
      return;
    }
    const k = Math.min(3, Math.floor(pts.length / 2));
    const a = pts.slice(-k), b = pts.slice(-2 * k, -k);
    const sa = avg(a.map(speedKmh)), sb = avg(b.map(speedKmh));
    const ha = avg(a.map((c) => c.avg_hr)), hb = avg(b.map((c) => c.avg_hr));
    const now = `${num(sa, 1)} km/h at ${num(ha, 0)} bpm`, before = `${num(sb, 1)} km/h at ${num(hb, 0)} bpm`;
    let msg;
    if (sa - sb >= 0.2 && ha - hb <= 2) msg = `Faster at the same or lower heart rate: ${now}, up from ${before}. A good sign your aerobic fitness is improving.`;
    else if (sa - sb <= -0.2 && ha - hb >= 2) msg = `Slower at a higher heart rate lately: ${now}, down from ${before}. Heat, poor sleep or fatigue can do this; ease off if it continues.`;
    else msg = `Last ${k} sessions: ${now}. Before that: ${before}.`;
    el.hidden = false;
    el.textContent = msg;
  }

  const METRICS = {
    speed: { label: "Speed", get: (c) => speedKmh(c), fmt: (v) => `${num(v, 1)} km/h` },
    distance: { label: "Distance", get: (c) => c.distance, fmt: (v) => `${num(v, 2)} km` },
    time: { label: "Time", get: (c) => Math.round(c.duration / 6) / 10, fmt: (v) => `${num(v, 1)} min` },
  };

  function renderCardioChart(rows) {
    const box = $("#cardio-chart-box");
    const chips = $("#cardio-metric");
    if (filter === "All") {
      chips.innerHTML = "";
      return drawWeekly(rows);
    }
    const avail = Object.keys(METRICS).filter((k) => rows.filter((c) => METRICS[k].get(c) != null).length >= 2);
    if (!avail.length) {
      chips.innerHTML = "";
      box.hidden = true;
      destroyChart("cardio");
      return;
    }
    if (!avail.includes(metric)) metric = avail[0];
    chips.innerHTML = avail.map((k) => `<button class="chip ${k === metric ? "active" : ""}" data-metric="${k}">${METRICS[k].label}</button>`).join("");
    box.hidden = false;
    const m = METRICS[metric];
    const pts = rows.slice(-40);
    const color = actColor(filter);
    const muted = cssVar("--muted");
    const hasHr = pts.some((c) => c.avg_hr);
    const datasets = [{
      label: m.label, data: pts.map((c) => m.get(c) ?? null), borderColor: color, backgroundColor: color,
      tension: 0.25, pointRadius: 3, spanGaps: true, yAxisID: "y",
    }];
    if (hasHr) {
      datasets.push({ label: "Avg heart rate", data: pts.map((c) => c.avg_hr ?? null), borderColor: muted, backgroundColor: muted,
        borderDash: [4, 4], tension: 0.25, pointRadius: 2, spanGaps: true, yAxisID: "y1" });
    }
    drawChart("cardio", {
      type: "line",
      data: { labels: pts.map((c) => shortDate(c.date)), datasets },
      options: {
        plugins: {
          legend: { labels: { boxWidth: 10, boxHeight: 2 } },
          tooltip: { callbacks: { label: (c) => (c.raw == null ? "" : c.dataset.yAxisID === "y1" ? `Avg heart rate: ${c.raw} bpm` : `${m.label}: ${m.fmt(c.raw)}`) } },
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0 } },
          y: { position: "left" },
          ...(hasHr ? { y1: { position: "right", grid: { drawOnChartArea: false }, ticks: { callback: (v) => `${v}` } } } : {}),
        },
      },
    });
  }

  // All activities: minutes per week for the last 12 weeks, stacked by activity.
  function drawWeekly(rows) {
    const box = $("#cardio-chart-box");
    const start = addDays(mondayOf(todayStr()), -11 * 7);
    const weeks = Array.from({ length: 12 }, (_, i) => addDays(start, i * 7));
    const names = ACTS.map((a) => a.name).filter((n) => rows.some((c) => c.activity === n && c.date >= start));
    if (!names.length) { box.hidden = true; destroyChart("cardio"); return; }
    box.hidden = false;
    drawChart("cardio", {
      type: "bar",
      data: {
        labels: weeks.map((w) => shortDate(w)),
        datasets: names.map((n) => ({
          label: n, backgroundColor: actColor(n),
          data: weeks.map((w) => Math.round(sum(rows.filter((c) => c.activity === n && c.date >= w && c.date <= addDays(w, 6)).map((c) => c.duration)) / 60)),
        })),
      },
      options: {
        plugins: { legend: { labels: { boxWidth: 10, boxHeight: 10 } },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw} min` } } },
        scales: { x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0 } },
          y: { stacked: true, ticks: { callback: (v) => `${v} min` } } },
      },
    });
  }

  function renderBests(rows) {
    const box = $("#cardio-bests");
    if (filter === "All" || !rows.length) { box.innerHTML = ""; return; }
    const tile = (label, c, value) => `<div><span class="muted small">${label}</span><strong>${value}</strong><span class="muted small">${shortDate(c.date)}</span></div>`;
    const pick = (score) => rows.reduce((best, c) => (score(c) != null && (best == null || score(c) > score(best)) ? c : best), null);
    const dist = pick((c) => c.distance);
    const fast = pick((c) => (c.duration >= 600 ? speedKmh(c) : null));
    const long = pick((c) => c.duration);
    const tiles = [];
    if (dist) tiles.push(tile("Longest", dist, `${num(dist.distance, 2)} km`));
    if (fast) tiles.push(tile("Fastest avg (10+ min)", fast, `${num(speedKmh(fast), 1)} km/h`));
    if (long) tiles.push(tile("Longest time", long, fmtDur(long.duration)));
    box.innerHTML = `<div class="lift-stats">${tiles.join("")}</div>`;
  }

  function load() {
    renderEntryChrome();
    renderDay();
    renderProgress();
    renderHistory();
  }

  // ---------- wiring ----------
  $("#form-cardio").addEventListener("submit", save);
  $("#cardio-delete").addEventListener("click", remove);
  $("#cardio-cancel").addEventListener("click", () => { resetForm(); renderDay(); renderHistory(); });
  $("#form-cardio").addEventListener("input", (e) => {
    const n = e.target.name;
    if (n === "speed" || n === "distance" || n === "duration") relink(n);
  });
  $("#form-cardio").addEventListener("focusin", (e) => e.target.select?.());
  $("#cardio-acts").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || b.dataset.act === activity) return;
    activity = b.dataset.act;
    store.set("gl_cardio_act", activity);
    resetForm();
  });
  $("#cardio-prev").addEventListener("click", () => setDate(addDays(date, -1)));
  $("#cardio-next").addEventListener("click", () => setDate(addDays(date, 1)));
  $("#cardio-day-label").addEventListener("click", () => {
    const p = $("#cardio-picker");
    p.max = todayStr();
    p.value = date;
    try { p.showPicker(); } catch { p.click(); }
  });
  $("#cardio-picker").addEventListener("change", (e) => setDate(e.target.value));
  for (const sel of ["#cardio-day", "#cardio-history"]) {
    $(sel).addEventListener("click", (e) => {
      const r = e.target.closest("[data-id]");
      if (r) startEdit(Number(r.dataset.id));
    });
  }
  $("#cardio-filter").addEventListener("click", (e) => {
    const b = e.target.closest("[data-filter]");
    if (!b) return;
    filter = b.dataset.filter;
    renderProgress();
  });
  $("#cardio-metric").addEventListener("click", (e) => {
    const b = e.target.closest("[data-metric]");
    if (!b) return;
    metric = b.dataset.metric;
    renderProgress();
  });

  // Called when the tab opens. Starts fresh unless you're mid-edit.
  function open() {
    if (editingId == null) resetForm();
    load();
  }

  // From History: jump to a given day's cardio.
  function showDate(d) {
    date = d;
    editingId = null;
  }

  return { load: open, showDate };
})();
