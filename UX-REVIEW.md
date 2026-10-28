# Crella (simple-tds) — product and UX review

Date: 2026-10-27. Based on reading the code (`web/src`, `internal/`), the README, and a walkthrough of the running panel on the dev stack (desktop and phone viewports, dark theme), with the seeded demo data.

**Status (2026-10-28):** Part 1 is implemented (commits `fa260bb`…`4558bb7`). Two items were scoped down and remain open decisions: geo presets are still shared and admin-managed (now on their own page, readable by everyone), and Breakdown and Top lists are linked both ways rather than merged into one page. Parts 2 and 3 are not started.

## Verdict in three sentences

The engine is genuinely good: in-memory click path, ClickHouse reports, filters-in-URL, test campaigns, funnels with outcomes, domain health and reputation, 2FA, sharing. The panel is above the bar for a self-hosted tool, and the **streams view of a campaign is the best screen in the product**. What keeps it from being sold as a tracker is not polish but *shape*: it is a cloaker/TDS first and a tracker second, with no traffic-source, offer or network model, no programmatic surface (API tokens, outgoing postbacks, alerts), and a panel that hides its depth behind one-place-only entry points.

## What is strong (keep, and put on the sales page)

- Click path never touches a database; swap-in snapshot; batched ClickHouse writes.
- Stream funnel page: three lanes, filters as a sentence, quick action switch, per-stream figures, copy/paste between campaigns.
- One filter grammar in the URL across reports, logs and drill-downs; every number links to the clicks behind it.
- Test campaigns with pre-issued click ids and sync from source. No other tracker in this class has this.
- Multi-stage funnels with outcomes, browser events, funnel presets.
- Domains: health tiles, bulk bar, ACME with journal, blocklist reputation (Safe Browsing, VirusTotal, Spamhaus, SURBL, URIBL, CF/Quad9).
- Postback log with refusal reasons; suppress rules that hide a source retroactively.
- Anti-bot stack: IP feeds, ASN sets, UA signatures, header consistency, JA3/JA4, JS challenge, external providers, PHP whitepages in a sandbox.
- Multi-user with group shares, TOTP, login rate limit, personal dashboards, EN/RU.

## Part 1 — UX: fix first (cheap, high impact)

Each item is something a buyer hits in the first hour.

1. **Campaign sections are hidden in a dropdown.** Eight sections (Streams, Settings, Link, Funnel, Integration, Sharing, Simulator, Test) sit behind one "Streams ▾" button (`web/src/pages/CampaignEditor.tsx:563-592`). Nobody discovers Integration or Simulator this way. Show them as tabs under the header; keep the dropdown only on phones.
2. **Unsaved work is lost silently.** The only dirty guard is on the Settings tab (`CampaignEditor.tsx:405-412`). Funnel stage edits, domain edit, IP list, integration, whitepage edit, funnel-preset drawer all drop typed input on Escape, overlay click or sidebar navigation. Make `Modal`/`Drawer` take a `dirty` flag and confirm, and block in-app navigation with a router guard.
3. **Enter on a confirm dialog deletes.** The destructive button has `autoFocus` (`web/src/components/ui.tsx:125`). Focus Cancel by default; for irreversible actions (Clear statistics, Delete campaign, Delete data by IP, delete domain) require typing the name.
4. **One click pauses a live campaign** (row toggle, no confirm, campaign answers 404 at once). Same for stream toggles. Either confirm when the campaign had traffic in the last hour, or add an undo toast.
5. **No undo anywhere.** Toasts have no action slot (`ui.tsx:12-16`). "Paste settings" overwrites a stream without confirm (`StreamFunnel.tsx:215-219`); widget remove, suppress rule remove, stage remove, sharing "Remove access" have no confirm. An undo toast (5 s, reverts via the API) fixes all of these at once.
6. **Period defaults disagree and are not persisted.** Dashboard, campaigns and logs open on *Today*; Breakdown opens on *Last 7 days*; Referrer activity uses its own lookback control. The chosen range lives in a module variable (`DateRangePicker.tsx:63-83`), so a reload resets it. Put the range in the URL on every page (it already is on links between pages) and remember the last choice per account.
7. **Streams: drag only.** Reorder is HTML5 drag armed on mousedown (`StreamFunnel.tsx:617-631`): no keyboard, no touch, no up/down buttons (Stages and Boards have them). Streams cannot be dragged between lanes; the kind is changed in the editor. No bulk enable/disable/delete, no search across streams.
8. **Phone layout of the streams page is broken.** The stream row is a fixed 4-column grid (`styles.css:6800-6810`); on 375 px the filter chips render one letter per line (seen in the walkthrough). Give `.frow` a stacked layout under 700 px. The campaigns list and reports survive on a phone; this page does not.
9. **Navigation structure.** "Conversions" group holds only Keys while the conversion and postback logs sit under "Tracking"; Users is hidden in the profile menu while Settings is in the tree; Geo presets live inside Anti-bot and are admin-only, so a regular user cannot manage the presets their country filters use (`Antibot.tsx:34`); the Status page links "Geo database settings" to `/settings`, where they are not (`Status.tsx:89`); the add-domains notice says "watch the Status column" on a page that has cards (`Domains.tsx:502`).
10. **Reports duplicate each other.** Breakdown and Top lists are two UIs over one query; only Top lists can save presets and pin them; the Dashboard "Report" links go to Breakdown. Merge into one report page with a "rank" mode, and let any view be saved and pinned.
11. **Click log is poorer than the conversion log.** No CSV, no column chooser, no sorting (`Clicks.tsx:179-189`), while Conversions has all three.
12. **Four stream-figure styles** are exposed as a user preference (`streamStats.ts`, "the style being compared"). Pick one and remove the switch.
13. **Three KPI styles** (StatBar, Dashboard score blocks, `.kpis` in StreamStats) and money in StreamStats without the campaign currency (`StreamStats.tsx:58-60`). One `Kpi` component.
14. **Accessibility.** Around 60 icon buttons rely on `title` only; table toggles have no accessible name; the section dropdown has `role="tablist"` with menu items; Dashboard tabs have no tabpanel or arrow keys. A buyer with a screen reader is rare, but keyboard users are not.
15. **Theme toggle has no "system"** option once touched (`hooks.ts:161-170`). Dark tokens are duplicated in two CSS blocks (`styles.css:59-112` and `114+`): a drift risk.

## Part 2 — UX: what makes it feel like a product

- **First-run checklist.** A fresh install lands on an empty dashboard with zero guidance. Add a dismissible checklist on the Dashboard: add a domain → wait for OK → create a campaign → point a stream at an offer → open the test link → send a test postback → see the conversion. Each step links to the exact screen and ticks itself off from real data.
- **Global search (Ctrl+K).** Campaigns, streams, domains, keys, landings, and a click id or IP pasted straight in opens the log. The campaign switcher in the editor already has the fuzzy logic; lift it.
- **Compare with the previous period** on Dashboard scores and report rows (▲12% vs last 7 days). Every competitor shows this.
- **Multi-level grouping in Breakdown** (campaign → country → device) with expandable rows, a column chooser, page size, and saved column sets. Today one dimension per report, drill only through filters.
- **A notifications bell** in the panel fed by what the server already knows: certificate failing, domain flagged by a blocklist, domain unreachable, dropped clicks, postbacks refused in a burst, a campaign with zero traffic for N hours. (Outbound delivery is in Part 3.)
- **Simulator inside the stream editor.** "Test with: IP / UA / country" right in the drawer, showing which filter matched. Today the simulator is a separate section reachable from the dropdown and from the click log only.
- **Keyboard**: Ctrl+S in every editor, `?` for shortcuts, `g c` style jumps.
- **Live mode** as a page-level switch everywhere a table shows recent data, not only the Dashboard.
- **Bulk operations** on campaigns (pause, move to group, delete), streams, suppress rules, keys. Domains already has the right pattern (select-all + bulk bar); reuse it.
- **Inline empty states with a call to action** on every list: "No landings yet — upload a zip or copy a whitepage."

## Part 3 — Features needed to sell it as a tracker

Compared against what buyers of Keitaro, Binom, Voluum, RedTrack and Bemob take for granted.

### Tier 1: without these it is a TDS, not a tracker

| Gap | Why it blocks a sale | Shape of the fix |
|---|---|---|
| **Traffic sources** entity | A buyer's first question is "where is the Facebook source?" Today sub1–sub5 and keyword are the only slots; everything else goes into a JSON blob. | Source = name, parameter template (`utm_campaign={campaign}`, `fbclid`, external ids), cost parameter, postback-to-source URL template. A campaign picks a source; reports group by source. |
| **Offers and affiliate networks** | Offers are bare URLs inside a redirect action. No payout, no network, no offer-level report, no "rotate between 3 offers". | Offer = URL, network, payout type/value, geo caps, status. Network = postback template, click-id param name. A stream picks offers with weights; reports get `offer` and `network` dimensions. |
| **Cost beyond a fixed campaign value** | CPC/CPM/CPA/revshare per campaign only (`process.go:276-286`). No `{cost}` from the URL, no per-source cost, no retroactive "update cost for 2026-10-20". | Cost from a URL parameter, cost per source/sub, manual cost update by period, then API import (FB Ads, Google Ads, TikTok). |
| **Outgoing postbacks** | Nothing sends conversions out. No S2S to the traffic source, no Facebook CAPI, TikTok Events, Google offline conversions. | Per-source postback template fired on goal (and optionally each stage), with retry and a log like the inbound one. CAPI/TikTok as built-in templates. |
| **API tokens and a documented API** | Session cookie + CSRF header only (`api.go:152-168`). Agencies automate everything. | Personal tokens with scopes, `Authorization: Bearer`, OpenAPI spec served from the panel, campaign export/import as JSON. |
| **Report depth** | One dimension per report; no ASN, OS version, browser version, weekday, hour-of-day, integration or `param:` dimensions; no CSV for clicks or breakdown rows. | Multi-level grouping, the missing dimensions (the columns already exist in ClickHouse), CSV everywhere, scheduled email export later. |
| **Account timezone and default currency** | `tz` is a query param that the panel sets from the browser; revenue in different currencies is summed as one number (`postback.go:257-260`). | Timezone and currency on the account, FX table (manual or ECB daily), per-currency totals. |
| **Alerts out of the box** | No Telegram, email, Slack or webhook anywhere. | Channels on the account; rules for the events in Part 2's bell. Telegram alone covers most of this market. |
| **Missing filters** | No time of day / weekday schedule, no OS or browser version, no connection type / carrier, no daily click cap or budget per stream, no frequency cap. | Add as `FilterDef`s (the panel builds the UI); caps need a counter in the snapshot. |

### Tier 2: expected by this audience, and your differentiators

- **Landing page CTR** as a built-in metric (click-to-offer), not only through `{offer}` on a landing variable. Needed for the LP → offer workflow every media buyer runs.
- **Auto-optimisation** of weighted streams and landing presets (bandit on CR or EPC) with a "lock weights" switch. Weighted rotation and `landing_preset` reports already exist, so this is a small step.
- **Bot analytics page**: bot share over time, reasons breakdown, top blocked ASNs/UAs, "what the whitepage was shown to". The data is there (`bot_reason` dimension); it needs a screen and a selling story.
- **Visitor identity across restarts.** Uniqueness is in memory and resets on restart (README, Operations). A buyer running many instances will call this a bug. Persist it (ClickHouse lookup with a cache, or a cookie-based visitor id).
- **Audit log** (who changed what, when). You have multi-user sharing; teams will ask for this on day one.
- **Backup and restore** command (`tds backup` → pg dump + ClickHouse export to one archive) and a documented upgrade path.
- **Rate limiting on the public click path** (per IP burst) so a flood cannot fill the write queue; today only login and postbacks are limited.
- **Latency and click-loss**: redirect time p50/p95 and dropped-click counters on the Status page and as an alert.
- **Readable campaign paths** in addition to the random alias (`/black-friday`), with a uniqueness check per domain.
- **Google Ads / Facebook policy modes**: a named preset per platform ("Meta review" = these ASNs, UAs, header checks, JS check on) so the buyer does not assemble it by hand. All ingredients exist.

### Tier 3: go-to-market and operations

- A **demo instance** with seeded data (you already have a seed) and a public screenshot tour; the streams page sells itself.
- Docs site built from the README (it is already good), split by task: install, domains, first campaign, postbacks, funnels, cloaking.
- Versioned releases with a changelog, one-line install script, `tds update`.
- Licensing hook (self-hosted key check or a cloud tier) and a pricing page; decide the name (the panel says Crella, the repo says simple-tds).
- Support channel (Telegram group) and a status/uptime page for the cloud tier if you offer one.

## Suggested order

1. **Two to three weeks of panel work** (Part 1 items 1–13, the first-run checklist, click-log CSV/columns, API tokens). Nothing here needs schema work except tokens, and it removes every "feels unfinished" moment.
2. **Tracker model** (sources, offers/networks, cost, outgoing postbacks, alerts). This is the release that makes it sellable as a tracker; plan the data model once, since reports, filters and macros all hang off it.
3. **Depth** (multi-level reports, timezone/currency, audit log, auto-optimisation, bot analytics, backups, visitor persistence).

## Small leftovers worth cleaning in passing

- `Domains.tsx:119` comment refers to a table that no longer exists; `Domains.tsx:502` "Status column".
- `Antibot.tsx:941` spacer `<div style={{height: 220}} />` in the geo preset editor.
- Settings validation silently resets out-of-range values to defaults (`api_data.go:617-625`); say so in the UI.
- `{offer}`, `clickid`, `subid` resolve as macros but are missing from the advertised list (`actions.go:124`).
- No `GET /api/<resource>/{id}`; the panel loads full lists everywhere, which will hurt at a few thousand campaigns or domains.
