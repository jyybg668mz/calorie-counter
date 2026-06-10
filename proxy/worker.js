// Cloudflare Worker: proxies food searches to USDA FoodData Central.
//
// The USDA API key is NOT in this file. It's stored as an encrypted
// environment variable named USDA_KEY in the Cloudflare dashboard
// (Worker > Settings > Variables), so it never appears in the repo or
// in the browser.
//
// The browser calls:  https://<your-worker>.workers.dev/?query=banana
// The worker adds the key and forwards to USDA, returning the JSON.

const ALLOWED_ORIGINS = ["https://jyybg668mz.github.io"];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowOrigin = ALLOWED_ORIGINS.includes(origin)
      ? origin
      : ALLOWED_ORIGINS[0];

    const cors = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const query = new URL(request.url).searchParams.get("query") || "";
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
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
