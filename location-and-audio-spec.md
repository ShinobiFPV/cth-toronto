# Location & Audio — ParkeMans GO!

Two additions: optional device location with a **Find a Park** action on the map, and a
sound/music layer with an admin interface for swapping the files.

Written against the invariants in `CLAUDE.md`.

---

# Part 1 — Location

## 1.1 Location never leaves the device

The nearest-park search runs **entirely client-side**. The browser gets a fix, the client
already holds park coordinates, and haversine over 1,513 points is sub-millisecond work. No
endpoint, no request body, nothing in nginx logs.

This matters more than it might seem in a six-player game where one of the players
administers the server. "The app knows where I am" and "William's Pi has a log of where I
was on Tuesday" are very different propositions, and the second one is easy to create by
accident and awkward to walk back.

It's also just better: no round trip while standing outside on bad LTE, and it works with
the app offline.

**Ship a park index** — `public/parks.index.json`, one entry per park:

```json
{"i":412,"n":"Trinity Bellwoods Park","h":9,"la":43.6469,"ln":-79.4131}
```

Short keys because there are 1,513 of them; roughly 60–80KB gzipped, precached by the
existing service worker. Generate it from the same source as the park data at build time so
it can't drift.

## 1.2 Permissions

**Never call `getCurrentPosition()` on load.** A permission prompt on cold start gets
dismissed reflexively, and once a browser has a denial recorded the app cannot ask again —
the user has to go into system settings and find it. The first prompt has to be earned.

So: the prompt is triggered only by tapping **Find a Park** or the locate-me control, both
of which are unambiguous user gestures where the reason for the prompt is obvious.

Handle the denial path properly. `PERMISSION_DENIED` gets a short explanation of how to
re-enable it and a Hood picker as a fallback, not a dead end.

**Secure context required.** Geolocation needs HTTPS. `cth.shintech.online` through the
tunnel is fine; `http://192.168.1.203:8096` is not, and it fails without an obvious error.
If you test location features on the LAN, that is why nothing happens — localhost is
exempt, LAN IPs are not.

## 1.3 The two modes

**Find a Park** — `getCurrentPosition()`, one fix:

```js
{ enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
```

High accuracy matters here; at street level the difference between GPS and tower
trilateration is the difference between the right park and the next one over.

**The dot on the map** — `watchPosition()`, and only while the map is foregrounded and the
user has turned the dot on. It drains battery in a way a single fix doesn't. Kill the watch
on tab change, on navigating away from the map, and on toggling it off.

Render it as a marker plus an accuracy circle — phone GPS downtown is routinely ±20–50m and
drawing a precise dot is a lie. **Do not auto-recenter** on every position update; it fights
the user's panning and makes the map feel possessed. Recenter only on an explicit tap.

## 1.4 Find a Park: the list

Nearest five, sorted by distance. Two rules make the difference between a feature people use
all season and one they stop opening in October:

**Default to uncollected parks.** Filter to parks this player hasn't collected this season.
By midseason every park within walking distance of home is already in the binder, and a list
of five parks you can't collect is worse than no list. Offer a toggle to show all, off by
default.

**Flag which ones will actually score.** With the per-Hood park points cap in place, the
nearest five may all sit in a Hood where you're already capped. Each row shows its Hood and,
where relevant, a quiet **XP only** marker. This is the thing that turns the cap from a
confusing silence into a visible reason to travel — and it's the reason to build these two
features in the same pass.

Each row: park name, distance, Hood, collected/uncollected, scoring state. Tapping it
centres the map and opens the park. A **Directions** action hands off to the OS maps app via
a `geo:` / Apple Maps URL — don't build routing.

If the fix is poor (`coords.accuracy` worse than ~200m), say so rather than silently
returning five parks that may be wrong.

## 1.5 This is not verification

Location is a convenience. It must not become a geofence.

The game is honour-based, enforcement is flagging, and nothing in this feature should ever
gate a collection on proximity. Worth a comment in the code, because "you must be within
100m to collect" is a very natural-looking next commit and it would quietly replace the
social system the whole game rests on.

## 1.6 UI placement

**Find a Park** sits on the map at the same level as the snap-a-car action. If that's a
floating button, this is a second one; two are fine, and a third would need stacking or a
speed-dial. Don't put it in the Hood sheet — the sheet's action row is already carrying the
claim button and Collect parks, and it's where the layout went wrong before.

The locate-me control is a small separate map control, conventionally bottom-right, not a
third primary button.

---

# Part 2 — Audio

## 2.1 Music and effects are different systems

- **Effects** — short, overlapping, latency-sensitive. Web Audio: decode once into
  `AudioBuffer`s at startup, fire through `AudioBufferSourceNode`. `new Audio()` has audible
  lag and handles overlapping plays badly.
- **Music** — long, looping, one at a time. If you want a seamless loop, use a short loop
  (60–90s, ~1.5MB as AAC) through Web Audio with `loop = true`; file-based looping has an
  audible gap at the seam in every format. A longer track is fine through an
  `HTMLAudioElement` — just don't decode three minutes into memory on a phone.

Both go through a `GainNode` per channel so the toggles are volume changes rather than
teardowns.

## 2.2 The unlock

`AudioContext` starts suspended. `ctx.resume()` only works inside a real user gesture — do
it on the first tap anywhere in the app, not on load.

**Music cannot autoplay.** It starts on the first gesture after the toggle is on, which in
practice means the first tap of a session. Don't fight this; a silent first two seconds is
correct behaviour, not a bug.

**iOS silent switch mutes Web Audio entirely.** When someone reports the sounds are broken,
this is the first thing to check, and it's worth a line in the options screen.

## 2.3 Two toggles, not one

You asked for Music On/Off. Recommend splitting it:

```
Music          [on/off]
Sound effects  [on/off]
```

They're genuinely different preferences — plenty of people want the Hologram sting and the
Fortify hit while listening to their own music, and a single switch means turning off the
background loop also silences the best moment in the game. It's one extra row and one extra
`GainNode`.

**Default music off, effects on.** Someone opening the app with Spotify playing and getting
a loop over the top of it is a bad first impression, and the effects are where the game's
personality lives anyway.

Persist both in localStorage, read before the first frame so there's no burst of sound
before the preference applies.

## 2.4 The sound set

Fix the slot keys now so the admin interface has a stable list:

| Key | Fires on |
|---|---|
| `conquer` | taking an unclaimed Hood |
| `steal` | taking a Hood from someone |
| `lost` | **your** Hood being taken — different, and it should sting |
| `reinforce` | reinforcing |
| `collect_park` | park collection |
| `collect_car` | car collection |
| `edition_gold` | Gold pull |
| `edition_holo` | Hologram pull — the best sound in the app |
| `item_grant` | item received |
| `fortify_hit` | your Fortify blocking a theft |
| `fortify_blocked` | walking into someone's Fortify |
| `trade` | trade completed |
| `level_up` | level threshold crossed |
| `chat` | incoming message, quiet |
| `blocked` | cooldown or validation rejection |
| `rollover` | season change |
| `music_main` | map loop |

`edition_holo` and `fortify_hit` carry the most weight. Everything else should be short and
unobtrusive — a chat blip at the same loudness as a Hologram pull is how people end up
muting the app permanently.

## 2.5 Format and sourcing

AAC in `.m4a`, mono for effects, stereo for music. A 300ms cue is ~8KB.

```
ffmpeg -i cue.wav -ac 1 -ar 44100 -c:a aac -b:a 96k cue.m4a
ffmpeg -i loop.wav -ac 2 -ar 44100 -c:a aac -b:a 128k loop.m4a
```

Trim leading silence before converting — it reads as input lag. Normalise the whole set to
the same loudness, or the levels will be wrong in a way that's hard to diagnose later.

**Source CC0 only.** The repo is public, so anything under CC-BY drags an attribution
obligation into it. Freesound filtered to CC0, Kenney's asset packs, and Pixabay's audio
library all qualify. Record the licence per file in the manifest so a future you can prove
it.

## 2.6 Admin swap interface

Use the pattern you already have on shintech.online: **Pi-authoritative files plus a
manifest, with repo defaults as the fallback.**

- Defaults ship in the repo at `public/audio/`.
- Overrides live in a Pi-authoritative directory, `/srv/parkemans/audio/`, which deploy
  never touches.
- `audio-manifest.json` on the Pi is the source of truth, exactly as `content.json` is for
  the site. A slot with no override resolves to the repo default.

```json
{
  "version": 7,
  "slots": {
    "edition_holo": {
      "file": "holo-custom.m4a",
      "hash": "a1c3f9",
      "gain": 0.8,
      "licence": "CC0 / freesound 123456"
    }
  }
}
```

Admin UI — a section in the existing options or admin screen, gated on `players.is_admin`:

- Every slot listed with its current source (default or override).
- **Preview play** on each. Non-negotiable; nobody can pick a sound without hearing it in
  context.
- Upload a replacement, with server-side transcode through ffmpeg to the standard format so
  a 40MB WAV doesn't get served to phones.
- **Reset to default** per slot.
- A per-slot gain slider — far easier than re-exporting a file to fix one loud cue.

Cap uploads and validate the decoded duration server-side; a 10-minute file in the `chat`
slot would be a memorable but unwelcome afternoon.

## 2.7 The thing that will actually break

**The service worker precaches audio.** Swap a file on the Pi and every client keeps playing
the old one, possibly for weeks, with no obvious cause.

Fix: the manifest carries a `hash` per slot and the client requests
`/audio/edition_holo.m4a?v=a1c3f9`. A changed hash is a new URL, so the cache misses and
refetches. The manifest itself is fetched network-first with a cached fallback.

Bump the top-level `version` on any change so clients can cheaply detect they need to
re-resolve without diffing the whole object.

Get this right on the first pass. Diagnosing "the new sound isn't playing" through a service
worker cache, remotely, on someone else's phone, is genuinely unpleasant.

---

## 3. Config

```
CTH_AUDIO_DIR              -- /srv/parkemans/audio
CTH_AUDIO_MAX_UPLOAD_MB
CTH_AUDIO_MAX_DURATION_S
CTH_NEARBY_PARK_COUNT      -- 5
CTH_NEARBY_ACCURACY_WARN_M -- 200
```

---

## 4. Tests

Location:

- Haversine against known Toronto coordinate pairs, and correct ordering of the nearest five.
- The uncollected filter respects season scope, and the toggle restores the full list.
- The scoring flag matches what `evaluateCollect()` would award — if these two ever disagree
  the list is lying, which is worse than not showing it.
- Denial and timeout paths both render a usable fallback rather than an empty state.
- **No request carries coordinates.** Assert it at the API layer; this is the privacy
  guarantee and it should fail loudly if someone adds a convenient endpoint later.

Audio:

- Manifest resolution: override wins, missing override falls back to the repo default,
  unknown slot fails safe and silent.
- A hash change produces a different URL.
- Upload rejects oversized files and over-long durations.
- Toggles persist and apply before first playback.
- Non-admins cannot reach the swap endpoints.

---

## 5. Open decisions

- **One toggle or two** (§2.3). Recommendation is two, music defaulting off.
- **Seasonal music variants** — one loop per season is a nice touch and four times the
  sourcing work. The manifest supports it for free; it's only a question of whether you want
  to find four tracks.
- **Does the dot show other players?** Everything else in this app is public — binders,
  Cases, the feed. Live location is the one thing that shouldn't be, and I'd keep it
  self-only without a setting, so there's nothing to misconfigure.
