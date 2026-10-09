// This script carries a token too. GREETING_JS is a "JS string" variable:
// its value is escaped to sit between the quotes.
var greeting = 'CRELLA_VAR_GREETING_JS';

document.getElementById('greeting').textContent = greeting;

(function () {
  var el = document.getElementById('timer');
  var left = parseInt(el.getAttribute('data-seconds'), 10);
  if (!(left > 0)) left = 300;
  function tick() {
    var m = Math.floor(left / 60), s = left % 60;
    el.textContent = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    if (left > 0) left--;
  }
  tick();
  setInterval(tick, 1000);
})();
