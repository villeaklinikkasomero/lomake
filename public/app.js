/* Kohtaamisten raportointi – käyttöliittymä (ei build-vaihetta, ei ulkoisia kirjastoja) */
'use strict';

// ---------------------------------------------------------------------------
// Apurit
// ---------------------------------------------------------------------------
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'required') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const $app = document.getElementById('app');
const fmtDate = (s) => { if (!s) return ''; const [y, m, d] = s.slice(0, 10).split('-'); return `${+d}.${+m}.${y}`; };
const fmtDateTime = (s) => { if (!s) return ''; const d = new Date(s.replace(' ', 'T') + 'Z');
  return d.toLocaleString('fi-FI', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const fmtNum = (n) => Number(n || 0).toLocaleString('fi-FI');
const typeLabel = (t) => (t === 'ryhma' ? 'Ryhmä' : 'Yksi kohtaaminen');
const DIGITAL_LOCATION = 'Digialustalla';
const VOLUNTEER = 'vapaaehtoinen';
const APPLIES = { kaikki: 'Kaikki kirjaukset', yksilo: 'Vain yksilökohtaamiset', ryhma: 'Vain ryhmät' };
const QTYPES = { text: 'Lyhyt teksti', textarea: 'Pitkä teksti', number: 'Luku', choice: 'Valinta (yksi)', multichoice: 'Valinta (useita)', rating: 'Arvio 1–5', date: 'Päivämäärä' };

let toastTimer;
function toast(msg, isErr) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'toast'; }, 3500);
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'kohtaamiset' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* ei JSONia */ }
  if (res.status === 401 && !path.startsWith('/login')) { state.me = null; go('#/kirjaudu'); throw new Error((data && data.error) || 'Kirjaudu sisään.'); }
  if (!res.ok) throw new Error((data && data.error) || 'Toiminto epäonnistui.');
  return data;
}

// Sama tunnistetietotarkistus kuin palvelimella (varoitus jo kirjoittaessa).
const SENSITIVE = [
  { re: /\b\d{6}[-+A-FU-Y]\d{3}[0-9A-FHJ-NPR-Y]\b/i, what: 'henkilötunnukselta' },
  { re: /[^\s@]+@[^\s@]+\.[a-z]{2,}/i, what: 'sähköpostiosoitteelta' },
  { re: /(\+358|\b0)\s?\d{1,3}[\s-]?\d{3}[\s-]?\d{3,4}\b/, what: 'puhelinnumerolta' },
];
const sensitiveHit = (t) => { for (const p of SENSITIVE) if (p.re.test(t)) return p.what; return null; };

// ---------------------------------------------------------------------------
// Tila ja reititys
// ---------------------------------------------------------------------------
const state = { me: null, form: null };
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

async function loadMe() {
  try { state.me = await api('/me'); } catch { state.me = null; }
  return state.me;
}

const ROUTES = [
  { re: /^#\/kirjaudu$/, view: viewLogin, public: true },
  { re: /^#\/salasana$/, view: viewPassword },
  { re: /^#\/kirjaa$/, view: viewRecord },
  { re: /^#\/kirjaukset$/, view: viewList, perm: (p) => p.viewScope !== 'none' },
  { re: /^#\/kirjaukset\/([\w-]+)$/, view: viewDetail, perm: (p) => p.viewScope !== 'none' },
  { re: /^#\/kirjaukset\/([\w-]+)\/muokkaa$/, view: viewEdit, perm: (p) => p.editScope !== 'none' },
  { re: /^#\/vienti$/, view: viewExport, perm: (p) => p.exportScope !== 'none' },
  { re: /^#\/tyontekijat$/, view: viewStaff, perm: (p) => p.staffScope !== 'none' },
  { re: /^#\/asiakaspolut$/, view: viewPaths, perm: (p) => p.pathScope !== 'none' },
  { re: /^#\/tilastot$/, view: viewDashboard, perm: (p) => p.dashScope !== 'none' },
  { re: /^#\/hallinta\/ohjauspalvelut$/, view: viewServices, perm: (p) => p.manageQuestions },
  { re: /^#\/tyontekijat\/(\d+)$/, view: viewStaffDetail, perm: (p) => p.staffScope !== 'none' },
  { re: /^#\/hallinta\/kayttajat$/, view: viewUsers, perm: (p) => p.manageUsers },
  { re: /^#\/hallinta\/hankkeet$/, view: viewProjects, perm: (p) => p.manageProjects },
  { re: /^#\/hallinta\/kysymykset$/, view: viewQuestions, perm: (p) => p.manageQuestions },
  { re: /^#\/hallinta\/loki$/, view: viewAudit, perm: (p) => p.manageUsers },
  { re: /^#\/hallinta\/testidata$/, view: viewDemo, perm: (p) => p.manageUsers },
  { re: /^#\/hallinta\/toiminnot$/, view: viewFeatures, perm: (p) => p.manageUsers },
];

async function route() {
  // Microsoft-kirjautumisen virhe palaa muodossa #/kirjaudu?virhe=...
  if (location.hash.startsWith('#/kirjaudu?')) {
    state.loginError = new URLSearchParams(location.hash.split('?')[1]).get('virhe');
    history.replaceState(null, '', '#/kirjaudu');
  }
  const hash = location.hash || '#/kirjaa';
  if (!state.me && hash !== '#/kirjaudu') await loadMe();
  if (!state.me && hash !== '#/kirjaudu') return go('#/kirjaudu');
  if (state.me && state.me.user.mustChangePassword && hash !== '#/salasana') return go('#/salasana');
  const r = ROUTES.find(x => x.re.test(hash));
  if (!r) return go('#/kirjaa');
  if (r.perm && !r.perm(state.me.permissions)) return go('#/kirjaa');
  renderNav(hash);
  $app.classList.toggle('container', hash !== '#/kirjaudu');
  $app.replaceChildren(h('div', { class: 'loading' }, 'Ladataan…'));
  try { await r.view(...hash.match(r.re).slice(1)); }
  catch (e) { $app.replaceChildren(h('div', { class: 'notice err' }, e.message)); }
  $app.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// Kuvakkeet (yksinkertaiset viivakuvakkeet, currentColor)
const ICONS = {
  plus: 'M12 5v14M5 12h14',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  users: 'M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20M9 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM22 20v-1.5a4 4 0 0 0-3-3.87M16 3.63a3.5 3.5 0 0 1 0 6.75',
  route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 15V9a4 4 0 0 1 4-4h6M18 9v6a4 4 0 0 1-4 4H8',
  download: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  settings: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  logout: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l-5-5 5-5M5 12h11',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6L6 18',
};
function icon(name, size = 20) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]); svg.append(path); return svg;
}

function renderNav(hash) {
  const bar = document.getElementById('topbar');
  const nav = document.getElementById('nav');
  if (!state.me || hash === '#/kirjaudu') { bar.hidden = true; document.body.classList.remove('has-nav'); return; }
  bar.hidden = false; document.body.classList.add('has-nav');
  const p = state.me.permissions;
  const isActive = (href, prefix) => hash === href || (prefix && hash.startsWith(prefix));
  const link = (href, text, ic, prefix) => h('a', { href, class: 'nav-link' + (isActive(href, prefix) ? ' active' : ''), 'aria-current': isActive(href, prefix) ? 'page' : null },
    icon(ic), h('span', null, text));
  const group = (title, items) => { const it = items.filter(Boolean); return it.length ? h('div', { class: 'nav-group' }, h('span', { class: 'nav-heading' }, title), it) : null; };
  const u = state.me.user;
  const initials = u.name.split(/\s+/).map(x => x[0]).slice(0, 2).join('').toUpperCase();
  nav.replaceChildren(...[
    h('a', { href: '#/kirjaa', class: 'nav-cta' + (hash === '#/kirjaa' ? ' active' : '') }, icon('plus'), h('span', null, 'Uusi kirjaus')),
    group('Kirjaukset', [
      p.viewScope !== 'none' ? link('#/kirjaukset', p.viewScope === 'own' ? 'Omat kirjaukset' : 'Kirjaukset', 'list', '#/kirjaukset') : null,
    ]),
    group('Seuranta', [
      p.dashScope !== 'none' ? link('#/tilastot', 'Tilastot', 'chart') : null,
      p.staffScope !== 'none' ? link('#/tyontekijat', 'Työntekijät', 'users', '#/tyontekijat') : null,
      p.pathScope !== 'none' ? link('#/asiakaspolut', 'Asiakaspolut', 'route') : null,
      p.exportScope !== 'none' ? link('#/vienti', 'Excel-vienti', 'download') : null,
    ]),
    group('Ylläpito', [p.manageQuestions ? link('#/hallinta/kysymykset', 'Hallinta', 'settings', '#/hallinta') : null]),
    h('div', { class: 'nav-user' },
      h(u.authMethod === 'entra' ? 'div' : 'a', u.authMethod === 'entra' ? { class: 'who', title: 'Kirjautunut Microsoft-tunnuksella' } : { href: '#/salasana', class: 'who' + (hash === '#/salasana' ? ' active' : ''), title: 'Vaihda salasana' },
        h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials), h('span', { class: 'who-text' }, h('strong', null, u.name), h('small', null, u.roleLabel))),
      h('button', { type: 'button', class: 'nav-logout', onclick: logout }, icon('logout'), h('span', null, 'Kirjaudu ulos'))),
  ].filter(Boolean));
  nav.classList.remove('open');
  const t = document.getElementById('menuToggle');
  t.setAttribute('aria-expanded', 'false'); t.replaceChildren(icon('menu', 22), h('span', { class: 'sr-only' }, 'Valikko'));
}
document.getElementById('menuToggle').addEventListener('click', (e) => {
  const nav = document.getElementById('nav'); const open = nav.classList.toggle('open');
  e.currentTarget.setAttribute('aria-expanded', open);
  e.currentTarget.replaceChildren(icon(open ? 'close' : 'menu', 22), h('span', { class: 'sr-only' }, open ? 'Sulje valikko' : 'Valikko'));
});

async function logout() {
  try { await api('/logout', { method: 'POST' }); } catch { /* ohitetaan */ }
  state.me = null; state.form = null; go('#/kirjaudu');
}

// ---------------------------------------------------------------------------
// Kirjautuminen ja salasana
// ---------------------------------------------------------------------------
async function viewLogin() {
  document.getElementById('topbar').hidden = true;
  let cfg = { entra: false };
  try { cfg = await api('/auth/config'); } catch { /* oletus: vain salasana */ }
  const panel = h('div');
  const mark = () => { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 554 437');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', '/brand/tunnus.svg#tunnus'); svg.append(use); return svg; };
  $app.replaceChildren(h('div', { class: 'login-wrap' },
    h('div', { class: 'login-brand' },
      h('div', { class: 'login-mark', 'aria-hidden': 'true' }, mark()),
      h('div', null, h('p', { class: 'login-org' }, 'A-klinikkasäätiö'), h('p', { class: 'login-claim' }, 'Kohtaamisten raportointi'))),
    h('div', { class: 'login' }, panel)));
  $app.classList.remove('container');
  const done = async () => { await loadMe(); state.form = null; go('#/kirjaa'); };

  // 1. vaihe: kirjautumistavan valinta / sähköposti ja salasana
  function drawStart(message) {
    const err = h('div', { class: 'notice err', hidden: !message, role: 'alert' }, message || '');
    const email = h('input', { type: 'email', id: 'email', autocomplete: 'username', required: true });
    const pw = h('input', { type: 'password', id: 'password', autocomplete: 'current-password', required: true });
    const btn = h('button', { class: 'btn btn-lg ' + (cfg.entra ? 'btn-secondary' : 'btn-primary'), type: 'submit' }, 'Kirjaudu');
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault(); err.hidden = true; btn.disabled = true;
      try {
        const r = await api('/login', { method: 'POST', body: { email: email.value, password: pw.value } });
        if (r.mfa) drawMfa(r, email.value); else await done();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; pw.value = ''; pw.focus(); }
      finally { btn.disabled = false; }
    } },
      h('div', { class: 'field' }, h('label', { for: 'email' }, 'Sähköposti'), email),
      h('div', { class: 'field' }, h('label', { for: 'password' }, 'Salasana'), pw),
      btn);
    panel.replaceChildren(...[
      h('h1', null, 'Kirjaudu sisään'),
      h('p', { class: 'muted' }, 'Hankkeiden yhteinen kohtaamisten kirjaus ja seuranta.'),
      err,
      cfg.entra ? [
        h('div', { class: 'login-method' },
          h('h2', null, 'A-klinikkasäätiön työntekijät'),
          h('a', { class: 'btn btn-primary btn-lg btn-ms', href: '/auth/entra' }, msLogo(), h('span', null, 'Kirjaudu Microsoft-tunnuksella'))),
        h('div', { class: 'login-divider', role: 'separator' }, h('span', null, 'tai')),
        h('div', { class: 'login-method' }, h('h2', null, 'Tuntityöntekijät ja muut'),
          h('p', { class: 'small muted' }, 'Sähköposti, salasana ja todennussovelluksen koodi.'), form),
      ] : form,
      h('p', { class: 'small muted login-help' }, 'Tunnukset saat hankkeesi tiiminvetäjältä tai pääkäyttäjältä.')].flat());
    (cfg.entra ? panel.querySelector('.btn-ms') : email).focus();
  }

  // 2. vaihe: todennussovelluksen koodi (ensimmäisellä kerralla käyttöönotto)
  function drawMfa(r, account) {
    const err = h('div', { class: 'notice err', hidden: true, role: 'alert' });
    const code = h('input', { type: 'text', id: 'mfa-code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9 ]*', maxlength: '7',
      class: 'input-narrow mono code-input', required: true, 'aria-describedby': 'mfa-help' });
    const btn = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, r.mfa === 'setup' ? 'Ota käyttöön ja kirjaudu' : 'Kirjaudu');
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault(); err.hidden = true; btn.disabled = true;
      try { await api('/login/mfa', { method: 'POST', body: { code: code.value } }); await done(); }
      catch (ex) {
        err.textContent = ex.message; err.hidden = false; code.value = ''; code.focus();
        if (/alusta|vanheni/.test(ex.message)) setTimeout(() => drawStart(ex.message), 1500);
      } finally { btn.disabled = false; }
    } },
      h('div', { class: 'field' }, h('label', { for: 'mfa-code' }, '6-numeroinen koodi'), code,
        h('p', { class: 'help help-below', id: 'mfa-help' }, 'Koodi vaihtuu 30 sekunnin välein.')),
      err, btn,
      h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => drawStart() }, 'Peruuta'));
    panel.replaceChildren(...(r.mfa === 'setup' ? [
      h('h1', null, 'Ota kaksivaiheinen tunnistautuminen käyttöön'),
      h('p', { class: 'muted' }, 'Tunnuksesi suojataan salasanan lisäksi puhelimen todennussovelluksella. Tämä tehdään vain kerran.'),
      h('ol', { class: 'mfa-steps' },
        h('li', null, 'Asenna puhelimeen todennussovellus, esim. ', h('strong', null, 'Microsoft Authenticator'), ' tai Google Authenticator.'),
        h('li', null, 'Lisää sovellukseen uusi tili ja lue alla oleva QR-koodi.',
          h('div', { class: 'mfa-qr' }, h('img', { src: r.qr, alt: 'QR-koodi todennussovellukseen', width: '220', height: '220' })),
          h('details', { class: 'define' }, h('summary', null, 'Et voi lukea koodia?'),
            h('p', null, 'Jos käytät tätä samalla puhelimella, ', h('a', { href: r.otpauth }, 'avaa todennussovelluksessa'), '. Voit myös syöttää avaimen käsin:'),
            h('p', null, h('code', { class: 'mfa-secret' }, r.secret)),
            h('p', { class: 'small muted' }, `Tili: ${account} · tyyppi: aikaperusteinen (TOTP)`))),
        h('li', null, 'Kirjoita sovelluksen näyttämä koodi alle.')),
      form,
    ] : [
      h('h1', null, 'Vahvista kirjautuminen'),
      h('p', { class: 'muted' }, 'Avaa puhelimen todennussovellus ja kirjoita sen näyttämä koodi.'),
      form,
      h('p', { class: 'small muted login-help' }, 'Puhelin kadonnut tai vaihtunut? Pyydä pääkäyttäjää nollaamaan kaksivaiheinen tunnistautuminen.'),
    ]));
    code.focus();
  }

  const msg = state.loginError; state.loginError = null;
  drawStart(msg);
}

function msLogo() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 21 21'); svg.setAttribute('width', '20'); svg.setAttribute('height', '20'); svg.setAttribute('aria-hidden', 'true');
  [['1', '1', '#f25022'], ['11', '1', '#7fba00'], ['1', '11', '#00a4ef'], ['11', '11', '#ffb900']].forEach(([x, y, c]) => {
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', '9'); r.setAttribute('height', '9'); r.setAttribute('fill', c); svg.append(r);
  });
  return svg;
}

async function viewPassword() {
  const forced = state.me.user.mustChangePassword;
  const msg = h('div', { class: 'notice', hidden: true });
  const cur = h('input', { type: 'password', id: 'cur', autocomplete: 'current-password', required: true });
  const n1 = h('input', { type: 'password', id: 'n1', autocomplete: 'new-password', minlength: '12', required: true });
  const n2 = h('input', { type: 'password', id: 'n2', autocomplete: 'new-password', minlength: '12', required: true });
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); msg.hidden = true;
    if (n1.value !== n2.value) { msg.className = 'notice err'; msg.textContent = 'Salasanat eivät täsmää.'; msg.hidden = false; return; }
    try {
      await api('/me/password', { method: 'POST', body: { current: cur.value, next: n1.value } });
      await loadMe(); toast('Salasana vaihdettu.'); go('#/kirjaa');
    } catch (ex) { msg.className = 'notice err'; msg.textContent = ex.message; msg.hidden = false; }
  } },
    h('div', { class: 'field' }, h('label', { for: 'cur' }, forced ? 'Väliaikainen salasana' : 'Nykyinen salasana'), cur),
    h('div', { class: 'field' }, h('label', { for: 'n1' }, 'Uusi salasana'), h('p', { class: 'help' }, 'Vähintään 12 merkkiä. Pitkä salalause on hyvä valinta.'), n1),
    h('div', { class: 'field' }, h('label', { for: 'n2' }, 'Uusi salasana uudelleen'), n2),
    msg, h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Vaihda salasana'),
      forced ? h('button', { class: 'btn btn-secondary', type: 'button', onclick: logout }, 'Kirjaudu ulos') : null));
  $app.replaceChildren(h('div', { class: 'narrow' },
    h('h1', null, 'Vaihda salasana'),
    forced ? h('div', { class: 'notice info' }, 'Vaihda väliaikainen salasana omaksi salasanaksesi ennen jatkamista.') : null,
    h('div', { class: 'card' }, form)));
}

// ---------------------------------------------------------------------------
// Kirjauslomake (uusi ja korjaus)
// ---------------------------------------------------------------------------
async function loadForm() { if (!state.form) state.form = await api('/form'); return state.form; }

async function viewRecord() {
  $app.classList.add('container');
  const me = state.me;
  if (!me.projects.filter(p => p.active).length) {
    $app.replaceChildren(h('div', { class: 'narrow' }, h('h1', null, 'Uusi kirjaus'),
      h('div', { class: 'notice warn' }, 'Sinua ei ole vielä liitetty yhteenkään hankkeeseen. Ole yhteydessä tiiminvetäjään tai pääkäyttäjään.')));
    return;
  }
  const { questions, referralServices, clientTracking, members } = await loadForm();
  const prefill = state.lastBasics || null;
  renderEncounterForm({ questions, referralServices, clientTracking, members, allowClient: true, initial: prefill, onSubmit: async (payload) => {
    const r = await api('/encounters', { method: 'POST', body: payload });
    state.lastBasics = { project_id: payload.project_id, encounter_date: payload.encounter_date, encounter_type: payload.encounter_type, performer: payload.performer };
    showSaved(payload, r.id);
  } });
}

function showSaved(payload, id) {
  const p = state.me.projects.find(x => x.id === payload.project_id);
  const count = payload.encounter_type === 'ryhma' ? Number(payload.encounter_count) : 1;
  $app.replaceChildren(h('div', { class: 'narrow' }, h('div', { class: 'card success' },
    h('div', { class: 'check', 'aria-hidden': 'true' }, '✓'),
    h('h1', null, 'Kirjaus tallennettu'),
    h('p', { class: 'muted' }, `${p ? p.name : ''} · ${fmtDate(payload.encounter_date)} · ${typeLabel(payload.encounter_type)} · ${fmtNum(count)} ${count === 1 ? 'kohtaaminen' : 'kohtaamista'}`),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: () => { route(); } }, 'Kirjaa seuraava'),
      h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => { state.lastBasics = null; route(); } }, 'Tyhjä lomake'),
      state.me.permissions.viewScope !== 'none' ? h('a', { class: 'btn btn-secondary', href: `#/kirjaukset/${id}` }, 'Näytä kirjaus') : null),
    h('p', { class: 'small muted' }, '”Kirjaa seuraava” säilyttää hankkeen, päivämäärän ja kirjauksen tyypin.'),
  )));
}

/**
 * Piirtää kirjauslomakkeen.
 * opts: { questions, initial, onSubmit(payload), title, submitLabel, onCancel, projects }
 */
function renderEncounterForm(opts) {
  const me = state.me;
  const init = opts.initial || {};
  const projects = opts.projects || me.projects.filter(p => p.active);
  const s = {
    project_id: init.project_id || (projects.length === 1 ? projects[0].id : null),
    encounter_date: init.encounter_date || me.today,
    encounter_type: init.encounter_type || null,
    encounter_count: init.encounter_count ?? '',
    person_count: init.person_count ?? '',
    answers: { ...(init.answers || {}) },
    // Kohtaamisen toteuttaja: käyttäjän id tai 'vapaaehtoinen' (oletus: kirjaaja itse)
    performer: init.performer || (init.id ? (init.performer_type === VOLUNTEER ? VOLUNTEER : String(init.performed_by ?? init.created_by)) : String(me.user.id)),
    // Asiakastunniste ja ohjaukset (vain uusi yksilökirjaus)
    client: { mode: 'none', ref: '', generated: false, checkedRef: null, summary: null, available: null, updates: {} },
    referrals: new Set(),
  };
  const qs = opts.questions;
  // Kun sijainniksi valitaan "Digialustalla", kaupunki ja kadunnimi piilotetaan (kysymyksen asetus digital_mode = 'hide')
  const digitalHidden = (q) => q.digital_mode === 'hide' && String(s.answers.sijainti || '').trim().toLowerCase() === DIGITAL_LOCATION.toLowerCase();
  const syncLocation = () => { for (const q of qs) if (q.digital_mode === 'hide') { const el = dynamic.querySelector('#fw-' + q.key); if (el) el.hidden = digitalHidden(q); } };

  const errBox = h('div', { class: 'notice err', hidden: true, role: 'alert' });
  const dynamic = h('div');

  // --- Perustiedot
  const dateInput = h('input', { type: 'date', id: 'f-date', class: 'input-narrow', value: s.encounter_date, max: me.today, min: '2020-01-01', required: true,
    oninput: (e) => { s.encounter_date = e.target.value; } });

  const projectField = projects.length === 1
    ? h('div', { class: 'field' }, h('div', { class: 'label' }, 'Hanke'), h('p', null, h('strong', null, projects[0].name)))
    : projects.length <= 8
      ? h('div', { class: 'field', id: 'fw-project' }, h('div', { class: 'label', id: 'l-project' }, 'Hanke', h('span', { class: 'req' }, '*')),
          h('div', { class: 'options project-cards', role: 'radiogroup', 'aria-labelledby': 'l-project' },
            projects.map(p => paintProject(h('label', { class: 'opt' },
              h('input', { type: 'radio', name: 'project', value: p.id, checked: p.id === s.project_id, onchange: () => { s.project_id = p.id; resetClientCheck(s); drawPerformer(); renderDynamic(); } }),
              h('span', null, h('span', { class: 'opt-title' }, p.name))), p))))
      : h('div', { class: 'field', id: 'fw-project' }, h('label', { for: 'f-project' }, 'Hanke', h('span', { class: 'req' }, '*')),
        h('select', { id: 'f-project', required: true, onchange: (e) => { s.project_id = Number(e.target.value) || null; resetClientCheck(s); drawPerformer(); renderDynamic(); } },
          h('option', { value: '' }, '– Valitse hanke –'),
          projects.map(p => h('option', { value: p.id, selected: p.id === s.project_id }, p.name))));

  // Kohtaamisen toteuttaja: oma nimi, toinen hankkeen käyttäjä tai vapaaehtoinen. Raportoinnin rooli määräytyy toteuttajasta.
  const performerSelect = h('select', { id: 'f-performer', 'aria-describedby': 'h-performer', onchange: (e) => { s.performer = e.target.value; drawPerformerNote(); } });
  const performerNote = h('p', { class: 'help help-below', id: 'h-performer' });
  const drawPerformerNote = () => performerNote.replaceChildren(s.performer === String(me.user.id)
    ? 'Valitse toinen henkilö, jos kirjaat kohtaamisen jonkun toisen puolesta.'
    : h('span', null, 'Kirjaat toisen puolesta. Kirjaajaksi tallentuu ', h('strong', null, init.id ? (init.created_by_name || 'alkuperäinen kirjaaja') : me.user.name), '.'));
  function drawPerformer() {
    const list = ((opts.members || {})[s.project_id] || []).slice();
    // Korjauksessa alkuperäinen toteuttaja näkyy, vaikka hän ei olisi enää hankkeessa
    if (init.id && init.performer_type !== VOLUNTEER && init.performed_by && init.performed_by !== me.user.id && !list.some(m => m.id === init.performed_by)) list.push({ id: init.performed_by, name: init.performed_by_name || 'Alkuperäinen toteuttaja' });
    const values = [String(me.user.id), ...list.map(m => String(m.id)), VOLUNTEER];
    if (!values.includes(s.performer)) s.performer = String(me.user.id);
    performerSelect.replaceChildren(
      h('option', { value: String(me.user.id) }, `Minä (${me.user.name})`),
      list.length ? h('optgroup', { label: 'Hankkeen työntekijät' }, list.map(m => h('option', { value: String(m.id) }, m.name))) : null,
      h('option', { value: VOLUNTEER }, 'Vapaaehtoinen tai vertainen'));
    performerSelect.value = s.performer;
    drawPerformerNote();
  }
  const roleField = h('div', { class: 'field', id: 'fw-performer' }, h('label', { for: 'f-performer' }, 'Kohtaamisen toteutti'), performerSelect, performerNote);
  drawPerformer();

  // Valitun tyypin laskentaohje näytetään suoraan valinnan alla
  const typeHelp = h('div', { class: 'type-help' });
  const drawTypeHelp = () => typeHelp.replaceChildren(s.encounter_type === 'yksilo'
    ? h('details', { class: 'define' }, h('summary', null, 'Mikä lasketaan yhdeksi kohtaamiseksi?'),
        h('p', null, 'Yksi yhtenäinen keskustelu yhden kohderyhmään kuuluvan henkilön kanssa = yksi kohtaaminen. Jatkokysymys samassa keskustelussa kuuluu samaan kohtaamiseen.'),
        h('p', null, 'Jos dialogi on luonteeltaan jatkuvaa (esim. tukihenkilötyöskentely), kohtaamiseksi lasketaan ne päivät, jolloin vuorovaikutusta on tapahtunut. Digialustalla yksi kysymys–vastaus-kokonaisuus jatkokysymyksineen = yksi kohtaaminen.'))
    : '');
  const typeField = h('div', { class: 'field', id: 'fw-type' }, h('div', { class: 'label', id: 'l-type' }, 'Valitse, mitä raportoit', h('span', { class: 'req' }, '*')),
    h('div', { class: 'segmented', role: 'radiogroup', 'aria-labelledby': 'l-type' },
      [['yksilo', 'Yksi kohtaaminen', 'Yksi henkilö, yksi keskustelu'], ['ryhma', 'Ryhmä tai useita kohtaamisia', 'Ryhmä tai useampi kohtaaminen kerralla']].map(([v, t, d]) => h('label', { class: 'opt' },
        h('input', { type: 'radio', name: 'encounter_type', value: v, checked: s.encounter_type === v, onchange: () => { s.encounter_type = v; renderDynamic(); } }),
        h('span', null, h('span', { class: 'opt-title' }, t), h('span', { class: 'opt-desc' }, d))))),
    typeHelp);

  const basics = h('section', { class: 'card section' },
    h('div', { class: 'section-title' }, h('h2', null, 'Perustiedot')),
    h('div', { class: 'field', id: 'fw-date' },
      h('label', { for: 'f-date' }, 'Kohtaamisen ajankohta (tai alkamisajankohta)', h('span', { class: 'req' }, '*')),
      h('details', { class: 'define' }, h('summary', null, 'Mikä on kohtaaminen?'),
        h('p', null, 'Kohtaaminen on vuorovaikutustilanne, jossa kohderyhmään kuuluva henkilö tai kohderyhmään kuuluvien ryhmä on vuorovaikutuksessa ammattilaisen, koulutetun ohjaajan tai muun tukea tarjoavan kanssa. Kohtaamisessa tarjotaan hankkeen tavoitteiden mukaista tukea, ohjausta, neuvontaa, vertaistukea tai muuta kohderyhmälle suunnattua vuorovaikutteista palvelua.'),
        h('p', null, 'Jos raportoit pitkäkestoisesta ryhmästä tai dialogista, merkitse aloituspäivä.')),
      h('div', { class: 'date-row' }, dateInput, h('div', { class: 'date-chips' },
        [['Tänään', 0], ['Eilen', 1], ['Toissapäivänä', 2]].map(([t, n]) => h('button', { type: 'button', class: 'chip', onclick: () => {
          const d = new Date(me.today + 'T12:00:00'); d.setDate(d.getDate() - n); s.encounter_date = d.toISOString().slice(0, 10); dateInput.value = s.encounter_date;
          clearFieldError(dateInput); } }, t))))),
    projectField, roleField, typeField);

  // --- Dynaaminen osa: yksilö/ryhmä, yhteiset ja hankekohtaiset kysymykset
  function renderDynamic() {
    const parts = [];
    drawTypeHelp();
    // Lomake jatkuu vasta, kun sekä hanke että kirjauksen tyyppi on valittu
    // (nimimerkit ja hankekohtaiset kysymykset riippuvat hankkeesta).
    if (!s.project_id || !s.encounter_type) {
      const missing = [!s.project_id ? 'hanke' : null, !s.encounter_type ? 'kohtaamisen tyyppi' : null].filter(Boolean).join(' ja ');
      dynamic.replaceChildren(h('div', { class: 'notice info next-step' }, `Valitse ensin ${missing}, niin lomake jatkuu.`));
      submitBtn.disabled = true;
      return;
    }
    submitBtn.disabled = false;
    if (s.encounter_type === 'ryhma') {
      parts.push(h('section', { class: 'card section' },
        h('div', { class: 'section-title' }, h('h2', null, 'Ryhmän tiedot')),
        h('details', { class: 'define' }, h('summary', null, 'Miten kohtaamiset lasketaan?'),
          h('p', null, 'Vuorovaikutustilanteeseen tai keskusteluketjuun osallistuneiden määrä = kohtaamisten määrä. Täysin passiivisia ei huomioida.'),
          h('p', null, 'Jos dialogi on luonteeltaan jatkuvaa, esim. verkkokeskustelualustalla, kohtaamisten määrä = viestien määrä (ohjaajat) tai aktiiviset päivät × osallistujien määrä, riippuen siitä kumpi kuvaa parhaiten erillisten vuorovaikutustilanteiden määrää.')),
        h('div', { class: 'row' },
          // Ohjeet kentän alla, jotta kentät asettuvat samalle tasolle
          h('div', { class: 'field', id: 'fw-count' }, h('label', { for: 'f-count' }, 'Kohtaamisten määrä', h('span', { class: 'req' }, '*')),
            h('input', { type: 'number', id: 'f-count', inputmode: 'numeric', enterkeyhint: 'next', min: '1', max: '9999', step: '1', required: true, value: s.encounter_count,
              'aria-describedby': 'h-count', oninput: (e) => { s.encounter_count = e.target.value; } }),
            h('p', { class: 'help help-below', id: 'h-count' }, 'Kaikki ryhmän tai sarjan kohtaamiset yhteensä.')),
          h('div', { class: 'field', id: 'fw-persons' }, h('label', { for: 'f-persons' }, 'Eri osallistujien määrä'),
            h('input', { type: 'number', id: 'f-persons', inputmode: 'numeric', enterkeyhint: 'next', min: '1', max: '9999', step: '1', value: s.person_count,
              'aria-describedby': 'h-persons', oninput: (e) => { s.person_count = e.target.value; } }),
            h('p', { class: 'help help-below', id: 'h-persons' }, 'Jätä tyhjäksi, jos ei tiedossa. Älä laske työntekijöitä tai ohjaajia.')))));
    } else {
      // Yksilökohtaamisella ei ole omia täytettäviä kenttiä: määritelmä on tyyppivalinnan alla
      if (opts.allowClient) parts.push(renderClientSection(s, opts));
      else if (init.client_linked || (init.referrals && init.referrals.length)) {
        parts.push(h('div', { class: 'notice info small' }, 'Asiakastunnistetta ja palveluohjauksia ei muuteta korjauksessa.'));
      }
    }

    // Sijainnista riippuvat kentät piirretään aina ja piilotetaan tarvittaessa (syncLocation), jotta vastaukset säilyvät
    const visible = (q) => (q.applies_to === 'kaikki' || q.applies_to === s.encounter_type);
    const common = qs.filter(q => q.project_id == null && visible(q));
    if (common.length) parts.push(h('section', { class: 'card section' },
      h('div', { class: 'section-title' }, h('h2', null, 'Yhteiset kysymykset')),
      common.map(q => renderQuestion(q, s.answers))));

    if (s.project_id) {
      const own = qs.filter(q => q.project_id === s.project_id && visible(q));
      const p = projects.find(x => x.id === s.project_id) || me.projects.find(x => x.id === s.project_id);
      if (own.length) parts.push(h('section', { class: 'card section' },
        h('div', { class: 'section-title' }, h('h2', null, p ? p.name : 'Hanke'), h('span', { class: 'tag' }, 'Hankekohtaiset kysymykset')),
        own.map(q => renderQuestion(q, s.answers))));
    }
    dynamic.replaceChildren(...parts);
    syncLocation();
  }

  const submitBtn = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, opts.submitLabel || 'Tallenna kirjaus');
  const form = h('form', { novalidate: true, class: 'encounter-form', onsubmit: async (e) => {
    e.preventDefault(); errBox.hidden = true;
    clearFieldErrors(form);
    const problem = clientValidate();
    if (problem) { showFieldError(problem[1], problem[0], errBox); return; }
    const visible = (q) => (q.applies_to === 'kaikki' || q.applies_to === s.encounter_type) && (q.project_id == null || q.project_id === s.project_id) && !digitalHidden(q);
    const answers = {};
    for (const q of qs) if (visible(q) && s.answers[q.key] != null && s.answers[q.key] !== '') answers[q.key] = s.answers[q.key];
    const payload = { project_id: s.project_id, encounter_date: s.encounter_date, encounter_type: s.encounter_type,
      encounter_count: s.encounter_type === 'ryhma' ? s.encounter_count : 1, person_count: s.encounter_type === 'ryhma' ? s.person_count : null,
      answers, performer: s.performer };
    if (opts.allowClient && s.encounter_type === 'yksilo') {
      // Palaava asiakas: haetaan automaattisesti, jos hakua ei ole tehty
      if (s.client.mode === 'existing' && s.client.checkedRef !== s.client.ref) {
        try { await lookupClient(s); } catch (ex) { showFieldError('fw-client', ex.message, errBox); return; }
      }
      if (s.client.mode === 'existing' && !s.client.summary) { showFieldError('fw-client', 'Nimimerkkiä ei löydy tästä hankkeesta. Tarkista hanke ja kirjoitusasu, tai valitse ”Uusi asiakas”.', errBox); return; }
      if (s.client.mode === 'new' && s.client.available === false && s.client.checkedRef === s.client.ref) { showFieldError('fw-client', 'Tunniste on jo toisen asiakkaan käytössä. Valitse toinen tunniste.', errBox); return; }
      Object.assign(payload, {
        client_mode: s.client.mode, client_ref: s.client.mode === 'none' ? '' : s.client.ref, client_generated: s.client.generated,
        referrals: [...s.referrals],
        referral_updates: Object.entries(s.client.updates).filter(([, st]) => st).map(([id, status]) => ({ id: Number(id), status })),
      });
    }
    submitBtn.disabled = true;
    try { await opts.onSubmit(payload); }
    catch (ex) { errBox.textContent = ex.message; errBox.hidden = false; errBox.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    finally { submitBtn.disabled = false; }
  }, oninput: (e) => clearFieldError(e.target), onchange: (e) => { clearFieldError(e.target); syncLocation(); }, onclick: () => setTimeout(syncLocation, 0) },
    h('div', { class: 'notice info small' }, 'Älä kirjaa lomakkeelle asiakkaan nimeä, yhteystietoja, terveystietoja tai muita tunnistetietoja.'),
    basics, dynamic, errBox,
    h('div', { class: 'sticky-actions actions' }, submitBtn,
      opts.onCancel ? h('button', { class: 'btn btn-secondary', type: 'button', onclick: opts.onCancel }, 'Peruuta') : null));

  // Palauttaa [virheilmoitus, kentän kääreen id] tai null.
  function clientValidate() {
    if (opts.allowClient && s.encounter_type === 'yksilo' && s.client.mode !== 'none') {
      const n = normalizeRef(s.client.ref);
      if (n.length < 3) return ['Anna asiakkaan tunniste (vähintään 3 kirjainta tai numeroa) tai valitse ”Ei tunnistetta”.', 'fw-client'];
      if (sensitiveHit(s.client.ref)) return ['Tunniste näyttää sisältävän tunnistetietoja. Älä käytä oikeaa nimeä tai yhteystietoja.', 'fw-client'];
    }
    if (!s.encounter_date) return ['Anna kohtaamisen ajankohta.', 'fw-date'];
    if (s.encounter_date > me.today) return ['Kohtaamisen ajankohta ei voi olla tulevaisuudessa.', 'fw-date'];
    if (!s.project_id) return ['Valitse hanke.', 'fw-project'];
    if (!s.encounter_type) return ['Valitse, mitä raportoit.', 'fw-type'];
    if (s.encounter_type === 'ryhma') {
      const n = Number(s.encounter_count);
      if (!Number.isInteger(n) || n < 1 || n > 9999) return ['Kohtaamisten määrä on oltava 1–9999.', 'fw-count'];
      if (s.person_count !== '' && s.person_count != null) { const p = Number(s.person_count); if (!Number.isInteger(p) || p < 1 || p > 9999) return ['Osallistujien määrä on oltava 1–9999 tai tyhjä.', 'fw-persons']; }
    }
    for (const q of qs) {
      if (!(q.applies_to === 'kaikki' || q.applies_to === s.encounter_type) || !(q.project_id == null || q.project_id === s.project_id) || digitalHidden(q)) continue;
      const v = s.answers[q.key];
      const empty = v == null || v === '' || (Array.isArray(v) && !v.length);
      if (q.required && empty) return [`Vastaa kysymykseen: ${q.label}`, 'fw-' + q.key];
      if (!empty && typeof v === 'string' && ['text', 'textarea'].includes(q.type)) { const hit = sensitiveHit(v); if (hit) return [`Kenttä "${q.label}" näyttää sisältävän ${hit} näyttävää tietoa. Poista tunnistetiedot.`, 'fw-' + q.key]; }
    }
    return null;
  }

  $app.classList.add('container');
  $app.replaceChildren(h('div', { class: 'narrow' },
    h('div', { class: 'page-head form-head' }, h('div', null, h('h1', null, opts.title || 'Uusi kirjaus'),
      h('p', { class: 'muted small' }, 'Tähdellä (*) merkityt kohdat ovat pakollisia.'))),
    form));
  renderDynamic();
}

// ---------------------------------------------------------------------------
// Asiakastunniste ja palveluohjaus (lomakkeen osio)
// ---------------------------------------------------------------------------
const normalizeRef = (v) => String(v || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
// Tunniste on hankekohtainen: hankkeen vaihtuessa aiempi tarkistus ei enää päde
function resetClientCheck(s) { Object.assign(s.client, { checkedRef: null, summary: null, available: null, updates: {} }); }
async function lookupClient(s) {
  const ref = s.client.ref;
  if (!s.project_id) throw new Error('Valitse ensin hanke. Asiakastunnisteet ovat hankekohtaisia.');
  const r = await api('/clients/lookup', { method: 'POST', body: { ref, project_id: s.project_id, mode: s.client.mode === 'new' ? 'new' : 'existing' } });
  s.client.checkedRef = ref;
  if (s.client.mode === 'new') { s.client.available = r.available; s.client.summary = null; }
  else { s.client.summary = r.found ? r.summary : null; s.client.available = null; s.client.updates = {}; }
  return r;
}

function renderClientSection(s, opts) {
  const c = s.client;
  const body = h('div');
  const services = opts.referralServices || [];

  function modeChange(mode) { c.mode = mode; c.ref = ''; c.generated = false; c.checkedRef = null; c.summary = null; c.available = null; c.updates = {}; draw(); }

  function draw(focusInput) {
    const parts = [];
    if (opts.clientTracking && !s.project_id) {
      parts.push(h('div', { class: 'field', id: 'fw-client' }, h('div', { class: 'label' }, 'Asiakkaan tunniste'),
        h('p', { class: 'help' }, 'Valitse ensin hanke. Asiakastunnisteet ovat hankekohtaisia.')));
    } else if (opts.clientTracking) {
      const status = h('div', { class: 'client-status' + (c.mode === 'new' ? ' reserve' : ''), 'aria-live': 'polite' });
      const input = h('input', { type: 'text', id: 'f-client', maxlength: '40', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
        enterkeyhint: 'search', class: 'client-input', value: c.ref, placeholder: c.mode === 'new' ? 'esim. Sininen Kettu' : 'nimimerkki',
        oninput: (e) => { c.ref = e.target.value; c.generated = false; if (c.checkedRef !== c.ref) { c.summary = null; c.available = null; drawStatus(); } },
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); check(); } },
        // Vain uusi asiakas tarkistetaan automaattisesti; tulos kirjoitetaan varattuun riviin, joten sisältö ei hyppää
        onblur: () => { if (c.mode === 'new' && c.ref && c.checkedRef !== c.ref && normalizeRef(c.ref).length >= 3) check(true); } });
      async function check(quiet) {
        clearFieldError(input);
        if (normalizeRef(c.ref).length < 3) { status.replaceChildren(h('p', { class: 'field-error' }, 'Vähintään 3 kirjainta tai numeroa.')); return; }
        if (sensitiveHit(c.ref)) { status.replaceChildren(h('p', { class: 'field-error' }, 'Älä käytä oikeaa nimeä, henkilötunnusta tai yhteystietoja.')); return; }
        if (!quiet) status.replaceChildren(h('p', { class: 'muted small' }, 'Tarkistetaan…'));
        try { await lookupClient(s); drawStatus(); } catch (ex) { status.replaceChildren(h('p', { class: 'field-error' }, ex.message)); }
      }
      function drawStatus() {
        const out = [];
        if (c.mode === 'existing' && c.checkedRef === c.ref && c.ref) {
          if (!c.summary) {
            const pr = (state.me.projects.find(x => x.id === s.project_id) || {}).name || 'tästä hankkeesta';
            out.push(h('div', { class: 'field-error' }, h('p', null, `Nimimerkkiä ei löydy hankkeesta ${pr}.`),
              h('p', { class: 'small' }, 'Nimimerkit ovat hankekohtaisia: tarkista, että hanke on sama kuin ensimmäisellä kerralla. Tarkista myös kirjoitusasu, tai valitse ”Uusi asiakas”.')));
          }
          else {
            const sm = c.summary;
            out.push(h('div', { class: 'notice ok client-found' }, h('strong', null, '✓ Tunnistettu asiakas'),
              h('span', null, ` · ${fmtNum(sm.encounters)} ${sm.encounters === 1 ? 'aiempi kohtaaminen' : 'aiempaa kohtaamista'} tässä hankkeessa`),
              sm.first_month ? h('span', null, ` · ensimmäinen ${fmtMonth(sm.first_month)}`) : null));
            if (services.length && sm.open_referrals.length) {
              out.push(h('div', { class: 'followups' }, h('div', { class: 'label' }, 'Aiemmat ohjaukset – toteutuiko?'),
                h('p', { class: 'help' }, 'Kysy asiakkaalta, jos tilanne sopii. Jätä ”Ei vielä tietoa”, jos et tiedä.'),
                sm.open_referrals.map(ref => {
                  const name = 'fu-' + ref.id;
                  const opt = (val, label) => h('label', { class: 'opt' }, h('input', { type: 'radio', name, value: val, checked: (c.updates[ref.id] || '') === val,
                    onchange: () => { c.updates[ref.id] = val; } }), h('span', null, label));
                  return h('div', { class: 'followup' }, h('p', null, h('strong', null, ref.service), h('span', { class: 'muted' }, ` · ohjattu ${fmtDate(ref.referred_on)}`)),
                    h('div', { class: 'seg3 segmented' }, opt('toteutui', 'Toteutui'), opt('ei_toteutunut', 'Ei toteutunut'), opt('', 'Ei vielä tietoa')));
                })));
            }
          }
        }
        if (c.mode === 'new' && c.checkedRef === c.ref && c.ref) {
          out.push(c.available ? h('p', { class: 'ok-text' }, '✓ Nimimerkki on vapaa.')
            : h('p', { class: 'field-error' }, 'Nimimerkki on jo toisen asiakkaan käytössä. Valitse toinen tai luo nimimerkki.'));
        }
        if (c.mode === 'new' && c.generated && c.ref) {
          out.push(h('div', { class: 'notice info' }, h('p', null, 'Kerro nimimerkki asiakkaalle: ', h('strong', { class: 'code-big' }, c.ref)),
            h('p', { class: 'small' }, 'Nimimerkki on käytössä vain tässä hankkeessa. Sitä ei voi hakea järjestelmästä myöhemmin, joten asiakkaan kannattaa painaa se mieleen. Kirjainkoolla, välilyönneillä tai ääkkösillä ei ole väliä.')));
        }
        status.replaceChildren(...out);
      }
      parts.push(h('div', { class: 'field', id: 'fw-client' },
        h('div', { class: 'label', id: 'l-client' }, 'Asiakkaan tunniste'),
        h('div', { class: 'segmented seg3', role: 'radiogroup', 'aria-labelledby': 'l-client' },
          [['none', 'Ei tunnistetta'], ['existing', 'Palaava asiakas'], ['new', 'Uusi asiakas']].map(([v, t]) => h('label', { class: 'opt' },
            h('input', { type: 'radio', name: 'client_mode', value: v, checked: c.mode === v, onchange: () => modeChange(v) }), h('span', null, t)))),
        c.mode === 'none' ? h('p', { class: 'help' }, services.length ? 'Ilman tunnistetta asiakkaan palveluihin ohjautumista ei voi seurata.'
          : 'Ilman tunnistetta kohtaaminen lasketaan täysin anonyymiksi, eikä se sisälly eri henkilöiden määrään.') : [
          h('p', { class: 'help' }, c.mode === 'existing' ? 'Kirjoita asiakkaan nimimerkki tai tunnus. Kirjainkoolla, välilyönneillä, väliviivoilla tai ääkkösillä ei ole väliä.'
            : 'Keksi asiakkaan kanssa nimimerkki tai luo helposti muistettava nimimerkki, esim. ”Sininen Kettu”. Älä käytä oikeaa nimeä.'),
          h('div', { class: 'actions client-row' }, input,
            c.mode === 'existing' ? h('button', { type: 'button', class: 'btn btn-secondary', onclick: check }, 'Hae')
              : h('button', { type: 'button', class: 'btn btn-secondary', onclick: async () => {
                  if (!s.project_id) { toast('Valitse ensin hanke.', true); return; }
                  try { const r = await api('/clients/generate', { method: 'POST', body: { project_id: s.project_id } }); c.ref = r.code; c.generated = true; c.checkedRef = r.code; c.available = true; draw(); }
                  catch (ex) { toast(ex.message, true); } } }, 'Luo nimimerkki')),
          status]));
      setTimeout(() => { drawStatus(); if (focusInput) input.focus(); }, 0);
    } else {
      parts.push(h('p', { class: 'help' }, 'Asiakastunnisteet eivät ole käytössä tässä ympäristössä.'));
    }
    if (services.length) {
      parts.push(h('div', { class: 'field', id: 'fw-referrals' },
        h('div', { class: 'label', id: 'l-ref' }, 'Ohjattiinko asiakas palveluun?'),
        h('p', { class: 'help' }, 'Valitse kaikki palvelut, joihin asiakas ohjattiin tai joihin häntä kehotettiin hakeutumaan. Jätä tyhjäksi, jos ohjausta ei tehty.'),
        h('div', { class: 'options checks', role: 'group', 'aria-labelledby': 'l-ref' }, services.map(sv => h('label', { class: 'opt' },
          h('input', { type: 'checkbox', checked: s.referrals.has(sv.id), onchange: (e) => { e.target.checked ? s.referrals.add(sv.id) : s.referrals.delete(sv.id); } }),
          h('span', null, sv.name))))));
    }
    body.replaceChildren(...parts);
  }
  draw();
  return h('section', { class: 'card section' },
    h('div', { class: 'section-title' }, h('h2', null, services.length ? 'Asiakkaan tunniste ja palveluohjaus' : 'Asiakkaan tunniste')),
    h('details', { class: 'define' }, h('summary', null, 'Miksi tunniste ja miten se suojataan?'),
      h('p', null, (services.length ? 'Tunnisteella voidaan seurata, ohjautuuko asiakas palveluihin.'
        : 'Tunnisteella lasketaan, montako eri asiakasta hankkeessa kohdataan, ja tunnistetaan palaavat asiakkaat.') + ' Tunniste on hankekohtainen: sama nimimerkki voi olla eri hankkeissa eri asiakkaalla, eikä hankkeiden tietoja yhdistetä.'),
      h('p', null, 'Tunnistetta ei tallenneta selväkielisenä: järjestelmään jää vain salattu tiiviste, josta tunnistetta ei voi palauttaa. Tunniste ei näy kirjauksissa, raporteissa eikä Excel-viennissä.')),
    body);
}

// Kenttäkohtainen virhe: korostus, viesti kentän alle, vieritys ja fokus.
function clearFieldErrors(root) {
  root.querySelectorAll('.field.has-error').forEach(f => f.classList.remove('has-error'));
  root.querySelectorAll('.field-error').forEach(e => e.remove());
}
function clearFieldError(target) {
  const f = target && target.closest && target.closest('.field.has-error');
  if (f) { f.classList.remove('has-error'); const e = f.querySelector('.field-error'); if (e) e.remove(); }
}
function showFieldError(fieldId, msg, fallbackBox) {
  const f = document.getElementById(fieldId);
  if (!f) { fallbackBox.textContent = msg; fallbackBox.hidden = false; fallbackBox.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  f.classList.add('has-error');
  const label = f.querySelector('.label, label');
  const err = h('p', { class: 'field-error', role: 'alert' }, msg);
  if (label) label.after(err); else f.prepend(err);
  f.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const input = f.querySelector('input:not([type=hidden]), select, textarea');
  if (input) setTimeout(() => input.focus({ preventScroll: true }), 350);
}

// Hankkeen teemaväri: asetetaan CSS-muuttujina (--pc1, --pc2); kahden värin hankkeessa raita on kaksivärinen
const projectColors = (p) => (p && p.color ? String(p.color).split(',') : []);
function paintProject(el, p) {
  const [c1, c2] = projectColors(p);
  if (!c1) return el;
  el.style.setProperty('--pc1', c1); el.style.setProperty('--pc2', c2 || c1);
  el.classList.add('has-pc');
  return el;
}
const projectDot = (p) => paintProject(h('span', { class: 'pdot', 'aria-hidden': 'true' }), p);
const BRAND_SWATCHES = [['#0037d3', 'Sininen'], ['#00a0f4', 'Vaaleansininen'], ['#008900', 'Vihreä'], ['#00ea00', 'Kirkkaanvihreä'],
  ['#ffe000', 'Keltainen'], ['#a437b8', 'Violetti'], ['#000000', 'Musta'], ['#919396', 'Harmaa']];

// Täydennysehdotukset tekstikenttään (ARIA-combobox). Haku alkaa 2 merkistä.
let suggestSeq = 0;
function attachSuggest(input, q, answers, set) {
  const listId = 'sg-' + q.key + '-' + (++suggestSeq);
  const list = h('ul', { class: 'suggest-list', id: listId, role: 'listbox', hidden: true, 'aria-label': 'Ehdotukset' });
  // Kadunnimet tulevat osin DVV:n avoimesta osoiteaineistosta: lähdemerkintä listan alle (CC BY 4.0)
  const attr = q.key === 'kadunnimi' ? h('p', { class: 'suggest-attr' }, 'Kadunnimet: Digi- ja väestötietovirasto') : null;
  const pop = h('div', { class: 'suggest-pop', hidden: true }, list, attr);
  Object.assign(input, { autocomplete: 'off' });
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-controls', listId);
  input.setAttribute('autocapitalize', 'words'); input.setAttribute('spellcheck', 'false');
  let items = [], active = -1, timer = null, seq = 0;
  const cache = new Map();
  const close = () => { list.hidden = true; pop.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
  const choose = (v) => { input.value = v; set(v); close(); input.dispatchEvent(new Event('change', { bubbles: true })); };
  const mark = (v, typed) => {
    const i = v.toLocaleLowerCase('fi').indexOf(typed.toLocaleLowerCase('fi'));
    return i < 0 ? v : [v.slice(0, i), h('strong', null, v.slice(i, i + typed.length)), v.slice(i + typed.length)];
  };
  const draw = (typed) => {
    list.replaceChildren(...items.map((v, i) => h('li', { id: `${listId}-${i}`, role: 'option', class: i === active ? 'active' : null, 'aria-selected': i === active ? 'true' : 'false',
      onmousedown: (e) => e.preventDefault(), onclick: () => choose(v) }, mark(v, typed))));
    const open = items.length > 0;
    list.hidden = !open; pop.hidden = !open; input.setAttribute('aria-expanded', String(open));
    if (active >= 0) input.setAttribute('aria-activedescendant', `${listId}-${active}`); else input.removeAttribute('aria-activedescendant');
  };
  const load = async () => {
    const typed = input.value.trim();
    if (typed.length < 2) { items = []; close(); return; }
    const params = new URLSearchParams({ key: q.key, q: typed });
    if (q.key !== 'kaupunki' && answers.kaupunki) params.set('kaupunki', answers.kaupunki);
    const ck = params.toString(); const my = ++seq;
    let r = cache.get(ck);
    if (!r) { try { r = (await api('/suggest?' + ck)).items; cache.set(ck, r); } catch { r = []; } }
    if (my !== seq || document.activeElement !== input) return;
    // Ei ehdoteta pelkkää jo kirjoitettua arvoa
    items = r.filter(v => v.toLocaleLowerCase('fi') !== typed.toLocaleLowerCase('fi')); active = -1; draw(typed);
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 150); });
  input.addEventListener('focus', () => {
    if (q.key === 'kadunnimi') input.placeholder = answers.kaupunki ? '' : 'Valitse ensin kaupunki, niin saat katuehdotukset';
    if (input.value.trim().length >= 2) load();
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; draw(input.value.trim()); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; draw(input.value.trim()); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(items[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  return h('div', { class: 'suggest' }, input, pop);
}

function renderQuestion(q, answers) {
  const id = 'q-' + q.key;
  const label = h(['choice', 'multichoice', 'rating'].includes(q.type) ? 'div' : 'label', { for: id, class: 'label', id: id + '-l' },
    q.label, q.required ? h('span', { class: 'req' }, '*') : null);
  const help = q.help ? h('p', { class: 'help' }, q.help) : null;
  let control;
  const set = (v) => { answers[q.key] = v; };

  switch (q.type) {
    case 'text': case 'textarea': {
      const warn = h('div', { class: 'field-warn', hidden: true });
      const attrs = { id, value: answers[q.key] || '', maxlength: q.type === 'text' ? '200' : '4000',
        oninput: (e) => { set(e.target.value); if (q.free_text_warning) { const hit = sensitiveHit(e.target.value); warn.hidden = !hit; if (hit) warn.textContent = `Teksti näyttää ${hit}. Älä kirjaa asiakkaan tunnistetietoja.`; } } };
      const input = q.type === 'text' ? h('input', { type: 'text', ...attrs }) : h('textarea', attrs);
      control = [q.type === 'text' && q.suggest ? attachSuggest(input, q, answers, set) : input, q.free_text_warning ? h('p', { class: 'help small' }, 'Älä kirjaa asiakkaan henkilö-, terveys- tai muita tunnistetietoja.') : null, warn];
      break;
    }
    case 'number':
      control = h('input', { type: 'number', id, class: 'input-narrow', value: answers[q.key] ?? '', oninput: (e) => set(e.target.value) });
      break;
    case 'date':
      control = h('input', { type: 'date', id, class: 'input-narrow', value: answers[q.key] || '', oninput: (e) => set(e.target.value) });
      break;
    case 'rating': {
      const inputs = [];
      const clear = h('button', { type: 'button', class: 'clear-link', hidden: answers[q.key] == null || q.required,
        onclick: () => { set(null); inputs.forEach(i => { i.checked = false; }); clear.hidden = true; } }, 'Tyhjennä');
      control = [h('div', { class: 'rating', role: 'radiogroup', 'aria-labelledby': id + '-l' },
        q.options.map(o => { const inp = h('input', { type: 'radio', name: id, value: o, checked: String(answers[q.key]) === String(o),
          onchange: () => { set(String(o)); clear.hidden = q.required; } }); inputs.push(inp);
          return h('label', { class: 'opt' }, inp, h('span', null, o)); }), clear),
        h('div', { class: 'rating-legend' }, h('span', null, '1 = ei lainkaan hyötyä'), h('span', null, '5 = erittäin hyödyllinen'))];
      break;
    }
    case 'choice': {
      const inputs = [];
      const clear = h('button', { type: 'button', class: 'clear-link', hidden: !answers[q.key] || q.required,
        onclick: () => { set(null); inputs.forEach(i => { i.checked = false; }); clear.hidden = true; } }, 'Tyhjennä valinta');
      control = [h('div', { class: 'options', role: 'radiogroup', 'aria-labelledby': id + '-l' },
        q.options.map(o => { const inp = h('input', { type: 'radio', name: id, value: o, checked: answers[q.key] === o,
          onchange: () => { set(o); clear.hidden = q.required; } }); inputs.push(inp);
          return h('label', { class: 'opt' }, inp, h('span', null, o)); })), clear];
      break;
    }
    case 'multichoice': {
      const cur = new Set(Array.isArray(answers[q.key]) ? answers[q.key] : []);
      control = h('div', { class: 'options', role: 'group', 'aria-labelledby': id + '-l' },
        q.options.map(o => h('label', { class: 'opt' },
          h('input', { type: 'checkbox', value: o, checked: cur.has(o), onchange: (e) => { e.target.checked ? cur.add(o) : cur.delete(o); set([...cur]); } }),
          h('span', null, o))));
      break;
    }
  }
  return h('div', { class: 'field', id: 'fw-' + q.key }, label, help, control);
}

// ---------------------------------------------------------------------------
// Kirjausten selaus, tarkastelu, korjaus
// ---------------------------------------------------------------------------
const listState = { from: '', to: '', project_id: '', type: '', created_by: '', offset: 0 };

async function viewList() {
  $app.classList.add('container');
  const me = state.me; const p = me.permissions;
  const PAGE = 50;
  let staffSelect = null;
  if (p.staffScope !== 'none') {
    const { rows: staff } = await api('/staff');
    staffSelect = h('select', { id: 'l-user' }, h('option', { value: '' }, 'Kaikki kirjaajat'),
      staff.filter(s => s.rows > 0 || String(s.id) === listState.created_by).map(s => h('option', { value: s.id }, s.name)));
  }
  const tableBox = h('div');
  const stats = h('div', { class: 'stats' });
  const pager = h('div', { class: 'pager' });

  const f = (key, el) => { el.value = listState[key]; el.addEventListener('change', () => { listState[key] = el.value; listState.offset = 0; load(); }); return el; };
  const filters = h('details', { class: 'card filter-card', open: window.matchMedia('(min-width: 641px)').matches ? true : null },
    h('summary', null, 'Rajaa kirjauksia'), h('div', { class: 'filters' },
    h('div', { class: 'field' }, h('label', { for: 'l-from' }, 'Alkaen'), f('from', h('input', { type: 'date', id: 'l-from' }))),
    h('div', { class: 'field' }, h('label', { for: 'l-to' }, 'Päättyen'), f('to', h('input', { type: 'date', id: 'l-to' }))),
    me.projects.length > 1 ? h('div', { class: 'field' }, h('label', { for: 'l-proj' }, 'Hanke'),
      f('project_id', h('select', { id: 'l-proj' }, h('option', { value: '' }, 'Kaikki hankkeet'), me.projects.map(x => h('option', { value: x.id }, x.name))))) : null,
    h('div', { class: 'field' }, h('label', { for: 'l-type' }, 'Tyyppi'),
      f('type', h('select', { id: 'l-type' }, h('option', { value: '' }, 'Kaikki'), h('option', { value: 'yksilo' }, 'Yksi kohtaaminen'), h('option', { value: 'ryhma' }, 'Ryhmä')))),
    staffSelect ? h('div', { class: 'field' }, h('label', { for: 'l-user' }, 'Työntekijä'), f('created_by', staffSelect)) : null,
  ));

  async function load() {
    tableBox.replaceChildren(h('div', { class: 'loading' }, 'Ladataan…'));
    const qs = new URLSearchParams({ limit: PAGE, offset: listState.offset });
    for (const k of ['from', 'to', 'project_id', 'type', 'created_by']) if (listState[k]) qs.set(k, listState[k]);
    const r = await api('/encounters?' + qs);
    stats.replaceChildren(
      h('div', { class: 'stat' }, h('b', null, fmtNum(r.totalEncounters)), h('span', null, 'kohtaamista')),
      h('div', { class: 'stat' }, h('b', null, fmtNum(r.total)), h('span', null, 'kirjausta (lomaketallennusta)')));
    if (!r.rows.length) { tableBox.replaceChildren(h('div', { class: 'card empty' }, 'Ei kirjauksia valituilla rajauksilla.')); pager.replaceChildren(); return; }
    tableBox.replaceChildren(h('div', { class: 'table-wrap' }, h('table', { class: 'cards-mobile' },
      h('thead', null, h('tr', null, h('th', null, 'Ajankohta · hanke'), h('th', null, 'Tyyppi'),
        h('th', { class: 'num' }, 'Kohtaamisia'), h('th', { class: 'num' }, 'Henkilöitä'), p.viewScope !== 'own' ? h('th', null, 'Toteuttaja') : null, h('th', null, 'Tallennettu'))),
      h('tbody', null, r.rows.map(row => h('tr', { class: 'clickable', tabindex: '0', onclick: () => go('#/kirjaukset/' + row.id),
        onkeydown: (e) => { if (e.key === 'Enter') go('#/kirjaukset/' + row.id); } },
        h('td', { class: 'cell-title' }, h('strong', null, fmtDate(row.encounter_date)), ' · ', projectDot(me.projects.find(x => x.id === row.project_id)), row.project_name, row.is_test ? [' ', h('span', { class: 'badge grey' }, 'testi')] : null),
        h('td', { 'data-label': 'Tyyppi' }, h('span', { class: 'badge ' + (row.encounter_type === 'ryhma' ? 'blue' : '') }, typeLabel(row.encounter_type))),
        h('td', { class: 'num', 'data-label': 'Kohtaamisia' }, fmtNum(row.encounter_count)), h('td', { class: 'num', 'data-label': 'Henkilöitä' }, row.person_count == null ? '–' : fmtNum(row.person_count)),
        p.viewScope !== 'own' ? h('td', { 'data-label': 'Toteuttaja' }, row.performer_type === VOLUNTEER ? 'Vapaaehtoinen' : (row.performed_by_name || row.created_by_name),
          row.performer_type === VOLUNTEER || (row.performed_by && row.performed_by !== row.created_by) ? h('span', { class: 'small muted block' }, `kirjannut ${row.created_by_name}`) : null) : null,
        h('td', { class: 'small muted', 'data-label': 'Tallennettu' }, fmtDateTime(row.created_at), row.updated_at ? h('span', { class: 'badge grey' }, ' korjattu') : null)))))));
    const end = Math.min(listState.offset + PAGE, r.total);
    pager.replaceChildren(h('span', { class: 'small muted' }, `Näytetään ${listState.offset + 1}–${end} / ${r.total}`),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-secondary btn-sm', disabled: listState.offset === 0, onclick: () => { listState.offset -= PAGE; load(); } }, '← Edelliset'),
        h('button', { class: 'btn btn-secondary btn-sm', disabled: end >= r.total, onclick: () => { listState.offset += PAGE; load(); } }, 'Seuraavat →')));
  }

  $app.replaceChildren(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, p.viewScope === 'own' ? 'Omat kirjaukset' : 'Kirjaukset'),
      h('p', { class: 'muted' }, p.viewScope === 'own' ? 'Näet tekemäsi kirjaukset. Korjaustarpeista ilmoita tiiminvetäjälle.' :
        p.viewScope === 'projects' ? 'Hankkeidesi kaikki kirjaukset.' : 'Kaikkien hankkeiden kirjaukset.')),
      p.exportScope !== 'none' ? h('a', { class: 'btn btn-secondary', href: '#/vienti' }, 'Lataa Excel') : null),
    filters, stats, tableBox, pager);
  await load();
}

async function viewDetail(id) {
  $app.classList.add('container');
  const { encounter: e, questions } = await api('/encounters/' + id);
  const project = state.me.projects.find(p => p.id === e.project_id);
  const showAnswer = (q) => {
    const v = e.answers[q.key];
    if (v == null) return null;
    return [h('dt', null, q.label, !q.active ? h('span', { class: 'badge grey' }, ' poistunut kysymys') : null),
      h('dd', null, Array.isArray(v) ? v.join(', ') : q.type === 'date' ? fmtDate(v) : v)];
  };
  const common = questions.filter(q => q.project_id == null).map(showAnswer).filter(Boolean);
  const own = questions.filter(q => q.project_id != null).map(showAnswer).filter(Boolean);

  const delBtn = e.canDelete ? h('button', { class: 'btn btn-danger', type: 'button', onclick: async (ev) => {
    const b = ev.currentTarget;
    if (!b.classList.contains('confirming')) { b.classList.add('confirming'); b.textContent = 'Vahvista poisto'; setTimeout(() => { b.classList.remove('confirming'); b.textContent = 'Poista kirjaus'; }, 4000); return; }
    try { await api('/encounters/' + e.id, { method: 'DELETE' }); toast('Kirjaus poistettu.'); go('#/kirjaukset'); } catch (ex) { toast(ex.message, true); }
  } }, 'Poista kirjaus') : null;

  $app.replaceChildren(h('div', { class: 'narrow' },
    h('p', null, h('a', { href: '#/kirjaukset' }, '← Takaisin kirjauksiin')),
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, `${fmtDate(e.encounter_date)} · ${project ? project.name : ''}`),
      h('p', { class: 'muted small' }, `Tunniste ${e.id}`)),
      h('div', { class: 'actions' }, e.canEdit ? h('a', { class: 'btn btn-primary', href: `#/kirjaukset/${e.id}/muokkaa` }, 'Korjaa') : null, delBtn)),
    h('div', { class: 'card' }, h('h2', null, 'Perustiedot'), h('dl', { class: 'kv' },
      h('dt', null, 'Tyyppi'), h('dd', null, typeLabel(e.encounter_type)),
      h('dt', null, 'Kohtaamisten määrä'), h('dd', null, fmtNum(e.encounter_count)),
      e.encounter_type === 'ryhma' ? [h('dt', null, 'Eri osallistujien määrä'), h('dd', null, e.person_count == null ? 'Ei tiedossa' : fmtNum(e.person_count))] : null,
      e.encounter_type === 'yksilo' ? [h('dt', null, 'Asiakkaan tunniste'), h('dd', null, e.client_linked ? 'Tunnistettu asiakas (tunniste suojattu)' : 'Ei tunnistetta')] : null,
      e.referrals && e.referrals.length ? [h('dt', null, 'Ohjattu palveluun'), h('dd', null, e.referrals.map(r => h('div', null, r.service, ' ', referralBadge(r.status))))] : null,
      e.referral_updates && e.referral_updates.length ? [h('dt', null, 'Kuitatut ohjaukset'), h('dd', null, e.referral_updates.map(r => h('div', null, `${r.service} (ohjattu ${fmtDate(r.referred_on)}) `, referralBadge(r.status))))] : null,
      h('dt', null, 'Kohtaamisen toteutti'), h('dd', null, e.performer_type === VOLUNTEER ? 'Vapaaehtoinen, vertainen tai kokemusasiantuntija' : (e.performed_by_name || '–')),
      h('dt', null, 'Toteuttajan rooli'), h('dd', null, e.recorder_role),
      h('dt', null, 'Kirjaaja'), h('dd', null, e.created_by_name || '–'),
      h('dt', null, 'Tallennettu'), h('dd', null, fmtDateTime(e.created_at)),
      e.updated_at ? [h('dt', null, 'Korjattu'), h('dd', null, fmtDateTime(e.updated_at))] : null)),
    common.length ? h('div', { class: 'card' }, h('h2', null, 'Yhteiset kysymykset'), h('dl', { class: 'kv' }, common)) : null,
    own.length ? h('div', { class: 'card' }, h('h2', null, 'Hankekohtaiset kysymykset'), h('dl', { class: 'kv' }, own)) : null,
  ));
}

const REF_STATUS = { avoin: ['Avoin', 'blue'], toteutui: ['Toteutui', 'green'], ei_toteutunut: ['Ei toteutunut', 'red'], ei_seurattavissa: ['Ei seurattavissa', 'grey'] };
const referralBadge = (st) => h('span', { class: 'badge ' + (REF_STATUS[st] || ['', ''])[1] }, (REF_STATUS[st] || [st])[0]);

async function viewEdit(id) {
  const [{ encounter: e }, { questions, members }] = await Promise.all([api('/encounters/' + id), loadForm()]);
  if (!e.canEdit) return go('#/kirjaukset/' + id);
  renderEncounterForm({ questions, members, initial: e, title: 'Korjaa kirjausta', submitLabel: 'Tallenna korjaukset',
    onCancel: () => go('#/kirjaukset/' + id),
    onSubmit: async (payload) => { await api('/encounters/' + id, { method: 'PUT', body: payload }); toast('Korjaukset tallennettu.'); go('#/kirjaukset/' + id); } });
}

// ---------------------------------------------------------------------------
// Työntekijäkohtainen seuranta
// ---------------------------------------------------------------------------
const staffState = { from: '', to: '', project_id: '', sort: 'encounters', dir: -1 };
const fmtAvg = (v) => (v == null ? '–' : Number(v).toLocaleString('fi-FI', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
const fmtMonth = (m) => { const [y, mm] = m.split('-'); return ['tammi', 'helmi', 'maalis', 'huhti', 'touko', 'kesä', 'heinä', 'elo', 'syys', 'loka', 'marras', 'joulu'][+mm - 1] + ' ' + y.slice(2); };
const roleBadge = (u) => [h('span', { class: 'badge blue' }, state.me.roles[u.role] || u.role),
  u.is_test ? [' ', h('span', { class: 'badge grey' }, 'testi')] : null, !u.active && !u.is_test ? [' ', h('span', { class: 'badge grey' }, 'suljettu')] : null];

function staffFilterBar(onChange, st = staffState) {
  const staffState = st;
  if (!staffState.from) { staffState.from = state.me.today.slice(0, 4) + '-01-01'; staffState.to = state.me.today; }
  const f = (key, el) => { el.value = staffState[key]; el.addEventListener('change', () => { staffState[key] = el.value; onChange(); }); return el; };
  const presets = [['Tämä vuosi', () => [state.me.today.slice(0, 4) + '-01-01', state.me.today]],
    ['30 pv', () => [isoDaysAgo(29), state.me.today]], ['Tämä kk', () => [state.me.today.slice(0, 8) + '01', state.me.today]]];
  const fromEl = f('from', h('input', { type: 'date', id: 's-from' })), toEl = f('to', h('input', { type: 'date', id: 's-to' }));
  return h('div', { class: 'card' }, h('div', { class: 'filters' },
    h('div', { class: 'field' }, h('label', { for: 's-from' }, 'Alkaen'), fromEl),
    h('div', { class: 'field' }, h('label', { for: 's-to' }, 'Päättyen'), toEl),
    state.me.projects.length > 1 ? h('div', { class: 'field' }, h('label', { for: 's-proj' }, 'Hanke'),
      f('project_id', h('select', { id: 's-proj' }, h('option', { value: '' }, 'Kaikki hankkeet'), state.me.projects.map(x => h('option', { value: x.id }, x.name))))) : null),
    h('div', { class: 'actions presets' }, presets.map(([label, fn]) => h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => {
      [staffState.from, staffState.to] = fn(); fromEl.value = staffState.from; toEl.value = staffState.to; onChange(); } }, label))));
}
function isoDaysAgo(n) { const d = new Date(state.me.today + 'T12:00:00'); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
function staffQuery() {
  const q = new URLSearchParams();
  for (const k of ['from', 'to', 'project_id']) if (staffState[k]) q.set(k, staffState[k]);
  return q.toString();
}

async function viewStaff() {
  const p = state.me.permissions;
  const box = h('div');
  const COLS = [
    ['name', 'Työntekijä', false], ['encounters', 'Kohtaamisia', true], ['rows', 'Kirjauksia', true], ['yksilo_rows', 'Yksilö', true],
    ['ryhma_rows', 'Ryhmiä', true], ['active_days', 'Aktiivipäiviä', true], ['per_day', 'Kohtaamisia / aktiivipäivä', true],
    ['worker_rating', 'Työntekijän arvio ka.', true], ['client_rating', 'Asiakkaan arvio ka.', true], ['last_date', 'Viimeisin kohtaaminen', false],
  ];
  async function load() {
    box.replaceChildren(h('div', { class: 'loading' }, 'Ladataan…'));
    const { rows, totals } = await api('/staff?' + staffQuery());
    rows.forEach(r => { r.per_day = r.active_days ? r.encounters / r.active_days : null; });
    const sorted = [...rows].sort((a, b) => {
      const k = staffState.sort; const va = a[k], vb = b[k];
      if (va == null && vb == null) return 0; if (va == null) return 1; if (vb == null) return -1;
      return (typeof va === 'string' ? va.localeCompare(vb, 'fi') : va - vb) * staffState.dir;
    });
    const noRecords = rows.filter(r => r.rows === 0).length;
    box.replaceChildren(
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('b', null, fmtNum(totals.encounters)), h('span', null, 'kohtaamista')),
        h('div', { class: 'stat' }, h('b', null, fmtNum(totals.rows)), h('span', null, 'kirjausta')),
        h('div', { class: 'stat' }, h('b', null, fmtNum(rows.length - noRecords)), h('span', null, `kirjaajaa${noRecords ? ` · ${noRecords} ilman kirjauksia` : ''}`))),
      !rows.length ? h('div', { class: 'card empty' }, 'Ei työntekijöitä valituilla rajauksilla.') :
      h('div', { class: 'table-wrap' }, h('table', { class: 'cards-mobile staff-table' },
        h('thead', null, h('tr', null, COLS.map(([k, label, num]) => h('th', { class: num ? 'num' : null, 'aria-sort': staffState.sort === k ? (staffState.dir > 0 ? 'ascending' : 'descending') : null },
          h('button', { type: 'button', class: 'sort-btn' + (staffState.sort === k ? ' active' : ''), onclick: () => {
            if (staffState.sort === k) staffState.dir *= -1; else { staffState.sort = k; staffState.dir = num ? -1 : 1; } load(); } },
            label, staffState.sort === k ? (staffState.dir > 0 ? ' ▲' : ' ▼') : ''))))),
        h('tbody', null, sorted.map(r => h('tr', { class: 'clickable' + (r.rows ? '' : ' dim'), tabindex: '0', onclick: () => go('#/tyontekijat/' + r.id),
          onkeydown: (e) => { if (e.key === 'Enter') go('#/tyontekijat/' + r.id); } },
          h('td', { class: 'cell-title' }, h('strong', null, r.name), ' ', roleBadge(r)),
          h('td', { class: 'num', 'data-label': 'Kohtaamisia' }, h('strong', null, fmtNum(r.encounters))),
          h('td', { class: 'num', 'data-label': 'Kirjauksia' }, fmtNum(r.rows)),
          h('td', { class: 'num hide-m', 'data-label': 'Yksilö' }, fmtNum(r.yksilo_rows)),
          h('td', { class: 'num hide-m', 'data-label': 'Ryhmiä' }, fmtNum(r.ryhma_rows)),
          h('td', { class: 'num', 'data-label': 'Aktiivipäiviä' }, fmtNum(r.active_days)),
          h('td', { class: 'num hide-m', 'data-label': 'Kohtaamisia / aktiivipäivä' }, fmtAvg(r.per_day)),
          h('td', { class: 'num', 'data-label': 'Työntekijän arvio ka.' }, fmtAvg(r.worker_rating)),
          h('td', { class: 'num', 'data-label': 'Asiakkaan arvio ka.' }, r.client_rating == null ? '–' : `${fmtAvg(r.client_rating)} (${r.client_rating_n})`),
          h('td', { 'data-label': 'Viimeisin kohtaaminen' }, r.last_date ? fmtDate(r.last_date) : h('span', { class: 'muted' }, 'ei kirjauksia'))))))));
  }
  $app.replaceChildren(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Työntekijät'),
      h('p', { class: 'muted' }, p.staffScope === 'all' ? 'Kirjaukset työntekijöittäin kaikista hankkeista.' : 'Kirjaukset työntekijöittäin hankkeistasi. Luvut sisältävät vain hankkeidesi kirjaukset.'))),
    staffFilterBar(load), box);
  await load();
}

async function viewStaffDetail(id) {
  const box = h('div');
  const head = h('div');
  async function load() {
    box.replaceChildren(h('div', { class: 'loading' }, 'Ladataan…'));
    const d = await api(`/staff/${id}?` + staffQuery());
    const k = d.kpi;
    head.replaceChildren(h('p', null, h('a', { href: '#/tyontekijat' }, '← Kaikki työntekijät')),
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, d.user.name), h('p', { class: 'muted' }, roleBadge(d.user), ' ', d.user.recorder_role)),
        state.me.permissions.viewScope !== 'none' ? h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => {
          Object.assign(listState, { from: staffState.from, to: staffState.to, project_id: staffState.project_id, type: '', created_by: String(id), offset: 0 });
          go('#/kirjaukset'); } }, 'Näytä kirjaukset') : null));
    if (!k.rows) { box.replaceChildren(h('div', { class: 'card empty' }, 'Ei kirjauksia valitulla aikavälillä.')); return; }
    const tile = (v, label, sub) => h('div', { class: 'stat' }, h('b', null, v), h('span', null, label), sub ? h('small', null, sub) : null);
    box.replaceChildren(
      h('div', { class: 'stats stats-grid' },
        tile(fmtNum(k.encounters), 'kohtaamista', `${fmtNum(k.rows)} kirjausta`),
        tile(fmtNum(k.active_days), 'aktiivipäivää', `${fmtAvg(k.encounters / k.active_days)} kohtaamista / päivä`),
        tile(fmtNum(k.yksilo_rows), 'yksilökohtaamista', k.distinct_pseudonyms ? `${fmtNum(k.distinct_pseudonyms)} eri tunnistettua asiakasta` : null),
        tile(fmtNum(k.ryhma_rows), 'ryhmää', k.ryhma_rows ? `${fmtNum(k.ryhma_encounters)} kohtaamista, ${fmtNum(k.ryhma_persons)} osallistujaa` : null),
        tile(fmtAvg(k.worker_rating), 'oma arvio hyödystä ka.', 'asteikko 1–5'),
        tile(fmtAvg(k.client_rating), 'asiakkaan arvio ka.', k.client_rating_n ? `${fmtNum(k.client_rating_n)} arviota` : 'ei arvioita'),
        tile(k.avg_delay_days == null ? '–' : fmtAvg(Math.max(0, k.avg_delay_days)), 'pv kirjausviive ka.', 'kohtaamisesta tallennukseen'),
        tile(fmtDate(k.last_date), 'viimeisin kohtaaminen', `ensimmäinen ${fmtDate(k.first_date)}`)),
      h('div', { class: 'card' }, h('h2', null, 'Kohtaamiset kuukausittain'), monthChart(fillMonths(d.monthly, staffState.from || k.first_date, staffState.to || k.last_date))),
      h('div', { class: 'grid-2' },
        h('div', { class: 'card' }, h('h2', null, 'Hankkeittain'), hBars(d.byProject.map(x => ({ label: x.name, value: x.encounters, sub: `${fmtNum(x.rows)} kirjausta` })))),
        h('div', { class: 'card' }, h('h2', null, 'Kohtaamisen sijainti'), d.byLocation.length ? hBars(d.byLocation.map(x => ({ label: x.name, value: x.encounters, sub: `${fmtNum(x.rows)} kirjausta` }))) : h('p', { class: 'muted' }, 'Ei tietoa.')),
        h('div', { class: 'card' }, h('h2', null, 'Oma arvio kohtaamisen hyödystä'),
          hBars([1, 2, 3, 4, 5].map(v => ({ label: String(v), value: (d.workerRatings.find(r => Number(r.rating) === v) || { n: 0 }).n, sub: 'kirjausta' })), { keepOrder: true, unit: 'kirjausta', compact: true }))));
  }
  $app.replaceChildren(head, staffFilterBar(load), box);
  await load();
}

// Täydentää puuttuvat kuukaudet nollilla (enintään 36 kk)
function fillMonths(rows, from, to) {
  const map = new Map(rows.map(r => [r.month, r]));
  const out = []; let [y, m] = from.slice(0, 7).split('-').map(Number); const end = to.slice(0, 7);
  for (let i = 0; i < 36; i++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out.push(map.get(key) || { month: key, rows: 0, encounters: 0, yksilo: 0, ryhma: 0 });
    if (key >= end) break; m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

// Pylväskaavio (yksi sarja), SVG + hover-tooltip + taulukkonäkymä
function monthChart(data) {
  const NS = 'http://www.w3.org/2000/svg';
  const s = (tag, attrs) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v); return el; };
  const narrow = window.matchMedia('(max-width: 640px)').matches;
  const W = narrow ? 340 : 720, H = narrow ? 200 : 240, L = narrow ? 30 : 40, R = 6, T = 12, B = 26;
  const max = Math.max(1, ...data.map(d => d.encounters));
  const step = niceStep(max); const top = Math.ceil(max / step) * step;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Kohtaamiset kuukausittain' });
  const y = (v) => T + (H - T - B) * (1 - v / top);
  for (let v = 0; v <= top; v += step) {
    svg.append(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'grid' }));
    const t = s('text', { x: L - 6, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' }); t.textContent = fmtNum(v); svg.append(t);
  }
  const bw = (W - L - R) / data.length; const barW = Math.min(36, bw * 0.62);
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const labelEvery = Math.max(1, Math.ceil(data.length / (narrow ? 4 : 8)));
  data.forEach((d, i) => {
    const cx = L + bw * i + bw / 2; const yy = y(d.encounters); const hgt = H - B - yy;
    if (d.encounters > 0) {
      const r = Math.min(4, barW / 2, hgt);
      svg.append(s('path', { class: 'bar', d: `M${cx - barW / 2},${H - B} V${yy + r} Q${cx - barW / 2},${yy} ${cx - barW / 2 + r},${yy} H${cx + barW / 2 - r} Q${cx + barW / 2},${yy} ${cx + barW / 2},${yy + r} V${H - B} Z` }));
    }
    if (i % labelEvery === 0) { const t = s('text', { x: cx, y: H - 8, class: 'tick', 'text-anchor': 'middle' }); t.textContent = fmtMonth(d.month); svg.append(t); }
    const hit = s('rect', { x: L + bw * i, y: T, width: bw, height: H - T - B, class: 'hit', tabindex: '0' });
    const show = () => {
      tip.replaceChildren(h('strong', null, fmtMonth(d.month)), h('div', null, `${fmtNum(d.encounters)} kohtaamista`),
        h('div', { class: 'muted' }, `${fmtNum(d.rows)} kirjausta · yksilö ${fmtNum(d.yksilo)} · ryhmä ${fmtNum(d.ryhma)}`));
      tip.hidden = false; tip.style.left = `${(cx / W) * 100}%`; tip.style.top = `${(yy / H) * 100}%`;
      hit.classList.add('on');
    };
    const hide = () => { tip.hidden = true; hit.classList.remove('on'); };
    hit.addEventListener('mouseenter', show); hit.addEventListener('focus', show);
    hit.addEventListener('mouseleave', hide); hit.addEventListener('blur', hide);
    hit.addEventListener('touchstart', show, { passive: true });
    svg.append(hit);
  });
  const table = h('details', { class: 'chart-table' }, h('summary', null, 'Näytä taulukkona'),
    h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Kuukausi'), h('th', { class: 'num' }, 'Kohtaamisia'),
      h('th', { class: 'num' }, 'Kirjauksia'), h('th', { class: 'num' }, 'Yksilö'), h('th', { class: 'num' }, 'Ryhmä'))),
      h('tbody', null, data.map(d => h('tr', null, h('td', null, fmtMonth(d.month)), h('td', { class: 'num' }, fmtNum(d.encounters)),
        h('td', { class: 'num' }, fmtNum(d.rows)), h('td', { class: 'num' }, fmtNum(d.yksilo)), h('td', { class: 'num' }, fmtNum(d.ryhma))))))));
  return h('div', null, h('div', { class: 'chart-wrap' }, svg, tip), table);
}
function niceStep(max) { const raw = max / 4; const p = 10 ** Math.floor(Math.log10(raw)); const n = raw / p; return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p); }

// Vaakapylväät HTML:nä (yksi sarja, arvo tekstinä)
function hBars(items, opts = {}) {
  const max = Math.max(1, ...items.map(i => i.value));
  return h('div', { class: 'hbars' + (opts.compact ? ' compact' : '') }, items.map(i => h('div', { class: 'hbar', title: `${i.label}: ${fmtNum(i.value)}${opts.unit ? ' ' + opts.unit : ''}` },
    h('div', { class: 'hbar-label' }, i.label),
    h('div', { class: 'hbar-track' }, i.value > 0 ? (() => { const el = h('div', { class: 'hbar-fill' }); el.style.width = `${(i.value / max) * 100}%`; return el; })() : null),
    h('div', { class: 'hbar-value' }, fmtNum(i.value)))));
}

// ---------------------------------------------------------------------------
// Tilastot (dashboard) – määrittelydokumentin mallin mukaan
// ---------------------------------------------------------------------------
const dashState = { from: '', to: '', project_id: '', types: ['yksilo', 'ryhma'], role: '', ika: '', sukupuoli: '', compare: 'none' };
const COMPARE = { none: 'Ei vertailua', prev: 'Edellinen jakso', year: 'Vuotta aiemmin' };
const SERIES = [
  { key: 'encounters', label: 'Kohtaamiset yhteensä', cls: 's1' },
  { key: 'yksilo', label: 'Yksilökohtaaminen', cls: 's2' },
  { key: 'ryhma', label: 'Ryhmä', cls: 's3' },
];
const svgEl = (tag, attrs) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v); return el; };
const infoTip = (text) => h('details', { class: 'info' }, h('summary', { 'aria-label': 'Lisätietoa' }, 'i'), h('div', { class: 'info-body' }, text));
// Muutos vertailujaksoon; näytetään vain, kun vertailu on valittu (prev === undefined → ei mitään)
function changeBadge(cur, prev, label) {
  if (prev === undefined) return null;
  if (!prev) return h('p', { class: 'kpi-change muted' }, `vertailujaksolla (${label}) ei kirjauksia`);
  const pct = Math.round(((cur - prev) / prev) * 100);
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  return h('p', { class: 'kpi-change ' + dir }, h('strong', null, `${pct > 0 ? '↑ +' : pct < 0 ? '↓ ' : '→ '}${pct} %`),
    h('span', null, ` (${fmtNum(prev)}) vertailujaksoon ${label}`));
}

async function viewDashboard() {
  const me = state.me; const p = me.permissions;
  if (!dashState.from) { dashState.from = me.today.slice(0, 4) + '-01-01'; dashState.to = me.today; }
  const body = h('div', { class: 'dash-body' });
  const updated = h('p', { class: 'dash-updated' });
  let opts = null;
  const filterBox = h('div', { class: 'card dash-filters' });
  let filtersOpen = window.matchMedia('(min-width: 641px)').matches;

  function query() {
    const q = new URLSearchParams({ from: dashState.from, to: dashState.to, types: dashState.types.join(',') });
    for (const k of ['project_id', 'role', 'ika', 'sukupuoli']) if (dashState[k]) q.set(k, dashState[k]);
    if (dashState.compare !== 'none') q.set('compare', dashState.compare);
    return q;
  }
  function drawFilters() {
    const sel = (key, id, label, items, allLabel) => h('div', { class: 'field' }, h('label', { for: id }, label),
      (() => { const el = h('select', { id }, h('option', { value: '' }, allLabel), items.map(([v, t]) => h('option', { value: v, selected: String(dashState[key]) === String(v) }, t)));
        el.addEventListener('change', () => { dashState[key] = el.value; load(); }); return el; })());
    const date = (key, id, label) => h('div', { class: 'field' }, h('label', { for: id }, label),
      (() => { const el = h('input', { type: 'date', id, value: dashState[key] }); el.addEventListener('change', () => { if (el.value) { dashState[key] = el.value; load(); } }); return el; })());
    const y = me.today.slice(0, 4);
    const presets = [['Tämä vuosi', `${y}-01-01`, me.today], ['Edellinen vuosi', `${+y - 1}-01-01`, `${+y - 1}-12-31`],
      ['30 pv', isoDaysAgo(29), me.today], ['Tämä kk', me.today.slice(0, 8) + '01', me.today]];
    const typeBox = (v, t) => { const el = h('input', { type: 'checkbox', checked: dashState.types.includes(v) });
      el.addEventListener('change', () => { const set = new Set(dashState.types); el.checked ? set.add(v) : set.delete(v);
        if (!set.size) { el.checked = true; return; } dashState.types = ['yksilo', 'ryhma'].filter(x => set.has(x)); load(); });
      return h('label', { class: 'opt' }, el, h('span', null, t)); };
    const active = ['project_id', 'role', 'ika', 'sukupuoli'].filter(k => dashState[k]).length + (dashState.types.length < 2 ? 1 : 0);
    const det = h('details', { class: 'dash-filter-details', open: filtersOpen || null },
      h('summary', null, `Rajaukset · ${fmtDate(dashState.from)}–${fmtDate(dashState.to)}${active ? ` · ${active} lisärajausta` : ''}${dashState.compare !== 'none' ? ' · vertailu' : ''}`));
    det.addEventListener('toggle', () => { filtersOpen = det.open; });
    filterBox.replaceChildren(det);
    det.append(
      h('div', { class: 'filters dash-filter-grid' },
        date('from', 'd-from', 'Alkaen'), date('to', 'd-to', 'Päättyen'),
        me.projects.length > 1 ? sel('project_id', 'd-proj', 'Hanke', me.projects.map(x => [x.id, x.name]), 'Kaikki hankkeet') : null,
        sel('role', 'd-role', 'Kirjaajan rooli', opts.roles.map(r => [r, r]), 'Kaikki'),
        sel('ika', 'd-ika', 'Ikä (arvio)', opts.ika.map(r => [r, r]), 'Kaikki'),
        sel('sukupuoli', 'd-sp', 'Sukupuoli', opts.sukupuoli.map(r => [r, r]), 'Kaikki')),
      h('div', { class: 'dash-filter-row' },
        h('div', { class: 'actions presets' }, presets.map(([t, f, to]) => h('button', { type: 'button',
          class: 'btn btn-sm ' + (dashState.from === f && dashState.to === to ? 'btn-primary' : 'btn-secondary'),
          onclick: () => { dashState.from = f; dashState.to = to; load(); } }, t))),
        h('div', { class: 'type-checks', role: 'group', 'aria-label': 'Kohtaamisen tyyppi' }, h('span', { class: 'label' }, 'Kohtaamisen tyyppi'),
          typeBox('yksilo', 'Yksilökohtaaminen'), typeBox('ryhma', 'Ryhmä'))),
      // Vertailu pikavalintojen alle, Excel-vienti oikealle
      h('div', { class: 'dash-filter-row dash-filter-bottom' },
        h('div', { class: 'field cmp-field' }, h('label', { for: 'd-cmp' }, 'Vertailu'),
          (() => { const el = h('select', { id: 'd-cmp' }, Object.entries(COMPARE).map(([v, t]) => h('option', { value: v, selected: dashState.compare === v }, t)));
            el.addEventListener('change', () => { dashState.compare = el.value; load(); }); return el; })()),
        p.exportScope !== 'none' ? h('a', { class: 'btn btn-secondary', href: '/api/export?' + new URLSearchParams({ from: dashState.from, to: dashState.to, projects: dashState.project_id || '' }),
          title: 'Raakadata valitulta aikaväliltä ja hankkeelta (muut rajaukset eivät koske vientiä)' }, '⤓ Lataa raakadata (Excel)') : null));
  }

  async function load() {
    body.classList.add('refreshing');
    let d;
    try { d = await api('/dashboard?' + query()); } catch (ex) { body.classList.remove('refreshing'); toast(ex.message, true); return; }
    opts = d.options; drawFilters();
    updated.textContent = d.updated ? `Uusin kirjaus tallennettu ${fmtDateTime(d.updated)}` : 'Ei kirjauksia valituilla rajauksilla';
    const T = d.totals, P = d.previous || {};
    const cmpOn = !!d.previous;
    const prevLabel = cmpOn ? `${fmtDate(d.period.prevFrom)}–${fmtDate(d.period.prevTo)}` : '';
    const pv = (k) => (cmpOn ? P[k] : undefined);
    const cmpText = (k) => (cmpOn ? ` Vertailujakso ${prevLabel}: ${fmtNum(P[k])}.` : '');
    const kpi1 = h('div', { class: 'card kpi' }, h('div', { class: 'kpi-head' }, h('h2', null, 'Kohtaamiset yhteensä'),
        infoTip(`Kaikkien kirjausten kohtaamisten summa (ryhmäkirjaukset mukaan lukien). ${fmtNum(T.rows)} lomaketallennusta.${cmpText('encounters')}`)),
      h('p', { class: 'kpi-value' }, fmtNum(T.encounters)), changeBadge(T.encounters, pv('encounters'), prevLabel));
    const kpi2 = h('div', { class: 'card kpi kpi-alt' }, h('div', { class: 'kpi-head' }, h('h2', null, 'Eri henkilöiden määrä (arvio)'),
        infoTip(`Arvio = tunnistetut asiakkaat (${fmtNum(T.identified)}) + ryhmien ilmoitetut osallistujat (${fmtNum(T.group_persons)}). `
          + `Täysin anonyymit kohtaamiset (${fmtNum(T.anonymous)}) eivät sisälly arvioon: yksilökohtaamiset ilman nimimerkkiä (${fmtNum(T.anon_individual)}) `
          + `ja kohtaamiset ryhmissä, joista osallistujamäärä puuttuu (${fmtNum(T.anon_group)}, ${fmtNum(T.groups_without_count)} ryhmäkirjausta). `
          + `Sama henkilö voi sisältyä useamman ryhmän lukuun.${cmpText('persons')}`)),
      h('p', { class: 'kpi-value' }, fmtNum(T.persons)), changeBadge(T.persons, pv('persons'), prevLabel),
      T.encounters ? h('div', { class: 'kpi-anon' },
        h('div', { class: 'anon-bar', role: 'img', 'aria-label': `${fmtPct(T.anonymous_share)} kohtaamisista täysin anonyymejä` },
          (() => { const el = h('span'); el.style.width = `${Math.round((T.anonymous_share || 0) * 100)}%`; return el; })()),
        h('p', { class: 'kpi-note' }, h('strong', null, `${fmtNum(T.anonymous)} / ${fmtNum(T.encounters)}`), ` kohtaamisesta (${fmtPct(T.anonymous_share)}) täysin anonyymejä – eivät sisälly arvioon`),
        h('p', { class: 'kpi-note sub' }, `yksilö ilman nimimerkkiä ${fmtNum(T.anon_individual)} · ryhmät ilman osallistujamäärää ${fmtNum(T.anon_group)}`)) : null);
    const donutCard = h('div', { class: 'card' }, h('div', { class: 'kpi-head' }, h('h2', null, 'Kohtaamisen tyyppi'),
      infoTip('Kohtaamisten määrä yksilö- ja ryhmäkirjauksissa.')), donut([{ label: 'Yksilökohtaaminen', value: T.yksilo, cls: 's1' }, { label: 'Ryhmä', value: T.ryhma, cls: 's2' }]));

    const R = d.ratings;
    const ratingBlock = (title, r) => h('div', { class: 'rating-sum' }, h('p', { class: 'kpi-value small-kpi' }, fmtAvg(r.avg)),
      h('p', { class: 'muted small' }, `${title} · ${fmtNum(r.n)} arviota`), r.n ? hBars(r.dist.map(x => ({ label: String(x.value), value: x.n })), { compact: true, unit: 'arviota' }) : null);
    body.replaceChildren(...[
      !T.rows ? h('div', { class: 'notice info' }, 'Valituilla rajauksilla ei ole kirjauksia.') : null,
      h('div', { class: 'dash-row r1' }, kpi1, kpi2, donutCard),
      h('div', { class: 'dash-row r2' },
        h('div', { class: 'card' }, h('div', { class: 'kpi-head' }, h('h2', null, 'Kohtaamisten määrä kuukausittain'),
          infoTip('Kohtaamiset kohtaamisen ajankohdan mukaan. Vie osoitin kaavion päälle nähdäksesi kuukauden luvut.')),
          lineChart(fillMonths(d.monthly, d.period.from, d.period.to), dashState.types,
            cmpOn ? { data: fillMonths(d.monthlyPrev, d.period.prevFrom, d.period.prevTo), label: `Vertailujakso ${prevLabel}` } : null)),
        h('div', { class: 'card' }, h('div', { class: 'kpi-head' }, h('h2', null, 'Kohtaamiset hankkeittain'),
          infoTip('Kohtaamisten määrä hankkeittain valituilla rajauksilla.')),
          d.byProject.length ? hBars(d.byProject.map(x => ({ label: x.name, value: x.encounters })), { unit: 'kohtaamista' }) : h('p', { class: 'muted' }, 'Ei kirjauksia.'))),
      h('div', { class: 'dash-row r3' },
        h('div', { class: 'card' }, h('div', { class: 'kpi-head' }, h('h2', null, 'Arviot kohtaamisen hyödystä'),
          infoTip('Asteikko 1–5 (1 = ei lainkaan hyötyä, 5 = erittäin hyödyllinen). Asiakkaan arvio vain, jos se on kysytty.')),
          h('div', { class: 'grid-2 tight' }, ratingBlock('Työntekijän arvio, keskiarvo', R.worker), ratingBlock('Asiakkaan arvio, keskiarvo', R.client))),
        h('div', { class: 'card' }, h('div', { class: 'kpi-head' }, h('h2', null, 'Palveluohjaukset'),
          infoTip('Yksilökohtaamisissa tehdyt palveluohjaukset. Toteutumisaste = toteutuneet / (toteutuneet + ei toteutuneet).')),
          h('p', { class: 'kpi-value small-kpi' }, fmtNum(d.referrals.total)), h('p', { class: 'muted small' }, 'ohjausta'),
          h('p', null, h('strong', null, fmtPct(d.referrals.rate)), ' toteutumisaste', h('span', { class: 'muted' }, ` · ${fmtNum(d.referrals.toteutui)} toteutui, ${fmtNum(d.referrals.ei_toteutunut)} ei, ${fmtNum(d.referrals.avoin)} avoinna`)),
          p.pathScope !== 'none' ? h('a', { href: '#/asiakaspolut' }, 'Asiakaspolut ja ohjaukset palveluittain →') : null)),
      d.distributions.length ? h('h2', { class: 'sub-head' }, dashState.project_id ? 'Vastausjakaumat (yhteiset ja hankekohtaiset kysymykset)' : 'Vastausjakaumat (yhteiset kysymykset – valitse hanke nähdäksesi hankekohtaiset)') : null,
      d.distributions.length ? h('div', { class: 'dist-grid' }, d.distributions.map(q => h('div', { class: 'card' },
        h('h3', null, q.label, q.project ? h('span', { class: 'tag' }, ' hankekohtainen') : null),
        h('p', { class: 'muted small' }, `${fmtNum(q.answered)} kirjausta vastannut${q.multiple ? ' · voi valita useita' : ''}`),
        hBars(q.items, { keepOrder: true, unit: 'kirjausta' })))) : null,
    ].filter(Boolean));
    body.classList.remove('refreshing');
  }

  $app.replaceChildren(
    h('div', { class: 'page-head dash-head' }, h('div', null, h('h1', null, 'Kohtaamisten raportointi'), h('p', { class: 'muted' }, 'A-klinikkasäätiö')), updated),
    filterBox, body);
  body.replaceChildren(h('div', { class: 'loading' }, 'Ladataan…'));
  await load();
}

// Rengaskaavio (2 osaa): 2 px rako osien välissä, selite arvoineen
function donut(parts) {
  const total = parts.reduce((s, x) => s + x.value, 0);
  const R = 70, r = 46, C = 90;
  const svg = svgEl('svg', { viewBox: '0 0 180 180', class: 'donut', role: 'img', 'aria-label': parts.map(x => `${x.label} ${x.value}`).join(', ') });
  let a0 = -Math.PI / 2;
  const pt = (rad, a) => [C + rad * Math.cos(a), C + rad * Math.sin(a)];
  if (total) parts.forEach(x => {
    if (!x.value) return;
    const a1 = a0 + (x.value / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const full = x.value === total;
    const path = full
      ? `M${C},${C - R} A${R},${R} 0 1 1 ${C - 0.01},${C - R} L${C - 0.01},${C - r} A${r},${r} 0 1 0 ${C},${C - r} Z`
      : (() => { const [x0, y0] = pt(R, a0), [x1, y1] = pt(R, a1), [x2, y2] = pt(r, a1), [x3, y3] = pt(r, a0);
          return `M${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${r},${r} 0 ${large} 0 ${x3},${y3} Z`; })();
    const el = svgEl('path', { d: path, class: 'slice ' + x.cls, tabindex: '0' });
    const t = svgEl('title'); t.textContent = `${x.label}: ${fmtNum(x.value)} (${Math.round(x.value / total * 100)} %)`; el.append(t);
    svg.append(el); a0 = a1;
  });
  else svg.append(svgEl('circle', { cx: C, cy: C, r: (R + r) / 2, class: 'donut-empty' }));
  const c1 = svgEl('text', { x: C, y: C + 2, class: 'donut-total', 'text-anchor': 'middle' }); c1.textContent = fmtNum(total);
  const c2 = svgEl('text', { x: C, y: C + 20, class: 'donut-sub', 'text-anchor': 'middle' }); c2.textContent = 'kohtaamista';
  svg.append(c1, c2);
  return h('div', { class: 'donut-wrap' }, svg, h('ul', { class: 'legend' }, parts.map(x => h('li', null, h('span', { class: 'key-dot ' + x.cls }),
    h('span', null, h('span', { class: 'legend-label' }, x.label), h('strong', null, total ? `${Math.round(x.value / total * 100)} %` : '–'), h('span', { class: 'muted' }, ` (${fmtNum(x.value)})`))))));
}

// Viivakaavio (1–3 sarjaa): tarkastelulinja + yksi tooltip kaikille sarjoille, suorat nimiöt, taulukkonäkymä
function lineChart(data, types, cmp) {
  const series = SERIES.filter(s => s.key === 'encounters' || (types.includes(s.key) && types.length > 1));
  // Vertailujakson kokonaismäärä kohdistetaan kuukausi kuukaudelta samaan järjestykseen (1. kk ↔ 1. kk)
  const cmpVals = cmp ? data.map((_, i) => (cmp.data[i] ? cmp.data[i].encounters : null)) : null;
  const narrow = window.matchMedia('(max-width: 640px)').matches;
  const W = narrow ? 340 : 720, H = narrow ? 220 : 260, L = narrow ? 32 : 42, Rm = narrow ? 8 : 112, T = 14, B = 28;
  const max = Math.max(1, ...data.flatMap(d => series.map(s => d[s.key])), ...(cmpVals || []).filter(v => v != null));
  const step = niceStep(max), top = Math.ceil(max / step) * step;
  const x = (i) => L + (data.length === 1 ? (W - L - Rm) / 2 : (i * (W - L - Rm)) / (data.length - 1));
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart line-chart', role: 'img', 'aria-label': 'Kohtaamisten määrä kuukausittain' });
  for (let v = 0; v <= top; v += step) {
    svg.append(svgEl('line', { x1: L, x2: W - Rm, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'grid' }));
    const t = svgEl('text', { x: L - 6, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' }); t.textContent = fmtNum(v); svg.append(t);
  }
  const every = Math.max(1, Math.ceil(data.length / (narrow ? 4 : 8)));
  let lastTick = -Infinity;
  data.forEach((d, i) => { if ((i % every === 0 || (i === data.length - 1 && data.length <= 12)) && i - lastTick >= every * 0.75) { lastTick = i;
    const t = svgEl('text', { x: x(i), y: H - 8, class: 'tick', 'text-anchor': 'middle' }); t.textContent = fmtMonth(d.month).split(' ')[0]; svg.append(t); } });
  if (cmpVals) svg.append(svgEl('polyline', { points: cmpVals.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' '), class: 'series cmp' }));
  for (const s of series) {
    svg.append(svgEl('polyline', { points: data.map((d, i) => `${x(i)},${y(d[s.key])}`).join(' '), class: 'series ' + s.cls }));
    if (data.length <= 24) data.forEach((d, i) => svg.append(svgEl('circle', { cx: x(i), cy: y(d[s.key]), r: 3.5, class: 'pt ' + s.cls })));
  }
  // Suorat nimiöt viimeisen pisteen kohdalle (työpöytä), päällekkäisyys estetään siirtämällä
  if (!narrow) {
    const last = data.length - 1;
    // Alhaalta ylös: pidetään nimiöt piirtoalueella ja vähintään 14 px erillään
    const labels = series.map(s => ({ s, y: y(data[last][s.key]) })).sort((a, b) => b.y - a.y);
    labels.forEach((l, i) => { l.y = Math.min(l.y, H - B - 6); if (i && labels[i - 1].y - l.y < 14) l.y = labels[i - 1].y - 14; });
    for (const l of labels) { const t = svgEl('text', { x: x(last) + 8, y: l.y + 4, class: 'direct-label' }); t.textContent = l.s.label.replace('Kohtaamiset yhteensä', 'Yhteensä'); svg.append(t); }
  }
  const cross = svgEl('line', { y1: T, y2: H - B, class: 'crosshair', visibility: 'hidden' }); svg.append(cross);
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const hit = svgEl('rect', { x: L, y: T, width: W - L - Rm, height: H - T - B, class: 'hit', tabindex: '0' });
  let idx = -1;
  const show = (i) => {
    idx = Math.max(0, Math.min(data.length - 1, i)); const d = data[idx];
    cross.setAttribute('x1', x(idx)); cross.setAttribute('x2', x(idx)); cross.setAttribute('visibility', 'visible');
    tip.replaceChildren(h('div', { class: 'tip-title' }, fmtMonth(d.month)), ...series.map(s => h('div', { class: 'tip-row' },
      h('span', { class: 'key-line ' + s.cls }), h('strong', null, fmtNum(d[s.key])), h('span', { class: 'muted' }, ' ' + s.label))),
      cmpVals && cmpVals[idx] != null ? h('div', { class: 'tip-row' }, h('span', { class: 'key-line cmp' }), h('strong', null, fmtNum(cmpVals[idx])),
        h('span', { class: 'muted' }, ` yhteensä ${fmtMonth(cmp.data[idx].month)}`)) : '');
    tip.hidden = false; tip.style.left = `${(x(idx) / W) * 100}%`; tip.style.top = `${(Math.min(...series.map(s => y(d[s.key]))) / H) * 100}%`;
  };
  const hide = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); };
  const fromEvent = (ev) => { const r = svg.getBoundingClientRect(); const px = ((ev.clientX - r.left) / r.width) * W;
    return data.length === 1 ? 0 : Math.round(((px - L) / (W - L - Rm)) * (data.length - 1)); };
  hit.addEventListener('pointermove', (ev) => show(fromEvent(ev)));
  hit.addEventListener('pointerdown', (ev) => show(fromEvent(ev)));
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('focus', () => show(idx < 0 ? data.length - 1 : idx));
  hit.addEventListener('blur', hide);
  hit.addEventListener('keydown', (ev) => { if (ev.key === 'ArrowLeft') { show(idx - 1); ev.preventDefault(); } if (ev.key === 'ArrowRight') { show(idx + 1); ev.preventDefault(); } });
  svg.append(hit);
  const legendItems = [...series.map(s => [s.cls, s.label]), ...(cmpVals ? [['cmp', cmp.label + ' (yhteensä)']] : [])];
  const legend = legendItems.length > 1 ? h('ul', { class: 'legend legend-row' }, legendItems.map(([c, l]) => h('li', null, h('span', { class: 'key-line ' + c }), l))) : null;
  const table = h('details', { class: 'chart-table' }, h('summary', null, 'Näytä taulukkona'),
    h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Kuukausi'), series.map(s => h('th', { class: 'num' }, s.label)),
      cmpVals ? h('th', { class: 'num' }, 'Vertailujakso yhteensä') : null)),
      h('tbody', null, data.map((d, i) => h('tr', null, h('td', null, fmtMonth(d.month)), series.map(s => h('td', { class: 'num' }, fmtNum(d[s.key]))),
        cmpVals ? h('td', { class: 'num' }, cmpVals[i] == null ? '–' : `${fmtNum(cmpVals[i])} (${fmtMonth(cmp.data[i].month)})`) : null))))));
  return h('div', null, legend, h('div', { class: 'chart-wrap' }, svg, tip), table);
}

// ---------------------------------------------------------------------------
// Asiakaspolut ja palveluohjaukset (vain koosteita)
// ---------------------------------------------------------------------------
const pathState = { from: '', to: '', project_id: '' };
const fmtPct = (v) => (v == null ? '–' : Math.round(v * 100) + '\u00a0%');
const fmtSup = (n) => (n == null ? 'alle 3' : fmtNum(n));

async function viewPaths() {
  const box = h('div');
  async function load() {
    box.replaceChildren(h('div', { class: 'loading' }, 'Ladataan…'));
    const q = new URLSearchParams(); for (const k of ['from', 'to', 'project_id']) if (pathState[k]) q.set(k, pathState[k]);
    const d = await api('/paths?' + q);
    const tile = (v, label, sub) => h('div', { class: 'stat' }, h('b', null, v), h('span', null, label), sub ? h('small', null, sub) : null);
    const R = d.referrals;
    box.replaceChildren(...[
      !d.enabled ? h('div', { class: 'notice warn' }, 'Asiakastunnisteet eivät ole käytössä, koska palvelimelta puuttuu PSEUDONYM_KEY. Ohjaukset näkyvät, mutta niiden toteutumista ei voi seurata.') : null,
      h('h2', { class: 'sub-head' }, 'Asiakkaat'),
      h('div', { class: 'stats stats-grid' },
        tile(fmtNum(d.clients.total), 'tunnistettua asiakasta', 'kohdattu valitulla aikavälillä'),
        tile(fmtNum(d.clients.new), 'uutta asiakasta', 'ensimmäinen kohtaaminen aikavälillä'),
        tile(fmtNum(d.clients.returning), 'palaavaa asiakasta', 'vähintään 2 kohtaamista'),
        tile(fmtPct(d.coverage.share), 'tunnisteen käyttöaste', `${fmtNum(d.coverage.with_client)} / ${fmtNum(d.coverage.yksilo_rows)} yksilökohtaamisesta`)),
      h('h2', { class: 'sub-head' }, 'Palveluohjaukset'),
      h('div', { class: 'stats stats-grid' },
        tile(fmtNum(R.total), 'ohjausta', `${fmtNum(R.avoin)} avoinna`),
        tile(fmtPct(R.rate), 'toteutumisaste', `${fmtNum(R.toteutui)} toteutui · ${fmtNum(R.ei_toteutunut)} ei toteutunut`),
        tile(R.median_days == null ? '–' : fmtNum(Math.round(R.median_days)), 'päivää toteutumiseen', 'mediaani ohjauksesta kuittaukseen'),
        tile(fmtNum(R.ei_seurattavissa), 'ei seurattavissa', 'ohjaus ilman asiakastunnistetta')),
      h('div', { class: 'grid-2' },
        h('div', { class: 'card' }, h('h2', null, 'Ohjausten tila'),
          hBars([['Toteutui', R.toteutui], ['Ei toteutunut', R.ei_toteutunut], ['Avoin', R.avoin], ['Ei seurattavissa', R.ei_seurattavissa]]
            .map(([label, value]) => ({ label, value })), { unit: 'ohjausta' })),
        h('div', { class: 'card' }, h('h2', null, 'Kohtaamisia asiakasta kohden'), hBars(d.visitBuckets, { unit: 'asiakasta' }),
          h('p', { class: 'help small' }, 'Asiakkaan kohtaamiset hankkeessa loppupäivään asti.'))),
      h('div', { class: 'card' }, h('h2', null, 'Ohjaukset palveluittain'),
        d.services.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'cards-mobile' },
          h('thead', null, h('tr', null, h('th', null, 'Palvelu'), h('th', { class: 'num' }, 'Ohjauksia'), h('th', { class: 'num' }, 'Toteutui'),
            h('th', { class: 'num' }, 'Ei toteutunut'), h('th', { class: 'num' }, 'Avoin'), h('th', { class: 'num' }, 'Ei seurattavissa'), h('th', { class: 'num' }, 'Toteutumisaste'))),
          h('tbody', null, d.services.map(sv => h('tr', null, h('td', { class: 'cell-title' }, h('strong', null, sv.service)),
            h('td', { class: 'num', 'data-label': 'Ohjauksia' }, fmtNum(sv.total)), h('td', { class: 'num', 'data-label': 'Toteutui' }, fmtNum(sv.toteutui)),
            h('td', { class: 'num', 'data-label': 'Ei toteutunut' }, fmtNum(sv.ei_toteutunut)), h('td', { class: 'num', 'data-label': 'Avoin' }, fmtNum(sv.avoin)),
            h('td', { class: 'num', 'data-label': 'Ei seurattavissa' }, fmtNum(sv.ei_seurattavissa)),
            h('td', { class: 'num', 'data-label': 'Toteutumisaste' }, h('strong', null, fmtPct(sv.rate))))))))
          : h('p', { class: 'muted' }, 'Ei ohjauksia valitulla aikavälillä.'),
        h('p', { class: 'help small' }, 'Toteutumisaste = toteutuneet / (toteutuneet + ei toteutuneet). Avoimet ja seurannan ulkopuoliset eivät vaikuta osuuteen.'))].filter(Boolean));
  }
  $app.replaceChildren(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Asiakaspolut'),
      h('p', { class: 'muted' }, 'Hankekohtaisesti tunnistettujen asiakkaiden palaaminen ja palveluohjausten toteutuminen. Kaikki luvut ovat koosteita, eikä yksittäisiä asiakkaita näytetä.'))),
    staffFilterBar(load, pathState), box);
  await load();
}

// --- Ohjauspalveluiden ylläpito
async function viewServices() {
  const { services } = await api('/referral-services');
  const name = h('input', { type: 'text', id: 'sv-new', placeholder: 'Uuden palvelun nimi', maxlength: '80' });
  const msg = h('div', { class: 'notice err', hidden: true });
  const save = async (sv, body) => { try { await api('/referral-services/' + sv.id, { method: 'PUT', body }); state.form = null; toast('Tallennettu.'); viewServices(); } catch (ex) { toast(ex.message, true); } };
  $app.replaceChildren(adminTabs('#/hallinta/ohjauspalvelut'),
    h('p', { class: 'muted' }, 'Palvelut, joihin asiakkaita ohjataan. Lista näkyy lomakkeella yksilökohtaamisissa. Käytössä olleita palveluita ei poisteta, vaan ne otetaan pois käytöstä.'),
    h('div', { class: 'card' }, h('div', { class: 'actions' }, name, h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
      try { await api('/referral-services', { method: 'POST', body: { name: name.value } }); state.form = null; toast('Lisätty.'); viewServices(); }
      catch (ex) { msg.textContent = ex.message; msg.hidden = false; } } }, '+ Lisää palvelu')), msg),
    h('div', { class: 'q-group card' }, services.map((sv, i) => h('div', { class: 'q-item' + (sv.active ? '' : ' inactive') },
      h('div', { class: 'q-main' }, h('strong', null, sv.name),
        h('div', { class: 'q-meta' }, !sv.active ? h('span', { class: 'badge grey' }, 'Ei käytössä') : null, h('span', { class: 'badge grey' }, `${fmtNum(sv.referral_count)} ohjausta`))),
      h('div', { class: 'q-ctrl' },
        h('button', { class: 'btn btn-secondary btn-sm', type: 'button', disabled: i === 0, 'aria-label': 'Siirrä ylös', onclick: () => save(sv, { name: sv.name, active: !!sv.active, sort: services[i - 1].sort - 1 }) }, '↑'),
        h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => {
          const input = h('input', { type: 'text', value: sv.name, class: 'grow' });
          const row = h('div', { class: 'actions grow' }, input, h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => save(sv, { name: input.value, active: !!sv.active }) }, 'Tallenna'));
          const item = document.querySelectorAll('.q-item')[i]; item.querySelector('.q-main').replaceChildren(row); input.focus(); } }, 'Nimeä'),
        h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => save(sv, { name: sv.name, active: !sv.active }) }, sv.active ? 'Poista käytöstä' : 'Ota käyttöön'))))));
}

// ---------------------------------------------------------------------------
// Excel-vienti
// ---------------------------------------------------------------------------
async function viewExport() {
  $app.classList.add('container');
  const me = state.me;
  const year = me.today.slice(0, 4);
  const from = h('input', { type: 'date', id: 'x-from', value: `${year}-01-01` });
  const to = h('input', { type: 'date', id: 'x-to', value: me.today });
  const all = h('input', { type: 'checkbox', checked: true });
  const boxes = me.projects.map(p => ({ p, el: h('input', { type: 'checkbox', checked: true, value: p.id }) }));
  all.addEventListener('change', () => boxes.forEach(b => { b.el.checked = all.checked; }));
  boxes.forEach(b => b.el.addEventListener('change', () => { all.checked = boxes.every(x => x.el.checked); }));
  const err = h('div', { class: 'notice err', hidden: true });

  $app.replaceChildren(h('div', { class: 'narrow' },
    h('h1', null, 'Raakadatan vienti Exceliin'),
    h('p', { class: 'muted' }, 'Jokainen lomaketallennus on omalla rivillään ja jokainen kysymys omassa sarakkeessaan. Ryhmäkirjaus säilyy yhtenä rivinä. Yksilökohtaamisten nimimerkit eivät sisälly vientiin.'),
    h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { for: 'x-from' }, 'Alkupäivä'), from),
        h('div', { class: 'field' }, h('label', { for: 'x-to' }, 'Loppupäivä'), to)),
      h('div', { class: 'field' }, h('div', { class: 'label' }, 'Hankkeet'),
        h('div', { class: 'options' }, h('label', { class: 'opt' }, all, h('span', null, h('strong', null, 'Kaikki hankkeet'))),
          h('div', { class: 'checks' }, boxes.map(b => h('label', { class: 'opt' }, b.el, h('span', null, b.p.name)))))),
      err,
      h('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: () => {
        err.hidden = true;
        const ids = boxes.filter(b => b.el.checked).map(b => b.p.id);
        if (!from.value || !to.value || from.value > to.value) { err.textContent = 'Tarkista aikaväli.'; err.hidden = false; return; }
        if (!ids.length) { err.textContent = 'Valitse vähintään yksi hanke.'; err.hidden = false; return; }
        const qs = new URLSearchParams({ from: from.value, to: to.value, projects: all.checked ? '' : ids.join(',') });
        window.location.href = '/api/export?' + qs;
      } }, 'Lataa Excel-tiedosto'))));
}

// ---------------------------------------------------------------------------
// Hallinta
// ---------------------------------------------------------------------------
function adminTabs(active) {
  const p = state.me.permissions;
  const t = (href, text) => h('a', { href, class: active === href ? 'active' : null }, text);
  return h('div', null, h('h1', null, 'Hallinta'), h('nav', { class: 'tabs' },
    p.manageQuestions ? t('#/hallinta/kysymykset', 'Kysymykset') : null,
    p.manageQuestions ? t('#/hallinta/ohjauspalvelut', 'Ohjauspalvelut') : null,
    p.manageProjects ? t('#/hallinta/hankkeet', 'Hankkeet') : null,
    p.manageUsers ? t('#/hallinta/kayttajat', 'Käyttäjät') : null,
    p.manageUsers ? t('#/hallinta/toiminnot', 'Toiminnot') : null,
    p.manageUsers ? t('#/hallinta/testidata', 'Testidata') : null,
    p.manageUsers ? t('#/hallinta/loki', 'Tapahtumaloki') : null));
}

// --- Käyttäjät
async function viewUsers() {
  $app.classList.add('container');
  const [{ users }, { projects }, cfg] = await Promise.all([api('/users'), api('/projects'), api('/auth/config')]);
  const roles = state.me.roles;
  const METHODS = { entra: 'Säätiön Microsoft-tunnus (Entra ID)', local: 'Sähköposti + salasana + todennussovellus' };
  const defaultMethod = (r) => (r === 'tuntityontekija' || !cfg.entra ? 'local' : 'entra');
  const editorBox = h('div');
  const pname = (id) => (projects.find(p => p.id === id) || {}).name || '?';

  function openEditor(u) {
    const isNew = !u;
    u = u || { name: '', email: '', role: 'hanketyontekija', active: 1, project_ids: [], auth_method: defaultMethod('hanketyontekija') };
    const method = h('select', { id: 'u-method' }, Object.entries(METHODS).map(([k, v]) => h('option', { value: k, selected: k === u.auth_method }, v)));
    let methodTouched = !isNew;
    const methodHelp = h('p', { class: 'help help-below' });
    const syncMethod = () => methodHelp.replaceChildren(method.value === 'entra'
      ? (cfg.entra ? 'Kirjautuu säätiön Microsoft-tunnuksella. Sähköpostin on oltava sama kuin Microsoft-tunnuksessa. Kaksivaiheinen tunnistautuminen hoidetaan Microsoftin puolella.'
        : h('span', { class: 'warn-text' }, 'Microsoft-kirjautumista ei ole vielä otettu käyttöön palvelimella. Tunnus toimii, kun Entra ID -asetukset on tehty.'))
      : 'Saa väliaikaisen salasanan. Ensimmäisellä kirjautumisella otetaan käyttöön todennussovellus (esim. Microsoft Authenticator).');
    method.addEventListener('change', () => { methodTouched = true; syncMethod(); });
    const name = h('input', { type: 'text', id: 'u-name', value: u.name });
    const email = h('input', { type: 'email', id: 'u-email', value: u.email });
    const role = h('select', { id: 'u-role' }, Object.entries(roles).map(([k, v]) => h('option', { value: k, selected: k === u.role }, v)));
    const active = h('input', { type: 'checkbox', checked: !!u.active });
    const pboxes = projects.map(p => ({ id: p.id, el: h('input', { type: 'checkbox', checked: u.project_ids.includes(p.id) }) }));
    const msg = h('div', { class: 'notice', hidden: true });
    const roleHelp = h('p', { class: 'help' });
    const ROLE_HELP = {
      admin: 'Kaikki oikeudet: kirjaukset, työntekijäseuranta, Excel-vienti, käyttäjien, hankkeiden ja kysymysten ylläpito. Hankevalinnat eivät rajoita adminia.',
      tiimivetaja: 'Kirjaa, selaa, korjaa ja poistaa valittujen hankkeiden kirjauksia, näkee työntekijäseurannan ja lataa Excel-viennin.',
      hanketyontekija: 'Kirjaa valittuihin hankkeisiin ja selaa omia kirjauksiaan.',
      tuntityontekija: 'Kirjaa valittuihin hankkeisiin. Ei kirjausten selausta.',
    };
    const syncHelp = () => {
      roleHelp.replaceChildren(h('strong', null, state.me.roleDescriptions[role.value]), '. ', ROLE_HELP[role.value], ' ',
        h('span', { class: 'muted' }, `Kirjauksiin tallentuu: ”${state.me.defaultRecorderRoles[role.value]}”.`));
    };
    role.addEventListener('change', () => { syncHelp(); if (!methodTouched) { method.value = defaultMethod(role.value); syncMethod(); } }); syncHelp(); syncMethod();

    editorBox.replaceChildren(h('div', { class: 'card editor' },
      h('h2', null, isNew ? 'Uusi käyttäjä' : 'Muokkaa käyttäjää'),
      h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { for: 'u-name' }, 'Nimi'), name),
        h('div', { class: 'field' }, h('label', { for: 'u-email' }, 'Sähköposti (käyttäjätunnus)'), email)),
      h('div', { class: 'field' }, h('label', { for: 'u-role' }, 'Rooli'), roleHelp, role),
      h('div', { class: 'field' }, h('label', { for: 'u-method' }, 'Kirjautumistapa'), method, methodHelp),
      h('div', { class: 'field' }, h('div', { class: 'label' }, 'Hankkeet'), h('div', { class: 'checks' },
        pboxes.map(b => h('label', { class: 'opt' }, b.el, h('span', null, pname(b.id)))))),
      !isNew ? h('div', { class: 'field' }, h('label', { class: 'switch' }, active, 'Tunnus käytössä')) : null,
      msg,
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
          const body = { name: name.value, email: email.value, role: role.value, active: active.checked, auth_method: method.value, project_ids: pboxes.filter(b => b.el.checked).map(b => b.id) };
          try {
            if (isNew) {
              const r = await api('/users', { method: 'POST', body });
              if (r.temporaryPassword) showTemp(`Käyttäjä luotu. Väliaikainen salasana:`, r.temporaryPassword);
              else { toast('Käyttäjä luotu. Hän kirjautuu Microsoft-tunnuksella.'); viewUsers(); }
            } else {
              const r = await api('/users/' + u.id, { method: 'PUT', body });
              if (r.temporaryPassword) showTemp(`Kirjautumistapa vaihdettu. Väliaikainen salasana:`, r.temporaryPassword);
              else { toast('Tallennettu.'); viewUsers(); }
            }
          } catch (ex) { msg.className = 'notice err'; msg.textContent = ex.message; msg.hidden = false; }
        } }, isNew ? 'Luo käyttäjä' : 'Tallenna'),
        !isNew && u.auth_method === 'local' ? h('button', { class: 'btn btn-secondary', type: 'button', onclick: async () => {
          try { const r = await api(`/users/${u.id}/reset-password`, { method: 'POST' }); showTemp(`Salasana nollattu käyttäjälle ${u.name}. Uusi väliaikainen salasana:`, r.temporaryPassword); }
          catch (ex) { toast(ex.message, true); }
        } }, 'Nollaa salasana') : null,
        !isNew && u.auth_method === 'local' && u.mfa_enabled ? h('button', { class: 'btn btn-secondary', type: 'button', onclick: async (ev) => {
          const b = ev.currentTarget;
          if (!b.classList.contains('confirming')) { b.classList.add('confirming'); b.textContent = 'Vahvista: nollaa todennussovellus'; return; }
          try { await api(`/users/${u.id}/reset-mfa`, { method: 'POST' }); toast(`${u.name} ottaa todennussovelluksen uudelleen käyttöön seuraavalla kirjautumisella.`); viewUsers(); }
          catch (ex) { toast(ex.message, true); }
        } }, 'Nollaa todennussovellus') : null,
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => editorBox.replaceChildren() }, 'Peruuta'))));
    editorBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
    name.focus();
  }
  function showTemp(text, pw) {
    editorBox.replaceChildren(h('div', { class: 'notice ok' }, h('p', null, text), h('p', null, h('span', { class: 'secret' }, pw)),
      h('p', { class: 'small' }, 'Toimita salasana käyttäjälle turvallista kanavaa pitkin. Salasana näytetään vain kerran, ja käyttäjä vaihtaa sen ensimmäisellä kirjautumisella.'),
      h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => viewUsers() }, 'Valmis')));
  }

  $app.replaceChildren(adminTabs('#/hallinta/kayttajat'),
    h('div', { class: 'page-head' }, h('p', { class: 'muted' }, `${users.length} käyttäjää`),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openEditor(null) }, '+ Uusi käyttäjä')),
    editorBox,
    h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Nimi'), h('th', null, 'Sähköposti'), h('th', null, 'Rooli'), h('th', null, 'Kirjautuminen'), h('th', null, 'Hankkeet'), h('th', null, 'Viimeksi kirjautunut'), h('th', null, 'Tila'))),
      h('tbody', null, users.map(u => h('tr', { class: 'clickable', tabindex: '0', onclick: () => openEditor(u), onkeydown: (e) => { if (e.key === 'Enter') openEditor(u); } },
        h('td', null, h('strong', null, u.name)), h('td', null, u.email), h('td', null, h('span', { class: 'badge blue' }, roles[u.role])),
        h('td', { class: 'small' }, u.auth_method === 'entra' ? 'Microsoft' : ['Salasana', ' ', u.mfa_enabled ? h('span', { class: 'badge green' }, 'MFA') : h('span', { class: 'badge grey' }, 'MFA ei vielä')]),
        h('td', { class: 'small' }, u.role === 'admin' ? 'Kaikki' : u.project_ids.map(pname).join(', ') || h('span', { class: 'badge red' }, 'Ei hankkeita')),
        h('td', { class: 'small muted' }, u.last_login_at ? fmtDateTime(u.last_login_at) : '–'),
        h('td', null, u.active ? h('span', { class: 'badge green' }, 'Käytössä') : h('span', { class: 'badge grey' }, 'Suljettu'))))))));
}

// --- Hankkeet
async function viewProjects() {
  $app.classList.add('container');
  const { projects } = await api('/projects');
  const editorBox = h('div');
  function openEditor(p) {
    const isNew = !p;
    const code = h('input', { type: 'text', id: 'p-code', value: p ? p.code : '', disabled: !isNew, maxlength: '20' });
    const name = h('input', { type: 'text', id: 'p-name', value: p ? p.name : '' });
    const active = h('input', { type: 'checkbox', checked: p ? !!p.active : true });
    const msg = h('div', { class: 'notice err', hidden: true });
    // Teemaväri: 1–2 väriä säätiön paletista tai vapaasti
    let colors = projectColors(p);
    const preview = h('div', { class: 'options project-cards color-preview' });
    const colorBox = h('div');
    const drawColors = () => {
      const slot = (i) => {
        const inp = h('input', { type: 'color', value: colors[i] || '#0037d3', 'aria-label': i ? 'Toinen väri' : 'Väri' });
        inp.addEventListener('input', () => { colors[i] = inp.value; drawPreview(); });
        return h('div', { class: 'color-slot' }, inp,
          h('div', { class: 'swatches', role: 'group', 'aria-label': 'Säätiön värit' }, BRAND_SWATCHES.map(([c, n]) => {
            const b = h('button', { type: 'button', class: 'swatch' + (colors[i] === c ? ' on' : ''), title: n, 'aria-label': n, 'aria-pressed': String(colors[i] === c), onclick: () => { colors[i] = c; drawColors(); } });
            b.style.background = c; return b; })));
      };
      colorBox.replaceChildren(...[
        colors.length ? slot(0) : null,
        colors.length > 1 ? slot(1) : null,
        h('div', { class: 'actions' },
          !colors.length ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => { colors = ['#0037d3']; drawColors(); } }, 'Lisää väri') : null,
          colors.length === 1 ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => { colors.push('#00a0f4'); drawColors(); } }, 'Lisää toinen väri') : null,
          colors.length === 2 ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => { colors.pop(); drawColors(); } }, 'Poista toinen väri') : null,
          colors.length ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => { colors = []; drawColors(); } }, 'Ei väriä') : null),
      ].filter(Boolean));
      drawPreview();
    };
    const drawPreview = () => preview.replaceChildren(paintProject(h('label', { class: 'opt' }, h('input', { type: 'radio', name: 'pv', checked: false }),
      h('span', null, h('span', { class: 'opt-title' }, name.value || 'Hanke'))), { color: colors.join(',') }));
    name.addEventListener('input', drawPreview);
    drawColors();
    editorBox.replaceChildren(h('div', { class: 'card editor' }, h('h2', null, isNew ? 'Uusi hanke' : 'Muokkaa hanketta'),
      h('div', { class: 'row' },
        h('div', { class: 'field' }, h('label', { for: 'p-code' }, 'Tunnus'), h('p', { class: 'help' }, 'Pysyvä, esim. KATUKLINIKKA. Ei voi muuttaa myöhemmin.'), code),
        h('div', { class: 'field' }, h('label', { for: 'p-name' }, 'Nimi lomakkeella'), h('p', { class: 'help' }, 'Näkyy kirjaajille ja raporteissa.'), name)),
      h('div', { class: 'field' }, h('div', { class: 'label' }, 'Teemaväri'),
        h('p', { class: 'help' }, 'Näkyy raitana hankevalinnassa ja kirjauslistassa, jotta oman hankkeen löytää nopeasti. Digipalveluiden värit ovat niiden verkkosivuilta.'),
        colorBox, h('div', { class: 'label small' }, 'Esikatselu'), preview),
      !isNew ? h('div', { class: 'field' }, h('label', { class: 'switch' }, active, 'Käytössä (näkyy lomakkeella)'),
        h('p', { class: 'help' }, 'Käytöstä poistetun hankkeen vanhat kirjaukset säilyvät raporteissa.')) : null,
      msg, h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
          try {
            if (isNew) await api('/projects', { method: 'POST', body: { code: code.value, name: name.value, color: colors.join(',') } });
            else await api('/projects/' + p.id, { method: 'PUT', body: { name: name.value, active: active.checked, color: colors.join(',') } });
            state.form = null; await loadMe(); toast('Tallennettu.'); viewProjects();
          } catch (ex) { msg.textContent = ex.message; msg.hidden = false; }
        } }, 'Tallenna'),
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => editorBox.replaceChildren() }, 'Peruuta'))));
    (isNew ? code : name).focus();
  }
  $app.replaceChildren(adminTabs('#/hallinta/hankkeet'),
    h('div', { class: 'page-head' }, h('p', { class: 'muted' }, 'Hankkeet näkyvät lomakkeen hankevalinnassa. Käyttäjät liitetään hankkeisiin Käyttäjät-välilehdellä.'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openEditor(null) }, '+ Uusi hanke')),
    editorBox,
    h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Hanke'), h('th', null, 'Tunnus'), h('th', { class: 'num' }, 'Kirjauksia'), h('th', null, 'Tila'))),
      h('tbody', null, projects.map(p => h('tr', { class: 'clickable', tabindex: '0', onclick: () => openEditor(p), onkeydown: (e) => { if (e.key === 'Enter') openEditor(p); } },
        h('td', null, projectDot(p), h('strong', null, p.name)), h('td', { class: 'small' }, p.code), h('td', { class: 'num' }, fmtNum(p.encounter_rows)),
        h('td', null, p.active ? h('span', { class: 'badge green' }, 'Käytössä') : h('span', { class: 'badge grey' }, 'Ei käytössä'))))))));
}

// --- Kysymykset
async function viewQuestions() {
  $app.classList.add('container');
  const [{ questions }, { projects }] = await Promise.all([api('/questions'), api('/projects')]);
  const editorBox = h('div');
  const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);

  function openEditor(q, projectId) {
    const isNew = !q;
    q = q || { label: '', help: '', type: 'choice', options: ['', ''], required: false, applies_to: 'kaikki', active: true, project_id: projectId, answer_count: 0 };
    const proj = projects.find(p => p.id === q.project_id);
    const label = h('input', { type: 'text', id: 'q-label', value: q.label });
    const key = h('input', { type: 'text', id: 'q-key', value: q.key || '', disabled: !isNew });
    let keyTouched = false;
    key.addEventListener('input', () => { keyTouched = true; });
    label.addEventListener('input', () => { if (isNew && !keyTouched) key.value = ((proj ? proj.code.toLowerCase() + '_' : '') + slug(label.value)).slice(0, 40); });
    const help = h('textarea', { id: 'q-help', value: q.help || '' });
    const type = h('select', { id: 'q-type', disabled: !isNew && q.answer_count > 0 }, Object.entries(QTYPES).map(([k, v]) => h('option', { value: k, selected: k === q.type }, v)));
    const applies = h('select', { id: 'q-applies' }, Object.entries(APPLIES).map(([k, v]) => h('option', { value: k, selected: k === q.applies_to }, v)));
    const required = h('input', { type: 'checkbox', checked: q.required });
    const suggest = h('input', { type: 'checkbox', checked: !!q.suggest });
    const suggestLabel = h('label', { class: 'switch' }, suggest, 'Täydennysehdotukset');
    const syncSuggest = () => { suggestLabel.hidden = type.value !== 'text'; };
    type.addEventListener('change', syncSuggest); syncSuggest();
    const dmode = h('select', { id: 'q-dmode' }, [['show', 'Näytetään aina'], ['hide', `Piilotetaan, kun sijainti on ”${DIGITAL_LOCATION}”`]]
      .map(([v, t]) => h('option', { value: v, selected: (q.digital_mode === 'hide' ? 'hide' : 'show') === v }, t)));
    const active = h('input', { type: 'checkbox', checked: q.active });
    const optsBox = h('div', { class: 'options' });
    let opts = Array.isArray(q.options) && ['choice', 'multichoice'].includes(q.type) ? [...q.options] : ['', ''];
    const renderOpts = () => {
      const show = ['choice', 'multichoice'].includes(type.value);
      optField.hidden = !show;
      optsBox.replaceChildren(...opts.map((o, i) => h('div', { class: 'actions' },
        h('input', { type: 'text', value: o, 'aria-label': `Vaihtoehto ${i + 1}`, class: 'grow', oninput: (e) => { opts[i] = e.target.value; } }),
        h('button', { type: 'button', class: 'btn btn-secondary btn-sm', disabled: i === 0, onclick: () => { [opts[i - 1], opts[i]] = [opts[i], opts[i - 1]]; renderOpts(); } }, '↑'),
        h('button', { type: 'button', class: 'btn btn-danger btn-sm', onclick: () => { opts.splice(i, 1); renderOpts(); } }, 'Poista'))),
        h('div', null, h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => { opts.push(''); renderOpts(); } }, '+ Lisää vaihtoehto')));
    };
    const optField = h('div', { class: 'field' }, h('div', { class: 'label' }, 'Vastausvaihtoehdot'),
      q.answer_count ? h('p', { class: 'help' }, 'Vanhat vastaukset säilyvät sellaisinaan. Jos muutat vaihtoehdon tekstiä, aiemmat vastaukset jäävät vanhalle tekstille.') : null, optsBox);
    type.addEventListener('change', renderOpts);
    const msg = h('div', { class: 'notice err', hidden: true });

    editorBox.replaceChildren(h('div', { class: 'card editor' },
      h('h2', null, (isNew ? 'Uusi kysymys' : 'Muokkaa kysymystä') + ' – ' + (proj ? proj.name : 'Yhteiset kysymykset')),
      h('div', { class: 'field' }, h('label', { for: 'q-label' }, 'Kysymys'), label),
      h('div', { class: 'field' }, h('label', { for: 'q-help' }, 'Ohjeteksti (valinnainen)'), help),
      h('div', { class: 'row' },
        h('div', { class: 'field' }, h('label', { for: 'q-type' }, 'Tyyppi'), type,
          !isNew && q.answer_count ? h('p', { class: 'help small' }, 'Tyyppiä ei voi muuttaa, koska kysymykseen on vastattu.') : null),
        h('div', { class: 'field' }, h('label', { for: 'q-applies' }, 'Näytetään'), applies),
        h('div', { class: 'field' }, h('label', { for: 'q-key' }, 'Pysyvä tunniste'), key, h('p', { class: 'help small' }, 'Raportoinnin sarakenimi. Ei muutu myöhemmin.'))),
      optField,
      q.key !== 'sijainti' ? h('div', { class: 'field' }, h('label', { for: 'q-dmode' }, 'Digialustalla tapahtuneet kohtaamiset'),
        h('p', { class: 'help' }, 'Esim. kaupunkia ja kadunnimeä ei kysytä, kun kohtaamisen sijainniksi valitaan digialusta.'), dmode) : null,
      h('div', { class: 'actions field' }, h('label', { class: 'switch' }, required, 'Pakollinen'), suggestLabel,
        !isNew ? h('label', { class: 'switch' }, active, 'Käytössä lomakkeella') : null),
      msg,
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
          const body = { key: key.value, project_id: q.project_id ?? null, label: label.value, help: help.value, type: type.value, applies_to: applies.value,
            required: required.checked, active: active.checked, options: opts, suggest: type.value === 'text' && suggest.checked,
            digital_mode: q.key === 'sijainti' ? 'show' : dmode.value, digital_value: null };
          try {
            if (isNew) await api('/questions', { method: 'POST', body }); else await api('/questions/' + q.id, { method: 'PUT', body });
            state.form = null; toast('Tallennettu.'); viewQuestions();
          } catch (ex) { msg.textContent = ex.message; msg.hidden = false; }
        } }, 'Tallenna'),
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => editorBox.replaceChildren() }, 'Peruuta'))));
    renderOpts();
    editorBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
    label.focus();
  }

  async function move(group, idx, dir) {
    const ids = group.map(q => q.id);
    const j = idx + dir; if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    await api('/questions/reorder', { method: 'POST', body: { ids } });
    state.form = null; viewQuestions();
  }

  const groupBlock = (title, pid, list) => h('div', { class: 'q-group card' },
    h('div', { class: 'page-head' }, h('h2', null, title), h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => openEditor(null, pid) }, '+ Lisää kysymys')),
    list.length ? list.map((q, i) => h('div', { class: 'q-item' + (q.active ? '' : ' inactive') },
      h('div', { class: 'q-main' }, h('strong', null, q.label), q.required ? h('span', { class: 'req' }, ' *') : null,
        h('div', { class: 'q-meta' }, h('span', { class: 'badge' }, QTYPES[q.type]), q.applies_to !== 'kaikki' ? h('span', { class: 'badge blue' }, APPLIES[q.applies_to]) : null,
          !q.active ? h('span', { class: 'badge grey' }, 'Ei käytössä') : null, h('span', { class: 'badge grey' }, `${fmtNum(q.answer_count)} vastausta`),
          q.digital_mode === 'hide' ? h('span', { class: 'badge' }, 'Piilotetaan digialustalla') : null,
          h('span', { class: 'small muted' }, q.key))),
      h('div', { class: 'q-ctrl' },
        h('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'aria-label': 'Siirrä ylös', disabled: i === 0, onclick: () => move(list, i, -1) }, '↑'),
        h('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'aria-label': 'Siirrä alas', disabled: i === list.length - 1, onclick: () => move(list, i, 1) }, '↓'),
        h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => openEditor(q) }, 'Muokkaa'))))
      : h('p', { class: 'muted small' }, 'Ei hankekohtaisia kysymyksiä.'));

  $app.replaceChildren(adminTabs('#/hallinta/kysymykset'),
    h('div', { class: 'notice info' }, 'Lomakkeen kiinteät perustiedot (ajankohta, hanke, kirjaajan rooli, yksilö/ryhmä, kohtaamisten ja osallistujien määrä, asiakastunniste ja palveluohjaus) ovat aina mukana. Digipalvelun hankkeissa kysymys voidaan piilottaa tai täyttää automaattisesti (Hallinta → Hankkeet → Digipalvelu). ',
      'Kysymyksiä ei poisteta, vaan ne otetaan pois käytöstä – näin aiempien vuosien raportointi säilyy ehjänä.'),
    editorBox,
    groupBlock('Yhteiset kysymykset', null, questions.filter(q => q.project_id == null)),
    ...projects.map(p => groupBlock(p.name + (p.active ? '' : ' (ei käytössä)'), p.id, questions.filter(q => q.project_id === p.id))));
}

// --- Testidata
async function viewDemo() {
  const c = await api('/admin/demo-data');
  const count = h('input', { type: 'number', id: 'd-count', class: 'input-narrow', min: '1', max: '500', value: 40 });
  const msg = h('div', { class: 'notice', hidden: true });
  const show = (cls, text) => { msg.className = 'notice ' + cls; msg.textContent = text; msg.hidden = false; };
  const createBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
    createBtn.disabled = true;
    try { const r = await api('/admin/demo-data', { method: 'POST', body: { count: Number(count.value) } });
      toast(`Luotiin ${r.created} testikirjausta.`); viewDemo(); }
    catch (ex) { show('err', ex.message); createBtn.disabled = false; }
  } }, 'Luo testikirjaukset');
  const delBtn = h('button', { class: 'btn btn-danger', type: 'button', disabled: !c.rows, onclick: async (ev) => {
    const b = ev.currentTarget;
    if (!b.classList.contains('confirming')) { b.classList.add('confirming'); b.textContent = 'Vahvista: poista kaikki testikirjaukset';
      setTimeout(() => { b.classList.remove('confirming'); b.textContent = 'Poista kaikki testidata'; }, 4000); return; }
    try { const r = await api('/admin/demo-data', { method: 'DELETE' }); toast(`Poistettiin ${r.deleted} testikirjausta.`); viewDemo(); }
    catch (ex) { show('err', ex.message); }
  } }, 'Poista kaikki testidata');

  $app.replaceChildren(adminTabs('#/hallinta/testidata'),
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', null, fmtNum(c.rows)), h('span', null, 'testikirjausta')),
      h('div', { class: 'stat' }, h('b', null, fmtNum(c.encounters)), h('span', null, 'kohtaamista niissä'))),
    h('div', { class: 'card' },
      h('h2', null, 'Luo testikirjauksia'),
      h('p', { class: 'muted' }, 'Luo vaihtelevia kirjauksia kaikkiin käytössä oleviin hankkeisiin kuluvan vuoden ajalle: yksilö- ja ryhmäkohtaamisia, toistuvia nimimerkkejä, eri kirjaajarooleja, kaupunkeja, arvioita ja vapaatekstejä. Myös myöhemmin lisättyihin hankekohtaisiin kysymyksiin vastataan.'),
      h('p', { class: 'muted' }, 'Testikirjaukset näkyvät listassa merkinnällä ”testi” ja Excel-viennissä sarakkeessa ”Testidata”.'),
      h('div', { class: 'field' }, h('label', { for: 'd-count' }, 'Määrä'), count),
      msg, h('div', { class: 'actions' }, createBtn)),
    h('div', { class: 'card' },
      h('h2', null, 'Poista testidata'),
      h('p', { class: 'muted' }, 'Poistaa pysyvästi kaikki testikirjaukset. Oikeisiin kirjauksiin ei kosketa. Tee tämä ennen varsinaista käyttöönottoa.'),
      delBtn));
}

// --- Kytkettävät toiminnot
async function viewFeatures() {
  $app.classList.add('container');
  const { features } = await api('/features');
  const card = (f) => {
    const id = 'feat-' + f.key;
    const status = h('span', { class: 'badge' + (f.enabled ? ' on' : '') }, f.enabled ? 'Käytössä' : 'Piilotettu');
    const cb = h('input', { type: 'checkbox', id, checked: f.enabled });
    cb.addEventListener('change', async () => {
      cb.disabled = true;
      try {
        const r = await api('/features/' + f.key, { method: 'PUT', body: { enabled: cb.checked } });
        status.textContent = r.enabled ? 'Käytössä' : 'Piilotettu'; status.classList.toggle('on', r.enabled);
        toast(r.enabled ? `${f.label} otettu käyttöön.` : `${f.label} piilotettu.`);
        state.form = null; // lomake (palveluohjaukset) ladataan uudelleen
        await loadMe(); renderNav(location.hash);
      } catch (ex) { cb.checked = !cb.checked; toast(ex.message); }
      finally { cb.disabled = false; }
    });
    return h('div', { class: 'card feature' },
      h('div', { class: 'feature-head' }, h('h2', null, f.label), status),
      h('p', { class: 'muted' }, f.description),
      h('label', { class: 'feature-toggle', for: id }, cb, h('span', null, 'Näytä käyttäjille')));
  };
  $app.replaceChildren(adminTabs('#/hallinta/toiminnot'),
    h('p', { class: 'muted' }, 'Toiminnot, jotka voidaan ottaa käyttöön myöhemmin. Muutos näkyy käyttäjille heti seuraavalla sivunlatauksella.'),
    ...features.map(card));
}

// --- Tapahtumaloki
async function viewAudit() {
  $app.classList.add('container');
  const { rows } = await api('/audit');
  const LABELS = { login: 'Kirjautuminen', login_failed: 'Epäonnistunut kirjautuminen', password_changed: 'Salasana vaihdettu', encounter_create: 'Kirjaus luotu',
    encounter_update: 'Kirjaus korjattu', encounter_delete: 'Kirjaus poistettu', export: 'Excel-vienti', user_create: 'Käyttäjä luotu', user_update: 'Käyttäjä muokattu',
    user_reset_password: 'Salasana nollattu', demo_create: 'Testidataa luotu', demo_delete: 'Testidata poistettu', project_create: 'Hanke luotu', project_update: 'Hanke muokattu', question_create: 'Kysymys luotu', question_update: 'Kysymys muokattu',
    feature_enable: 'Toiminto otettu käyttöön', mfa_failed: 'Väärä tunnistautumiskoodi', mfa_enrolled: 'Todennussovellus otettu käyttöön', user_reset_mfa: 'Todennussovellus nollattu', feature_disable: 'Toiminto piilotettu' };
  $app.replaceChildren(adminTabs('#/hallinta/loki'),
    h('p', { class: 'muted' }, '200 viimeisintä tapahtumaa.'),
    h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Aika'), h('th', null, 'Käyttäjä'), h('th', null, 'Tapahtuma'), h('th', null, 'Kohde'))),
      h('tbody', null, rows.map(r => h('tr', null, h('td', { class: 'small' }, fmtDateTime(r.at)), h('td', null, r.user_name || '–'),
        h('td', null, LABELS[r.action] || r.action), h('td', { class: 'small muted' }, r.entity ? `${r.entity} ${r.entity_id || ''}` : '')))))));
}

route();
