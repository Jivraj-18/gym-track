"use strict";
// On-device storage for Gym Log. Everything lives in IndexedDB inside the app's
// private storage; nothing leaves the phone unless you export it.
// Data is small (a few thousand sets a year), so it's loaded into memory on start
// and every change is written through to IndexedDB.

const CATEGORIES = ["Legs", "Arms & Shoulders", "Pull", "Push", "Abs"];

// Exercise types: "reps" (weight × reps) or "time" (held for a duration, optional added weight).
const DEFAULT_EXERCISES = {
  "Legs": ["Squat", "Leg Press", "Romanian Deadlift", "Leg Curl", "Leg Extension", "Calf Raise", "Wall Sit"],
  "Arms & Shoulders": ["Overhead Press", "Lateral Raise", "Bicep Curl", "Hammer Curl", "Tricep Pushdown"],
  "Pull": ["Deadlift", "Pull-up", "Lat Pulldown", "Barbell Row", "Seated Cable Row", "Face Pull", "Dead Hang"],
  "Push": ["Bench Press", "Incline Dumbbell Press", "Dips", "Push-up", "Chest Fly"],
  "Abs": ["Plank", "Side Plank", "Hanging Leg Raise", "Cable Crunch", "Russian Twist"],
};
const TIMED_DEFAULTS = new Set(["Plank", "Side Plank", "Dead Hang", "Wall Sit"]);

// Body circumference sites, in cm.
const BODY_SITES = [
  { key: "neck", label: "Neck" },
  { key: "shoulders", label: "Shoulders" },
  { key: "chest", label: "Chest" },
  { key: "waist", label: "Waist" },
  { key: "belly", label: "Belly (at navel)" },
  { key: "hips", label: "Hips" },
  { key: "bicep_l", label: "Left bicep" },
  { key: "bicep_r", label: "Right bicep" },
  { key: "forearm_l", label: "Left forearm" },
  { key: "forearm_r", label: "Right forearm" },
  { key: "thigh_l", label: "Left thigh" },
  { key: "thigh_r", label: "Right thigh" },
  { key: "calf_l", label: "Left calf" },
  { key: "calf_r", label: "Right calf" },
];
const SITE_KEYS = new Set(BODY_SITES.map((s) => s.key));

const EXPORT_FORMAT = "gym-log-export";
const EXPORT_VERSION = 2;

const e1rm = (weight, reps) => weight * (1 + reps / 30); // Epley estimate

const DB = (() => {
  let idb;
  let exercises = []; // {id, name, category, type, created_at}
  let sets = [];      // {id, exercise_id, workout_date, set_number, weight, reps|null, duration|null, created_at}
  let body = [];      // {date, weight|null, measurements: {site: cm}, updated_at}

  // ---------- IndexedDB plumbing ----------
  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("gymlog", 2);
      req.onupgradeneeded = (e) => {
        const d = req.result;
        if (e.oldVersion < 1) {
          d.createObjectStore("exercises", { keyPath: "id", autoIncrement: true });
          d.createObjectStore("sets", { keyPath: "id", autoIncrement: true });
          d.createObjectStore("meta", { keyPath: "key" });
        }
        if (e.oldVersion < 2) d.createObjectStore("body", { keyPath: "date" }); // one entry per day
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Run fn(transaction) and resolve when the transaction commits.
  function tx(storeNames, fn) {
    return new Promise((resolve, reject) => {
      const t = idb.transaction(storeNames, "readwrite");
      const out = fn(t);
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("Save failed"));
    });
  }

  function req(r) {
    return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  }
  const getAll = (store) => req(idb.transaction(store).objectStore(store).getAll());
  const getMeta = (key) => req(idb.transaction("meta").objectStore("meta").get(key)).catch(() => null);

  // add() and record the generated id on the object
  function addTo(store, obj) {
    store.add(obj).onsuccess = (e) => { obj.id = e.target.result; };
    return obj;
  }

  async function init() {
    idb = await open();
    [exercises, sets, body] = await Promise.all([getAll("exercises"), getAll("sets"), getAll("body")]);
    const [seeded, v2] = await Promise.all([getMeta("seeded"), getMeta("v2")]);
    const now = new Date().toISOString();

    if (!seeded && exercises.length === 0) {
      await tx(["exercises", "meta"], (t) => {
        const st = t.objectStore("exercises");
        for (const [category, names] of Object.entries(DEFAULT_EXERCISES)) {
          for (const name of names) {
            exercises.push(addTo(st, { name, category, type: TIMED_DEFAULTS.has(name) ? "time" : "reps", created_at: now }));
          }
        }
        t.objectStore("meta").put({ key: "seeded", value: true });
        t.objectStore("meta").put({ key: "v2", value: true });
      });
    } else if (!v2) {
      await migrateToV2(now);
    }
    // Ask the OS not to evict our storage (no-op where unsupported).
    try { await navigator.storage?.persist?.(); } catch {}
  }

  // v1 → v2: exercises gain a type. Plank was logged with seconds in the reps field,
  // so it becomes a timed exercise and its sets move reps → duration.
  // The new timed defaults are added if you don't already have them.
  async function migrateToV2(now) {
    const changedEx = [];
    const changedSets = [];
    for (const e of exercises) {
      if (e.type) continue;
      e.type = e.name === "Plank" ? "time" : "reps";
      changedEx.push(e);
      if (e.type === "time") {
        for (const s of sets) {
          if (s.exercise_id === e.id && s.duration == null) { s.duration = s.reps; s.reps = null; changedSets.push(s); }
        }
      }
    }
    const missing = [];
    for (const [category, names] of Object.entries(DEFAULT_EXERCISES)) {
      for (const name of names) {
        if (TIMED_DEFAULTS.has(name) && !exercises.some((e) => sameName(e.name, name))) {
          missing.push({ name, category, type: "time", created_at: now });
        }
      }
    }
    await tx(["exercises", "sets", "meta"], (t) => {
      const es = t.objectStore("exercises");
      changedEx.forEach((e) => es.put(e));
      missing.forEach((e) => addTo(es, e));
      changedSets.forEach((s) => t.objectStore("sets").put(s));
      t.objectStore("meta").put({ key: "v2", value: true });
    });
    exercises.push(...missing);
  }

  // ---------- validation ----------
  const fail = (msg) => { throw new Error(msg); };
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const checkDate = (d) => (DATE_RE.test(d || "") ? d : fail("Date must be YYYY-MM-DD"));
  function checkWeight(w) {
    const n = Number(w);
    if (!Number.isFinite(n) || n < 0 || n > 1000) fail("Weight must be between 0 and 1000 kg");
    return Math.round(n * 100) / 100;
  }
  function checkReps(r) {
    const n = Number(r);
    if (!Number.isInteger(n) || n < 1 || n > 1000) fail("Reps must be a whole number from 1 to 1000");
    return n;
  }
  function checkDuration(d) {
    const n = Number(d);
    if (!Number.isInteger(n) || n < 1 || n > 36000) fail("Time must be between 1 second and 10 hours");
    return n;
  }
  const checkCategory = (c) => (CATEGORIES.includes(c) ? c : fail(`Category must be one of: ${CATEGORIES.join(", ")}`));
  const checkType = (t) => (t === "time" || t === "reps" ? t : fail("Type must be reps or time"));
  function checkName(n) {
    const name = String(n ?? "").trim().replace(/\s+/g, " ");
    if (!name || name.length > 60) fail("Exercise name must be 1–60 characters");
    return name;
  }
  const exById = (id) => exercises.find((e) => e.id === id) || fail("Exercise not found");
  const sameName = (a, b) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
  const isTimed = (ex) => ex.type === "time";

  // Validate one set for an exercise's type → {weight, reps, duration}
  function cleanSet(ex, s) {
    return isTimed(ex)
      ? { weight: checkWeight(s.weight ?? 0), reps: null, duration: checkDuration(s.duration) }
      : { weight: checkWeight(s.weight), reps: checkReps(s.reps), duration: null };
  }

  // ---------- exercises ----------
  function listExercises() {
    const stats = new Map();
    for (const s of sets) {
      const st = stats.get(s.exercise_id) || { last: null, days: new Set() };
      st.days.add(s.workout_date);
      if (!st.last || s.workout_date > st.last) st.last = s.workout_date;
      stats.set(s.exercise_id, st);
    }
    return exercises
      .map((e) => ({ ...e, last_done: stats.get(e.id)?.last || null, sessions: stats.get(e.id)?.days.size || 0 }))
      .sort((a, b) => a.category.localeCompare(b.category) || b.sessions - a.sessions || a.name.localeCompare(b.name));
  }

  async function createExercise({ name, category, type = "reps" }) {
    name = checkName(name);
    category = checkCategory(category);
    type = checkType(type);
    if (exercises.some((e) => sameName(e.name, name))) fail(`You already have "${name}"`);
    const ex = { name, category, type, created_at: new Date().toISOString() };
    await tx(["exercises"], (t) => addTo(t.objectStore("exercises"), ex));
    exercises.push(ex);
    return ex;
  }

  async function deleteExercise(id) {
    exById(id);
    const doomed = sets.filter((s) => s.exercise_id === id);
    await tx(["exercises", "sets"], (t) => {
      t.objectStore("exercises").delete(id);
      for (const s of doomed) t.objectStore("sets").delete(s.id);
    });
    exercises = exercises.filter((e) => e.id !== id);
    sets = sets.filter((s) => s.exercise_id !== id);
  }

  const bySetOrder = (a, b) => a.set_number - b.set_number || a.id - b.id;
  // Pick the better of two sets: rep sets by estimated 1RM then reps; timed sets by duration then weight.
  const betterReps = (a, b) => (e1rm(b.weight, b.reps) > e1rm(a.weight, a.reps) ||
    (e1rm(b.weight, b.reps) === e1rm(a.weight, a.reps) && b.reps > a.reps) ? b : a);
  const betterTime = (a, b) => (b.duration > a.duration || (b.duration === a.duration && b.weight > a.weight) ? b : a);
  const betterFor = (ex) => (isTimed(ex) ? betterTime : betterReps);

  // Most recent session before `before` (any date if omitted) + all-time best set.
  function lastSession(id, before) {
    const ex = exById(id);
    const mine = sets.filter((s) => s.exercise_id === id);
    const b = mine.length ? mine.reduce(betterFor(ex)) : null;
    const best = b && { weight: b.weight, reps: b.reps, duration: b.duration, date: b.workout_date };
    const prior = before ? mine.filter((s) => s.workout_date < before) : mine;
    if (!prior.length) return { date: null, sets: [], best, type: ex.type };
    const date = prior.reduce((m, s) => (s.workout_date > m ? s.workout_date : m), "");
    return { date, sets: prior.filter((s) => s.workout_date === date).sort(bySetOrder), best, type: ex.type };
  }

  // ---------- sets ----------
  function listSets(date) {
    checkDate(date);
    return sets.filter((s) => s.workout_date === date).sort((a, b) => a.id - b.id)
      .map((s) => {
        const e = exercises.find((x) => x.id === s.exercise_id);
        return { ...s, exercise: e?.name ?? "?", category: e?.category ?? "", type: e?.type ?? "reps" };
      });
  }

  // Returns {added, pr} where pr is set when the best new set beats all earlier history.
  async function addSets({ exercise_id, date, sets: list }) {
    const ex = exById(exercise_id);
    checkDate(date);
    if (!Array.isArray(list) || list.length < 1 || list.length > 30) fail("Add between 1 and 30 sets at a time");
    const clean = list.map((s) => cleanSet(ex, s));

    const history = sets.filter((s) => s.exercise_id === exercise_id);
    const start = history.filter((s) => s.workout_date === date).reduce((m, s) => Math.max(m, s.set_number), 0);
    const now = new Date().toISOString();
    const rows = clean.map((s, i) => ({ exercise_id, workout_date: date, set_number: start + i + 1, ...s, created_at: now }));
    await tx(["sets"], (t) => rows.forEach((r) => addTo(t.objectStore("sets"), r)));
    sets.push(...rows);

    let pr = null;
    if (history.length) {
      const newBest = clean.reduce(betterFor(ex));
      if (isTimed(ex)) {
        const prevDur = Math.max(...history.map((s) => s.duration || 0));
        if (newBest.duration > prevDur) pr = { ...newBest, timed: true, previous_duration: prevDur };
      } else {
        const prevBest = history.reduce(betterReps);
        const bodyweight = history.every((s) => s.weight === 0) && newBest.weight === 0;
        const prevReps = Math.max(...history.map((s) => s.reps));
        if (bodyweight ? newBest.reps > prevReps : e1rm(newBest.weight, newBest.reps) > e1rm(prevBest.weight, prevBest.reps) + 1e-9) {
          pr = { ...newBest, bodyweight, e1rm: e1rm(newBest.weight, newBest.reps),
            previous_e1rm: e1rm(prevBest.weight, prevBest.reps), previous_reps: prevReps };
        }
      }
    }
    return { added: rows.length, pr };
  }

  async function updateSet(id, values) {
    const s = sets.find((x) => x.id === id) || fail("Set not found");
    const next = { ...s, ...cleanSet(exById(s.exercise_id), values) };
    await tx(["sets"], (t) => t.objectStore("sets").put(next));
    Object.assign(s, next);
  }

  async function deleteSet(id) {
    const s = sets.find((x) => x.id === id) || fail("Set not found");
    const siblings = sets.filter((x) => x.id !== id && x.exercise_id === s.exercise_id && x.workout_date === s.workout_date)
      .sort(bySetOrder).map((x, i) => ({ ...x, set_number: i + 1 }));
    await tx(["sets"], (t) => {
      const st = t.objectStore("sets");
      st.delete(id);
      siblings.forEach((x) => st.put(x));
    });
    sets = sets.filter((x) => x.id !== id);
    for (const x of siblings) Object.assign(sets.find((y) => y.id === x.id), x);
  }

  // ---------- history & progress ----------
  function listWorkouts({ limit = 20, before } = {}) {
    const days = new Map();
    for (const s of sets) {
      if (before && s.workout_date >= before) continue;
      const d = days.get(s.workout_date) || { date: s.workout_date, sets: 0, ex: new Set(), volume: 0, cats: new Set() };
      d.sets++;
      d.volume += s.weight * (s.reps || 0);
      d.ex.add(s.exercise_id);
      const e = exercises.find((x) => x.id === s.exercise_id);
      if (e) d.cats.add(e.category);
      days.set(s.workout_date, d);
    }
    return [...days.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, limit)
      .map((d) => ({ date: d.date, sets: d.sets, exercises: d.ex.size, volume: d.volume, categories: [...d.cats] }));
  }

  // One row per (exercise, day): best set of that session + session totals.
  function progressSessions() {
    const groups = new Map();
    for (const s of sets) {
      const k = `${s.exercise_id}|${s.workout_date}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
    const rows = [];
    for (const g of groups.values()) {
      const e = exercises.find((x) => x.id === g[0].exercise_id);
      if (!e) continue;
      const best = g.reduce(betterFor(e));
      rows.push({
        id: e.id, name: e.name, category: e.category, type: e.type, date: g[0].workout_date, sets: g.length,
        best_weight: best.weight, best_reps: best.reps, best_duration: best.duration,
        top_weight: Math.max(...g.map((s) => s.weight)),
        max_reps: Math.max(...g.map((s) => s.reps || 0)),
        max_duration: Math.max(...g.map((s) => s.duration || 0)),
      });
    }
    return rows.sort((a, b) => a.id - b.id || (a.date < b.date ? -1 : 1));
  }

  // ---------- body: weight & circumferences ----------
  function checkBodyWeight(w) {
    if (w === "" || w == null) return null;
    const n = Number(w);
    if (!Number.isFinite(n) || n < 20 || n > 400) fail("Body weight must be between 20 and 400 kg");
    return Math.round(n * 100) / 100;
  }
  function checkCm(key, v) {
    const n = Number(v);
    const label = BODY_SITES.find((s) => s.key === key)?.label || key;
    if (!Number.isFinite(n) || n < 5 || n > 300) fail(`${label} must be between 5 and 300 cm`);
    return Math.round(n * 10) / 10;
  }
  function cleanBody({ date, weight, measurements = {} }) {
    const m = {};
    for (const [k, v] of Object.entries(measurements || {})) {
      if (!SITE_KEYS.has(k) || v === "" || v == null) continue;
      m[k] = checkCm(k, v);
    }
    return { date: checkDate(date), weight: checkBodyWeight(weight), measurements: m };
  }

  const listBody = () => [...body].sort((a, b) => (a.date < b.date ? -1 : 1));
  const getBody = (date) => body.find((b) => b.date === date) || null;

  // Replace the entry for that date. Saving an empty entry deletes it.
  async function saveBody(entry) {
    const e = { ...cleanBody(entry), updated_at: new Date().toISOString() };
    if (e.weight == null && !Object.keys(e.measurements).length) return deleteBody(e.date);
    await tx(["body"], (t) => t.objectStore("body").put(e));
    body = body.filter((b) => b.date !== e.date).concat(e);
    return e;
  }

  async function deleteBody(date) {
    await tx(["body"], (t) => t.objectStore("body").delete(date));
    body = body.filter((b) => b.date !== date);
  }

  // ---------- export / import ----------
  // Self-describing JSON: readable by a person, an AI agent, or this app's Import.
  function exportJSON() {
    const exName = new Map(exercises.map((e) => [e.id, e]));
    const rows = [...sets].sort((a, b) => (a.workout_date < b.workout_date ? -1 : a.workout_date > b.workout_date ? 1 : 0)
      || a.exercise_id - b.exercise_id || a.set_number - b.set_number);
    return {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exported_at: new Date().toISOString(),
      description: "Workout and body log from the Gym Log app. " +
        "`sets`: one entry per performed set. type is 'reps' (weight × repetitions) or 'time' (a hold such as a plank). " +
        "weight_kg is the load in kilograms (0 = bodyweight only; for timed holds it is added weight). " +
        "reps is set for 'reps' exercises, duration_sec for 'time' exercises; the other is null. " +
        "date is the local calendar day of the workout. " +
        "`body`: one entry per day with body weight in kg and circumference measurements in cm (site keys are described in body_sites). " +
        "Missing values were not measured that day.",
      categories: CATEGORIES,
      exercises: exercises.map((e) => ({ name: e.name, category: e.category, type: e.type })),
      sets: rows.map((s) => {
        const e = exName.get(s.exercise_id);
        return {
          date: s.workout_date,
          exercise: e?.name ?? "?",
          category: e?.category ?? "",
          type: e?.type ?? "reps",
          set: s.set_number,
          weight_kg: s.weight,
          reps: s.reps ?? null,
          duration_sec: s.duration ?? null,
        };
      }),
      body_sites: BODY_SITES,
      body: listBody().map((b) => ({ date: b.date, weight_kg: b.weight, measurements_cm: b.measurements })),
    };
  }

  const csvCell = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

  function exportCSV() {
    const lines = ["date,category,exercise,type,set,weight_kg,reps,duration_sec"];
    for (const s of exportJSON().sets) {
      lines.push([s.date, s.category, s.exercise, s.type, s.set, s.weight_kg, s.reps, s.duration_sec].map(csvCell).join(","));
    }
    return lines.join("\n") + "\n";
  }

  function exportBodyCSV() {
    const lines = [["date", "weight_kg", ...BODY_SITES.map((s) => `${s.key}_cm`)].join(",")];
    for (const b of listBody()) {
      lines.push([b.date, b.weight, ...BODY_SITES.map((s) => b.measurements[s.key])].map(csvCell).join(","));
    }
    return lines.join("\n") + "\n";
  }

  // Replace all data with an exported JSON backup. Validates fully before touching anything.
  // Accepts v1 exports (before timed exercises/body) and v2.
  async function importJSON(data) {
    if (!data || data.format !== EXPORT_FORMAT || !Array.isArray(data.sets) || !Array.isArray(data.exercises)) {
      fail("That file isn't a Gym Log JSON export");
    }
    const v1 = (data.version || 1) < 2;
    const exs = [];
    const seen = new Map();
    const addEx = (name, category, type) => {
      const n = checkName(name);
      const key = n.toLowerCase();
      if (!seen.has(key)) {
        const t = type === "time" || type === "reps" ? type : (v1 && n === "Plank" ? "time" : "reps");
        const ex = { name: n, category: CATEGORIES.includes(category) ? category : CATEGORIES[0], type: t, created_at: new Date().toISOString() };
        seen.set(key, ex);
        exs.push(ex);
      }
      return seen.get(key);
    };
    data.exercises.forEach((e) => addEx(e.name, e.category, e.type));
    const rows = data.sets.map((s, i) => {
      try {
        const ex = addEx(s.exercise, s.category, s.type);
        const vals = cleanSet(ex, { weight: s.weight_kg, reps: s.reps, duration: s.duration_sec ?? (v1 ? s.reps : undefined) });
        return { ex, workout_date: checkDate(s.date), set_number: Number(s.set) || 1, ...vals };
      } catch (e) { fail(`Set ${i + 1}: ${e.message}`); }
    });
    const replaceBody = Array.isArray(data.body);
    const bodyRows = replaceBody ? data.body.map((b, i) => {
      try {
        return { ...cleanBody({ date: b.date, weight: b.weight_kg, measurements: b.measurements_cm }), updated_at: new Date().toISOString() };
      } catch (e) { fail(`Body entry ${i + 1}: ${e.message}`); }
    }) : null;

    const stores = replaceBody ? ["exercises", "sets", "body"] : ["exercises", "sets"];
    await tx(stores, (t) => {
      const es = t.objectStore("exercises"), ss = t.objectStore("sets");
      es.clear();
      ss.clear();
      exs.forEach((e) => addTo(es, e));
      // Exercise ids arrive in each add's success callback. Requests in a transaction
      // complete in order, so once this count() succeeds every exercise has its id.
      es.count().onsuccess = () => rows.forEach((r) => {
        const { ex, ...rest } = r;
        r.row = addTo(ss, { exercise_id: ex.id, ...rest, created_at: new Date().toISOString() });
      });
      if (replaceBody) {
        const bs = t.objectStore("body");
        bs.clear();
        bodyRows.forEach((b) => bs.put(b));
      }
    });
    exercises = exs;
    sets = rows.map((r) => r.row);
    if (replaceBody) body = bodyRows;
    return { exercises: exs.length, sets: sets.length, body: body.length };
  }

  return {
    init, listExercises, createExercise, deleteExercise, lastSession,
    listSets, addSets, updateSet, deleteSet, listWorkouts, progressSessions,
    listBody, getBody, saveBody, deleteBody,
    exportJSON, exportCSV, exportBodyCSV, importJSON,
    categories: CATEGORIES, bodySites: BODY_SITES,
  };
})();
