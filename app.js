"use strict";

// ---- Config ----
// Cloudflare Worker that proxies to USDA FoodData Central. It holds the
// USDA API key as an encrypted secret, so the key is never in this code.
// Source: proxy/worker.js
const FOOD_API = "https://calorie-api.jyybg668mz.workers.dev/";

// ---- State ----
let currentDate = startOfToday();

// ---- DOM ----
const totalKcalEl = document.getElementById("totalKcal");
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
    searchResults.innerHTML = "";
    searchStatus.textContent = "Type at least 2 characters.";
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
  searchResults.innerHTML = "";
  searchStatus.textContent = "Type at least 2 characters.";
  setTimeout(() => searchInput.focus(), 50);
}
function closeSearch() {
  searchOverlay.classList.add("hidden");
}

// ---- Food search (via Worker proxy to USDA FoodData Central) ----
async function runSearch(query) {
  const url = FOOD_API + "?query=" + encodeURIComponent(query);

  try {
    const res = await fetch(url);
    if (res.status === 403) {
      searchStatus.textContent = "Search is temporarily unavailable. Try again later.";
      searchResults.innerHTML = "";
      return;
    }
    if (res.status === 429) {
      searchStatus.textContent = "Hit the hourly search limit. Try again in a bit.";
      searchResults.innerHTML = "";
      return;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const items = (data.foods || [])
      .map(parseFood)
      .filter((p) => p && p.kcal100 != null && p.name);

    if (items.length === 0) {
      searchStatus.textContent = "No results with calorie data. Try another term.";
      searchResults.innerHTML = "";
      return;
    }
    searchStatus.textContent = "";
    renderResults(items);
  } catch (e) {
    searchStatus.textContent = "Couldn't reach the food database. Check your connection.";
    searchResults.innerHTML = "";
  }
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

function renderResults(items) {
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

    card.querySelector(".confirm-add").addEventListener("click", (ev) => {
      ev.stopPropagation();
      const grams = Math.max(1, Math.round(parseFloat(amountInput.value) || 0));
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
