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

## Conversions

```
https://domain/postback?key=KEY&click_id={click_id}&type=sale&revenue=10&currency=USD&any=thing
```

- Built-in types: `lead, sale, install, registration, deposit, action, rejected`.
  A campaign with a funnel (below) also accepts its stage keys.
- Any other parameter is stored and shown as its own column in
  Conversions → Log, filterable, and included in the CSV export.
- GET, form POST and flat JSON POST are accepted. The key may also be sent as
  an `X-TDS-Key` header.

- Parameter names are not fixed. `click_id` is also read from `clickid`,
  `subid` and `cid`, `revenue` from `payout`, and Settings → Parameter names
  adds more for any of them (`key`, `type`, `currency`, `ip`, `sig`, `ts`, and
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
- The Funnel tab and the stream editor build the URL of every stage: choose a
  conversion key there and copy the postbacks with the key already in place.
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
