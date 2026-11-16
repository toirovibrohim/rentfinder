# Joymee rent watcher

Watches a filtered [joymee.uz](https://joymee.uz) search and sends every **newly
published** listing to your Telegram — once, never twice.

No dependencies, no database, no server to maintain. It runs on GitHub Actions
for free and keeps working whether or not your PC is on.

---

## How it works

The joymee.uz website loads its listings from a public JSON API at
`api.joymee.uz/api/v1/announcement/`. The watcher calls that API directly with
the exact filters from your search URL, so it sees the same apartments you do,
without rendering a browser.

Each check it:

1. fetches the newest listings for your filters,
2. drops anything whose ID it has already sent (`state.json`),
3. loads the full details of what is left,
4. sends them to Telegram, oldest first,
5. writes the updated `state.json` back to the repo.

Each message carries the cover photo, price, room count, floor area, floor,
address, publish time, the advertiser's name, a tappable phone number, and a
link to the listing.

The phone number, area, rooms and floor are not in the search results — they
only exist on the per-listing detail endpoint. That costs one extra request per
listing, so it is only done for listings that are actually being sent, not for
everything scanned.

### Three things the site's API does that this works around

These were found by testing the API, and each one would otherwise send you the
wrong apartments:

- **`room_qty_min` / `room_qty_max` are silently ignored.** The API accepts
  them and returns the same results as no room filter at all — a 2–3 room
  search still returns 1-room flats. Only the `room_quantity_*` spelling works,
  so the URL parameters are renamed before the request goes out.
- **`entity_purpose` and `entity_type` are silently ignored too.** Even a
  nonsense value returns the full result set, which means a long-term-rent
  search also returns daily rentals ("посуточно") and sale listings. They are
  translated into the `category` filter the API does respect, using the site's
  own category dictionary.
- **Promoted ("VIP") ads are pinned to the top** regardless of sort order, and
  they can be days old. Results are re-sorted by publish time before anything
  is compared, so a pinned old ad never looks new.

Run `npm run verify` at any time to re-check all of this against the live site.

### Bursts

One agency on this site publishes ten or more ads in the same second. A fixed
page count would see the newest few and silently drop the rest, so paging is
adaptive: it reads `PAGES_TO_SCAN` pages, then keeps going while each new page
still holds listings it has not seen, up to `MAX_PAGES_TO_SCAN`. A normal quiet
check still costs only two requests.

---

## About the one-minute interval

GitHub's scheduler **cannot run a job more often than every 5 minutes**, and in
practice it sometimes runs late when GitHub is busy.

To get close to one minute anyway, each scheduled run stays alive and checks the
site **4 times, 60 seconds apart**, then exits just before the next run starts.
The practical result is a check roughly every minute, with occasional gaps when
GitHub delays the schedule.

### If the schedule never fires

GitHub's scheduler is unreliable, and on a new repository it can refuse to
start for hours while `push` and manual runs work perfectly. The fix is to let
each run start the next one, so the watcher no longer depends on the schedule
at all.

GitHub blocks workflows from triggering workflows with the built-in token, so
this needs a Personal Access Token:

1. Create a **fine-grained** token at
   [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens/new)
2. Scope it to this repository only
3. Under *Repository permissions*, set **Actions** to **Read and write**
4. Add it as a repository secret named `CHAIN_TOKEN`

Each run then requests the next one as it finishes. Delete the secret to stop.

If a run fails within two minutes, the chain deliberately stops rather than
spinning — fix the problem, then push or run the workflow manually to restart.

> **Make the repository public.** Public repos get unlimited free Actions
> minutes. A private repo only gets 2,000 minutes/month, and this schedule uses
> around 39,000. Nothing sensitive is in the repo — your bot token and chat ID
> live in encrypted GitHub Secrets, and `state.json` holds only listing IDs.
>
> If you want it private, change the cron to `'*/30 * * * *'` and set
> `POLL_ITERATIONS` to `1`. That stays inside the free allowance but only checks
> twice an hour.

---

## Setup

### 1. Create the Telegram bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Follow the prompts. It gives you a token like `123456789:AAE...`.
3. **Send your new bot any message** (e.g. `hi`). A bot cannot message you until
   you have messaged it first.

### 2. Find your chat ID

```bash
cp .env.example .env
```

Put your token in `.env`, then:

```bash
npm run find-chat-id
```

It confirms the token works, lists every chat that has messaged the bot, and
writes `TELEGRAM_CHAT_ID` into `.env` for you when there is exactly one.

If it says no conversations were found, you have not messaged the bot yet.

### 3. Try it on your machine first

With the search URL set in `.env`:

```bash
npm run verify
```

That prints what the watcher currently sees and confirms your filters are
actually applied. Then:

```bash
npm run test-telegram
```

You should get a message in Telegram. Finally:

```bash
npm run seed
```

This marks everything currently listed as already seen, so you are not flooded
with hundreds of old ads. From here on only genuinely new listings are sent.

```bash
npm run once
```

Runs a single real check.

### 4. Push to GitHub

```bash
git init
git add .
git commit -m "Joymee rent watcher"
git branch -M main
git remote add origin https://github.com/<your-username>/joymee-rent-watcher.git
git push -u origin main
```

Commit `state.json` too — that is how the watcher remembers between runs.

### 5. Add the secrets

In your repository: **Settings → Secrets and variables → Actions**

Under **Secrets** → *New repository secret*:

| Name | Value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | the token from BotFather |
| `TELEGRAM_CHAT_ID` | your chat ID |

Under **Variables** → *New repository variable*:

| Name | Value |
| --- | --- |
| `SEARCH_URL` | your filtered joymee.uz URL |

### 6. Turn it on

Go to the **Actions** tab and enable workflows if prompted. Open
**Watch joymee rentals** → **Run workflow** → choose `test-telegram` to confirm
the secrets work, then `seed` once.

After that the schedule takes over. You can watch each run in the Actions tab.

---

## Changing what you watch

Set the filters on joymee.uz, copy the URL from the address bar, and update the
`SEARCH_URL` repository variable. Nothing else needs to change — every filter in
the URL is forwarded to the API as-is.

After a big filter change, run the workflow once with mode `seed` so the new
matches are not all sent at once.

---

## Settings

All optional, set as repository variables or in `.env`:

| Variable | Default | What it does |
| --- | --- | --- |
| `PAGES_TO_SCAN` | `2` | Result pages always read per check. |
| `MAX_PAGES_TO_SCAN` | `12` | Cap on adaptive paging during a burst. |
| `POLL_ITERATIONS` | `1` (`4` in CI) | Checks per process run. |
| `POLL_INTERVAL_SECONDS` | `60` | Seconds between those checks. |
| `MAX_NOTIFICATIONS_PER_CHECK` | `25` | Flood guard. Extras are counted, not sent. |
| `SEEN_IDS_TO_KEEP` | `1000` | How many listing IDs to remember. |
| `STATE_PATH` | `state.json` | Where the already-sent list is kept. |

A run exits non-zero if a listing could not be delivered to Telegram, so a bad
token or chat ID shows up as a red run in the Actions tab instead of failing
quietly. Undelivered listings are retried on the next run.

---

## Troubleshooting

**No messages arriving.** Check the Actions tab for failed runs. The most common
cause is not having messaged the bot first — Telegram returns
`403: bot can't initiate conversation with a user`.

**Everything arrived at once.** The watcher had no `state.json`. Run the
workflow with mode `seed`.

**The same listing arrives twice.** A run failed before it could push
`state.json`. It self-corrects on the next run.

**Listings outside my filters.** Run `npm run verify` — it drops each filter in
turn and reports any the API ignores.

**The schedule stopped.** GitHub disables scheduled workflows in repositories
with no activity for 60 days, and emails you first. Any manual commit re-enables
it.

---

## Running it somewhere else

`npm start` is a plain long-running process — set `POLL_ITERATIONS` high (or
wrap it in a loop) and it works on any always-on machine, a Raspberry Pi, or a
small VM, with `state.json` kept on disk.
