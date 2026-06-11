"use strict";

// ---- Config ----
// Cloudflare Worker that proxies to USDA FoodData Central. It holds the
// USDA API key as an encrypted secret, so the key is never in this code.
// Source: proxy/worker.js
const FOOD_API = "https://calorie-api.jyybg668mz.workers.dev/";

// Daily calorie goal. 2,000 kcal is the USDA/FDA reference intake for an
// average adult (the basis for nutrition-label % Daily Values) and the
// default. Each person can set their own (stored as cc:goal), and any
// exercise logged that day is added on top to grow that day's budget.
const DEFAULT_GOAL = 2000;

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

// ---- Daily goal & exercise ----
// The base daily goal is a single user setting (cc:goal); 2,000 is the
// default until they pick one. Exercise is logged per day (cc:ex:<date>) and
// its calories are added to that day's goal, so moving more earns headroom.
const GOAL_KEY = "cc:goal";

function getGoal() {
  const v = parseInt(localStorage.getItem(GOAL_KEY), 10);
  return isFinite(v) && v > 0 ? v : DEFAULT_GOAL;
}
function setGoal(n) {
  const v = Math.round(n);
  if (isFinite(v) && v > 0) localStorage.setItem(GOAL_KEY, String(v));
}
function hasGoalSet() {
  return localStorage.getItem(GOAL_KEY) != null;
}

function loadExercise(d) {
  try { return JSON.parse(localStorage.getItem("cc:ex:" + dateKey(d))) || []; }
  catch (e) { return []; }
}
function saveExercise(d, arr) {
  localStorage.setItem("cc:ex:" + dateKey(d), JSON.stringify(arr));
}
function addExerciseEntry(ex) {
  const arr = loadExercise(currentDate);
  arr.push(ex);
  saveExercise(currentDate, arr);
  render();
}
function deleteExercise(id) {
  saveExercise(currentDate, loadExercise(currentDate).filter((e) => e.id !== id));
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
function updateRing(total, goal) {
  const pct = Math.min(total / goal, 1);
  ringProgressEl.style.setProperty("--p", pct);
  totalKcalEl.parentElement.classList.toggle("over", total > goal);
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
  const exercises = loadExercise(currentDate);
  const foodTotal = entries.reduce((s, e) => s + e.kcal, 0);
  const exTotal = exercises.reduce((s, e) => s + e.kcal, 0);
  const goal = getGoal() + exTotal; // exercise grows the day's budget
  totalKcalEl.textContent = Math.round(foodTotal);
  totalGoalEl.textContent = "of " + Math.round(goal).toLocaleString() + " kcal";
  updateRing(foodTotal, goal);
  scheduleSync(); // keep shared total fresh (no-op unless sharing is on)

  const hasAny = entries.length > 0 || exercises.length > 0;
  feedbackBar.classList.toggle("hidden", !hasAny);

  entryListEl.innerHTML = "";

  // Add-food card always sits at the top of the day — the intuitive place to
  // log something you ate.
  const addCard = document.createElement("button");
  addCard.className = "add-card";
  addCard.innerHTML = `
    <span class="add-card-icon">+</span>
    <span class="add-card-text">Add food</span>
  `;
  addCard.addEventListener("click", openSearch);
  entryListEl.appendChild(addCard);

  if (!hasAny) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Nothing logged yet — tap “Add food” to start.";
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

  // Exercise rows: earned calories, shown in green with a +.
  for (const ex of exercises) {
    const row = document.createElement("div");
    row.className = "entry exercise";
    row.innerHTML = `
      <div class="entry-info">
        <div class="entry-name"></div>
        <div class="entry-sub"></div>
      </div>
      <div class="entry-kcal earned">+${Math.round(ex.kcal)}</div>
      <button class="entry-del" aria-label="Remove">✕</button>
    `;
    row.querySelector(".entry-name").textContent = ex.name || "Exercise";
    row.querySelector(".entry-sub").textContent =
      (ex.minutes ? ex.minutes + " min · " : "") + "earned back";
    row.querySelector(".entry-del").addEventListener("click", () => deleteExercise(ex.id));
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

// ---- Accountability (share codes) ----
//
// Opt-in only: nothing leaves the device until you enable sharing. Your
// secret account id (the write key) stays on your phone; friends only ever
// get a short share code that lets them READ your daily total + streak.
const SYNC_API = FOOD_API + "share/"; // .../share/sync , .../share/peek
const ACCOUNT_KEY = "cc:account";     // { userId, code, name }
const FRIENDS_KEY = "cc:friends";     // [ "CODE1", "CODE2", ... ]
const APP_URL = "https://jyybg668mz.github.io/calorie-counter/";

// The message sent when inviting a friend: the app link so they can install
// it, plus your code so they can follow you once they enable sharing.
function inviteMessage(code) {
  return code
    ? "Let's keep each other accountable on calories. Install the app, turn on " +
      "sharing, and add my code " + code + " to follow my daily total:"
    : "Let's keep each other accountable on calories. Install the app:";
}

const friendsOverlay = document.getElementById("friendsOverlay");
const friendsBody = document.getElementById("friendsBody");
document.getElementById("friendsBtn").addEventListener("click", openFriends);
document.getElementById("closeFriends")
  .addEventListener("click", () => friendsOverlay.classList.add("hidden"));

function getAccount() {
  try { return JSON.parse(localStorage.getItem(ACCOUNT_KEY)); }
  catch (e) { return null; }
}
function setAccount(a) { localStorage.setItem(ACCOUNT_KEY, JSON.stringify(a)); }
function getFriends() {
  try { return JSON.parse(localStorage.getItem(FRIENDS_KEY)) || []; }
  catch (e) { return []; }
}
function setFriends(f) { localStorage.setItem(FRIENDS_KEY, JSON.stringify(f)); }

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function todayTotal() {
  const entries = loadEntries(startOfToday());
  return Math.round(entries.reduce((s, e) => s + e.kcal, 0));
}

// Push today's total to the server. Debounced; safe to call on every change.
let syncTimer = null;
function scheduleSync() {
  if (!getAccount()) return; // not opted in
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 800);
}
async function syncNow() {
  const acct = getAccount();
  if (!acct) return;
  try {
    const res = await fetch(SYNC_API + "sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: acct.userId,
        name: acct.name || "",
        goal: getGoal(),
        date: dateKey(startOfToday()),
        total: todayTotal(),
      }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.code && data.code !== acct.code) {
      acct.code = data.code;
      setAccount(acct);
      if (!friendsOverlay.classList.contains("hidden")) renderFriends();
    }
  } catch (e) { /* offline — will retry on the next change */ }
}

async function peek(code) {
  const res = await fetch(
    SYNC_API + "peek?code=" + encodeURIComponent(code) +
    "&date=" + dateKey(startOfToday())
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

function openFriends() {
  friendsOverlay.classList.remove("hidden");
  renderFriends();
}

async function enableSharing(name, btn) {
  let acct = getAccount();
  if (!acct) acct = { userId: randomId(), code: "", name: name || "" };
  else acct.name = name || acct.name;
  setAccount(acct);
  if (btn) { btn.disabled = true; btn.textContent = "Enabling…"; }
  await syncNow();         // creates the server record and returns a code
  renderFriends();
}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function renderFriends() {
  const acct = getAccount();
  friendsBody.innerHTML = "";

  // Not opted in yet: intro + enable.
  if (!acct) {
    const intro = document.createElement("div");
    intro.className = "friends-intro";
    intro.innerHTML = `
      <p>Keep each other accountable. Turn on sharing to get a short code you
      can send to a friend — they'll see your daily calorie total and streak,
      and you can cheer each other on.</p>
      <p class="muted-note">Only your name, daily total, goal, and streak are
      shared. Your food list stays private on your phone.</p>
      <label class="field-label">Your name</label>
      <input id="nameInput" class="text-input" type="text" maxlength="40" placeholder="e.g. Erik" />
      <button id="enableBtn" class="primary-btn">Enable sharing</button>
    `;
    friendsBody.appendChild(intro);
    intro.querySelector("#enableBtn").addEventListener("click", () => {
      enableSharing(intro.querySelector("#nameInput").value.trim(),
        intro.querySelector("#enableBtn"));
    });
    return;
  }

  const hasFriends = getFriends().length > 0;

  // 1) Friends list — the main thing, prominent at the top once you have any.
  if (hasFriends) {
    const heading = document.createElement("div");
    heading.className = "section-title";
    heading.textContent = "Your friends";
    friendsBody.appendChild(heading);

    const list = document.createElement("div");
    list.className = "friend-list";
    list.id = "friendList";
    friendsBody.appendChild(list);
    refreshFriendStats();
  }

  // 2) Invite / add controls — full size when you have no friends yet (so you
  //    know how to start), compact footer once friends are listed above. Your
  //    own code + name live in a collapsible disclosure to keep it tidy.
  const share = document.createElement("div");
  share.className = "share-section" + (hasFriends ? " compact" : "");
  share.innerHTML = `
    <div class="section-title">${hasFriends ? "Add or invite friends" : "Connect with a friend"}</div>
    <div class="add-friend">
      <div class="field-label">Add a friend's code</div>
      <div class="code-row">
        <input id="friendCode" class="text-input" type="text" maxlength="10"
          placeholder="e.g. K7QF2M" autocapitalize="characters" autocomplete="off" />
        <button id="addFriend" class="small-btn">Add</button>
      </div>
      <div id="addStatus" class="add-status"></div>
    </div>
    <button id="inviteBtn" class="${hasFriends ? "small-btn" : "primary-btn"}">Share app link &amp; code</button>
    <div id="inviteStatus" class="add-status"></div>
    <details class="my-code"${hasFriends ? "" : " open"}>
      <summary>Your share code &amp; name</summary>
      <div class="field-label">Your share code</div>
      <div class="code-row">
        <span class="code" id="myCode">${acct.code || "…"}</span>
        <button id="copyCode" class="small-btn">Copy</button>
      </div>
      <div class="field-label">Your name</div>
      <div class="code-row">
        <input id="nameInput" class="text-input" type="text" maxlength="40"
          value="${escapeAttr(acct.name || "")}" placeholder="Your name" />
        <button id="saveName" class="small-btn">Save</button>
      </div>
    </details>
  `;
  friendsBody.appendChild(share);

  // Add a friend's code.
  share.querySelector("#addFriend").addEventListener("click", () =>
    addFriend(share.querySelector("#friendCode").value, share.querySelector("#addStatus")));

  // Share the app link + your code in one tap.
  share.querySelector("#inviteBtn").addEventListener("click", async () => {
    const status = share.querySelector("#inviteStatus");
    const text = inviteMessage(acct.code);
    if (navigator.share) {
      try {
        await navigator.share({ title: "Calorie Counter", text, url: APP_URL });
      } catch (e) { /* user cancelled the share sheet */ }
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text + " " + APP_URL);
      status.textContent = "Invite copied — paste it into a message.";
      setTimeout(() => { status.textContent = ""; }, 2500);
    } else {
      status.textContent = APP_URL;
    }
  });

  // Your code + name.
  share.querySelector("#copyCode").addEventListener("click", () => {
    if (!acct.code) return;
    if (navigator.clipboard) navigator.clipboard.writeText(acct.code);
    const b = share.querySelector("#copyCode");
    b.textContent = "Copied";
    setTimeout(() => { b.textContent = "Copy"; }, 1500);
  });
  share.querySelector("#saveName").addEventListener("click", () => {
    acct.name = share.querySelector("#nameInput").value.trim();
    setAccount(acct);
    syncNow();
    const b = share.querySelector("#saveName");
    b.textContent = "Saved";
    setTimeout(() => { b.textContent = "Save"; }, 1500);
  });
}

async function addFriend(rawCode, statusEl) {
  const code = (rawCode || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length < 4) { statusEl.textContent = "Enter a valid code."; return; }
  const acct = getAccount();
  if (acct && acct.code === code) { statusEl.textContent = "That's your own code."; return; }
  const friends = getFriends();
  if (friends.includes(code)) { statusEl.textContent = "Already added."; return; }
  statusEl.textContent = "Checking…";
  try {
    const stat = await peek(code);
    if (!stat) { statusEl.textContent = "No one found with that code."; return; }
    friends.push(code);
    setFriends(friends);
    renderFriends();
  } catch (e) {
    statusEl.textContent = "Couldn't reach the server. Try again.";
  }
}

function removeFriend(code) {
  setFriends(getFriends().filter((c) => c !== code));
  renderFriends();
}

function refreshFriendStats() {
  const list = document.getElementById("friendList");
  if (!list) return;
  const friends = getFriends();
  if (friends.length === 0) {
    list.innerHTML = `<div class="friends-empty">No friends yet. Add a code above to start.</div>`;
    return;
  }
  list.innerHTML = "";
  for (const code of friends) {
    const row = document.createElement("div");
    row.className = "friend";
    let friendName = "Friend";
    row.innerHTML = `
      <div class="friend-info">
        <div class="friend-name">…</div>
        <div class="friend-sub">Loading…</div>
      </div>
      <div class="friend-streak"></div>
      <span class="friend-go" aria-hidden="true">›</span>
      <button class="friend-del" aria-label="Remove">&#10005;</button>
    `;
    row.querySelector(".friend-del").addEventListener("click", (ev) => {
      ev.stopPropagation();
      removeFriend(code);
    });
    // Tap the row to open a 1:1 encouragement chat with this friend.
    row.addEventListener("click", () => openChat(code, friendName));
    list.appendChild(row);

    peek(code).then((stat) => {
      const nameEl = row.querySelector(".friend-name");
      const subEl = row.querySelector(".friend-sub");
      if (!stat) {
        nameEl.textContent = code;
        subEl.textContent = "Not found";
        return;
      }
      friendName = stat.name || "Friend";
      nameEl.textContent = friendName;
      subEl.textContent =
        stat.total.toLocaleString() + " / " + stat.goal.toLocaleString() + " kcal";
      subEl.classList.toggle("over", stat.total > stat.goal);
      row.querySelector(".friend-streak").textContent =
        stat.streak > 0 ? "🔥 " + stat.streak : "";
    }).catch(() => {
      row.querySelector(".friend-sub").textContent = "Couldn't load";
    });
  }
}

// ---- 1:1 encouragement chat ----
//
// Tap a friend to open a private back-and-forth thread. Quick "nudge" buttons
// send one-tap encouragement; the text box is there when you want to say more.
// Threads live in the same Cloudflare KV as the share data (keyed by the two
// share codes) and are userId-authed, so only the two of you can read them.
const NUDGES = ["👏 Nice work!", "🔥 Keep it going!", "💪 You've got this!", "🎉 Proud of you!"];

const chatOverlay = document.getElementById("chatOverlay");
const chatMessages = document.getElementById("chatMessages");
const chatNudges = document.getElementById("chatNudges");
const chatInput = document.getElementById("chatInput");
const chatTitle = document.getElementById("chatTitle");

let chatCode = null;     // the friend's share code (the thread partner)
let chatName = "Friend";
let chatMyCode = null;   // my own share code, to tell my bubbles from theirs
let chatPoll = null;     // interval id for refreshing the thread

// iOS doesn't resize a fixed/standalone PWA when the on-screen keyboard opens,
// so the input row ends up hidden behind it. Follow visualViewport and shrink
// the chat overlay to the visible area so the text box stays above the keyboard.
function fitChatViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  chatOverlay.style.top = vv.offsetTop + "px";
  chatOverlay.style.height = vv.height + "px";
  chatOverlay.style.bottom = "auto";
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
function clearChatViewport() {
  chatOverlay.style.top = "";
  chatOverlay.style.height = "";
  chatOverlay.style.bottom = "";
}

function openChat(code, name) {
  const acct = getAccount();
  if (!acct || !acct.code) return; // need to be opted in to chat
  chatCode = code;
  chatName = name || "Friend";
  chatMyCode = acct.code;
  chatTitle.textContent = chatName;
  chatMessages.innerHTML = `<div class="chat-empty">Loading…</div>`;
  renderNudges();
  chatOverlay.classList.remove("hidden");
  loadThread(true);
  clearInterval(chatPoll);
  chatPoll = setInterval(() => loadThread(false), 4000);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", fitChatViewport);
    window.visualViewport.addEventListener("scroll", fitChatViewport);
  }
}

function closeChat() {
  clearInterval(chatPoll);
  chatPoll = null;
  chatCode = null;
  if (window.visualViewport) {
    window.visualViewport.removeEventListener("resize", fitChatViewport);
    window.visualViewport.removeEventListener("scroll", fitChatViewport);
  }
  clearChatViewport();
  chatInput.blur();
  chatOverlay.classList.add("hidden");
}

function renderNudges() {
  chatNudges.innerHTML = "";
  for (const text of NUDGES) {
    const b = document.createElement("button");
    b.className = "nudge";
    b.textContent = text;
    b.addEventListener("click", () => sendChat(text));
    chatNudges.appendChild(b);
  }
}

async function loadThread(scroll) {
  const acct = getAccount();
  if (!acct || !chatCode) return;
  try {
    const res = await fetch(SYNC_API + "thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: acct.userId, withCode: chatCode }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.code) chatMyCode = data.code;
    renderMessages(data.messages || [], scroll);
  } catch (e) { /* offline — the poll will try again */ }
}

function renderMessages(msgs, scroll) {
  if (!msgs.length) {
    chatMessages.innerHTML =
      `<div class="chat-empty">No messages yet. Send a little encouragement 👋</div>`;
    return;
  }
  chatMessages.innerHTML = "";
  for (const m of msgs) {
    const b = document.createElement("div");
    b.className = "bubble " + (m.from === chatMyCode ? "mine" : "theirs");
    b.textContent = m.text;
    chatMessages.appendChild(b);
  }
  if (scroll) chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function sendChat(text) {
  const acct = getAccount();
  text = (text || "").trim();
  if (!acct || !chatCode || !text) return;
  chatInput.value = "";
  try {
    const res = await fetch(SYNC_API + "msg", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: acct.userId, toCode: chatCode, text }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.code) chatMyCode = data.code;
    renderMessages(data.messages || [], true); // optimistic: server echoes the thread
  } catch (e) { /* offline */ }
}

document.getElementById("closeChat").addEventListener("click", closeChat);
document.getElementById("chatSend").addEventListener("click", () => sendChat(chatInput.value));
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); sendChat(chatInput.value); }
});
// When the field gains focus the keyboard is opening — snap the overlay to the
// visible area (visualViewport's own resize can lag a frame on iOS).
chatInput.addEventListener("focus", () => {
  fitChatViewport();
  setTimeout(fitChatViewport, 300); // again after the keyboard finishes animating
});

// ---- Nutrition feedback (hand the day off to an AI coach) ----
//
// Nada deliberately holds no nutrition knowledge of its own. Instead it writes
// the day's food into a ready-made question and either opens Claude with it
// pre-filled (claude.ai/new?q=...) or copies it so you can paste into any
// assistant. The framing asks for gentle, encouraging-coach feedback.
const feedbackBar = document.getElementById("feedbackBar");
const feedbackSheet = document.getElementById("feedbackSheet");

document.getElementById("feedbackBtn").addEventListener("click", openFeedback);
document.getElementById("feedbackBackdrop").addEventListener("click", closeFeedback);
document.getElementById("feedbackCancel").addEventListener("click", closeFeedback);
document.getElementById("askClaudeBtn").addEventListener("click", () => {
  const prompt = buildFeedbackPrompt(currentDate);
  window.open("https://claude.ai/new?q=" + encodeURIComponent(prompt), "_blank", "noopener");
  closeFeedback();
});
document.getElementById("copyDayBtn").addEventListener("click", () => {
  const status = document.getElementById("feedbackStatus");
  const prompt = buildFeedbackPrompt(currentDate);
  if (navigator.clipboard) {
    navigator.clipboard.writeText(prompt).then(
      () => { status.textContent = "Copied — paste it into any AI chat."; },
      () => { status.textContent = "Couldn't copy. Try again."; }
    );
  } else {
    status.textContent = "Clipboard isn't available on this device.";
  }
});

function dayPhrase(d) {
  const diff = Math.round((d - startOfToday()) / 86400000);
  if (diff === 0) return "today";
  if (diff === -1) return "yesterday";
  return "on " + d.toLocaleDateString(undefined,
    { weekday: "long", month: "long", day: "numeric" });
}

function buildFeedbackPrompt(d) {
  const entries = loadEntries(d);
  const exercises = loadExercise(d);
  const total = Math.round(entries.reduce((s, e) => s + e.kcal, 0));
  const exTotal = Math.round(exercises.reduce((s, e) => s + e.kcal, 0));
  const goal = getGoal() + exTotal;
  const lines = entries.map((e) =>
    "- " + e.name + (e.brand ? " (" + e.brand + ")" : "") +
    ", " + e.grams + " g, " + Math.round(e.kcal) + " kcal"
  ).join("\n");
  let exBlock = "";
  if (exercises.length) {
    exBlock = "\n\nExercise " + dayPhrase(d) + ":\n" + exercises.map((e) =>
      "- " + (e.name || "Exercise") + (e.minutes ? ", " + e.minutes + " min" : "") +
      ", ~" + Math.round(e.kcal) + " kcal burned"
    ).join("\n");
  }
  const budgetNote = exTotal > 0
    ? " (a " + getGoal() + " base plus " + exTotal + " earned from exercise)"
    : "";
  return (
    "I'm using a simple calorie-logging app and trying to eat better. " +
    "Here's everything I ate " + dayPhrase(d) + ":\n\n" + lines + exBlock +
    "\n\nTotal eaten: " + total + " of a " + goal + " kcal budget" + budgetNote + ".\n\n" +
    "Please act as a gentle, encouraging nutrition coach. In a few short, " +
    "friendly paragraphs: tell me what I'm doing well, what might be missing " +
    "for well-rounded nutrition (protein, fiber, fruits and vegetables, whole " +
    "grains, healthy fats, key vitamins and minerals), and suggest a few easy, " +
    "realistic foods I could add or swap in. Keep it positive and practical — " +
    "no shaming and no calorie lectures."
  );
}

function openFeedback() {
  document.getElementById("feedbackStatus").textContent = "";
  feedbackSheet.classList.remove("hidden");
}
function closeFeedback() {
  feedbackSheet.classList.add("hidden");
}

// ---- Daily goal settings (sheet) ----
const settingsSheet = document.getElementById("settingsSheet");
const goalInput = document.getElementById("goalInput");

document.getElementById("settingsBtn").addEventListener("click", () => openSettings(false));
document.getElementById("settingsBackdrop").addEventListener("click", closeSettings);
document.getElementById("settingsCancel").addEventListener("click", closeSettings);
document.getElementById("useDefaultBtn").addEventListener("click", () => {
  setGoal(DEFAULT_GOAL);
  closeSettings();
  render();
});
document.getElementById("saveGoalBtn").addEventListener("click", () => {
  const v = parseInt(goalInput.value, 10);
  if (!isFinite(v) || v < 800 || v > 10000) { goalInput.focus(); return; }
  setGoal(v);
  closeSettings();
  render();
});

function openSettings(onboarding) {
  settingsSheet.classList.toggle("onboarding", !!onboarding);
  document.getElementById("settingsTitle").textContent =
    onboarding ? "Welcome to Nada" : "Daily goal";
  document.getElementById("settingsNote").textContent = onboarding
    ? "First, set the calories you're aiming for each day. The default, 2,000, " +
      "is the general adult reference — pick whatever fits you. You can change " +
      "it anytime, and any exercise you log adds to that day's budget."
    : "Set the calories you're aiming for each day. Exercise you log is added " +
      "on top of this to grow that day's budget.";
  goalInput.value = getGoal();
  settingsSheet.classList.remove("hidden");
}
function closeSettings() { settingsSheet.classList.add("hidden"); }

// ---- Exercise logging (sheet) ----
// "Both" input styles: tap a quick activity + minutes for a rough estimate
// (editable), or just type the calories. The kcal/min figures are rough
// averages for an adult — good enough to nudge the budget, easy to override.
const ACTIVITIES = [
  { key: "walk",  label: "Walk",  kcalPerMin: 4 },
  { key: "run",   label: "Run",   kcalPerMin: 10 },
  { key: "bike",  label: "Bike",  kcalPerMin: 7 },
  { key: "gym",   label: "Gym",   kcalPerMin: 5 },
  { key: "other", label: "Other", kcalPerMin: 5 },
];
let selectedActivity = ACTIVITIES[0];

const exerciseSheet = document.getElementById("exerciseSheet");
const exName = document.getElementById("exName");
const exMinutes = document.getElementById("exMinutes");
const exKcal = document.getElementById("exKcal");

document.getElementById("exerciseBtn").addEventListener("click", openExercise);
document.getElementById("exerciseBackdrop").addEventListener("click", closeExercise);
document.getElementById("exerciseCancel").addEventListener("click", closeExercise);
exMinutes.addEventListener("input", recomputeBurn);
document.getElementById("addExerciseBtn").addEventListener("click", () => {
  const kcal = Math.max(0, Math.round(parseFloat(exKcal.value) || 0));
  if (kcal <= 0) { exKcal.focus(); return; }
  addExerciseEntry({
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    name: (exName.value || selectedActivity.label || "Exercise").trim(),
    minutes: Math.max(0, Math.round(parseFloat(exMinutes.value) || 0)),
    kcal,
  });
  closeExercise();
});

function renderChips() {
  const wrap = document.getElementById("activityChips");
  wrap.innerHTML = "";
  for (const a of ACTIVITIES) {
    const b = document.createElement("button");
    b.className = "chip" + (a.key === selectedActivity.key ? " on" : "");
    b.textContent = a.label;
    b.addEventListener("click", () => {
      selectedActivity = a;
      if (a.key !== "other") exName.value = a.label;
      else if (ACTIVITIES.some((x) => x.label === exName.value)) exName.value = "";
      renderChips();
      recomputeBurn();
    });
    wrap.appendChild(b);
  }
}
// Re-estimate burned calories from the selected activity + minutes. (Manual
// edits to the calorie field stick until the activity or minutes change.)
function recomputeBurn() {
  const mins = Math.max(0, parseFloat(exMinutes.value) || 0);
  exKcal.value = Math.round((selectedActivity.kcalPerMin || 5) * mins);
}
function openExercise() {
  selectedActivity = ACTIVITIES[0];
  exName.value = selectedActivity.label;
  exMinutes.value = 30;
  recomputeBurn();
  renderChips();
  exerciseSheet.classList.remove("hidden");
}
function closeExercise() { exerciseSheet.classList.add("hidden"); }

// ---- Service worker ----
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

// ---- Init ----
render();
if (!hasGoalSet()) openSettings(true); // first-run: choose a goal or default
