// Scales a published SiteSlides page down to fit narrow screens.
// Published pages load this file; their security policy blocks every other script.
// Keep in sync with FIT_SCRIPT in app.js.
(function () {
  var v = document.querySelector('.site-viewport');
  var p = document.querySelector('.site-page');
  if (!v || !p) return;
  function f() {
    var w = document.documentElement.clientWidth;
    if (!w) return;
    var s = Math.min(1, w / 1200);
    p.style.transform = s < 1 ? 'scale(' + s + ')' : '';
    p.style.marginLeft = s < 1 ? '0' : '';
    v.style.height = (p.offsetHeight * s) + 'px';
  }
  window.addEventListener('resize', f);
  window.addEventListener('load', f);
  f();
})();
