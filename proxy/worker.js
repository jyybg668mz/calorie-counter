// Cloudflare Worker for the Calorie Counter app. It does two things:
//
//   1. Proxies food searches to USDA FoodData Central (default route).
//      The USDA API key is NOT in this file. It's stored as an encrypted
//      environment variable named USDA_KEY in the Cloudflare dashboard
//      (Worker > Settings > Variables), so it never appears in the repo
//      or in the browser.   Browser calls:  .../?query=banana
//
//   2. A tiny accountability sync under /share/* so friends can see each
//      other's daily calorie total + streak via a short share code, plus
//      1:1 encouragement chat (/share/msg, /share/thread). It stores only a
//      name, goal, per-day totals, and short chat threads in a KV namespace.
//      Bind a KV namespace to this Worker with the variable name ACCOUNTS
//      (Worker > Settings > Bindings). If it isn't bound, /share/* returns
//      503 and the rest of the app keeps working.
//
// Privacy note: a user's secret account id (used to WRITE their own data)
// never leaves their device except in the sync request. A share code only
// lets others READ a name, daily total, goal, and streak -- never the id,
// and never the ability to write.

const ALLOWED_ORIGINS = ["https://jyybg668mz.github.io"];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowOrigin = ALLOWED_ORIGINS.includes(origin)
      ? origin
      : ALLOWED_ORIGINS[0];

    const cors = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);

    if (url.pathname.startsWith("/share/")) {
      return handleShare(request, env, url, cors);
    }
    return handleSearch(env, url, cors);
  },
};

// ---- Food search proxy (unchanged behavior) ----
async function handleSearch(env, url, cors) {
  const query = url.searchParams.get("query") || "";
  if (!query) {
    return json({ error: "missing query parameter" }, 400, cors);
  }

  const api = new URL("https://api.nal.usda.gov/fdc/v1/foods/search");
  api.searchParams.set("api_key", env.USDA_KEY);
  api.searchParams.set("query", query);
  api.searchParams.set("pageSize", "25");
  api.searchParams.set("dataType", "Foundation,SR Legacy,Survey (FNDDS)");

  try {
    const res = await fetch(api.toString());
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return json({ error: "upstream request failed" }, 502, cors);
  }
}

// ---- Accountability sync ----
async function handleShare(request, env, url, cors) {
  if (!env.ACCOUNTS) {
    return json({ error: "sync not configured" }, 503, cors);
  }

  // Upsert the caller's own data. The userId is the secret write key.
  if (url.pathname === "/share/sync" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "bad json" }, 400, cors);
    }
    const userId = cleanId(body.userId);
    if (!userId) return json({ error: "bad userId" }, 400, cors);

    const name = cleanName(body.name);
    const goal = clampNum(body.goal, 0, 100000, 2000);
    const date = cleanDate(body.date);
    const total = clampNum(body.total, 0, 1000000, 0);

    const raw = await env.ACCOUNTS.get("user:" + userId);
    let user = raw ? JSON.parse(raw) : null;
    if (!user) {
      const code = await allocCode(env);
      user = { code, name, goal, days: {} };
      await env.ACCOUNTS.put("code:" + code, userId);
    } else {
      if (name) user.name = name;
      user.goal = goal;
    }
    if (date) {
      user.days[date] = total;
      user.days = trimDays(user.days, 60);
    }
    await env.ACCOUNTS.put("user:" + userId, JSON.stringify(user));
    return json({ code: user.code, name: user.name || "" }, 200, cors);
  }

  // Read someone else's public stats by their share code.
  if (url.pathname === "/share/peek" && request.method === "GET") {
    const code = cleanCode(url.searchParams.get("code"));
    if (!code) return json({ error: "bad code" }, 400, cors);

    const userId = await env.ACCOUNTS.get("code:" + code);
    if (!userId) return json({ error: "not found" }, 404, cors);
    const raw = await env.ACCOUNTS.get("user:" + userId);
    if (!raw) return json({ error: "not found" }, 404, cors);

    const user = JSON.parse(raw);
    const today = cleanDate(url.searchParams.get("date")) || isoToday();
    return json(
      {
        code,
        name: user.name || "Friend",
        goal: user.goal || 2000,
        total: (user.days && user.days[today]) || 0,
        streak: streakFrom(user.days || {}, today),
      },
      200,
      cors
    );
  }

  // Send a 1:1 chat message to a friend. The userId authenticates the sender;
  // the message is appended to the thread keyed by the two share codes.
  if (url.pathname === "/share/msg" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "bad json" }, 400, cors);
    }
    const userId = cleanId(body.userId);
    if (!userId) return json({ error: "bad userId" }, 400, cors);
    const toCode = cleanCode(body.toCode);
    if (!toCode) return json({ error: "bad code" }, 400, cors);
    const text = cleanText(body.text);
    if (!text) return json({ error: "empty message" }, 400, cors);

    const raw = await env.ACCOUNTS.get("user:" + userId);
    if (!raw) return json({ error: "not set up" }, 403, cors);
    const me = JSON.parse(raw);
    if (me.code === toCode) return json({ error: "cannot message self" }, 400, cors);

    const key = threadKey(me.code, toCode);
    const traw = await env.ACCOUNTS.get(key);
    const thread = traw ? JSON.parse(traw) : [];
    thread.push({ from: me.code, name: me.name || "Friend", text, ts: Date.now() });
    while (thread.length > 50) thread.shift(); // keep the last 50 only
    await env.ACCOUNTS.put(key, JSON.stringify(thread));
    return json({ ok: true, code: me.code, messages: thread }, 200, cors);
  }

  // Read the 1:1 thread between the caller and a friend. userId-authed, so
  // only the two participants (each with their own secret id) can read it.
  if (url.pathname === "/share/thread" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "bad json" }, 400, cors);
    }
    const userId = cleanId(body.userId);
    if (!userId) return json({ error: "bad userId" }, 400, cors);
    const withCode = cleanCode(body.withCode);
    if (!withCode) return json({ error: "bad code" }, 400, cors);

    const raw = await env.ACCOUNTS.get("user:" + userId);
    if (!raw) return json({ error: "not set up" }, 403, cors);
    const me = JSON.parse(raw);

    const traw = await env.ACCOUNTS.get(threadKey(me.code, withCode));
    return json({ code: me.code, messages: traw ? JSON.parse(traw) : [] }, 200, cors);
  }

  return json({ error: "not found" }, 404, cors);
}

// ---- helpers ----
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function cleanId(v) {
  return typeof v === "string" && /^[A-Za-z0-9_-]{16,100}$/.test(v) ? v : null;
}
// Keep printable characters only (drop control chars), trim, cap length.
function cleanName(v) {
  const s = typeof v === "string" ? v : "";
  let out = "";
  for (const ch of s) {
    if (ch.charCodeAt(0) >= 32) out += ch;
  }
  return out.trim().slice(0, 40);
}
function cleanDate(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
function cleanCode(v) {
  return typeof v === "string" && /^[A-Z0-9]{4,10}$/.test(v) ? v : null;
}
// Chat message body: keep printable chars + newlines, trim, cap length.
function cleanText(v) {
  const s = typeof v === "string" ? v : "";
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c >= 32 || c === 10) out += ch;
  }
  return out.trim().slice(0, 500);
}
// Stable thread key from the two share codes (order-independent).
function threadKey(a, b) {
  return "chat:" + (a < b ? a + ":" + b : b + ":" + a);
}
function clampNum(v, min, max, dflt) {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}
function trimDays(days, keep) {
  const keys = Object.keys(days).sort();
  if (keys.length <= keep) return days;
  for (const k of keys.slice(0, keys.length - keep)) delete days[k];
  return days;
}
// Consecutive days with a logged total ending at `today`. If today hasn't
// been logged yet, count from yesterday so an unfinished day doesn't reset
// the streak.
function streakFrom(days, today) {
  const d = new Date(today + "T00:00:00Z");
  if (!(days[today] > 0)) d.setUTCDate(d.getUTCDate() - 1);
  let streak = 0;
  for (let i = 0; i < 400; i++) {
    const key = d.toISOString().slice(0, 10);
    if (days[key] > 0) {
      streak++;
      d.setUTCDate(d.getUTCDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
async function allocCode(env) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    let c = "";
    for (const b of bytes) c += CODE_ALPHABET[b % CODE_ALPHABET.length];
    if (!(await env.ACCOUNTS.get("code:" + c))) return c;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let c = "";
  for (const b of bytes) c += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return c;
}
