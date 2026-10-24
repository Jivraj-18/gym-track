"use strict";
// On-device storage for Gym Log. Everything lives in IndexedDB inside the app's
// private storage; nothing leaves the phone unless you export it.
// Data is small (a few thousand sets a year), so it's loaded into memory on start
// and every change is written through to IndexedDB.

const CATEGORIES = ["Legs", "Arms & Shoulders", "Pull", "Push", "Abs"];

const DEFAULT_EXERCISES = {
  "Legs": ["Squat", "Leg Press", "Romanian Deadlift", "Leg Curl", "Leg Extension", "Calf Raise"],
  "Arms & Shoulders": ["Overhead Press", "Lateral Raise", "Bicep Curl", "Hammer Curl", "Tricep Pushdown"],
  "Pull": ["Deadlift", "Pull-up", "Lat Pulldown", "Barbell Row", "Seated Cable Row", "Face Pull"],
  "Push": ["Bench Press", "Incline Dumbbell Press", "Dips", "Push-up", "Chest Fly"],
  "Abs": ["Plank", "Hanging Leg Raise", "Cable Crunch", "Russian Twist"],
};

const EXPORT_FORMAT = "gym-log-export";
const EXPORT_VERSION = 1;

const e1rm = (weight, reps) => weight * (1 + reps / 30); // Epley estimate

const DB = (() => {
  let idb;
  let exercises = []; // {id, name, category, created_at}
  let sets = [];      // {id, exercise_id, workout_date, set_number, weight, reps, created_at}

  // ---------- IndexedDB plumbing ----------
  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("gymlog", 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore("exercises", { keyPath: "id", autoIncrement: true });
        d.createObjectStore("sets", { keyPath: "id", autoIncrement: true });
        d.createObjectStore("meta", { keyPath: "key" });
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

  function getAll(store) {
    return new Promise((resolve, reject) => {
      const req = idb.transaction(store).objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // add() and record the generated id on the object
  function addTo(store, obj) {
    const req = store.add(obj);
    req.onsuccess = () => { obj.id = req.result; };
    return obj;
  }

  async function init() {
    idb = await open();
    [exercises, sets] = await Promise.all([getAll("exercises"), getAll("sets")]);
    const meta = await new Promise((res) => {
      const r = idb.transaction("meta").objectStore("meta").get("seeded");
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    });
    if (!meta && exercises.length === 0) {
      await tx(["exercises", "meta"], (t) => {
        const st = t.objectStore("exercises");
        const now = new Date().toISOString();
        for (const [category, names] of Object.entries(DEFAULT_EXERCISES)) {
          for (const name of names) exercises.push(addTo(st, { name, category, created_at: now }));
        }
        t.objectStore("meta").put({ key: "seeded", value: true });
      });
    }
    // Ask the OS not to evict our storage (no-op where unsupported).
    try { await navigator.storage?.persist?.(); } catch {}
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
  const checkCategory = (c) => (CATEGORIES.includes(c) ? c : fail(`Category must be one of: ${CATEGORIES.join(", ")}`));
  function checkName(n) {
    const name = String(n ?? "").trim().replace(/\s+/g, " ");
    if (!name || name.length > 60) fail("Exercise name must be 1–60 characters");
    return name;
  }
  const exById = (id) => exercises.find((e) => e.id === id) || fail("Exercise not found");
  const sameName = (a, b) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

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

  async function createExercise({ name, category }) {
    name = checkName(name);
    category = checkCategory(category);
    if (exercises.some((e) => sameName(e.name, name))) fail(`You already have "${name}"`);
    const ex = { name, category, created_at: new Date().toISOString() };
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
  const better = (a, b) => (e1rm(b.weight, b.reps) > e1rm(a.weight, a.reps) ||
    (e1rm(b.weight, b.reps) === e1rm(a.weight, a.reps) && b.reps > a.reps) ? b : a);

  // Most recent session before `before` (any date if omitted) + all-time best set.
  function lastSession(id, before) {
    exById(id);
    const mine = sets.filter((s) => s.exercise_id === id);
    const best = mine.length ? mine.reduce(better) : null;
    const prior = before ? mine.filter((s) => s.workout_date < before) : mine;
    if (!prior.length) return { date: null, sets: [], best };
    const date = prior.reduce((m, s) => (s.workout_date > m ? s.workout_date : m), "");
    return {
      date,
      sets: prior.filter((s) => s.workout_date === date).sort(bySetOrder),
      best: best && { weight: best.weight, reps: best.reps, date: best.workout_date },
    };
  }

  // ---------- sets ----------
  function listSets(date) {
    checkDate(date);
    return sets.filter((s) => s.workout_date === date).sort((a, b) => a.id - b.id)
      .map((s) => {
        const e = exercises.find((x) => x.id === s.exercise_id);
        return { ...s, exercise: e?.name ?? "?", category: e?.category ?? "" };
      });
  }

  // Returns {added, pr} where pr is set when the best new set beats all earlier history.
  async function addSets({ exercise_id, date, sets: list }) {
    exById(exercise_id);
    checkDate(date);
    if (!Array.isArray(list) || list.length < 1 || list.length > 30) fail("Add between 1 and 30 sets at a time");
    const clean = list.map((s) => ({ weight: checkWeight(s.weight), reps: checkReps(s.reps) }));

    const history = sets.filter((s) => s.exercise_id === exercise_id);
    const start = history.filter((s) => s.workout_date === date).reduce((m, s) => Math.max(m, s.set_number), 0);
    const now = new Date().toISOString();
    const rows = clean.map((s, i) => ({ exercise_id, workout_date: date, set_number: start + i + 1, ...s, created_at: now }));
    await tx(["sets"], (t) => rows.forEach((r) => addTo(t.objectStore("sets"), r)));
    sets.push(...rows);

    let pr = null;
    if (history.length) {
      const prevBest = history.reduce(better);
      const newBest = clean.reduce(better);
      const bodyweight = history.every((s) => s.weight === 0) && newBest.weight === 0;
      const prevReps = Math.max(...history.map((s) => s.reps));
      if (bodyweight ? newBest.reps > prevReps : e1rm(newBest.weight, newBest.reps) > e1rm(prevBest.weight, prevBest.reps) + 1e-9) {
        pr = { ...newBest, bodyweight, e1rm: e1rm(newBest.weight, newBest.reps),
          previous_e1rm: e1rm(prevBest.weight, prevBest.reps), previous_reps: prevReps };
      }
    }
    return { added: rows.length, pr };
  }

  async function updateSet(id, { weight, reps }) {
    const s = sets.find((x) => x.id === id) || fail("Set not found");
    const next = { ...s, weight: checkWeight(weight), reps: checkReps(reps) };
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
      d.volume += s.weight * s.reps;
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
      const best = g.reduce(better);
      rows.push({
        id: e.id, name: e.name, category: e.category, date: g[0].workout_date, sets: g.length,
        best_weight: best.weight, best_reps: best.reps,
        top_weight: Math.max(...g.map((s) => s.weight)), max_reps: Math.max(...g.map((s) => s.reps)),
      });
    }
    return rows.sort((a, b) => a.id - b.id || (a.date < b.date ? -1 : 1));
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
      description: "Workout log from the Gym Log app. Each entry in `sets` is one performed set. " +
        "weight_kg is the load in kilograms (0 = bodyweight only); reps is repetitions " +
        "(for timed holds like Plank, reps are seconds). date is the local calendar day of the workout.",
      categories: CATEGORIES,
      exercises: exercises.map((e) => ({ name: e.name, category: e.category })),
      sets: rows.map((s) => ({
        date: s.workout_date,
        exercise: exName.get(s.exercise_id)?.name ?? "?",
        category: exName.get(s.exercise_id)?.category ?? "",
        set: s.set_number,
        weight_kg: s.weight,
        reps: s.reps,
      })),
    };
  }

  function exportCSV() {
    const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = ["date,category,exercise,set,weight_kg,reps"];
    for (const s of exportJSON().sets) lines.push([s.date, s.category, s.exercise, s.set, s.weight_kg, s.reps].map(q).join(","));
    return lines.join("\n") + "\n";
  }

  // Replace all data with an exported JSON backup. Validates fully before touching anything.
  async function importJSON(data) {
    if (!data || data.format !== EXPORT_FORMAT || !Array.isArray(data.sets) || !Array.isArray(data.exercises)) {
      fail("That file isn't a Gym Log JSON export");
    }
    const exs = [];
    const seen = new Map();
    const addEx = (name, category) => {
      const n = checkName(name);
      const key = n.toLowerCase();
      if (!seen.has(key)) {
        const ex = { name: n, category: CATEGORIES.includes(category) ? category : CATEGORIES[0], created_at: new Date().toISOString() };
        seen.set(key, ex);
        exs.push(ex);
      }
      return seen.get(key);
    };
    data.exercises.forEach((e) => addEx(e.name, e.category));
    const rows = data.sets.map((s, i) => {
      try {
        return { ex: addEx(s.exercise, s.category), workout_date: checkDate(s.date), set_number: Number(s.set) || 1,
          weight: checkWeight(s.weight_kg), reps: checkReps(s.reps) };
      } catch (e) { fail(`Row ${i + 1}: ${e.message}`); }
    });

    await tx(["exercises", "sets"], (t) => {
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
    });
    exercises = exs;
    sets = rows.map((r) => r.row);
    return { exercises: exs.length, sets: sets.length };
  }

  return {
    init, listExercises, createExercise, deleteExercise, lastSession,
    listSets, addSets, updateSet, deleteSet, listWorkouts, progressSessions,
    exportJSON, exportCSV, importJSON, categories: CATEGORIES,
  };
})();
