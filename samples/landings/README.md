# Sample landings

Two archives to upload on the Landings page. After the upload, set each
variable's kind and default as below.

## html-landing.zip

`index.html`, `details.html`, `css/style.css`, `js/app.js` — the stylesheet and
the script carry tokens, so they are rendered per visitor.

| Variable | Kind | Example value |
|---|---|---|
| `TITLE` | Text | `Free delivery to {city}` |
| `SUBTITLE` | Text | `Today only for visitors from {country}` |
| `BADGE` | Text | `-50%` |
| `FEATURES_HTML` | HTML | `<ul><li>Fast</li><li>Works on <b>{os}</b></li></ul>` |
| `TIMER_SECONDS` | Text | `300` |
| `CTA_URL` | Link | `{offer}` (with an offer URL on the stream) or `https://example.com/?sub={click_id}` |
| `CTA_TEXT` | Text | `Get it now` |
| `ACCENT_COLOR` | Text | `#22c55e` |
| `GREETING_JS` | JS string | `Hi from {city}, it's "quoted" </script>` |

## php-landing.zip

`index.php`, `order.php`, `assets/style.css` (no tokens: a plain asset).

| Variable | Kind | Example value |
|---|---|---|
| `HEADLINE` | Text | `Smart watch X200` |
| `DESCRIPTION` | Text | `Ships to {city} in two days` |
| `OLD_PRICE` | Text | `$99` |
| `PRICE` | Text | `$49` |
| `BUTTON_TEXT` | Text | `Order now` |
| `OFFER_URL` | Link | `{offer}` |
| `THANKS_TEXT` | Text | `We will call you back within 15 minutes.` |
| `STOCK` | Server only | `5` |
| `API_KEY` | Server only | `test-key-123` |

`STOCK` and `API_KEY` are read from `$_SERVER` and never written into the page:
the debug table shows only whether the key is set.

## What to check

- Two presets with different `PRICE` / `ACCENT_COLOR`, split by weight in a stream.
- A stream value overriding one variable.
- The second page (`details.html`, `order.php`) keeps the click and the preset;
  opened directly without the cookie it shows the defaults.
- `GREETING_JS` with quotes and `</script>` does not break the page.
- `{offer}` in the link variable goes through `/_a/<key>/_go` and reports the stage.
