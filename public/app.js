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
  if (res.status === 401 && path !== '/login') { state.me = null; go('#/kirjaudu'); throw new Error((data && data.error) || 'Kirjaudu sisään.'); }
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
  { re: /^#\/hallinta\/kayttajat$/, view: viewUsers, perm: (p) => p.manageUsers },
  { re: /^#\/hallinta\/hankkeet$/, view: viewProjects, perm: (p) => p.manageProjects },
  { re: /^#\/hallinta\/kysymykset$/, view: viewQuestions, perm: (p) => p.manageQuestions },
  { re: /^#\/hallinta\/loki$/, view: viewAudit, perm: (p) => p.manageUsers },
];

async function route() {
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

function renderNav(hash) {
  const bar = document.getElementById('topbar');
  const nav = document.getElementById('nav');
  if (!state.me || hash === '#/kirjaudu') { bar.hidden = true; return; }
  bar.hidden = false;
  const p = state.me.permissions;
  const link = (href, text) => h('a', { href, class: hash === href || (href !== '#/kirjaa' && hash.startsWith(href)) ? 'active' : null }, text);
  const adminHref = p.manageQuestions ? '#/hallinta/kysymykset' : null;
  nav.replaceChildren(...[
    link('#/kirjaa', 'Uusi kirjaus'),
    p.viewScope !== 'none' ? link('#/kirjaukset', p.viewScope === 'own' ? 'Omat kirjaukset' : 'Kirjaukset') : null,
    p.exportScope !== 'none' ? link('#/vienti', 'Excel-vienti') : null,
    adminHref ? h('a', { href: adminHref, class: hash.startsWith('#/hallinta') ? 'active' : null }, 'Hallinta') : null,
    h('span', { class: 'who' }, `${state.me.user.name} · ${state.me.user.roleLabel}`),
    h('a', { href: '#/salasana' }, 'Salasana'),
    h('button', { type: 'button', onclick: logout }, 'Kirjaudu ulos'),
  ].filter(Boolean));
  nav.classList.remove('open');
  document.getElementById('menuToggle').setAttribute('aria-expanded', 'false');
}
document.getElementById('menuToggle').addEventListener('click', (e) => {
  const nav = document.getElementById('nav'); nav.classList.toggle('open');
  e.currentTarget.setAttribute('aria-expanded', nav.classList.contains('open'));
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
  const err = h('div', { class: 'notice err', hidden: true });
  const email = h('input', { type: 'email', id: 'email', autocomplete: 'username', required: true });
  const pw = h('input', { type: 'password', id: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Kirjaudu');
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.hidden = true; btn.disabled = true;
    try {
      await api('/login', { method: 'POST', body: { email: email.value, password: pw.value } });
      await loadMe(); state.form = null; go('#/kirjaa');
    } catch (ex) { err.textContent = ex.message; err.hidden = false; pw.value = ''; pw.focus(); }
    finally { btn.disabled = false; }
  } },
    h('div', { class: 'field' }, h('label', { for: 'email' }, 'Sähköposti'), email),
    h('div', { class: 'field' }, h('label', { for: 'password' }, 'Salasana'), pw),
    err, btn);
  $app.replaceChildren(h('div', { class: 'login-wrap' }, h('div', { class: 'login' }, h('div', { class: 'card' },
    h('div', { class: 'brand-mark' }, 'K'),
    h('h1', null, 'Kohtaamisten raportointi'),
    h('p', { class: 'muted' }, 'A-klinikkasäätiön hankkeiden yhteinen kirjauslomake.'),
    form,
    h('p', { class: 'small muted' }, 'Tunnukset saat hankkeesi tiimivetäjältä tai pääkäyttäjältä.'),
  ))));
  $app.classList.remove('container');
  email.focus();
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
      h('div', { class: 'notice warn' }, 'Sinua ei ole vielä liitetty yhteenkään hankkeeseen. Ole yhteydessä tiimivetäjään tai pääkäyttäjään.')));
    return;
  }
  const { questions } = await loadForm();
  const prefill = state.lastBasics || null;
  renderEncounterForm({ questions, initial: prefill, onSubmit: async (payload) => {
    const r = await api('/encounters', { method: 'POST', body: payload });
    state.lastBasics = { project_id: payload.project_id, encounter_date: payload.encounter_date, encounter_type: payload.encounter_type };
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
    h('p', { class: 'small muted' }, '”Kirjaa seuraava” säilyttää hankkeen, päivämäärän, roolin ja kirjauksen tyypin.'),
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
    pseudonym: init.pseudonym || '',
    answers: { ...(init.answers || {}) },
  };
  const qs = opts.questions;

  const errBox = h('div', { class: 'notice err', hidden: true, role: 'alert' });
  const dynamic = h('div');

  // --- Perustiedot
  const dateInput = h('input', { type: 'date', id: 'f-date', class: 'input-narrow', value: s.encounter_date, max: me.today, min: '2020-01-01', required: true,
    oninput: (e) => { s.encounter_date = e.target.value; } });

  const projectField = projects.length === 1
    ? h('div', { class: 'field' }, h('div', { class: 'label' }, 'Hanke'), h('p', null, h('strong', null, projects[0].name)))
    : h('div', { class: 'field' }, h('label', { for: 'f-project' }, 'Hanke', h('span', { class: 'req' }, '*')),
        h('select', { id: 'f-project', required: true, onchange: (e) => { s.project_id = Number(e.target.value) || null; renderDynamic(); } },
          h('option', { value: '' }, '– Valitse hanke –'),
          projects.map(p => h('option', { value: p.id, selected: p.id === s.project_id }, p.name))));

  // Kirjaajan rooli tulee käyttäjäprofiilista (korjattaessa säilyy alkuperäinen).
  const roleField = h('p', { class: 'small muted' }, 'Kirjaaja: ', h('strong', null, init.id ? init.recorder_role : me.user.recorderRole));

  const typeField = h('div', { class: 'field' }, h('div', { class: 'label', id: 'l-type' }, 'Valitse, mitä raportoit', h('span', { class: 'req' }, '*')),
    h('div', { class: 'segmented', role: 'radiogroup', 'aria-labelledby': 'l-type' },
      [['yksilo', 'Yksi kohtaaminen'], ['ryhma', 'Ryhmä tai useita kohtaamisia']].map(([v, t]) => h('label', { class: 'opt' },
        h('input', { type: 'radio', name: 'encounter_type', value: v, checked: s.encounter_type === v, onchange: () => { s.encounter_type = v; renderDynamic(); } }),
        h('span', null, t)))));

  const basics = h('section', { class: 'card section' },
    h('div', { class: 'section-title' }, h('h2', null, 'Perustiedot')),
    roleField,
    h('div', { class: 'field' },
      h('label', { for: 'f-date' }, 'Kohtaamisen ajankohta (tai alkamisajankohta)', h('span', { class: 'req' }, '*')),
      h('details', { class: 'define' }, h('summary', null, 'Mikä on kohtaaminen?'),
        h('p', null, 'Kohtaaminen on vuorovaikutustilanne, jossa kohderyhmään kuuluva henkilö tai kohderyhmään kuuluvien ryhmä on vuorovaikutuksessa ammattilaisen, koulutetun ohjaajan tai muun tukea tarjoavan kanssa. Kohtaamisessa tarjotaan hankkeen tavoitteiden mukaista tukea, ohjausta, neuvontaa, vertaistukea tai muuta kohderyhmälle suunnattua vuorovaikutteista palvelua.'),
        h('p', null, 'Jos raportoit pitkäkestoisesta ryhmästä tai dialogista, merkitse aloituspäivä.')),
      dateInput),
    projectField, typeField);

  // --- Dynaaminen osa: yksilö/ryhmä, yhteiset ja hankekohtaiset kysymykset
  function renderDynamic() {
    const parts = [];
    if (!s.encounter_type) { dynamic.replaceChildren(); return; }
    if (s.encounter_type === 'ryhma') {
      parts.push(h('section', { class: 'card section' },
        h('div', { class: 'section-title' }, h('h2', null, 'Ryhmän tiedot')),
        h('p', { class: 'help' }, 'Vuorovaikutustilanteeseen tai keskusteluketjuun osallistuneiden määrä = kohtaamisten määrä. Täysin passiivisia ei huomioida. Jos dialogi on luonteeltaan jatkuvaa, esim. verkkokeskustelualustalla, kohtaamisten määrä = viestien määrä (ohjaajat) tai aktiiviset päivät × osallistujien määrä, riippuen siitä kumpi kuvaa parhaiten erillisten vuorovaikutustilanteiden määrää.'),
        h('div', { class: 'row' },
          h('div', { class: 'field' }, h('label', { for: 'f-count' }, 'Kohtaamisten määrä', h('span', { class: 'req' }, '*')),
            h('p', { class: 'help' }, '1–9999'),
            h('input', { type: 'number', id: 'f-count', inputmode: 'numeric', min: '1', max: '9999', step: '1', required: true, value: s.encounter_count,
              oninput: (e) => { s.encounter_count = e.target.value; } })),
          h('div', { class: 'field' }, h('label', { for: 'f-persons' }, 'Eri osallistujien määrä'),
            h('p', { class: 'help' }, 'Jos ei tiedossa, jätä tyhjäksi. Älä laske työntekijöitä tai ohjaajia mukaan.'),
            h('input', { type: 'number', id: 'f-persons', inputmode: 'numeric', min: '1', max: '9999', step: '1', value: s.person_count,
              oninput: (e) => { s.person_count = e.target.value; } })))));
    } else {
      const warn = h('div', { class: 'field-warn', hidden: true });
      parts.push(h('section', { class: 'card section' },
        h('div', { class: 'section-title' }, h('h2', null, 'Yksilökohtaamisen tiedot')),
        h('p', { class: 'help' }, 'Yksi yhtenäinen keskustelu yhden kohderyhmään kuuluvan henkilön kanssa = yksi kohtaaminen. Jatkokysymys samassa keskustelussa kuuluu samaan kohtaamiseen. Jos dialogi on luonteeltaan jatkuvaa (esim. tukihenkilötyöskentely), kohtaamiseksi lasketaan ne päivät, jolloin vuorovaikutusta on tapahtunut. Digialustalla yksi kysymys–vastaus-kokonaisuus jatkokysymyksineen = yksi kohtaaminen.'),
        h('div', { class: 'field' }, h('label', { for: 'f-pseudo' }, 'Kohdatun mahdollinen nimimerkki tai muu tunniste'),
          h('p', { class: 'help' }, 'Jos ei tiedossa tai tietoa ei kerätä, jätä tyhjäksi. Älä kirjoita oikeita nimiä. Nimimerkkiä käytetään vain eri henkilöiden määrän arviointiin, eikä se näy Excel-viennissä.'),
          h('input', { type: 'text', id: 'f-pseudo', maxlength: '60', autocomplete: 'off', class: 'input-narrow', value: s.pseudonym,
            oninput: (e) => { s.pseudonym = e.target.value; const hit = sensitiveHit(e.target.value); warn.hidden = !hit; if (hit) warn.textContent = `Teksti näyttää ${hit}. Älä kirjaa tunnistetietoja.`; } }),
          warn)));
    }

    const visible = (q) => q.applies_to === 'kaikki' || q.applies_to === s.encounter_type;
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
    } else {
      parts.push(h('div', { class: 'notice info' }, 'Valitse hanke, niin näet myös hankekohtaiset kysymykset.'));
    }
    dynamic.replaceChildren(...parts);
  }

  const submitBtn = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, opts.submitLabel || 'Tallenna kirjaus');
  const form = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); errBox.hidden = true;
    const problem = clientValidate();
    if (problem) { errBox.textContent = problem; errBox.hidden = false; errBox.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    const visible = (q) => (q.applies_to === 'kaikki' || q.applies_to === s.encounter_type) && (q.project_id == null || q.project_id === s.project_id);
    const answers = {};
    for (const q of qs) if (visible(q) && s.answers[q.key] != null && s.answers[q.key] !== '') answers[q.key] = s.answers[q.key];
    const payload = { project_id: s.project_id, encounter_date: s.encounter_date, encounter_type: s.encounter_type,
      encounter_count: s.encounter_type === 'ryhma' ? s.encounter_count : 1, person_count: s.encounter_type === 'ryhma' ? s.person_count : null,
      pseudonym: s.encounter_type === 'yksilo' ? s.pseudonym : null, answers };
    submitBtn.disabled = true;
    try { await opts.onSubmit(payload); }
    catch (ex) { errBox.textContent = ex.message; errBox.hidden = false; errBox.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    finally { submitBtn.disabled = false; }
  } },
    h('div', { class: 'notice info small' }, 'Älä kirjaa lomakkeelle asiakkaan nimeä, yhteystietoja, terveystietoja tai muita tunnistetietoja.'),
    basics, dynamic, errBox,
    h('div', { class: 'sticky-actions actions' }, submitBtn,
      opts.onCancel ? h('button', { class: 'btn btn-secondary', type: 'button', onclick: opts.onCancel }, 'Peruuta') : null));

  function clientValidate() {
    if (!s.encounter_date) return 'Anna kohtaamisen ajankohta.';
    if (s.encounter_date > me.today) return 'Kohtaamisen ajankohta ei voi olla tulevaisuudessa.';
    if (!s.project_id) return 'Valitse hanke.';
    if (!s.encounter_type) return 'Valitse, mitä raportoit.';
    if (s.encounter_type === 'ryhma') {
      const n = Number(s.encounter_count);
      if (!Number.isInteger(n) || n < 1 || n > 9999) return 'Kohtaamisten määrä on oltava 1–9999.';
      if (s.person_count !== '' && s.person_count != null) { const p = Number(s.person_count); if (!Number.isInteger(p) || p < 1 || p > 9999) return 'Osallistujien määrä on oltava 1–9999 tai tyhjä.'; }
    }
    for (const q of qs) {
      if (!(q.applies_to === 'kaikki' || q.applies_to === s.encounter_type) || !(q.project_id == null || q.project_id === s.project_id)) continue;
      const v = s.answers[q.key];
      const empty = v == null || v === '' || (Array.isArray(v) && !v.length);
      if (q.required && empty) return `Vastaa kysymykseen: ${q.label}`;
      if (!empty && typeof v === 'string' && ['text', 'textarea'].includes(q.type)) { const hit = sensitiveHit(v); if (hit) return `Kenttä "${q.label}" näyttää sisältävän ${hit} näyttävää tietoa. Poista tunnistetiedot.`; }
    }
    return null;
  }

  $app.classList.add('container');
  $app.replaceChildren(h('div', { class: 'narrow' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, opts.title || 'Uusi kirjaus'),
      h('p', { class: 'muted' }, 'Tähdellä (*) merkityt kohdat ovat pakollisia.'))),
    form));
  renderDynamic();
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
      control = [input, q.free_text_warning ? h('p', { class: 'help small' }, 'Älä kirjaa asiakkaan henkilö-, terveys- tai muita tunnistetietoja.') : null, warn];
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
  return h('div', { class: 'field' }, label, help, control);
}

// ---------------------------------------------------------------------------
// Kirjausten selaus, tarkastelu, korjaus
// ---------------------------------------------------------------------------
const listState = { from: '', to: '', project_id: '', type: '', offset: 0 };

async function viewList() {
  $app.classList.add('container');
  const me = state.me; const p = me.permissions;
  const PAGE = 50;
  const tableBox = h('div');
  const stats = h('div', { class: 'stats' });
  const pager = h('div', { class: 'pager' });

  const f = (key, el) => { el.value = listState[key]; el.addEventListener('change', () => { listState[key] = el.value; listState.offset = 0; load(); }); return el; };
  const filters = h('div', { class: 'card' }, h('div', { class: 'filters' },
    h('div', { class: 'field' }, h('label', { for: 'l-from' }, 'Alkaen'), f('from', h('input', { type: 'date', id: 'l-from' }))),
    h('div', { class: 'field' }, h('label', { for: 'l-to' }, 'Päättyen'), f('to', h('input', { type: 'date', id: 'l-to' }))),
    me.projects.length > 1 ? h('div', { class: 'field' }, h('label', { for: 'l-proj' }, 'Hanke'),
      f('project_id', h('select', { id: 'l-proj' }, h('option', { value: '' }, 'Kaikki hankkeet'), me.projects.map(x => h('option', { value: x.id }, x.name))))) : null,
    h('div', { class: 'field' }, h('label', { for: 'l-type' }, 'Tyyppi'),
      f('type', h('select', { id: 'l-type' }, h('option', { value: '' }, 'Kaikki'), h('option', { value: 'yksilo' }, 'Yksi kohtaaminen'), h('option', { value: 'ryhma' }, 'Ryhmä')))),
  ));

  async function load() {
    tableBox.replaceChildren(h('div', { class: 'loading' }, 'Ladataan…'));
    const qs = new URLSearchParams({ limit: PAGE, offset: listState.offset });
    for (const k of ['from', 'to', 'project_id', 'type']) if (listState[k]) qs.set(k, listState[k]);
    const r = await api('/encounters?' + qs);
    stats.replaceChildren(
      h('div', { class: 'stat' }, h('b', null, fmtNum(r.totalEncounters)), h('span', null, 'kohtaamista')),
      h('div', { class: 'stat' }, h('b', null, fmtNum(r.total)), h('span', null, 'kirjausta (lomaketallennusta)')));
    if (!r.rows.length) { tableBox.replaceChildren(h('div', { class: 'card empty' }, 'Ei kirjauksia valituilla rajauksilla.')); pager.replaceChildren(); return; }
    tableBox.replaceChildren(h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Ajankohta'), h('th', null, 'Hanke'), h('th', null, 'Tyyppi'),
        h('th', { class: 'num' }, 'Kohtaamisia'), h('th', { class: 'num' }, 'Henkilöitä'), p.viewScope !== 'own' ? h('th', null, 'Kirjaaja') : null, h('th', null, 'Tallennettu'))),
      h('tbody', null, r.rows.map(row => h('tr', { class: 'clickable', tabindex: '0', onclick: () => go('#/kirjaukset/' + row.id),
        onkeydown: (e) => { if (e.key === 'Enter') go('#/kirjaukset/' + row.id); } },
        h('td', null, fmtDate(row.encounter_date)), h('td', null, row.project_name),
        h('td', null, h('span', { class: 'badge ' + (row.encounter_type === 'ryhma' ? 'blue' : '') }, typeLabel(row.encounter_type))),
        h('td', { class: 'num' }, fmtNum(row.encounter_count)), h('td', { class: 'num' }, row.person_count == null ? '–' : fmtNum(row.person_count)),
        p.viewScope !== 'own' ? h('td', null, row.created_by_name) : null,
        h('td', { class: 'small muted' }, fmtDateTime(row.created_at), row.updated_at ? h('span', { class: 'badge grey' }, ' korjattu') : null)))))));
    const end = Math.min(listState.offset + PAGE, r.total);
    pager.replaceChildren(h('span', { class: 'small muted' }, `Näytetään ${listState.offset + 1}–${end} / ${r.total}`),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-secondary btn-sm', disabled: listState.offset === 0, onclick: () => { listState.offset -= PAGE; load(); } }, '← Edelliset'),
        h('button', { class: 'btn btn-secondary btn-sm', disabled: end >= r.total, onclick: () => { listState.offset += PAGE; load(); } }, 'Seuraavat →')));
  }

  $app.replaceChildren(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, p.viewScope === 'own' ? 'Omat kirjaukset' : 'Kirjaukset'),
      h('p', { class: 'muted' }, p.viewScope === 'own' ? 'Näet tekemäsi kirjaukset. Korjaustarpeista ilmoita tiimivetäjälle.' :
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
      e.encounter_type === 'yksilo' && e.pseudonym ? [h('dt', null, 'Nimimerkki'), h('dd', null, e.pseudonym)] : null,
      h('dt', null, 'Kirjaajan rooli'), h('dd', null, e.recorder_role),
      h('dt', null, 'Tallennettu'), h('dd', null, fmtDateTime(e.created_at)),
      e.updated_at ? [h('dt', null, 'Korjattu'), h('dd', null, fmtDateTime(e.updated_at))] : null)),
    common.length ? h('div', { class: 'card' }, h('h2', null, 'Yhteiset kysymykset'), h('dl', { class: 'kv' }, common)) : null,
    own.length ? h('div', { class: 'card' }, h('h2', null, 'Hankekohtaiset kysymykset'), h('dl', { class: 'kv' }, own)) : null,
  ));
}

async function viewEdit(id) {
  const [{ encounter: e }, { questions }] = await Promise.all([api('/encounters/' + id), loadForm()]);
  if (!e.canEdit) return go('#/kirjaukset/' + id);
  renderEncounterForm({ questions, initial: e, title: 'Korjaa kirjausta', submitLabel: 'Tallenna korjaukset',
    onCancel: () => go('#/kirjaukset/' + id),
    onSubmit: async (payload) => { await api('/encounters/' + id, { method: 'PUT', body: payload }); toast('Korjaukset tallennettu.'); go('#/kirjaukset/' + id); } });
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
    p.manageProjects ? t('#/hallinta/hankkeet', 'Hankkeet') : null,
    p.manageUsers ? t('#/hallinta/kayttajat', 'Käyttäjät') : null,
    p.manageUsers ? t('#/hallinta/loki', 'Tapahtumaloki') : null));
}

// --- Käyttäjät
async function viewUsers() {
  $app.classList.add('container');
  const [{ users }, { projects }] = await Promise.all([api('/users'), api('/projects')]);
  const roles = state.me.roles;
  const editorBox = h('div');
  const pname = (id) => (projects.find(p => p.id === id) || {}).name || '?';

  function openEditor(u) {
    const isNew = !u;
    u = u || { name: '', email: '', role: 'hanketyontekija', recorder_role: null, active: 1, project_ids: [] };
    const name = h('input', { type: 'text', id: 'u-name', value: u.name });
    const email = h('input', { type: 'email', id: 'u-email', value: u.email });
    const role = h('select', { id: 'u-role' }, Object.entries(roles).map(([k, v]) => h('option', { value: k, selected: k === u.role }, v)));
    const active = h('input', { type: 'checkbox', checked: !!u.active });
    const defaults = state.me.defaultRecorderRoles;
    const recRole = h('select', { id: 'u-recrole' }, state.me.recorderRoles.map(r => h('option', { value: r, selected: r === (u.recorder_role || defaults[u.role]) }, r)));
    let recTouched = !isNew && u.recorder_role && u.recorder_role !== defaults[u.role];
    recRole.addEventListener('change', () => { recTouched = true; });
    role.addEventListener('change', () => { if (!recTouched) recRole.value = defaults[role.value]; });
    const pboxes = projects.map(p => ({ id: p.id, el: h('input', { type: 'checkbox', checked: u.project_ids.includes(p.id) }) }));
    const msg = h('div', { class: 'notice', hidden: true });
    const roleHelp = h('p', { class: 'help' });
    const ROLE_HELP = {
      admin: 'Kaikki oikeudet: kirjaukset, Excel-vienti, käyttäjien, hankkeiden ja kysymysten ylläpito. Hankevalinnat eivät rajoita adminia.',
      tiimivetaja: 'Kirjaa, selaa, korjaa ja poistaa valittujen hankkeiden kirjauksia sekä lataa niiden Excel-viennin.',
      hanketyontekija: 'Kirjaa valittuihin hankkeisiin ja selaa omia kirjauksiaan.',
      tuntityontekija: 'Kirjaa valittuihin hankkeisiin. Ei kirjausten selausta.',
    };
    const syncHelp = () => { roleHelp.textContent = ROLE_HELP[role.value]; };
    role.addEventListener('change', syncHelp); syncHelp();

    editorBox.replaceChildren(h('div', { class: 'card editor' },
      h('h2', null, isNew ? 'Uusi käyttäjä' : 'Muokkaa käyttäjää'),
      h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { for: 'u-name' }, 'Nimi'), name),
        h('div', { class: 'field' }, h('label', { for: 'u-email' }, 'Sähköposti (käyttäjätunnus)'), email)),
      h('div', { class: 'row' },
        h('div', { class: 'field' }, h('label', { for: 'u-role' }, 'Käyttöoikeusrooli'), roleHelp, role),
        h('div', { class: 'field' }, h('label', { for: 'u-recrole' }, 'Kirjaajan rooli raportoinnissa'),
          h('p', { class: 'help' }, 'Tallentuu jokaiseen käyttäjän kirjaukseen (lomakkeen ”Olen”-tieto). Vertaisille ja vapaaehtoisille valitse kolmas vaihtoehto.'), recRole)),
      h('div', { class: 'field' }, h('div', { class: 'label' }, 'Hankkeet'), h('div', { class: 'checks' },
        pboxes.map(b => h('label', { class: 'opt' }, b.el, h('span', null, pname(b.id)))))),
      !isNew ? h('div', { class: 'field' }, h('label', { class: 'switch' }, active, 'Tunnus käytössä')) : null,
      msg,
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
          const body = { name: name.value, email: email.value, role: role.value, recorder_role: recRole.value, active: active.checked, project_ids: pboxes.filter(b => b.el.checked).map(b => b.id) };
          try {
            if (isNew) {
              const r = await api('/users', { method: 'POST', body });
              showTemp(`Käyttäjä luotu. Väliaikainen salasana:`, r.temporaryPassword);
            } else { await api('/users/' + u.id, { method: 'PUT', body }); toast('Tallennettu.'); viewUsers(); }
          } catch (ex) { msg.className = 'notice err'; msg.textContent = ex.message; msg.hidden = false; }
        } }, isNew ? 'Luo käyttäjä' : 'Tallenna'),
        !isNew ? h('button', { class: 'btn btn-secondary', type: 'button', onclick: async () => {
          try { const r = await api(`/users/${u.id}/reset-password`, { method: 'POST' }); showTemp(`Salasana nollattu käyttäjälle ${u.name}. Uusi väliaikainen salasana:`, r.temporaryPassword); }
          catch (ex) { toast(ex.message, true); }
        } }, 'Nollaa salasana') : null,
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
      h('thead', null, h('tr', null, h('th', null, 'Nimi'), h('th', null, 'Sähköposti'), h('th', null, 'Rooli'), h('th', null, 'Hankkeet'), h('th', null, 'Viimeksi kirjautunut'), h('th', null, 'Tila'))),
      h('tbody', null, users.map(u => h('tr', { class: 'clickable', tabindex: '0', onclick: () => openEditor(u), onkeydown: (e) => { if (e.key === 'Enter') openEditor(u); } },
        h('td', null, h('strong', null, u.name)), h('td', null, u.email), h('td', null, h('span', { class: 'badge blue' }, roles[u.role])),
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
    editorBox.replaceChildren(h('div', { class: 'card editor' }, h('h2', null, isNew ? 'Uusi hanke' : 'Muokkaa hanketta'),
      h('div', { class: 'row' },
        h('div', { class: 'field' }, h('label', { for: 'p-code' }, 'Tunnus'), h('p', { class: 'help' }, 'Pysyvä, esim. KATUKLINIKKA. Ei voi muuttaa myöhemmin.'), code),
        h('div', { class: 'field' }, h('label', { for: 'p-name' }, 'Nimi lomakkeella'), h('p', { class: 'help' }, 'Näkyy kirjaajille ja raporteissa.'), name)),
      !isNew ? h('div', { class: 'field' }, h('label', { class: 'switch' }, active, 'Käytössä (näkyy lomakkeella)'),
        h('p', { class: 'help' }, 'Käytöstä poistetun hankkeen vanhat kirjaukset säilyvät raporteissa.')) : null,
      msg, h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
          try {
            if (isNew) await api('/projects', { method: 'POST', body: { code: code.value, name: name.value } });
            else await api('/projects/' + p.id, { method: 'PUT', body: { name: name.value, active: active.checked } });
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
        h('td', null, h('strong', null, p.name)), h('td', { class: 'small' }, p.code), h('td', { class: 'num' }, fmtNum(p.encounter_rows)),
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
      h('div', { class: 'actions field' }, h('label', { class: 'switch' }, required, 'Pakollinen'),
        !isNew ? h('label', { class: 'switch' }, active, 'Käytössä lomakkeella') : null),
      msg,
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
          const body = { key: key.value, project_id: q.project_id ?? null, label: label.value, help: help.value, type: type.value, applies_to: applies.value,
            required: required.checked, active: active.checked, options: opts };
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
          h('span', { class: 'small muted' }, q.key))),
      h('div', { class: 'q-ctrl' },
        h('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'aria-label': 'Siirrä ylös', disabled: i === 0, onclick: () => move(list, i, -1) }, '↑'),
        h('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'aria-label': 'Siirrä alas', disabled: i === list.length - 1, onclick: () => move(list, i, 1) }, '↓'),
        h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => openEditor(q) }, 'Muokkaa'))))
      : h('p', { class: 'muted small' }, 'Ei hankekohtaisia kysymyksiä.'));

  $app.replaceChildren(adminTabs('#/hallinta/kysymykset'),
    h('div', { class: 'notice info' }, 'Lomakkeen kiinteät perustiedot (ajankohta, hanke, kirjaajan rooli, yksilö/ryhmä, kohtaamisten ja osallistujien määrä sekä nimimerkki) ovat aina mukana. ',
      'Kysymyksiä ei poisteta, vaan ne otetaan pois käytöstä – näin aiempien vuosien raportointi säilyy ehjänä.'),
    editorBox,
    groupBlock('Yhteiset kysymykset', null, questions.filter(q => q.project_id == null)),
    ...projects.map(p => groupBlock(p.name + (p.active ? '' : ' (ei käytössä)'), p.id, questions.filter(q => q.project_id === p.id))));
}

// --- Tapahtumaloki
async function viewAudit() {
  $app.classList.add('container');
  const { rows } = await api('/audit');
  const LABELS = { login: 'Kirjautuminen', login_failed: 'Epäonnistunut kirjautuminen', password_changed: 'Salasana vaihdettu', encounter_create: 'Kirjaus luotu',
    encounter_update: 'Kirjaus korjattu', encounter_delete: 'Kirjaus poistettu', export: 'Excel-vienti', user_create: 'Käyttäjä luotu', user_update: 'Käyttäjä muokattu',
    user_reset_password: 'Salasana nollattu', project_create: 'Hanke luotu', project_update: 'Hanke muokattu', question_create: 'Kysymys luotu', question_update: 'Kysymys muokattu' };
  $app.replaceChildren(adminTabs('#/hallinta/loki'),
    h('p', { class: 'muted' }, '200 viimeisintä tapahtumaa.'),
    h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Aika'), h('th', null, 'Käyttäjä'), h('th', null, 'Tapahtuma'), h('th', null, 'Kohde'))),
      h('tbody', null, rows.map(r => h('tr', null, h('td', { class: 'small' }, fmtDateTime(r.at)), h('td', null, r.user_name || '–'),
        h('td', null, LABELS[r.action] || r.action), h('td', { class: 'small muted' }, r.entity ? `${r.entity} ${r.entity_id || ''}` : '')))))));
}

route();
