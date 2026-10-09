<?php
// Every variable arrives unescaped in $_SERVER under its token name, next to
// the click id. Server-only variables exist nowhere else.
$clickId = $_SERVER['TDS_CLICK_ID'] ?? '';
$apiKey  = $_SERVER['CRELLA_VAR_API_KEY'] ?? '';
$stock   = (int)($_SERVER['CRELLA_VAR_STOCK'] ?? 0);
if ($stock <= 0) {
    $stock = 7;
}
$h = fn($s) => htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8');
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CRELLA_VAR_HEADLINE</title>
<link rel="stylesheet" href="assets/style.css">
</head>
<body>
<main class="card">
  <h1>CRELLA_VAR_HEADLINE</h1>
  <p class="lead">CRELLA_VAR_DESCRIPTION</p>

  <p class="price">
    <s>CRELLA_VAR_OLD_PRICE</s>
    <b>CRELLA_VAR_PRICE</b>
  </p>
  <p class="stock">Only <?= $stock ?> left in stock</p>

  <form action="order.php" method="get">
    <input name="name" placeholder="Your name" required>
    <input name="phone" placeholder="Phone" required>
    <button type="submit">CRELLA_VAR_BUTTON_TEXT</button>
  </form>

  <p class="small">or <a href="CRELLA_VAR_OFFER_URL">go straight to the offer</a></p>

  <table class="debug">
    <caption>Seen by PHP</caption>
    <tr><th>PHP</th><td><?= $h(PHP_VERSION) ?></td></tr>
    <tr><th>Click id</th><td><?= $h($clickId !== '' ? $clickId : '(none)') ?></td></tr>
    <tr><th>API key (server only)</th><td><?= $apiKey !== '' ? 'set, ' . strlen($apiKey) . ' chars' : 'not set' ?></td></tr>
    <tr><th>Stock (from $_SERVER)</th><td><?= $stock ?></td></tr>
  </table>
</main>
</body>
</html>
