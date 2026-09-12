# Capture the Hood: Toronto

A photo-based territory game for a small private friend group. Players conquer Toronto's
25 city wards — always called **Hoods** — by posting recent photos taken inside them,
with a rock-paper-scissors layer based on **what the photo is of**.

```
          landmark  ──beats──▶  animal
             ▲                     │
             │                   beats
           beats                   │
             │                     ▼
          person   ◀──beats──   animal
```

| Subject | Covers | Beats | Beaten by |
|---|---|---|---|
| `landmark` | buildings, monuments, streets, local businesses | `animal` | `person` |
| `person` | selfies, friends, willing strangers | `landmark` | `animal` |
| `animal` | anything with a pulse that isn't a person | `person` | `landmark` |

Any camera counts — phone, drone, SLR, disposable. Only the subject matters.

**The game runs on the honour system.** The server never checks where or when a photo
was taken, or whether it shows what you said it shows. Players police each other by
flagging. Two flags revert a claim and cancel its points.

Built for [shinobi](http://192.168.1.203), served at `https://cth.shintech.online`.

---

## The three actions

One endpoint handles all three; the server infers which from who holds the Hood.

| Action | When | Subject needed | Points |
|---|---|---|---|
| **Conquer** | nobody holds it | any | the Hood's `unclaimed_value` (25, escalating) |
| **Steal** | somebody else holds it | must beat theirs | 100 |
| **Reinforce** | you hold it, 72h since its last claim | must beat *your own* | 25, flat, forever |

- After a Hood changes hands it is locked from stealing for 12 hours.
- **Conquering unclaimed ground closes that Hood's neighbours to you for 24 hours** — the
  anti-drone rule, so one flight cannot sweep up a contiguous block. Per-player and
  conquer-only: anyone else can still take the neighbour, and your own steals and
  reinforces there are unaffected. Adjacency is computed from the real boundaries.
- **A reinforce does not lock it.** Rotating what beats you is the defence a reinforce
  buys; if it also shielded the Hood, you could hold one forever on a timer.
- Losing a Hood costs you nothing. The ledger is append-only — territory changes, score
  does not.

## Seasons

Four, stored in the `seasons` table, never hardcoded. At each rollover season tallies
reset (by scoping queries to `season_id` — nothing is deleted), Hood ownership persists,
and every Hood **never conquered by anyone** gains +25. So an untouched Hood goes
25 → 50 → 75 → 100, and by Season 4 it is worth exactly as much as a steal. That is what
finally makes someone drive out to Rouge Park in February.

Season winner = most points in one season. Champion = most across all four. Both come
from the same ledger; there is no stored running total anywhere, by design.

---

## Running it

```bash
npm run install:all        # server deps + web deps
npm run import-hoods       # fetch the 25 Hood boundaries from City of Toronto Open Data
npm run invite             # mint an invite code — the first player to use one is admin
npm run build              # build the PWA into web/dist
npm start                  # http://localhost:8096
```

For frontend work, run the API and Vite side by side — Vite proxies `/api`, `/media`
and `/ws` through to the server:

```bash
npm run dev                # API with --watch
npm run dev:web            # Vite on :5173
```

```bash
npm test                   # 78 tests: game rules, the HTTP API, reprojection
```

`npm test` needs no running server and touches nothing in `data/` — it boots its own
instance against a throwaway database in the OS temp directory.

### Scripts

| Command | What it does |
|---|---|
| `npm run import-hoods` | Fetches `city-wards` from CKAN, writes `web/public/hoods.min.geojson` (1.1 MB → 66 kB), and updates the `hoods` table plus the `hood_neighbours` adjacency graph. `--file` for a local copy, `--seed` to also rewrite the seed module. |
| `npm run rollover` | Checks whether the active season has ended; applies escalation and posts to chat. Idempotent. `--dry-run` to see what it would do. |
| `npm run invite [n]` | Mints invite codes. |
| `node scripts/make-icons.js` | Regenerates the PWA icons and favicon from one SVG. |

---

## Layout

```
server/
  index.js            express + ws + static hosting
  config.js           every tunable, including the game levers
  schema.sql          the whole database
  lib/game.js         ← the claim state machine. This is the game.
  lib/views.js        read models; all scores derived from the ledger
  lib/auth.js         argon2id + JWT cookie + invite codes
  lib/images.js       sharp pipeline, HEIC fallback, EXIF panel
  lib/hub.js          WebSocket hub; every claim and flag posts itself to chat
  routes/             thin HTTP wrappers over the above
scripts/              import-hoods, rollover, make-invite, make-icons
web/                  React 18 + Vite + Leaflet PWA
deploy/               systemd units, nginx vhost, backup script
test/                 game rules, end-to-end API, reprojection
```

`server/lib/game.js` is the only file that decides who owns a Hood. Everything else is
presentation. If you change one thing, change it there.

## Stack

Node 20+ · Express 4 · better-sqlite3 · ws · sharp · argon2 · React 18 · Vite · Leaflet.

No API keys. The basemap is plain OpenStreetMap raster darkened in CSS — CARTO's dark
tiles now stamp "API KEY REQUIRED" across every tile. To use a keyed provider instead,
set `VITE_MAP_TILES`, `VITE_MAP_ATTRIB` and `VITE_MAP_DARKEN=false` at build time.

## Deploying

See [SETUP.md](SETUP.md) for the one-time install. After that, `.\deploy.ps1`.

## Attribution

Hood boundaries contain information licensed under the
[Open Government Licence – Toronto](https://open.toronto.ca/open-data-license/), from
the City of Toronto `city-wards` dataset (25-ward model, 2018). Map tiles ©
[OpenStreetMap](https://www.openstreetmap.org/copyright) contributors. Fonts: Rubik Mono
One and Space Mono, SIL Open Font License (see `web/public/fonts/`).
