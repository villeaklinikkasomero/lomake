'use strict';
// Teema (vaalea / tumma) asetetaan ennen sivun piirtoa, jotta näyttö ei välähdä valkoisena.
// Valinta: 'auto' (seuraa laitteen asetusta), 'light' tai 'dark'; tallennetaan vain tähän selaimeen.
(function () {
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  function pref() { try { return localStorage.getItem('kr.theme') || 'auto'; } catch (e) { return 'auto'; } }
  function apply() {
    var p = pref(), dark = p === 'dark' || (p === 'auto' && mq.matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', dark ? '#1c1d21' : '#ffffff');
  }
  window.krTheme = {
    get: pref,
    set: function (v) { try { if (v === 'auto') localStorage.removeItem('kr.theme'); else localStorage.setItem('kr.theme', v); } catch (e) { /* ohitetaan */ } apply(); },
  };
  if (mq.addEventListener) mq.addEventListener('change', apply); else if (mq.addListener) mq.addListener(apply);
  apply();
})();
