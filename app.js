"use strict";

// ---- Config ----
// Cloudflare Worker that proxies to USDA FoodData Central. It holds the
// USDA API key as an encrypted secret, so the key is never in this code.
// Source: proxy/worker.js
const FOOD_API = "https://calorie-api.jyybg668mz.workers.dev/";

// Daily calorie goal. 2,000 kcal is the USDA/FDA reference intake for an
// average adult (the basis for nutrition-label % Daily Values). Change
// this to personalize the ring.
const CALORIE_GOAL = 2000;

// ---- State ----
let currentDate = startOfToday();

// ---- DOM ----
const totalKcalEl = document.getElementById("totalKcal");
const totalGoalEl = document.getElementById("totalGoal");
const ringProgressEl = document.getElementById("ringProgress");
const dateLabelEl = document.getElementById("dateLabel");
const entryListEl = document.getElementById("entryList");
const searchOverlay = document.getElementById("searchOverlay");
const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");
const searchStatus = document.getElementById("searchStatus");

document.getElementById("addBtn").addEventListener("click", openSearch);
document.getElementById("closeSearch").addEventListener("click", closeSearch);
document.getElementById("prevDay").addEventListener("click", () => changeDay(-1));
document.getElementById("nextDay").addEventListener("click", () => changeDay(1));

let searchTimer = null;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) {
    showRecents();
    return;
  }
  searchStatus.textContent = "Searching…";
  searchTimer = setTimeout(() => runSearch(q), 350);
});

// ---- Date helpers ----
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function dateKey(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
function changeDay(delta) {
  currentDate = new Date(currentDate.getTime());
  currentDate.setDate(currentDate.getDate() + delta);
  render();
}

// ---- Storage ----
function loadEntries(d) {
  try {
    const raw = localStorage.getItem("cc:" + dateKey(d));
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}
function saveEntries(d, entries) {
  localStorage.setItem("cc:" + dateKey(d), JSON.stringify(entries));
}
function addEntry(entry) {
  const entries = loadEntries(currentDate);
  entries.push(entry);
  saveEntries(currentDate, entries);
  render();
}
function deleteEntry(id) {
  const entries = loadEntries(currentDate).filter((e) => e.id !== id);
  saveEntries(currentDate, entries);
  render();
}

// ---- Recent / favorite foods ----
// Most days you eat the same things, so we remember every food you add and
// offer it for one-tap re-adding — no search needed. Stored as a single
// list under "cc:foods"; favorites are pinned to the top and never aged out.
const RECENTS_KEY = "cc:foods";
const RECENTS_MAX = 30; // non-favorites kept, most-recent first

function loadFoods() {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY)) || [];
  } catch (e) {
    return [];
  }
}
function saveFoods(foods) {
  localStorage.setItem(RECENTS_KEY, JSON.stringify(foods));
}
function foodKey(item) {
  return [
    (item.name || "").toLowerCase().trim(),
    (item.brand || "").toLowerCase().trim(),
    Math.round(item.kcal100 || 0),
  ].join("|");
}
function recordFood(item) {
  if (item.kcal100 == null) return;
  const foods = loadFoods();
  const key = foodKey(item);
  let f = foods.find((x) => x.key === key);
  if (f) {
    f.count = (f.count || 1) + 1;
    f.lastUsed = Date.now();
  } else {
    foods.push({
      key,
      name: item.name,
      brand: item.brand || "",
      kcal100: item.kcal100,
      count: 1,
      lastUsed: Date.now(),
      fav: false,
    });
  }
  pruneFoods(foods);
  saveFoods(foods);
}
function pruneFoods(foods) {
  const overflow = foods
    .filter((f) => !f.fav)
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .slice(RECENTS_MAX);
  const drop = new Set(overflow.map((f) => f.key));
  for (let i = foods.length - 1; i >= 0; i--) {
    if (drop.has(foods[i].key)) foods.splice(i, 1);
  }
}
function toggleFav(key) {
  const foods = loadFoods();
  const f = foods.find((x) => x.key === key);
  if (!f) return;
  f.fav = !f.fav;
  saveFoods(foods);
  showRecents();
}
function sortedFoods() {
  return loadFoods().sort((a, b) => {
    if (!!b.fav !== !!a.fav) return (b.fav ? 1 : 0) - (a.fav ? 1 : 0);
    return b.lastUsed - a.lastUsed;
  });
}
// Shown in the search overlay when nothing has been typed yet.
function showRecents() {
  const foods = sortedFoods();
  if (foods.length === 0) {
    searchResults.innerHTML = "";
    searchStatus.textContent = "Type at least 2 characters to search.";
    return;
  }
  searchStatus.textContent = "Recent foods";
  renderResults(foods, { recents: true });
}

// ---- Progress ring ----
const RING_CIRCUMFERENCE = 2 * Math.PI * 54; // r=54 in the SVG
ringProgressEl.style.strokeDasharray = RING_CIRCUMFERENCE;

function updateRing(total) {
  const pct = Math.min(total / CALORIE_GOAL, 1);
  ringProgressEl.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - pct);
  const over = total > CALORIE_GOAL;
  ringProgressEl.classList.toggle("over", over);
  totalKcalEl.parentElement.classList.toggle("over", over);
}

// ---- Render ----
function render() {
  const today = startOfToday();
  const diffDays = Math.round((currentDate - today) / 86400000);
  if (diffDays === 0) dateLabelEl.textContent = "Today";
  else if (diffDays === -1) dateLabelEl.textContent = "Yesterday";
  else if (diffDays === 1) dateLabelEl.textContent = "Tomorrow";
  else {
    dateLabelEl.textContent = currentDate.toLocaleDateString(undefined, {
      weekday: "short", month: "short", day: "numeric",
    });
  }

  const entries = loadEntries(currentDate);
  const total = entries.reduce((s, e) => s + e.kcal, 0);
  totalKcalEl.textContent = Math.round(total);
  totalGoalEl.textContent = "of " + CALORIE_GOAL.toLocaleString() + " kcal";
  updateRing(total);

  entryListEl.innerHTML = "";
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No food logged yet. Tap + to add something you ate.";
    entryListEl.appendChild(empty);
    return;
  }

  for (const e of entries) {
    const row = document.createElement("div");
    row.className = "entry";
    row.innerHTML = `
      <div class="entry-info">
        <div class="entry-name"></div>
        <div class="entry-sub"></div>
      </div>
      <div class="entry-kcal">${Math.round(e.kcal)}</div>
      <button class="entry-del" aria-label="Remove">✕</button>
    `;
    row.querySelector(".entry-name").textContent = e.name;
    row.querySelector(".entry-sub").textContent =
      `${e.grams} g${e.brand ? " · " + e.brand : ""}`;
    row.querySelector(".entry-del").addEventListener("click", () => deleteEntry(e.id));
    entryListEl.appendChild(row);
  }
}

// ---- Search overlay ----
function openSearch() {
  searchOverlay.classList.remove("hidden");
  searchInput.value = "";
  showRecents();
  setTimeout(() => searchInput.focus(), 50);
}
function closeSearch() {
  searchOverlay.classList.add("hidden");
}

// ---- Food search (via Worker proxy to USDA FoodData Central) ----
//
// USDA does whole-word matching, so "ban" finds nothing while "banana"
// works. To get typeahead, we turn the word being typed into a prefix
// search ("ban" -> "ban*"). USDA's wildcard search is flaky (it randomly
// returns HTTP 400 on the exact same query), so we retry a couple times,
// then fall back to a plain whole-word search if the wildcard won't take.
async function runSearch(query) {
  const q = query.trim();
  const tokens = q.split(/\s+/);
  const wildcard = tokens
    .map((t, i) => (i === tokens.length - 1 ? t + "*" : t))
    .join(" ");

  try {
    let result = await searchOnce(wildcard);
    let tries = 0;
    while (result === "retry" && tries < 2) {
      result = await searchOnce(wildcard);
      tries++;
    }
    if (result === "retry") result = await searchOnce(q); // fall back to plain
    if (result === "retry") result = []; // even plain misbehaved: treat as empty

    if (result === "limit") {
      setStatus("Hit the hourly search limit. Try again in a bit.");
      return;
    }
    if (result === "unavailable") {
      setStatus("Search is temporarily unavailable. Try again later.");
      return;
    }
    if (!Array.isArray(result)) throw new Error("search failed");

    if (result.length === 0) {
      setStatus("No results with calorie data. Try another term.");
      return;
    }
    searchStatus.textContent = "";

    // USDA returns everything containing the word in no useful order, so a
    // plain "coffee" can land far below "coffee cake" etc. Re-rank so the
    // most generic, closest match floats to the top.
    const lastToken = tokens[tokens.length - 1].toLowerCase();
    result.sort((a, b) =>
      scoreResult(b, q.toLowerCase(), lastToken) -
      scoreResult(a, q.toLowerCase(), lastToken));

    renderResults(result);
  } catch (e) {
    setStatus("Couldn't reach the food database. Check your connection.");
  }
}

// One request to the proxy. Returns an array of foods on success, or a
// string code: "retry" (flaky 400), "limit" (rate limited), "unavailable"
// (proxy/key problem). Throws on network failure.
async function searchOnce(query) {
  const res = await fetch(FOOD_API + "?query=" + encodeURIComponent(query));
  if (res.status === 400) return "retry";
  if (res.status === 429) return "limit";
  if (res.status === 403) return "unavailable";
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  return (data.foods || [])
    .map(parseFood)
    .filter((p) => p && p.kcal100 != null && p.name);
}

function setStatus(msg) {
  searchStatus.textContent = msg;
  searchResults.innerHTML = "";
}

// Relevance score for a search result (higher = shown first). Favors names
// that begin with what was typed, an exact whole-word hit, the matched word
// appearing early, and shorter (more generic) names — so plain "Coffee"
// outranks "Cake, coffee" or "Ice cream, coffee".
function scoreResult(item, query, lastToken) {
  const name = (item.name || "").toLowerCase();
  const words = name.split(/[\s,]+/).filter(Boolean);
  let score = 0;
  if (name.startsWith(query)) score += 1000;
  if (words.includes(lastToken)) score += 200;
  let wi = words.findIndex((w) => w.startsWith(lastToken));
  if (wi === -1) wi = words.length;
  score += Math.max(0, 100 - wi * 20); // earlier match = better
  score -= name.length;                // shorter = more generic
  return score;
}

function parseFood(f) {
  if (!f) return null;
  const nutrients = f.foodNutrients || [];
  let kcal100 = null;
  for (const n of nutrients) {
    if ((n.nutrientName || "").toLowerCase() === "energy" &&
        (n.unitName || "").toUpperCase() === "KCAL") {
      kcal100 = numOrNull(n.value);
      break;
    }
  }
  if (kcal100 == null) {
    for (const n of nutrients) {
      if ((n.nutrientName || "").toLowerCase() === "energy" &&
          (n.unitName || "").toUpperCase() === "KJ") {
        const v = numOrNull(n.value);
        if (v != null) kcal100 = v / 4.184;
        break;
      }
    }
  }
  return {
    name: (f.description || "").trim(),
    brand: (f.brandName || f.brandOwner || "").trim(),
    kcal100,
    serving: "",
  };
}

function numOrNull(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
}

function renderResults(items, opts) {
  opts = opts || {};
  searchResults.innerHTML = "";
  for (const item of items) {
    const card = document.createElement("div");
    card.className = "result";
    card.innerHTML = `
      <div class="result-top">
        <div class="result-info">
          <div class="result-name"></div>
          <div class="result-sub"></div>
        </div>
        <div class="result-per">${Math.round(item.kcal100)} kcal/100g</div>
        ${opts.recents ? '<button class="fav-btn" aria-label="Favorite">' + (item.fav ? "★" : "☆") + "</button>" : ""}
      </div>
      <div class="result-add">
        <div class="amount-field">
          <input type="number" inputmode="numeric" value="100" min="1" />
          <span>g</span>
        </div>
        <div class="computed"></div>
        <button class="confirm-add">Add</button>
      </div>
    `;
    card.querySelector(".result-name").textContent = item.name;
    card.querySelector(".result-sub").textContent =
      item.brand || item.serving || "Generic";

    const amountInput = card.querySelector(".amount-field input");
    const computedEl = card.querySelector(".computed");
    const updateComputed = () => {
      const grams = Math.max(0, parseFloat(amountInput.value) || 0);
      computedEl.textContent = Math.round((item.kcal100 * grams) / 100) + " kcal";
    };
    updateComputed();
    amountInput.addEventListener("input", updateComputed);

    card.querySelector(".result-top").addEventListener("click", () => {
      card.classList.toggle("open");
    });

    if (opts.recents) {
      const favBtn = card.querySelector(".fav-btn");
      if (item.fav) favBtn.classList.add("on");
      favBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        toggleFav(item.key);
      });
    }

    card.querySelector(".confirm-add").addEventListener("click", (ev) => {
      ev.stopPropagation();
      const grams = Math.max(1, Math.round(parseFloat(amountInput.value) || 0));
      recordFood(item); // remember it for next time (and bump recency)
      addEntry({
        id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
        name: item.name,
        brand: item.brand,
        grams,
        kcal: (item.kcal100 * grams) / 100,
      });
      closeSearch();
    });

    searchResults.appendChild(card);
  }
}

// ---- Service worker ----
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

// ---- Init ----
render();
