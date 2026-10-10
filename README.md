# simple-tds

A small, fast traffic distribution system: campaigns → stream funnel → actions,
with bot filtering, whitepages, conversion postbacks and reports.

- **Core**: one Go binary. Campaigns, streams, filters, domains, geo and IP
  lists are held in memory; a click never touches a database on its way through.
- **Storage**: Postgres for configuration, ClickHouse for clicks and conversions
  (clicks are written in background batches).
- **PHP whitepages** run in a separate locked-down php-fpm container.

## Start

```bash
cp .env.example .env      # set the passwords
docker compose up -d --build
```

Panel: `http://SERVER-IP:8080`. Traffic: ports 80 and 443.

A fresh installation has no users: the first person to open the panel creates
the administrator account, so open it right after the first start. Until then
anyone who can reach port 8080 can claim it — on a public server, either go
there immediately or publish the panel on loopback first (`PANEL_BIND=127.0.0.1:8080`
and an SSH tunnel). A lost password is reset with
`docker compose exec tds tds reset-password USER`.

The panel is available in English and Russian: the `EN` / `RU` button on the
login page and at the bottom of the sidebar switches the language. The choice
is kept in the browser.

## Domains

1. Point an A record at the server.
2. Panel → Domains → Add (paste any number of names).
3. The status turns **OK** once the domain is verified to reach this server.

Per domain:

| Setting | Values |
|---|---|
| TLS | `auto` — the app obtains and renews a Let's Encrypt certificate itself. `proxy` — a CDN or balancer terminates TLS (Cloudflare etc.). |
| Real IP | `direct` (socket address, PROXY-protocol aware), `cf` (CF-Connecting-IP), `xff` (X-Forwarded-For), `x_real_ip` |
| Panel access | serve the admin panel on this domain under `/<admin path>/` |

Forwarding headers and PROXY protocol headers are honoured **only** from the
addresses listed in Settings → Network → Trusted proxies. PROXY protocol is a
global switch (the header arrives before the hostname is known) and can be
toggled without a restart; with it on, trusted balancers may send the header
and everyone else is rejected if they try.

TLS fingerprint checks (JA3/JA4, GREASE) only work on `auto` domains, where the
app sees the handshake.

The Domains page opens as a list of cards, one per domain, with every check
spelled out; the switch in its toolbar turns it into a compact sortable table.
The choice is kept on the account, so it is the same in every browser. The
tiles above the list count the domains by state — healthy, flagged, unreachable,
pending, switched off — and filter the list when clicked.

### Reputation checks

A domain that lands on a blocklist loses traffic before anything else shows it:
browsers put up a warning page, ad platforms reject the link, mail with the
link goes to spam. Settings → Domain reputation asks the lists themselves:

| Provider | Needs | Tells you |
|---|---|---|
| Google Safe Browsing | API key (free) | the red warning page in Chrome, Firefox and Safari; a Google Ads signal |
| VirusTotal | API key (free: 4 requests a minute, 500 a day) | how many of about 90 security vendors flag the domain |
| Spamhaus DBL | nothing, or a free DQS key | spam, phishing, malware and botnet listings |
| SURBL, URIBL | nothing | domains seen in spam and phishing mail |
| Cloudflare security DNS, Quad9 | nothing | whether the filtering resolvers 1.1.1.2 and 9.9.9.9 refuse the domain |

Every provider is off until an administrator switches it on, because a check
tells the provider the domain name. Once on, each enabled domain is asked about
when it is added, on "Re-check", and then every N hours (12 by default). The
answers are shown per domain — in the cards, in the table's Reputation column
and in the domain's edit dialog, each with a link to the provider's own page —
and summed up by the **Domains** widget that can be added to any personal
dashboard. They are information only: a listed domain keeps serving traffic
until you decide otherwise.

- Spamhaus, SURBL and URIBL are asked over DNS and refuse public resolvers
  (8.8.8.8, 1.1.1.1): the provider then shows "no answer" with the reason. The
  compose file therefore runs a small recursive resolver (`unbound`) that only
  these lookups go through; it needs outbound port 53. `TDS_BLOCKLIST_DNS`
  points them at another resolver (`host` or `host:port`), and set empty sends
  them through the system resolver. A Spamhaus DQS key works from anywhere.
- A provider that fails (timeout, spent quota) does not erase its last verdict
  for three check intervals, so an outage never turns a listed domain clean.
- With VirusTotal's free key, multiply the number of domains by the checks per
  day before choosing the interval: 100 domains every 12 hours is 200 requests
  a day.

### Certificates

Every `auto` domain is actively managed: its certificate is requested as soon
as the domain is added and renewed in the background well before expiry,
whether or not the domain gets traffic. Certificates and account keys live in
the `data` volume and survive restarts.

Each domain gets its own ACME account, registered as `acme@<domain>`
(subdomains share their parent's: `shop.sample.com` → `acme@sample.com`). Set
Settings → TLS → ACME email to use one address for everything instead.

Let's Encrypt allows about 10 new accounts per server IP per 3 hours. When you
bulk-add more new domains than that, the rest are issued as the limit frees
up — retries are automatic, and the domain's status shows what it is waiting
for. Subdomains of an already-registered domain do not count.

### Turning off ip:port panel access

Settings → Panel access. It can only be switched off once a domain with panel
access enabled has status OK, and that domain cannot then be removed or
demoted. If you still lock yourself out:

```bash
docker compose exec tds tds panel-ip on
docker compose restart tds
```

Forgot the password:

```bash
docker compose exec tds tds reset-password admin
```

### Behind an existing web server (nginx, OpenResty, 1Panel)

If something else already owns ports 80 and 443, publish the tracker on
loopback and let that server proxy to it:

```
HTTP_BIND=127.0.0.1:8081
HTTPS_BIND=127.0.0.1:8443
```

In the front server, proxy each tracker domain to `http://127.0.0.1:8081`,
passing the original host and client address:

```nginx
location / {
    proxy_pass http://127.0.0.1:8081;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Then in the panel:

- Settings → Network → Trusted proxies: the address the front server connects
  from. With Docker port publishing that is the bridge gateway, so
  `172.16.0.0/12` (plus `127.0.0.1` if you run with host networking).
- Each domain: TLS `proxy`, Real IP `X-Forwarded-For`.

The front server issues the certificates in this setup, so each domain has to
be added there as well, and TLS-fingerprint bot checks are unavailable.

## Users and sharing

- **Admins** manage users (and can make other users admins), global settings,
  anti-bot lists and integrations, and can see and change everything.
- **Users** own what they create — campaigns, domains, groups, whitepages,
  conversion keys — and see nothing of anyone else's. Reports, clicks and
  conversions are limited the same way.
- A **campaign** can be shared with other users (Campaign → Sharing):

  | Level | Can do |
  |---|---|
  | Stats only | reports, clicks and conversions of that campaign; no configuration |
  | Read-only | also see streams and settings, change nothing |
  | Can edit | change streams and settings, and run the campaign on their own domains and postback keys |

  Only the owner (or an admin) can share or delete a campaign. Domains,
  whitepages and keys are not shareable.
- Campaigns can be filed into **groups** (Campaigns → Groups) and a group can
  be shared at the same three levels: the share then covers every campaign in
  the group, including the ones moved into it later. With both a group share
  and a direct one, the higher level counts. A group holds only its owner's
  campaigns, and only the owner moves campaigns in or out; deleting the group
  or taking a campaign out of it ends that access at once.
- **Dashboards** next to the built-in overview are personal: each user
  composes their own from numbers, charts, top lists and pinned funnels
  ("Pin" in any funnel drawer). They store only the layout — the figures come
  from the reports and follow the same access rules.

The separation also holds for traffic: a campaign link works only on domains
of its owner (or of someone with edit access), and a postback key only
converts clicks of campaigns its owner runs. Only admins can serve the panel
on a domain.

Deleting a user hands everything they owned to the admin who deleted them, so
live traffic is not interrupted. Disabling a user only blocks their login.

The first account is an admin. Installations upgraded from a single-user
version keep working: the existing account becomes admin and owns everything.

## Campaigns and streams

A campaign is reachable as `https://domain/<alias>` on every linked domain, and
at `/` on domains that name it as their default campaign.

Streams are evaluated top to bottom: **intercepting** → **regular** (by position, or
by weight) → **default**. Each stream has filters (IS / IS NOT, combined with
AND or OR) and one action. A filter can be **bypassed** in the stream editor:
it stays in the stream but is ignored when matching — handy for testing a link
yourself without deleting the rule. The actions:

| Action | |
|---|---|
| HTTP status | 404 or any code |
| Show text / HTML | inline content with macros |
| Show JavaScript | inline script with macros, run in the visitor's browser: wrapped in a page, or raw for `<script src>` and the JS integration |
| Redirect | 301/302/303/307, meta or JS |
| Whitepage | an uploaded HTML or PHP page |
| Landing | an uploaded page with variables, filled in from presets and the stream's own values |
| JavaScript from URL | fetches code from a partner endpoint; optional cache in minutes (stale copies are served while one background request refreshes them) |
| Send to campaign | hand over to another campaign |

Typical setup: an intercepting stream `Bot IS` → whitepage, regular streams by geo and
device → offers, default stream → whitepage or 404.

Integrations (Campaign → Integration): direct URL, a JS snippet for existing
pages, and a `tds.php` include for server-side use.

### Adding an action type

Actions live in [internal/engine/actions.go](internal/engine/actions.go). Call
`RegisterAction` with a type, its form fields and a `Build` function that turns
the stored config into a handler. The panel renders the form from the field
list; nothing else needs to change.

## Bot filtering

Passive, on every click, no added latency:

- IP lists: Googlebot, Bing, datacenters, VPNs, AWS, GCP, Oracle, Tor (open
  feeds, refreshed automatically), plus your own block and allow lists
- ASN sets for ad platforms and hosting providers
- User-Agent signatures (crawlers, link previewers, HTTP libraries, headless
  browsers, scanners), extendable
- header consistency (client hints, fetch metadata, Accept-* headers)
- TLS fingerprint consistency and JA3/JA4 blocklists
- optional external providers (any HTTP JSON API; presets for ip-api,
  ipinfo, IPQualityScore), cached per IP, fail-open

Per stream, optional **JS check**: an interstitial that inspects the browser
(webdriver, automation globals, WebGL renderer, platform/UA agreement, …) and
reloads. It costs one extra round trip on the first visit, works on direct
campaign URLs only, and a browser that fails is re-routed as a bot.

Geo data defaults to DB-IP Lite (no key needed). Set a MaxMind key to use
GeoLite2, or upload `.mmdb` files by hand.

Use Campaign → Simulator to see which stream a given IP / User-Agent would get
and which filter decided it.

After testing, the campaign owner can wipe what the tests left behind with
⋯ → **Clear statistics**: it deletes every click and conversion of that
campaign for good and makes its visitors unique again. The campaign itself is
not touched. To remove only certain visitors — your own test visits on a live
campaign, or a spammer — use ⋯ → **Delete data by IP** with a list of
addresses or CIDR ranges: their clicks go, together with the conversions of
those clicks.

### Suppressing sources

To keep a source out for good, add it under **Utilities → Suppress IPs**
(addresses and CIDR networks) or **Suppress referrers** (domains; a domain
covers its subdomains). A suppressed request never reaches a campaign: it gets
a 404, is not a click, does not use up uniqueness and shows in no report.

The lists are personal. An entry applies to every campaign its owner owns, or
only to the campaigns picked for it — any campaign the user may edit. Each
entry also says what is kept about the requests it refuses: a counter (the
default), the counter plus a request log (time, address, referrer, domain,
campaign, User-Agent), or nothing. Both follow the data retention period.

## Conversions

```
https://domain/postback?key=KEY&click_id={click_id}&type=sale&revenue=10&currency=USD&any=thing
```

- Built-in types: `lead, sale, install, registration, deposit, action, rejected`.
  A campaign with a funnel (below) also accepts its stage keys.
- Any other parameter is stored and shown as its own column in
  Conversions → Conversion log, filterable, and included in the CSV export.
- GET, form POST and flat JSON POST are accepted. The key may also be sent as
  an `X-TDS-Key` header.
- Conversions → Postback log lists every request the postback URL received and
  what became of it — accepted, duplicate, refused (with the reason) or not
  stored — with the parameters as they arrived. Filter it by result, key,
  campaign, type, click id, sender IP or any text. You see the requests made
  with your own keys; administrators also see those with an unknown key. Keys
  are cut to their first characters in the log, and it is kept as long as
  clicks are.

- Parameter names are not fixed. `click_id` is also read from `clickid`,
  `subid` and `cid`, `revenue` from `payout`, and Settings → Parameter names
  adds more for any of them (`key`, `type`, `outcome`, `currency`, `ip`, `sig`, `ts`, and
  on campaign URLs `keyword` and `sub1`–`sub5`) — for a network that can only
  send `sub_id=` or `status=`. A name added for `click_id`, `keyword` or a sub
  id works as a macro too: `{sub_id}`.

Keys are named, and each has its own rules:

| Rule | |
|---|---|
| Attribution | `click_id` — the postback carries the click id (ids are signed; a forged one is refused). `ip` — match the latest human click from `&ip=` (or the sender), for installers that do not know the click id. `none` — standalone event. |
| Require click | refuse postbacks that match no click |
| Dedupe | one conversion per click and type |
| Rate limit | per sender IP per minute |
| IP allowlist | only these senders |
| Signature | `sig = hex(HMAC-SHA256(secret, "k1=v1&k2=v2…"))` over all parameters except `sig`, sorted by name, plus a `ts` (unix seconds, ±10 min) |

A key embedded in an installer can be extracted, so for installs prefer `ip`
attribution with *require click* and *dedupe* on: a stolen key can then only
produce one install per real click.

### Multi-stage funnels

A campaign can define its own ordered stages (campaign → Funnel), for example
`lp_click → offer_click → registration → order → install → subscription`.
Each stage is a conversion whose `type` is the stage key, so attribution stays
what the key says: different keys, with different attribution, can feed the
same click.

- One stage is the **goal**. Only it counts as a conversion in reports (CR)
  and only it is charged the CPA cost; revenue is summed from every stage.
- Stages marked **browser event** need no key — the page reports them with the
  signed click id alone: `https://domain/_e/<stage>?cid=<click id>` (GET or
  beacon, any origin). They carry no revenue, are counted once per click and
  are accepted for 7 days after it. In a stream's content or URL the macro
  `{event:<stage>}` expands to that address for the visitor's own click.
- A stage can be split into **outcomes** — the ways it can end, each a
  success, a failure or neither: `send → sent | error`,
  `purchase → paid | declined`. The event is the same one with
  `&outcome=<key>` added (`…&type=send&outcome=error&reason=timeout`), so a
  failure stays inside its stage instead of becoming a step of its own, and
  is told apart from an event that never came: the funnel cuts the stage's bar
  into its outcomes and "no result". A click counts under one outcome — a
  successful one if it has any, otherwise the latest — so a retry that worked
  is not a failure. Without `outcome` the event only says the stage was
  started. An outcome key is by default **linked** to its stage: it is the
  stage key, `_` and a suffix (`install` → `install_ok`, `install_error`) and
  follows the stage key when that is renamed; the link button next to the key
  frees it. A key that names nothing else in the funnel can be sent as the
  type on its own — `&type=install_error`, `/_e/install_error`,
  `{event:install_error}`. Any other parameter (the error text, a code) is kept with the event
  and can be filtered in the conversion log. A failed outcome carries no
  revenue; on the goal stage only a successful outcome is the conversion once
  one is defined. Dedupe is per click, type and outcome. An outcome the stage
  does not define is refused and shows in the postback log. Browser events
  take `&outcome=` too and keep up to 8 short parameters.
- The Funnel tab and the stream editor build the URL of every stage and
  outcome: choose a conversion key there and copy the postbacks with the key
  already in place. Stages are reordered by dragging.
- **Funnel presets** (Funnels → Presets) are sets of stages you reuse. A
  preset is applied from a campaign's Funnel tab ("Presets") or picked when
  the campaign is created; the stages are copied, so the campaign's funnel
  stays its own and can be edited freely. The campaign remembers the preset
  it came from: when the preset's stages change later, its Funnel tab offers
  "Update from preset", which replaces the stages after a confirmation. A
  campaign's funnel can be saved as a new preset from the same menu. Presets
  are personal — only their owner sees and applies them — and deleting one
  leaves the campaigns copied from it as they are.
- The Funnel tab shows how many clicks of the period reached each stage,
  whenever the events arrived, in any order or strictly in order. Give keys a
  window long enough for the late stages.

## Whitepages

Upload a `.zip` (or a single `.html` / `.php`). Relative asset URLs keep
working on any campaign URL because a `<base>` tag is injected (switchable).
PHP pages get `$_SERVER['TDS_CLICK_ID']`, `TDS_COUNTRY`, `TDS_CITY`,
`TDS_DEVICE`, `TDS_OS`, `TDS_BROWSER`, `TDS_IS_BOT`, `TDS_CAMPAIGN`.

The PHP container has no internet access, cannot reach the databases, sees the
whitepage files read-only, and has process-spawning functions disabled. If a
page must call an external API, attach the `php` service to the `edge` network
in `docker-compose.yml`.

## Landings

A landing is uploaded like a whitepage and adds **variables**: write
`CRELLA_VAR_TITLE` anywhere in its files and `TITLE` becomes a variable of the
landing. The "Landing" stream action shows the page with the variables filled
in, so one landing serves many streams with different texts, links and
settings.

- **Where a value comes from.** The stream's own value, else the value of the
  preset the stream shows, else the variable's default (empty unless set).
  Values may contain macros: `Hello, {city}`.
- **Presets** are named sets of values kept with the landing: `prod` and
  `staging` settings, or the variants of an A/B test. A stream shows one
  preset, or splits its visitors between several by weight; the reports group
  by Landing and by Landing preset to compare them.
- **Kinds.** A variable's kind says where its value goes, and so how it is
  escaped: *Text* (HTML-escaped whole), *HTML* (markup as is, macro values
  escaped), *Link* (macro values URL-encoded), *JS string* (between the quotes
  of a script string), *Server only* (never written into a page). Visitor data
  arriving through a macro cannot inject markup unless the kind is HTML and
  the markup is yours.
- **PHP.** Every variable is in `$_SERVER['CRELLA_VAR_NAME']`, unescaped,
  next to `TDS_CLICK_ID`. PHP source is not rewritten before it runs; a token
  is replaced only in what the script prints. Keep secrets (a DSN, an API
  key) in *Server only* variables and read them from `$_SERVER`. The PHP
  container has no network by default (see Whitepages) — attach it to one if
  the page must reach a database.
- **Other pages.** The first page sets a signed cookie for the landing's
  path, valid for seven days; its other pages, and the scripts and styles
  that carry tokens, are rendered with the same click, preset and macros.
  Files without tokens stay plain cacheable assets. A page opened without
  the cookie gets the defaults and reports no events. The JS and PHP
  integrations deliver the first page only.
- **Funnel events.** `{event:<stage>}` in a value works as elsewhere. A
  stream can only show a landing whose values report stages its campaign
  accepts from a browser: saving the stream, or a preset used by one, is
  refused otherwise and names the variable and the stage.
- **Offer link.** Give the stream an offer URL and put `{offer}` into a link
  variable: the visitor goes to `/_a/<key>/_go` on the tracker domain, which
  records the chosen browser stage for the click and redirects to the offer.
- The panel edits text files in place, shows a sandboxed preview with any
  preset, and can copy a whitepage into a landing.

## Operations

- Data lives in the `data`, `whitepages`, `postgres` and `clickhouse` volumes.
- Click retention is set in Settings (ClickHouse TTL, default 180 days).
- Visitor uniqueness is tracked in memory and resets on restart.
- On Linux the published ports preserve the visitor's address. If you publish
  through something that NATs (Docker Desktop, some IPv6 setups), run the
  `tds` service with `network_mode: host` or put a PROXY-protocol balancer in
  front.

## Development

No image rebuilds while working on the code. Only the databases and the PHP
sandbox run in Docker; the server and the panel run from source.

```bash
go run ./dev
```

starts the dependencies ([dev/docker-compose.yml](dev/docker-compose.yml)),
builds and runs the server, and rebuilds and restarts it in about a second
whenever a `.go` file changes. Settings are in [dev/env](dev/env); a variable
set in your shell overrides the file for that run.

```bash
cd web && npm install && npm run dev
```

serves the panel at http://localhost:5173 with hot reload, forwarding API
calls to the dev server.

| | |
|---|---|
| Panel (hot reload) | http://localhost:5173 |
| Panel (as built into the binary) | http://127.0.0.1:18080 |
| Traffic | http://127.0.0.1:18081 — send a `Host:` header for the domain |
| Login | created on the setup page the first time the panel opens; use `admin` / `dev-password-123` |
| Data | `.dev/` and the `simple-tds-dev` Docker volumes |

Campaign links are tested with a host header, no DNS needed:

```bash
curl -i -H "Host: test.local" http://127.0.0.1:18081/<alias>
```

Run `go test ./...` for the unit tests. Build the real image
(`docker compose up -d --build`) only to check packaging.
