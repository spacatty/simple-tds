<?php
// The second page: found through the landing cookie, so it gets the same
// click id, preset and variables as index.php.
$clickId = $_SERVER['TDS_CLICK_ID'] ?? '';
$apiKey  = $_SERVER['CRELLA_VAR_API_KEY'] ?? '';
$name    = trim((string)($_GET['name'] ?? ''));
$phone   = trim((string)($_GET['phone'] ?? ''));
$h = fn($s) => htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8');

// A real page would send the lead to a CRM here, signed with $apiKey.
$orderNo = strtoupper(substr(md5($clickId . $name . $phone), 0, 8));
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
<?php if ($name === '' || $phone === ''): ?>
  <h1>Something is missing</h1>
  <p class="lead">Please fill in your name and phone.</p>
  <p class="small"><a href="index.php">Back</a></p>
<?php else: ?>
  <h1>Thank you, <?= $h($name) ?>!</h1>
  <p class="lead">CRELLA_VAR_THANKS_TEXT</p>
  <table class="debug">
    <caption>Order</caption>
    <tr><th>Number</th><td><?= $h($orderNo) ?></td></tr>
    <tr><th>Phone</th><td><?= $h($phone) ?></td></tr>
    <tr><th>Click id</th><td><?= $h($clickId !== '' ? $clickId : '(none)') ?></td></tr>
    <tr><th>API key (server only)</th><td><?= $apiKey !== '' ? 'set' : 'not set' ?></td></tr>
  </table>
  <p class="small"><a href="CRELLA_VAR_OFFER_URL">Continue to the offer</a></p>
<?php endif ?>
</main>
</body>
</html>
