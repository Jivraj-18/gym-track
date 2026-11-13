"use strict";
// Body tab: daily body weight + circumference measurements, with trends.
// Uses helpers and DB from db.js / app.js (loaded before this file).

const Body = (() => {
  const SITES = DB.bodySites;
  const siteLabel = (k) => SITES.find((s) => s.key === k)?.label || k;
  const DEFAULT_SITES = ["chest", "waist", "hips", "bicep_l", "bicep_r", "thigh_l", "thigh_r"];

  let date = todayStr();
  let range = Number(store.get("gl_bw_range") ?? 30);
  let openSite = null;

  // ---------- which sites to show (per-phone preference) ----------
  function tracked() {
    try {
      const v = JSON.parse(store.get("gl_sites"));
      if (Array.isArray(v)) return SITES.map((s) => s.key).filter((k) => v.includes(k));
    } catch {}
    return DEFAULT_SITES;
  }

  // ---------- trend maths ----------
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const weighIns = () => DB.listBody().filter((b) => b.weight != null);

  // Average of weigh-ins in the 7 days ending on `end` (inclusive)
  function weekAvg(list, end) {
    const start = addDays(end, -6);
    const xs = list.filter((b) => b.date >= start && b.date <= end).map((b) => b.weight);
    return xs.length ? avg(xs) : null;
  }

  // Least-squares slope in kg/week over weigh-ins in the last `days` days
  function slopePerWeek(list, days) {
    const from = addDays(todayStr(), -(days - 1));
    const pts = list.filter((b) => b.date >= from).map((b) => [daysBetween(from, b.date), b.weight]);
    if (pts.length < 4 || pts[pts.length - 1][0] - pts[0][0] < 10) return null;
    const mx = avg(pts.map((p) => p[0])), my = avg(pts.map((p) => p[1]));
    const num_ = pts.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0);
    const den = pts.reduce((a, [x]) => a + (x - mx) ** 2, 0);
    return den ? (num_ / den) * 7 : null;
  }

  const signed = (v, d = 1, unit = "") => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${num(Math.abs(v), d)}${unit}`;

  // ---------- entry form ----------
  function previousBefore(d) {
    return DB.listBody().filter((b) => b.date < d).reverse();
  }

  function renderEntry() {
    const t = todayStr();
    $("#body-day-label").textContent = prettyDate(date, { long: true });
    $("#body-next").disabled = date >= t;
    const cur = DB.getBody(date);
    const prev = previousBefore(date);
    const lastW = prev.find((b) => b.weight != null);
    const lastOf = (k) => prev.find((b) => b.measurements[k] != null);

    $("#in-bw").value = cur?.weight ?? "";
    $("#in-bw").placeholder = lastW ? `last ${num(lastW.weight, 2)}` : "e.g. 72.5";

    const keys = tracked();
    for (const k of Object.keys(cur?.measurements || {})) if (!keys.includes(k)) keys.push(k);
    $("#meas-grid").innerHTML = keys.length ? keys.map((k) => {
      const l = lastOf(k);
      return `<label class="meas">${esc(siteLabel(k))}
        <input inputmode="decimal" name="m_${k}" value="${cur?.measurements[k] ?? ""}" placeholder="${l ? `last ${num(l.measurements[k], 1)}` : "cm"}">
      </label>`;
    }).join("") : `<p class="muted small">No measurements selected. Tap “Choose measurements”.</p>`;

    $("#body-delete").hidden = !cur;
    $("#body-save").textContent = cur ? "Update" : "Save";
    $("#body-error").textContent = "";
  }

  function stepWeight(dir) {
    const inp = $("#in-bw");
    let v = parseFloat(inp.value.replace(",", "."));
    if (!Number.isFinite(v)) {
      const last = previousBefore(date).find((b) => b.weight != null);
      v = last ? last.weight : 70;
    } else {
      v += 0.1 * dir;
    }
    inp.value = String(Math.round(Math.min(400, Math.max(20, v)) * 10) / 10);
  }

  async function save(e) {
    e.preventDefault();
    const f = $("#form-body");
    const measurements = {};
    for (const inp of f.querySelectorAll("[name^=m_]")) {
      const v = inp.value.trim().replace(",", ".");
      if (v !== "") measurements[inp.name.slice(2)] = v;
    }
    try {
      const saved = await DB.saveBody({ date, weight: f.weight.value.trim().replace(",", "."), measurements });
      toast(saved ? "Saved" : "Entry cleared");
      navigator.vibrate?.(30);
      load();
    } catch (err) {
      $("#body-error").textContent = err.message;
    }
  }

  async function remove() {
    if (!confirm(`Delete the body entry for ${prettyDate(date)}?`)) return;
    await DB.deleteBody(date);
    toast("Entry deleted");
    load();
  }

  function setDate(d) {
    if (!d || d > todayStr()) return;
    date = d;
    renderEntry();
  }

  // ---------- weight trend ----------
  function renderWeight() {
    const list = weighIns();
    const box = $("#bw-summary");
    if (!list.length) {
      box.innerHTML = `<div class="empty small">Log your weight a few times a week to see the trend.</div>`;
      destroyChart("bw");
      $("#bw-range").hidden = true;
      $("#chart-bw").parentElement.hidden = true;
      return;
    }
    $("#bw-range").hidden = false;
    $("#chart-bw").parentElement.hidden = false;
    const t = todayStr();
    const latest = list[list.length - 1];
    const nowAvg = weekAvg(list, t) ?? latest.weight;
    const prevAvg = weekAvg(list, addDays(t, -7));
    const slope = slopePerWeek(list, 28);
    const sinceStart = nowAvg - list[0].weight;

    const tiles = [
      [`${num(nowAvg, 1)}<small> kg</small>`, weekAvg(list, t) != null ? "7-day average" : `last weigh-in (${shortDate(latest.date)})`],
      [prevAvg != null ? `${signed(nowAvg - prevAvg, 1)}<small> kg</small>` : "—", "vs previous week"],
      [slope != null ? `${signed(slope, 2)}<small> kg/wk</small>` : "—", "4-week trend"],
      [list.length > 1 ? `${signed(sinceStart, 1)}<small> kg</small>` : "—", `since ${shortDate(list[0].date)}`],
    ];
    let insight = "";
    if (slope != null) {
      const pct = Math.abs(slope) / nowAvg * 100;
      insight = Math.abs(slope) < 0.1
        ? "Your weight has been stable over the last 4 weeks."
        : `You're ${slope < 0 ? "losing" : "gaining"} about ${num(Math.abs(slope), 2)} kg a week (${num(pct, 1)}% of body weight).`;
    } else if (list.length < 4) {
      insight = `Log ${4 - list.length} more weigh-in${4 - list.length > 1 ? "s" : ""} over 2+ weeks to see your rate of change.`;
    }
    box.innerHTML = `<div class="kpis tight">${tiles.map(([v, l]) =>
      `<div class="kpi"><div class="kpi-val">${v}</div><div class="kpi-label">${l}</div></div>`).join("")}</div>
      ${insight ? `<p class="insight">${insight}</p>` : ""}`;

    $$("#bw-range .chip").forEach((c) => c.classList.toggle("active", Number(c.dataset.range) === range));
    drawWeightChart(list);
  }

  function drawWeightChart(list) {
    const t = todayStr();
    const from = range ? addDays(t, -(range - 1)) : list[0].date;
    const shown = list.filter((b) => b.date >= from);
    if (!shown.length) { destroyChart("bw"); return; }
    const origin = shown[0].date;
    const x = (d) => daysBetween(origin, d);
    const raw = shown.map((b) => ({ x: x(b.date), y: b.weight }));
    const smooth = shown.map((b) => ({ x: x(b.date), y: Math.round(weekAvg(list, b.date) * 100) / 100 }));
    drawChart("bw", {
      type: "line",
      data: {
        datasets: [
          { label: "7-day average", data: smooth, borderColor: cssVar("--accent"), backgroundColor: cssVar("--accent"),
            borderWidth: 2.5, pointRadius: 0, tension: 0.3 },
          { label: "Weigh-in", data: raw, showLine: false, pointRadius: 3, borderColor: cssVar("--muted"),
            backgroundColor: cssVar("--muted") },
        ],
      },
      options: {
        plugins: {
          legend: { labels: { boxWidth: 10, boxHeight: 2 } },
          tooltip: { callbacks: {
            title: (items) => shortDate(addDays(origin, items[0].raw.x)),
            label: (c) => `${c.dataset.label}: ${num(c.raw.y, 2)} kg`,
          } },
        },
        scales: {
          x: { type: "linear", grid: { display: false }, min: 0, max: Math.max(1, x(shown[shown.length - 1].date)),
            ticks: { maxTicksLimit: 5, maxRotation: 0, callback: (v) => shortDate(addDays(origin, Math.round(v))) } },
          y: { ticks: { callback: (v) => `${num(v, 1)}` } },
        },
      },
    });
  }

  // ---------- measurements ----------
  function renderMeasurements() {
    const list = DB.listBody();
    const keys = SITES.map((s) => s.key).filter((k) => list.some((b) => b.measurements[k] != null));
    const box = $("#meas-summary");
    if (!keys.length) {
      box.innerHTML = `<div class="empty small">Measure every 2–4 weeks. Changes show up here with a trend per body part.</div>`;
      return;
    }
    box.innerHTML = `<div class="meas-head muted small"><span>Body part</span><span>Latest</span><span>1 month</span><span>Since start</span></div>` +
      keys.map((k) => {
        const pts = list.filter((b) => b.measurements[k] != null).map((b) => ({ date: b.date, v: b.measurements[k] }));
        const last = pts[pts.length - 1];
        const monthAgo = [...pts].reverse().find((p) => daysBetween(p.date, last.date) >= 21);
        const d1 = monthAgo ? last.v - monthAgo.v : null;
        const d0 = pts.length > 1 ? last.v - pts[0].v : null;
        const cell = (d) => (d == null ? `<span class="muted">—</span>` : `<span class="chg ${d > 0 ? "pos" : d < 0 ? "neg" : ""}">${signed(d, 1)}</span>`);
        const open = openSite === k;
        return `<div class="meas-item ${open ? "open" : ""}">
          <button class="meas-row" data-site="${k}" aria-expanded="${open}">
            <span class="meas-name">${esc(siteLabel(k))}<span class="muted small">${shortDate(last.date)}</span></span>
            <span class="meas-v">${num(last.v, 1)}<small> cm</small></span>${cell(d1)}${cell(d0)}
          </button>
          ${open ? `<div class="meas-detail">${pts.length > 1 ? `<div class="chart-box short"><canvas id="chart-site"></canvas></div>` : ""}
            <div class="recent">${pts.slice(-6).reverse().map((p) =>
              `<div class="recent-row"><span>${prettyDate(p.date)}</span><span>${num(p.v, 1)} cm</span></div>`).join("")}</div></div>` : ""}
        </div>`;
      }).join("");
    if (openSite && keys.includes(openSite)) drawSiteChart(openSite, list);
  }

  function drawSiteChart(k, list) {
    const pts = list.filter((b) => b.measurements[k] != null);
    if (pts.length < 2 || !$("#chart-site")) return;
    drawChart("site", {
      type: "line",
      data: {
        labels: pts.map((b) => shortDate(b.date)),
        datasets: [{ label: `${siteLabel(k)} (cm)`, data: pts.map((b) => b.measurements[k]), borderColor: cssVar("--accent"),
          backgroundColor: cssVar("--accent"), tension: 0.25, pointRadius: 3 }],
      },
      options: { plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0 } } } },
    });
  }

  // ---------- log ----------
  function renderHistory() {
    const list = DB.listBody().reverse().slice(0, 30);
    $("#body-history").innerHTML = list.length ? list.map((b) => {
      const n = Object.keys(b.measurements).length;
      return `<button class="body-row ${b.date === date ? "current" : ""}" data-date="${b.date}">
        <span>${prettyDate(b.date)}</span>
        <span>${b.weight != null ? `<strong>${num(b.weight, 2)} kg</strong>` : `<span class="muted">no weight</span>`}${n ? ` <span class="muted small">· ${n} measurement${n > 1 ? "s" : ""}</span>` : ""}</span>
      </button>`;
    }).join("") : `<div class="empty small">Nothing logged yet.</div>`;
  }

  // ---------- sites dialog ----------
  function openSites() {
    const on = tracked();
    $("#site-list").innerHTML = SITES.map((s) =>
      `<label class="check"><input type="checkbox" name="${s.key}" ${on.includes(s.key) ? "checked" : ""}><span>${esc(s.label)}</span></label>`
    ).join("");
    $("#dlg-sites").showModal();
  }

  function onSitesSubmit(e) {
    e.preventDefault();
    if (e.submitter?.value === "ok") {
      store.set("gl_sites", JSON.stringify($$("#site-list input:checked").map((i) => i.name)));
      renderEntry();
    }
    $("#dlg-sites").close();
  }

  function load() {
    renderEntry();
    renderWeight();
    renderMeasurements();
    renderHistory();
  }

  // ---------- wiring ----------
  $("#form-body").addEventListener("submit", save);
  $("#body-delete").addEventListener("click", remove);
  $$('[data-field="bw"] .step').forEach((b) => b.addEventListener("click", () => stepWeight(Number(b.dataset.dir))));
  $("#body-prev").addEventListener("click", () => { setDate(addDays(date, -1)); renderHistory(); });
  $("#body-next").addEventListener("click", () => { setDate(addDays(date, 1)); renderHistory(); });
  $("#body-day-label").addEventListener("click", () => {
    const p = $("#body-picker");
    p.max = todayStr();
    p.value = date;
    try { p.showPicker(); } catch { p.click(); }
  });
  $("#body-picker").addEventListener("change", (e) => { setDate(e.target.value); renderHistory(); });
  $("#bw-range").addEventListener("click", (e) => {
    const c = e.target.closest("[data-range]");
    if (!c) return;
    range = Number(c.dataset.range);
    store.set("gl_bw_range", range);
    renderWeight();
  });
  $("#meas-summary").addEventListener("click", (e) => {
    const r = e.target.closest("[data-site]");
    if (!r) return;
    openSite = openSite === r.dataset.site ? null : r.dataset.site;
    destroyChart("site");
    renderMeasurements();
  });
  $("#body-history").addEventListener("click", (e) => {
    const r = e.target.closest("[data-date]");
    if (!r) return;
    setDate(r.dataset.date);
    renderHistory();
    $("#view-body").scrollIntoView({ behavior: "smooth" });
  });
  $("#sites-btn").addEventListener("click", openSites);
  $("#form-sites").addEventListener("submit", onSitesSubmit);
  $$("#meas-grid, #in-bw").forEach((el) => el.addEventListener("focusin", (e) => e.target.select?.()));

  return { load };
})();
