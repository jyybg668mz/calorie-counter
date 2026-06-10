# Calorie Counter

A simple, installable food-education app that starts with the most basic
habit: **seeing how many calories you eat**. It's a Progressive Web App
(PWA) — no app store, no install step beyond "Add to Home Screen" — built
to grow over time.

**Live app:** https://jyybg668mz.github.io/calorie-counter/

## Features

- **Daily calorie log** — search a food, set the grams, and add it. Totals
  are kept per day in your browser (nothing to sign up for).
- **Progress ring** — a circular gauge around your daily total, based on the
  2,000 kcal USDA reference intake. It fills as you log food and turns amber
  when you go over.
- **Food search** — typeahead matching (type a few letters), with results
  re-ranked so the plainest, closest match floats to the top. Powered by the
  free [USDA FoodData Central](https://fdc.nal.usda.gov/) database.
- **Recents & favorites** — every food you add is remembered and offered for
  one-tap re-adding. Star the ones you eat often to pin them to the top.
- **Accountability (opt-in)** — share a short code with a friend to let them
  see your daily total, goal, and logging streak — and add their code to see
  theirs. Only those numbers are shared; your food list stays on your device.

## How it works

Plain HTML, CSS, and JavaScript — no build step, no framework.

| File | Role |
| --- | --- |
| `index.html` | App shell and markup |
| `app.js` | All app logic (logging, search, ring, recents, sharing) |
| `styles.css` | Styling (dark theme) |
| `service-worker.js` | Offline caching of the app shell (versioned) |
| `manifest.json` | PWA metadata for "Add to Home Screen" |
| `proxy/worker.js` | Cloudflare Worker: food-search proxy + sync backend |
| `generate_icons.py` | Pure-Python generator for the app icons |

- **Storage:** daily logs and recents live in the browser's `localStorage`
  (keys like `cc:YYYY-MM-DD`, `cc:foods`, `cc:account`, `cc:friends`).
- **Food search** goes through a Cloudflare Worker rather than calling USDA
  directly, so the USDA API key never ships to the browser (USDA asks that
  the key be kept private). The key is stored as an encrypted Worker secret.
- **Accountability sync** is a small set of endpoints on the same Worker
  (`/share/sync`, `/share/peek`), backed by Cloudflare KV. A private account
  id (kept on your device) is the only thing that can *write* your data; a
  share code only lets others *read* your name, total, goal, and streak.

## Running locally

It's static files, so any local web server works, for example:

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. Note: food search and accountability call
the deployed Cloudflare Worker, which only allows requests from the live
site's origin — so those features won't work from `localhost` (by design).
Calorie logging, recents, and the ring all work offline/locally.

## Deployment

- **Frontend:** hosted on GitHub Pages from the `main` branch. Pushing to
  `main` redeploys automatically in a minute or two. Bump the `CACHE`
  version string in `service-worker.js` whenever assets change so installed
  PWAs pick up the update.
- **Backend (Cloudflare Worker):** code lives in `proxy/worker.js` and is
  deployed via the Cloudflare dashboard. It needs:
  - an encrypted variable `USDA_KEY` (your USDA FoodData Central API key), and
  - a KV namespace bound with the variable name `ACCOUNTS` (for the
    accountability sync). Without the binding, `/share/*` returns `503` and
    the rest of the app keeps working.

## Privacy

Your food log stays on your device. The only data that ever leaves it is
what you explicitly opt into sharing — your name, daily total, goal, and
streak — and only with the people you exchange codes with.
