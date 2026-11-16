# Rent watcher

Watches filtered property searches on [joymee.uz](https://joymee.uz) and
[uybor.uz](https://uybor.uz), and sends every **newly published** listing to
your Telegram — once, never twice.

No dependencies, no database, no server to maintain. It runs on GitHub Actions
for free and keeps working whether or not your PC is on.

---

## How it works

Both sites load their listings from public JSON APIs. The watcher calls those
directly with the filters from your search URLs, so it sees the same
apartments you do, without rendering a browser.

Each check, for every search:

1. fetches the newest listings,
2. drops anything whose key it has already sent (`state.json`),
3. loads any missing details,
4. sends what is left to Telegram, oldest first,
5. writes the updated `state.json` back to the repo.

Each message carries the cover photo, price, room count, floor area, floor,
address, publish time, the advertiser's name where known, a tappable phone
number, and a link to the listing on whichever site it came from.

De-duplication is per source, with keys like `joymee:606422`, so the two
sites can never collide.

### Adding a site

Each site is an adapter in `src/sources/` exposing `buildSearch`,
`fetchListings` and `fetchDetail`. Register its hostnames in
`src/sources/index.js` and add its URL to `SEARCH_URLS`.

Before writing one, check the site is reachable from CI:

```bash
npm run probe-sites
```

Run it on a GitHub runner too, not just locally. **olx.uz and makler.uz were
rejected this way** — OLX blocks datacenter IPs outright through CloudFront, so
it works from a laptop and fails completely from Actions.

### What each API does that this works around

Both APIs accept filter parameters and silently ignore some of them, which is
the dangerous kind of bug: you get results, they are just the wrong ones.

**joymee.uz**

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

**uybor.uz**

- **`room__gte` / `room__lte` and `price__lte` do not filter.** Rooms are
  stored as strings, and the price filter matches nothing at all. Both are
  applied to the results instead, over fields the API already returns.
- **`offset` and `skip` are accepted and ignored.** Paging is by `page`;
  using `offset` returns page one every time, which quietly turns deeper
  paging into the same request repeated.
- Promoted listings are pinned to the top here too, so results are re-sorted
  by publish time.

Run `npm run verify` at any time to re-check all of this against both live
sites. It drops each filter in turn and reports any that make no difference.

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
2. Set **Expiration** to a custom date about a year out. The default is 30
   days, and the chain stops the day it expires
3. Scope it to this repository only
4. Under *Repository permissions*, set **Actions** to **Read and write**
5. Add it as a repository secret named `CHAIN_TOKEN`

Each run then requests the next one as it finishes. Delete the secret to stop.

**When the token expires** the watcher stops and the run goes red with a
message saying so, so it fails loudly rather than going quiet. GitHub also
emails you before the expiry date. To restart: renew the token, update the
secret, and push any commit.

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
| `SEARCH_URLS` | your filtered search URLs, comma- or newline-separated |

### 6. Turn it on

Go to the **Actions** tab and enable workflows if prompted. Open
**Watch joymee rentals** → **Run workflow** → choose `test-telegram` to confirm
the secrets work, then `seed` once.

After that the schedule takes over. You can watch each run in the Actions tab.

---

## Letting other people receive listings

By default only you are notified. You can also approve other people's chats —
**only you can grant access, nobody can subscribe themselves**, and every
approval expires (a day by default).

### Turning it on

Generate a key and add it as the repository secret `SUBSCRIBER_KEY`:

```bash
openssl rand -hex 32
```

That key encrypts the approved-chat list. The list is committed to the
repository so access survives between runs, the repository is public, and a
chat id identifies a real person — so it is only ever written as ciphertext.
Without the secret, access control stays off and only you are notified.

Optionally set the repository variable `ACCESS_HOURS` to change how long an
approval lasts. The default is 24.

### Using it

Someone who wants access messages the bot. They are told their chat id and get
nothing else; you get a notification with the command ready to copy:

```
👤 Access requested by Dilnoza
chat id: 123456789

Approve with:
/approve 123456789
```

Your commands:

| Command | What it does |
| --- | --- |
| `/approve <chat_id> [hours]` | Grant access, default `ACCESS_HOURS` |
| `/revoke <chat_id>` | Remove access immediately |
| `/list` | Who has access, and how long is left |
| `/whoami` | Your own chat id |

Anyone can send `/status` to see their own remaining time.

Re-approving someone extends them from that moment, so `/approve 123 24` each
morning keeps a person on a rolling daily window.

### What is guaranteed

- A listing is never sent to a chat you have not approved.
- Access ends by itself. Forgetting to revoke someone is not a leak.
- If someone blocks the bot, their access is dropped automatically.
- Your own notifications never expire and cannot be revoked.
- Commands are read on each check, so an approval takes effect within a minute.

Messages sent to the bot while no run is active are not lost — Telegram holds
them for 24 hours and the next run picks them up.

---

## Changing what you watch

Set the filters on the site, copy the URL from the address bar, and update
the `SEARCH_URLS` repository variable. Nothing else needs to change — every filter in
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
| `ACCESS_HOURS` | `24` | How long an approval lasts. |
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
