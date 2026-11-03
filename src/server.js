'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');

const { db, ensureAdmin, audit, RECORDER_ROLES, DIGITAL_LOCATION, FEATURES, featureEnabled, setFeature, features } = require('./db');
const { ROLES, PERMISSIONS, DEFAULT_RECORDER_ROLE_INDEX, can, scope, allowsEncounter } = require('./permissions');
const { buildWorkbook } = require('./export');
const demo = require('./demo');
const clients = require('./clients');
const { dashboard } = require('./dashboard');
const auth = require('./auth');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 10);

// ---------------------------------------------------------------------------
// Istuntovarasto SQLiteen (ei muistivuotoja, istunnot säilyvät uudelleenkäynnistyksessä)
// ---------------------------------------------------------------------------
class SqliteStore extends session.Store {
  constructor() {
    super();
    this.getStmt = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?');
    this.setStmt = db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expires) VALUES (?, ?, ?)');
    this.delStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    setInterval(() => db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now()), 15 * 60 * 1000).unref();
  }
  get(sid, cb) { try { const r = this.getStmt.get(sid, Date.now()); cb(null, r ? JSON.parse(r.sess) : null); } catch (e) { cb(e); } }
  set(sid, sess, cb) {
    try {
      const exp = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + SESSION_HOURS * 3600e3;
      this.setStmt.run(sid, JSON.stringify(sess), exp); cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) { try { this.delStmt.run(sid); cb && cb(null); } catch (e) { cb && cb(e); } }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

const app = express();
app.disable('x-powered-by');
if (IS_PROD) app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'] } },
}));
app.use(express.json({ limit: '200kb' }));
app.use(session({
  name: 'kr.sid',
  secret: SESSION_SECRET,
  store: new SqliteStore(),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'strict', secure: IS_PROD, maxAge: SESSION_HOURS * 3600e3 },
}));

// Terveystarkistus (Render health check)
app.get('/healthz', (req, res) => { db.prepare('SELECT 1').get(); res.json({ ok: true }); });

// Yksinkertainen CSRF-suoja: muuttavat pyynnöt vaativat oman otsakkeen,
// jota selain ei lähetä ristiinsivustopyynnöissä ilman CORS-lupaa.
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.get('X-Requested-With') !== 'kohtaamiset') {
    return res.status(403).json({ error: 'Pyyntö hylätty.' });
  }
  next();
});

// ---------------------------------------------------------------------------
// Apufunktiot
// ---------------------------------------------------------------------------
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

function loadUser(req) {
  if (!req.session.userId) return null;
  const u = db.prepare('SELECT id, email, name, role, active, must_change_password, recorder_role, auth_method, mfa_enabled FROM users WHERE id = ?').get(req.session.userId);
  return u && u.active ? u : null;
}

function userProjectIds(user) {
  if (user.role === 'admin') return db.prepare('SELECT id FROM projects').all().map(r => r.id);
  return db.prepare('SELECT project_id FROM user_projects WHERE user_id = ?').all(user.id).map(r => r.project_id);
}

function requireAuth(req, res, next) {
  const user = loadUser(req);
  if (!user) { if (req.session.userId) req.session.destroy(() => {}); return bad(res, 'Kirjaudu sisään.', 401); }
  req.user = user;
  req.projectIds = userProjectIds(user);
  if (user.must_change_password && !req.originalUrl.startsWith('/api/me')) return bad(res, 'Vaihda salasana ennen jatkamista.', 403);
  next();
}
const requirePerm = (perm) => (req, res, next) => (can(req.user, perm) ? next() : bad(res, 'Ei oikeutta.', 403));

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const toInt = (v) => (v === '' || v == null ? null : Number.isInteger(Number(v)) ? Number(v) : NaN);

// Henkilötunnus, sähköposti ja puhelinnumero – estetään vapaatekstikentissä.
const SENSITIVE_PATTERNS = [
  { re: /\b\d{6}[-+A-FU-Y]\d{3}[0-9A-FHJ-NPR-Y]\b/i, what: 'henkilötunnukselta' },
  { re: /[^\s@]+@[^\s@]+\.[a-z]{2,}/i, what: 'sähköpostiosoitteelta' },
  { re: /(\+358|\b0)\s?\d{1,3}[\s-]?\d{3}[\s-]?\d{3,4}\b/, what: 'puhelinnumerolta' },
];
function sensitiveHit(text) {
  for (const p of SENSITIVE_PATTERNS) if (p.re.test(text)) return p.what;
  return null;
}

function parseQ(q) { return { ...q, options: q.options ? JSON.parse(q.options) : null, required: !!q.required, active: !!q.active, free_text_warning: !!q.free_text_warning, suggest: !!q.suggest }; }

function activeQuestionsFor(projectId, type) {
  return db.prepare(`SELECT * FROM questions WHERE active = 1 AND (project_id IS NULL OR project_id = ?)
                     AND applies_to IN ('kaikki', ?) ORDER BY project_id IS NOT NULL, sort, id`)
    .all(projectId, type).map(parseQ);
}

// Validoi lomaketallennuksen. Palauttaa { data, answers } tai { error }.
// Kirjaajan rooli tulee kirjautuneen käyttäjän profiilista, ei lomakkeelta.
function validateEncounter(body, user, projectIds, existing) {
  const projectId = Number(body.project_id);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project || !project.active) return { error: 'Valitse hanke.' };
  if (!projectIds.includes(projectId)) return { error: 'Sinulla ei ole oikeutta kirjata tähän hankkeeseen.' };

  if (!isDate(body.encounter_date)) return { error: 'Anna kohtaamisen ajankohta.' };
  if (body.encounter_date > today()) return { error: 'Kohtaamisen ajankohta ei voi olla tulevaisuudessa.' };
  if (body.encounter_date < '2020-01-01') return { error: 'Tarkista kohtaamisen ajankohta.' };

  const type = body.encounter_type;
  if (!['yksilo', 'ryhma'].includes(type)) return { error: 'Valitse, mitä raportoit.' };

  // Selväkielistä nimimerkkiä ei tallenneta: asiakastunniste käsitellään clients.js:ssä tiivisteenä.
  let encounterCount, personCount;
  const pseudonym = null;
  if (type === 'yksilo') {
    encounterCount = 1; personCount = 1;
  } else {
    encounterCount = toInt(body.encounter_count);
    personCount = toInt(body.person_count);
    if (!Number.isInteger(encounterCount) || encounterCount < 1 || encounterCount > 9999) return { error: 'Kohtaamisten määrä on oltava 1–9999.' };
    if (personCount !== null && (!Number.isInteger(personCount) || personCount < 1 || personCount > 9999)) return { error: 'Osallistujien määrä on oltava 1–9999 tai tyhjä.' };
  }

  const answers = [];
  const given = body.answers && typeof body.answers === 'object' ? body.answers : {};
  // Sijainti valitaan joka kerta; jos se on "Digialustalla", kaupunkia ja katua ei kysytä eikä tallenneta
  const onDigital = String(given.sijainti || '').trim().toLowerCase() === DIGITAL_LOCATION.toLowerCase();
  for (const q of activeQuestionsFor(projectId, type)) {
    if (onDigital && q.digital_mode === 'hide') continue;
    let v = given[q.key];
    const empty = v == null || v === '' || (Array.isArray(v) && v.length === 0);
    if (empty) { if (q.required) return { error: `Vastaa kysymykseen: ${q.label}` }; continue; }
    switch (q.type) {
      case 'text': case 'textarea': {
        v = String(v).trim().slice(0, q.type === 'text' ? 200 : 4000);
        if (!v) { if (q.required) return { error: `Vastaa kysymykseen: ${q.label}` }; continue; }
        const hit = sensitiveHit(v);
        if (hit) return { error: `Kenttä "${q.label}" näyttää sisältävän ${hit} näyttävää tietoa. Älä kirjaa asiakkaan tunnistetietoja.` };
        break;
      }
      case 'number': { const n = Number(v); if (!Number.isFinite(n)) return { error: `Anna luku: ${q.label}` }; v = String(n); break; }
      case 'rating': { const n = Number(v); if (!q.options.map(Number).includes(n)) return { error: `Virheellinen arvio: ${q.label}` }; v = String(n); break; }
      case 'choice': if (!q.options.includes(v)) return { error: `Virheellinen valinta: ${q.label}` }; break;
      case 'multichoice': {
        if (!Array.isArray(v) || !v.every(x => q.options.includes(x))) return { error: `Virheellinen valinta: ${q.label}` };
        v = JSON.stringify(v); break;
      }
      case 'date': if (!isDate(v)) return { error: `Virheellinen päivämäärä: ${q.label}` }; break;
    }
    answers.push({ question_id: q.id, value: v });
  }

  const performer = resolvePerformer(body.performer, user, projectId, existing);
  if (performer.error) return performer;

  return {
    data: { project_id: projectId, encounter_date: body.encounter_date, encounter_type: type,
            encounter_count: encounterCount, person_count: personCount, pseudonym, ...performer },
    answers,
  };
}

// Kohtaamisen toteuttaja: kirjaaja itse (oletus), toinen hankkeen käyttäjä tai vapaaehtoinen.
// Kirjaajan rooli (raportoinnin "Olen"-tieto) määräytyy toteuttajasta.
const VOLUNTEER = 'vapaaehtoinen';
function projectMembers(projectId) {
  return db.prepare(`SELECT u.id, u.name, u.role FROM users u WHERE u.active = 1 AND u.is_test = 0
    AND (u.role = 'admin' OR EXISTS (SELECT 1 FROM user_projects up WHERE up.user_id = u.id AND up.project_id = ?)) ORDER BY u.name`).all(projectId);
}
function resolvePerformer(value, user, projectId, existing) {
  // Korjauksessa säilytetään alkuperäinen toteuttaja ja rooli, ellei toteuttajaa vaihdeta
  if (existing) {
    const cur = existing.performer_type === VOLUNTEER ? VOLUNTEER : String(existing.performed_by);
    if (value == null || value === '' || String(value) === cur) return { performer_type: existing.performer_type, performed_by: existing.performed_by, recorder_role: existing.recorder_role };
  }
  if (value === VOLUNTEER) return { performer_type: VOLUNTEER, performed_by: null, recorder_role: RECORDER_ROLES[2] };
  const id = value == null || value === '' || value === 'self' ? user.id : Number(value);
  if (id === user.id) return { performer_type: 'kayttaja', performed_by: user.id, recorder_role: RECORDER_ROLES[DEFAULT_RECORDER_ROLE_INDEX[user.role]] };
  const u = db.prepare('SELECT id, role, active FROM users WHERE id = ?').get(id);
  if (!u || !projectMembers(projectId).some(m => m.id === id)) {
    return { error: 'Valitse kohtaamisen toteuttaja hankkeen käyttäjistä tai ”Vapaaehtoinen”.' };
  }
  return { performer_type: 'kayttaja', performed_by: u.id, recorder_role: RECORDER_ROLES[DEFAULT_RECORDER_ROLE_INDEX[u.role]] };
}

function encounterVisibleWhere(user, projectIds) {
  const s = scope(user, 'viewScope');
  if (s === 'all') return { sql: '1=1', params: [] };
  if (s === 'projects') return { sql: `e.project_id IN (${projectIds.map(() => '?').join(',') || 'NULL'})`, params: projectIds };
  if (s === 'own') return { sql: '(e.created_by = ? OR e.performed_by = ?)', params: [user.id, user.id] };
  return { sql: '0=1', params: [] };
}

// ---------------------------------------------------------------------------
// Kirjautuminen
// ---------------------------------------------------------------------------
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.LOGIN_RATE_LIMIT || 10), standardHeaders: true, legacyHeaders: false,
  message: { error: 'Liian monta kirjautumisyritystä. Yritä uudelleen 15 minuutin kuluttua.' } });

const DUMMY_HASH = bcrypt.hashSync('dummy-password', 12);
const mfaLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.LOGIN_RATE_LIMIT || 10) * 2, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Liian monta yritystä. Yritä uudelleen 15 minuutin kuluttua.' } });
const PENDING_MS = 5 * 60 * 1000;

// Kirjautuminen valmis: uusi istunto ja käyttäjä siihen
function completeLogin(req, res, u, method, done) {
  req.session.regenerate((err) => {
    if (err) return bad(res, 'Kirjautuminen epäonnistui.', 500);
    req.session.userId = u.id;
    req.session.authMethod = method;
    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(u.id);
    audit(u.id, 'login', 'user', u.id, { method });
    done();
  });
}

// ---------------------------------------------------------------------------
// Täydennysehdotukset tekstikysymyksiin (vähintään 2 merkkiä)
//  - kaupunki: Suomen kunnat + aiemmin kirjatut
//  - muut (esim. kadunnimi): aiemmin kirjatut omien hankkeiden kirjauksista. Arvo ehdotetaan,
//    jos sitä on käytetty vähintään kahdessa kirjauksessa tai käyttäjä on kirjannut sen itse
//    (yksittäinen, mahdollisesti virheellinen teksti ei näy muille). Kadunnimet rajataan
//    valittuun kaupunkiin, jos sellainen on annettu.
// ---------------------------------------------------------------------------
const MUNICIPALITIES = require('./kunnat.json');
const fold = (v) => String(v || '').normalize('NFKC').trim().toLocaleLowerCase('fi');
const suggestLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false, message: { error: 'Liian monta hakua.' } });
const streets = require('./streets');
app.get('/api/suggest', requireAuth, requirePerm('record'), suggestLimiter, (req, res) => {
  const key = String(req.query.key || '');
  const q = fold(req.query.q);
  const qrow = db.prepare("SELECT id FROM questions WHERE key = ? AND type = 'text' AND suggest = 1").get(key);
  if (!qrow || q.length < 2 || q.length > 60) return res.json({ items: [] });
  const ph = req.projectIds.map(() => '?').join(',') || 'NULL';
  let cityFilter = '', cityParams = [];
  const city = fold(req.query.kaupunki);
  const cityQ = db.prepare("SELECT id FROM questions WHERE key = 'kaupunki'").get();
  if (key !== 'kaupunki' && city && cityQ) {
    cityFilter = 'AND EXISTS (SELECT 1 FROM encounter_answers c WHERE c.encounter_id = e.id AND c.question_id = ? AND lower(trim(c.value)) = ?)';
    cityParams = [cityQ.id, city];
  }
  const history = (withCity) => db.prepare(`SELECT a.value, COUNT(*) n, MAX(e.created_by = ?) mine FROM encounter_answers a
      JOIN encounters e ON e.id = a.encounter_id
      WHERE a.question_id = ? AND e.deleted_at IS NULL AND e.project_id IN (${ph}) ${withCity ? cityFilter : ''}
      GROUP BY lower(trim(a.value))`).all(req.user.id, qrow.id, ...req.projectIds, ...(withCity ? cityParams : []))
    .filter(r => r.n >= 2 || r.mine).map(r => ({ value: String(r.value).trim(), n: r.n }));
  let rows = history(true);
  if (cityFilter && !rows.some(r => fold(r.value).includes(q))) rows = history(false);
  if (key === 'kaupunki') {
    const known = new Set(rows.map(r => fold(r.value)));
    for (const m of MUNICIPALITIES) if (!known.has(fold(m))) rows.push({ value: m, n: 0 });
  }
  // Kadunnimet: valitun kunnan kadut sovelluksen omasta aineistosta (DVV:n osoitetiedot)
  const ALIAS = { mariehamn: 'Maarianhamina', 'maarianhamina - mariehamn': 'Maarianhamina', 'pedersören kunta': 'Pedersöre' };
  const municipality = city && (ALIAS[city] || MUNICIPALITIES.find(m => fold(m) === city));
  if (key === 'kadunnimi' && municipality) {
    const names = streets.streetsFor(municipality);
    if (names) {
      const known = new Set(rows.map(r => fold(r.value)));
      for (const n of names) if (!known.has(fold(n)) && fold(n).includes(q)) rows.push({ value: n, n: 0 });
    }
  }
  // Alusta alkavat ensin, sitten sanan alusta, sitten muualta; käytetyimmät ensin
  const rank = (v) => { const f = fold(v); return f.startsWith(q) ? 0 : f.split(/[\s-]+/).some(w => w.startsWith(q)) ? 1 : f.includes(q) ? 2 : 9; };
  let ranked = rows.map(r => ({ ...r, r: rank(r.value) })).filter(r => r.r < 9);
  // Keskeltä sanaa osuvat näytetään vain, jos alkuosumia ei ole (vähemmän kohinaa)
  if (ranked.some(r => r.r < 2)) ranked = ranked.filter(r => r.r < 2);
  const items = ranked
    .sort((a, b) => a.r - b.r || b.n - a.n || a.value.localeCompare(b.value, 'fi')).slice(0, 8).map(r => r.value);
  res.json({ items });
});

// Kirjautumistavat kirjautumissivulle (ei vaadi kirjautumista)
app.get('/api/auth/config', (req, res) => res.json({ entra: auth.entraEnabled(), mfaRequired: auth.mfaRequired() }));

// 1. vaihe: sähköposti ja salasana (paikalliset tunnukset, esim. tuntityöntekijät)
app.post('/api/login', loginLimiter, (req, res) => {
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (u && u.auth_method === 'entra' && u.active) {
    return bad(res, auth.entraEnabled() ? 'Kirjaudu säätiön Microsoft-tunnuksella.' : 'Tämä tunnus käyttää Microsoft-kirjautumista, joka ei ole vielä käytössä. Ota yhteyttä pääkäyttäjään.', 401);
  }
  const ok = bcrypt.compareSync(password, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok || !u.active) { audit(u && u.id, 'login_failed', 'user', u && u.id, { email }); return bad(res, 'Virheellinen sähköposti tai salasana.', 401); }
  if (!(auth.mfaRequired() || u.mfa_enabled)) return completeLogin(req, res, u, 'password', () => res.json({ ok: true }));
  // 2. vaihe: todennussovelluksen koodi (tai sen käyttöönotto ensimmäisellä kerralla)
  req.session.regenerate(async (err) => {
    if (err) return bad(res, 'Kirjautuminen epäonnistui.', 500);
    req.session.pending = { userId: u.id, exp: Date.now() + PENDING_MS, fails: 0 };
    if (u.mfa_enabled) return res.json({ mfa: 'verify' });
    const secret = auth.newSecret();
    req.session.pending.secret = auth.encrypt(secret);
    const uri = auth.otpauthUri(secret, u.email);
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220, errorCorrectionLevel: 'M' });
    res.json({ mfa: 'setup', secret: secret.replace(/(.{4})/g, '$1 ').trim(), otpauth: uri, qr });
  });
});

// 2. vaihe: TOTP-koodi
app.post('/api/login/mfa', mfaLimiter, (req, res) => {
  const pend = req.session.pending;
  if (!pend || pend.exp < Date.now()) { delete req.session.pending; return bad(res, 'Kirjautuminen vanheni. Aloita alusta.', 401); }
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(pend.userId);
  if (!u || !u.active) { delete req.session.pending; return bad(res, 'Kirjautuminen epäonnistui.', 401); }
  const secret = pend.secret ? auth.decrypt(pend.secret) : (u.mfa_secret ? auth.decrypt(u.mfa_secret) : null);
  if (!secret) { delete req.session.pending; return bad(res, 'Kirjautuminen epäonnistui. Aloita alusta.', 401); }
  const step = auth.verifyTotp(secret, req.body.code, pend.secret ? null : u.mfa_last_step);
  if (step == null) {
    pend.fails = (pend.fails || 0) + 1;
    audit(u.id, 'mfa_failed', 'user', u.id);
    if (pend.fails >= 5) { delete req.session.pending; return bad(res, 'Liian monta väärää koodia. Aloita kirjautuminen alusta.', 401); }
    return bad(res, 'Koodi ei kelpaa. Tarkista koodi sovelluksesta ja yritä uudelleen.', 401);
  }
  if (pend.secret) {
    db.prepare('UPDATE users SET mfa_secret = ?, mfa_enabled = 1, mfa_last_step = ? WHERE id = ?').run(pend.secret, step, u.id);
    audit(u.id, 'mfa_enrolled', 'user', u.id);
  } else {
    db.prepare('UPDATE users SET mfa_last_step = ? WHERE id = ?').run(step, u.id);
  }
  completeLogin(req, res, u, 'password+mfa', () => res.json({ ok: true }));
});

// ---------------------------------------------------------------------------
// Microsoft Entra ID -kirjautuminen (säätiön työntekijät)
// Rooli tulee Entran sovellusroolista (roles-väite), jos se on annettu;
// muuten käytetään sovelluksessa määriteltyä roolia. Hankkeet hallitaan sovelluksessa.
// ---------------------------------------------------------------------------
const AUTH_COOKIE = 'kr.auth';
const loginError = (res, msg) => res.redirect('/#/kirjaudu?virhe=' + encodeURIComponent(msg));
app.get('/auth/entra', loginLimiter, async (req, res) => {
  if (!auth.entraEnabled()) return loginError(res, 'Microsoft-kirjautuminen ei ole käytössä.');
  try {
    const { generators } = require('openid-client');
    const client = await auth.entraClient();
    const st = { state: generators.state(), nonce: generators.nonce(), verifier: generators.codeVerifier(), exp: Date.now() + 10 * 60 * 1000 };
    res.cookie(AUTH_COOKIE, auth.signState(st, SESSION_SECRET), { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: 10 * 60 * 1000, path: '/auth' });
    res.redirect(client.authorizationUrl({ scope: 'openid profile email', state: st.state, nonce: st.nonce,
      code_challenge: generators.codeChallenge(st.verifier), code_challenge_method: 'S256', prompt: 'select_account' }));
  } catch (e) {
    console.error('Entra-kirjautumisen aloitus epäonnistui:', e.message);
    loginError(res, 'Microsoft-kirjautumista ei saatu yhteyttä. Yritä hetken kuluttua uudelleen.');
  }
});

app.get('/auth/callback', loginLimiter, async (req, res) => {
  const st = auth.readState(auth.readCookie(req, AUTH_COOKIE), SESSION_SECRET);
  res.clearCookie(AUTH_COOKIE, { path: '/auth' });
  if (!auth.entraEnabled() || !st) return loginError(res, 'Kirjautuminen vanheni. Yritä uudelleen.');
  let claims;
  try {
    const client = await auth.entraClient();
    const params = client.callbackParams(req);
    if (params.error) return loginError(res, 'Microsoft-kirjautuminen peruttiin tai sitä ei sallittu.');
    const tokens = await client.callback(auth.entraConfig().redirectUri, params, { state: st.state, nonce: st.nonce, code_verifier: st.verifier });
    claims = tokens.claims();
  } catch (e) {
    console.error('Entra-kirjautuminen epäonnistui:', e.message);
    return loginError(res, 'Microsoft-kirjautuminen epäonnistui.');
  }
  const cfg = auth.entraConfig();
  if (claims.tid && cfg.tenant && claims.tid !== cfg.tenant) return loginError(res, 'Tunnus ei kuulu säätiön organisaatioon.');
  const oid = claims.oid || claims.sub;
  const email = String(claims.email || claims.preferred_username || '').trim().toLowerCase();
  const name = String(claims.name || email).trim();
  const roleClaims = Array.isArray(claims.roles) ? claims.roles.filter(r => ROLES[r]) : [];
  // Useasta roolista valitaan laajin
  const order = ['admin', 'tiimivetaja', 'hanketyontekija', 'tuntityontekija'];
  const entraRole = order.find(r => roleClaims.includes(r)) || null;

  let u = db.prepare('SELECT * FROM users WHERE entra_oid = ?').get(oid);
  if (!u && email) u = db.prepare("SELECT * FROM users WHERE email = ? AND auth_method = 'entra' AND entra_oid IS NULL").get(email);
  if (!u && email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    audit(null, 'login_failed', 'user', null, { email, method: 'entra', reason: 'local_account' });
    return loginError(res, 'Sähköpostiosoitteelle on sovelluksessa salasanatunnus. Pyydä pääkäyttäjää vaihtamaan kirjautumistavaksi Microsoft.');
  }
  if (!u && !entraRole) {
    audit(null, 'login_failed', 'user', null, { email, method: 'entra', reason: 'no_role' });
    return loginError(res, 'Sinulla ei ole vielä käyttöoikeutta. Ota yhteyttä pääkäyttäjään tai tiiminvetäjään.');
  }
  if (!u) {
    const id = db.prepare(`INSERT INTO users (email, name, password_hash, role, recorder_role, must_change_password, auth_method, entra_oid)
                           VALUES (?, ?, '!', ?, ?, 0, 'entra', ?)`).run(email || oid, name, entraRole, RECORDER_ROLES[DEFAULT_RECORDER_ROLE_INDEX[entraRole]], oid).lastInsertRowid;
    audit(null, 'user_create', 'user', id, { role: entraRole, method: 'entra' });
    u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  } else {
    if (!u.active) return loginError(res, 'Tunnus on suljettu.');
    const role = entraRole || u.role;
    db.prepare(`UPDATE users SET entra_oid = ?, name = ?, role = ?, recorder_role = ?, must_change_password = 0 WHERE id = ?`)
      .run(oid, name || u.name, role, RECORDER_ROLES[DEFAULT_RECORDER_ROLE_INDEX[role]], u.id);
    u = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
  }
  completeLogin(req, res, u, 'entra', () => res.redirect('/#/kirjaa'));
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => { res.clearCookie('kr.sid'); res.json({ ok: true }); }); });

// Piilotettu toiminto poistaa siihen liittyvän oikeuden kaikilta rooleilta
function effectivePermissions(role) {
  const p = { ...PERMISSIONS[role] };
  if (!featureEnabled('paths')) p.pathScope = 'none';
  return p;
}

app.get('/api/me', requireAuth, (req, res) => {
  const projects = db.prepare(`SELECT id, code, name, active, digital, color FROM projects WHERE id IN (${req.projectIds.map(() => '?').join(',') || 'NULL'}) ORDER BY sort, name`).all(...req.projectIds);
  res.json({
    user: { id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role, roleLabel: ROLES[req.user.role].label,
            mustChangePassword: !!req.user.must_change_password, authMethod: req.user.auth_method, mfaEnabled: !!req.user.mfa_enabled, recorderRole: RECORDER_ROLES[DEFAULT_RECORDER_ROLE_INDEX[req.user.role]] },
    permissions: effectivePermissions(req.user.role),
    features: features(),
    projects,
    recorderRoles: RECORDER_ROLES,
    defaultRecorderRoles: Object.fromEntries(Object.keys(ROLES).map(r => [r, RECORDER_ROLES[DEFAULT_RECORDER_ROLE_INDEX[r]]])),
    roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, v.label])),
    roleDescriptions: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, v.description])),
    today: today(),
    clientTracking: clients.ENABLED,
  });
});

app.post('/api/me/password', requireAuth, (req, res) => {
  if (req.user.auth_method === 'entra') return bad(res, 'Microsoft-tunnuksen salasanaa hallitaan Microsoftin palveluissa.');
  const { current, next: newPw } = req.body;
  const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(String(current || ''), u.password_hash)) return bad(res, 'Nykyinen salasana on väärin.');
  if (typeof newPw !== 'string' || newPw.length < 12) return bad(res, 'Uuden salasanan on oltava vähintään 12 merkkiä.');
  if (newPw === current) return bad(res, 'Uusi salasana ei voi olla sama kuin vanha.');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(bcrypt.hashSync(newPw, 12), req.user.id);
  audit(req.user.id, 'password_changed', 'user', req.user.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Lomake ja kirjaukset
// ---------------------------------------------------------------------------
app.get('/api/form', requireAuth, (req, res) => {
  const qs = db.prepare(`SELECT * FROM questions WHERE active = 1 AND (project_id IS NULL OR project_id IN (${req.projectIds.map(() => '?').join(',') || 'NULL'}))
                         ORDER BY project_id IS NOT NULL, sort, id`).all(...req.projectIds).map(parseQ);
  const services = db.prepare('SELECT id, name FROM referral_services WHERE active = 1 ORDER BY sort, name').all();
  const members = Object.fromEntries(req.projectIds.map(pid => [pid, projectMembers(pid).filter(m => m.id !== req.user.id).map(({ id, name }) => ({ id, name }))]));
  res.json({ questions: qs, referralServices: featureEnabled('paths') ? services : [], clientTracking: clients.ENABLED, members, digitalLocation: DIGITAL_LOCATION });
});

app.post('/api/encounters', requireAuth, requirePerm('record'), (req, res) => {
  const v = validateEncounter(req.body, req.user, req.projectIds);
  if (v.error) return bad(res, v.error);
  // Palveluohjausten seuranta kuuluu Asiakaspolut-toimintoon: piilotettuna ohjauksia ei kirjata
  const body = featureEnabled('paths') ? req.body : { ...req.body, referrals: [], referral_updates: [] };
  const cp = clients.prepareClientPart(body, v.data.encounter_type, sensitiveHit, v.data.project_id);
  if (cp.error) return bad(res, cp.error);
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.prepare(`INSERT INTO encounters (id, project_id, encounter_date, encounter_type, encounter_count, person_count, pseudonym, recorder_role, created_by, performed_by, performer_type)
                VALUES (@id, @project_id, @encounter_date, @encounter_type, @encounter_count, @person_count, @pseudonym, @recorder_role, @created_by, @performed_by, @performer_type)`)
      .run({ id, ...v.data, created_by: req.user.id });
    const ins = db.prepare('INSERT INTO encounter_answers (encounter_id, question_id, value) VALUES (?, ?, ?)');
    for (const a of v.answers) ins.run(id, a.question_id, a.value);
    clients.applyClientPart(cp, { encounterId: id, encounterDate: v.data.encounter_date, userId: req.user.id });
    audit(req.user.id, 'encounter_create', 'encounter', id, cp.client || cp.services.length || cp.updates.length
      ? { client: cp.client ? cp.client.mode : 'none', referrals: cp.services.length, referral_updates: cp.updates.length } : null);
  })();
  res.status(201).json({ id });
});

app.get('/api/encounters', requireAuth, (req, res) => {
  if (scope(req.user, 'viewScope') === 'none') return bad(res, 'Ei oikeutta.', 403);
  const w = encounterVisibleWhere(req.user, req.projectIds);
  const where = ['e.deleted_at IS NULL', w.sql]; const params = [...w.params];
  if (isDate(req.query.from)) { where.push('e.encounter_date >= ?'); params.push(req.query.from); }
  if (isDate(req.query.to)) { where.push('e.encounter_date <= ?'); params.push(req.query.to); }
  if (req.query.project_id) { where.push('e.project_id = ?'); params.push(Number(req.query.project_id)); }
  if (['yksilo', 'ryhma'].includes(req.query.type)) { where.push('e.encounter_type = ?'); params.push(req.query.type); }
  if (req.query.created_by && scope(req.user, 'viewScope') !== 'own') { where.push('(e.created_by = ? OR e.performed_by = ?)'); params.push(Number(req.query.created_by), Number(req.query.created_by)); }
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const whereSql = where.join(' AND ');
  const totals = db.prepare(`SELECT COUNT(*) rows, COALESCE(SUM(encounter_count),0) encounters FROM encounters e WHERE ${whereSql}`).get(...params);
  const rows = db.prepare(`SELECT e.id, e.encounter_date, e.encounter_type, e.encounter_count, e.person_count, e.created_at, e.updated_at, e.is_test,
                                  e.project_id, e.created_by, e.performed_by, e.performer_type, p.name project_name, u.name created_by_name, pu.name performed_by_name
                           FROM encounters e JOIN projects p ON p.id = e.project_id JOIN users u ON u.id = e.created_by LEFT JOIN users pu ON pu.id = e.performed_by
                           WHERE ${whereSql} ORDER BY e.encounter_date DESC, e.created_at DESC, e.rowid DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  for (const r of rows) {
    r.canEdit = allowsEncounter(req.user, 'editScope', r, req.projectIds);
    r.canDelete = allowsEncounter(req.user, 'deleteScope', r, req.projectIds);
  }
  res.json({ rows, total: totals.rows, totalEncounters: totals.encounters });
});

function loadEncounter(id) {
  return db.prepare('SELECT * FROM encounters WHERE id = ? AND deleted_at IS NULL').get(String(id));
}

app.get('/api/encounters/:id', requireAuth, (req, res) => {
  const e = loadEncounter(req.params.id);
  if (!e || !allowsEncounter(req.user, 'viewScope', e, req.projectIds)) return bad(res, 'Kirjausta ei löydy.', 404);
  const answers = db.prepare(`SELECT q.key, q.type, a.value FROM encounter_answers a JOIN questions q ON q.id = a.question_id WHERE a.encounter_id = ?`).all(e.id);
  const ans = {};
  for (const a of answers) ans[a.key] = a.type === 'multichoice' ? JSON.parse(a.value) : a.value;
  // Myös käytöstä poistettujen kysymysten vastaukset näytetään
  const allQs = db.prepare(`SELECT * FROM questions WHERE project_id IS NULL OR project_id = ? ORDER BY project_id IS NOT NULL, sort, id`).all(e.project_id).map(parseQ);
  const referralsMade = db.prepare(`SELECT rs.name service, r.status, r.status_on FROM referrals r JOIN referral_services rs ON rs.id = r.service_id
                                    WHERE r.encounter_id = ? ORDER BY rs.sort`).all(e.id);
  const referralUpdates = db.prepare(`SELECT rs.name service, r.status, r.referred_on FROM referrals r JOIN referral_services rs ON rs.id = r.service_id
                                      WHERE r.status_encounter_id = ? ORDER BY r.referred_on`).all(e.id);
  const { pseudonym, client_id, ...pub } = e;
  const nameOf = (id) => id == null ? null : (db.prepare('SELECT name FROM users WHERE id = ?').get(id) || {}).name || null;
  pub.created_by_name = nameOf(e.created_by); pub.performed_by_name = nameOf(e.performed_by);
  res.json({ encounter: { ...pub, client_linked: !!client_id, referrals: referralsMade, referral_updates: referralUpdates, answers: ans,
    canEdit: allowsEncounter(req.user, 'editScope', e, req.projectIds), canDelete: allowsEncounter(req.user, 'deleteScope', e, req.projectIds) },
    questions: allQs });
});

app.put('/api/encounters/:id', requireAuth, (req, res) => {
  const e = loadEncounter(req.params.id);
  if (!e || !allowsEncounter(req.user, 'editScope', e, req.projectIds)) return bad(res, 'Ei oikeutta korjata tätä kirjausta.', 403);
  // Korjaaja voi siirtää kirjauksen vain hankkeeseen, johon hänellä on oikeus.
  const v = validateEncounter(req.body, req.user, req.projectIds, e);
  if (v.error) return bad(res, v.error);
  db.transaction(() => {
    db.prepare(`UPDATE encounters SET project_id=@project_id, encounter_date=@encounter_date, encounter_type=@encounter_type,
                encounter_count=@encounter_count, person_count=@person_count,
                performed_by=@performed_by, performer_type=@performer_type, recorder_role=@recorder_role,
                updated_by=@uid, updated_at=datetime('now') WHERE id=@id`).run({ ...v.data, uid: req.user.id, id: e.id });
    // Säilytetään käytöstä poistettujen kysymysten vastaukset, korvataan aktiivisten.
    db.prepare(`DELETE FROM encounter_answers WHERE encounter_id = ? AND question_id IN (SELECT id FROM questions WHERE active = 1)`).run(e.id);
    const ins = db.prepare('INSERT INTO encounter_answers (encounter_id, question_id, value) VALUES (?, ?, ?)');
    for (const a of v.answers) ins.run(e.id, a.question_id, a.value);
    audit(req.user.id, 'encounter_update', 'encounter', e.id);
  })();
  res.json({ ok: true });
});

app.delete('/api/encounters/:id', requireAuth, (req, res) => {
  const e = loadEncounter(req.params.id);
  if (!e || !allowsEncounter(req.user, 'deleteScope', e, req.projectIds)) return bad(res, 'Ei oikeutta poistaa tätä kirjausta.', 403);
  db.prepare("UPDATE encounters SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ?").run(req.user.id, e.id);
  audit(req.user.id, 'encounter_delete', 'encounter', e.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Työntekijäkohtainen seuranta (admin: kaikki, tiiminvetäjä: omien hankkeiden kirjaukset)
// ---------------------------------------------------------------------------
function staffScopeSql(req, alias = 'e') {
  const s = scope(req.user, 'staffScope');
  if (s === 'all') return { sql: '1=1', params: [] };
  return { sql: `${alias}.project_id IN (${req.projectIds.map(() => '?').join(',') || 'NULL'})`, params: [...req.projectIds] };
}
function staffFilters(req) {
  const sc = staffScopeSql(req);
  const where = ['e.deleted_at IS NULL', sc.sql]; const params = [...sc.params];
  if (isDate(req.query.from)) { where.push('e.encounter_date >= ?'); params.push(req.query.from); }
  if (isDate(req.query.to)) { where.push('e.encounter_date <= ?'); params.push(req.query.to); }
  if (req.query.project_id) { where.push('e.project_id = ?'); params.push(Number(req.query.project_id)); }
  return { sql: where.join(' AND '), params };
}
const ratingQ = (key) => (db.prepare('SELECT id FROM questions WHERE key = ?').get(key) || {}).id || -1;

// Käyttäjät, jotka kuuluvat tarkastelijan näkyvyyteen (myös ne, joilla ei ole kirjauksia)
function staffUserIds(req) {
  if (scope(req.user, 'staffScope') === 'all') return db.prepare("SELECT id FROM users WHERE role <> 'admin' AND (active = 1 OR is_test = 1)").all().map(r => r.id);
  if (!req.projectIds.length) return [];
  return db.prepare(`SELECT DISTINCT user_id id FROM user_projects WHERE project_id IN (${req.projectIds.map(() => '?').join(',')})`).all(...req.projectIds).map(r => r.id);
}

app.get('/api/staff', requireAuth, (req, res) => {
  if (scope(req.user, 'staffScope') === 'none') return bad(res, 'Ei oikeutta.', 403);
  const f = staffFilters(req);
  const wr = ratingQ('tyontekijan_arvio'), cr = ratingQ('asiakkaan_arvio');
  const stats = db.prepare(`
    SELECT e.performed_by user_id, COUNT(*) rows, SUM(e.encounter_count) encounters,
           SUM(e.encounter_type = 'yksilo') yksilo_rows,
           SUM(e.encounter_type = 'ryhma') ryhma_rows,
           COALESCE(SUM(CASE WHEN e.encounter_type = 'ryhma' THEN e.encounter_count END), 0) ryhma_encounters,
           COUNT(DISTINCT e.encounter_date) active_days, MAX(e.encounter_date) last_date, MAX(e.created_at) last_saved,
           AVG(CAST(w.value AS REAL)) worker_rating, AVG(CAST(c.value AS REAL)) client_rating, COUNT(c.value) client_rating_n
    FROM encounters e
    LEFT JOIN encounter_answers w ON w.encounter_id = e.id AND w.question_id = ?
    LEFT JOIN encounter_answers c ON c.encounter_id = e.id AND c.question_id = ?
    WHERE ${f.sql} AND e.performed_by IS NOT NULL GROUP BY e.performed_by`).all(wr, cr, ...f.params);
  const byUser = new Map(stats.map(s => [s.user_id, s]));
  const ids = new Set([...staffUserIds(req), ...byUser.keys()]);
  if (!ids.size) return res.json({ rows: [], totals: { rows: 0, encounters: 0 } });
  const users = db.prepare(`SELECT id, name, role, recorder_role, active, is_test FROM users WHERE id IN (${[...ids].map(() => '?').join(',')})`).all(...ids);
  const rows = users.map(u => ({ ...u, rows: 0, encounters: 0, yksilo_rows: 0, ryhma_rows: 0, ryhma_encounters: 0, active_days: 0,
    last_date: null, last_saved: null, worker_rating: null, client_rating: null, client_rating_n: 0, ...(byUser.get(u.id) || {}) }))
    .sort((a, b) => b.encounters - a.encounters || a.name.localeCompare(b.name, 'fi'));
  const totals = rows.reduce((t, r) => ({ rows: t.rows + r.rows, encounters: t.encounters + r.encounters }), { rows: 0, encounters: 0 });
  res.json({ rows, totals });
});

app.get('/api/staff/:id', requireAuth, (req, res) => {
  if (scope(req.user, 'staffScope') === 'none') return bad(res, 'Ei oikeutta.', 403);
  const id = Number(req.params.id);
  const u = db.prepare('SELECT id, name, email, role, recorder_role, active, is_test, last_login_at, created_at FROM users WHERE id = ?').get(id);
  const f = staffFilters(req);
  const visible = u && (scope(req.user, 'staffScope') === 'all' || staffUserIds(req).includes(id) ||
    db.prepare(`SELECT 1 FROM encounters e WHERE e.performed_by = ? AND ${staffScopeSql(req).sql} LIMIT 1`).get(id, ...staffScopeSql(req).params));
  if (!visible) return bad(res, 'Työntekijää ei löydy.', 404);
  const where = `e.performed_by = ? AND ${f.sql}`; const params = [id, ...f.params];
  const wr = ratingQ('tyontekijan_arvio'), cr = ratingQ('asiakkaan_arvio');
  const kpi = db.prepare(`SELECT COUNT(*) rows, COALESCE(SUM(e.encounter_count), 0) encounters,
      COALESCE(SUM(e.encounter_type = 'yksilo'), 0) yksilo_rows, COALESCE(SUM(e.encounter_type = 'ryhma'), 0) ryhma_rows,
      COALESCE(SUM(CASE WHEN e.encounter_type = 'ryhma' THEN e.encounter_count END), 0) ryhma_encounters,
      COALESCE(SUM(CASE WHEN e.encounter_type = 'ryhma' THEN e.person_count END), 0) ryhma_persons,
      COUNT(DISTINCT e.encounter_date) active_days, MIN(e.encounter_date) first_date, MAX(e.encounter_date) last_date,
      COUNT(DISTINCT e.client_id) distinct_pseudonyms,
      AVG(CAST(w.value AS REAL)) worker_rating, AVG(CAST(c.value AS REAL)) client_rating, COUNT(c.value) client_rating_n,
      AVG(julianday(e.created_at) - julianday(e.encounter_date)) avg_delay_days
    FROM encounters e
    LEFT JOIN encounter_answers w ON w.encounter_id = e.id AND w.question_id = ?
    LEFT JOIN encounter_answers c ON c.encounter_id = e.id AND c.question_id = ?
    WHERE ${where}`).get(wr, cr, ...params);
  const monthly = db.prepare(`SELECT substr(e.encounter_date, 1, 7) month, COUNT(*) rows, SUM(e.encounter_count) encounters,
      COALESCE(SUM(CASE WHEN e.encounter_type = 'yksilo' THEN e.encounter_count END), 0) yksilo,
      COALESCE(SUM(CASE WHEN e.encounter_type = 'ryhma' THEN e.encounter_count END), 0) ryhma
    FROM encounters e WHERE ${where} GROUP BY month ORDER BY month`).all(...params);
  const byProject = db.prepare(`SELECT p.name, COUNT(*) rows, SUM(e.encounter_count) encounters
    FROM encounters e JOIN projects p ON p.id = e.project_id WHERE ${where} GROUP BY p.id ORDER BY encounters DESC`).all(...params);
  const workerRatings = db.prepare(`SELECT w.value rating, COUNT(*) n FROM encounters e JOIN encounter_answers w ON w.encounter_id = e.id AND w.question_id = ?
    WHERE ${where} GROUP BY w.value ORDER BY w.value`).all(wr, ...params);
  const byLocation = db.prepare(`SELECT a.value name, COUNT(*) rows, SUM(e.encounter_count) encounters FROM encounters e
    JOIN encounter_answers a ON a.encounter_id = e.id AND a.question_id = (SELECT id FROM questions WHERE key = 'sijainti')
    WHERE ${where} GROUP BY a.value ORDER BY encounters DESC`).all(...params);
  res.json({ user: { ...u, roleLabel: ROLES[u.role].label }, kpi, monthly, byProject, workerRatings, byLocation });
});

// ---------------------------------------------------------------------------
// Asiakastunnisteet (kaikki kirjaajat) – rajoitettu, ettei tunnisteita voi arvailla
// ---------------------------------------------------------------------------
const clientLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.CLIENT_LOOKUP_LIMIT || 60), standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => 'u' + req.session.userId, validate: false,
  message: { error: 'Liian monta tunnistehakua. Odota hetki ja yritä uudelleen.' } });

app.post('/api/clients/lookup', requireAuth, requirePerm('record'), clientLimiter, (req, res) => {
  if (!clients.ENABLED) return bad(res, 'Asiakastunnisteet eivät ole käytössä.', 503);
  const ref = String(req.body.ref || '');
  const projectId = Number(req.body.project_id);
  if (!req.projectIds.includes(projectId)) return bad(res, 'Valitse ensin hanke.');
  const err = clients.validateRef(ref, sensitiveHit); if (err) return bad(res, err);
  const c = clients.findClient(projectId, ref);
  audit(req.user.id, 'client_lookup', 'client', null, { mode: req.body.mode === 'new' ? 'new' : 'existing', found: !!c });
  if (req.body.mode === 'new') return res.json({ available: !c });
  if (!c) return res.json({ found: false });
  res.json({ found: true, summary: clients.clientSummary(c.id) });
});
app.post('/api/clients/generate', requireAuth, requirePerm('record'), clientLimiter, (req, res) => {
  if (!clients.ENABLED) return bad(res, 'Asiakastunnisteet eivät ole käytössä.', 503);
  const projectId = Number(req.body.project_id);
  if (!req.projectIds.includes(projectId)) return bad(res, 'Valitse ensin hanke.');
  res.json({ code: clients.generateUniqueCode(projectId) });
});

// ---------------------------------------------------------------------------
// Asiakaspolut (admin: kaikki, tiiminvetäjä: omien hankkeiden kirjaukset). Vain koosteita.
// ---------------------------------------------------------------------------
app.get('/api/paths', requireAuth, (req, res) => {
  if (!featureEnabled('paths')) return bad(res, 'Asiakaspolut eivät ole käytössä.', 404);
  const s = scope(req.user, 'pathScope');
  if (s === 'none') return bad(res, 'Ei oikeutta.', 403);
  const projectIds = s === 'all' ? db.prepare('SELECT id FROM projects').all().map(r => r.id) : req.projectIds;
  const projectId = req.query.project_id ? Number(req.query.project_id) : null;
  if (projectId && !projectIds.includes(projectId)) return bad(res, 'Ei oikeutta.', 403);
  res.json(clients.pathStats({ from: isDate(req.query.from) ? req.query.from : null, to: isDate(req.query.to) ? req.query.to : null, projectIds, projectId }));
});

// Kytkettävät toiminnot (vain admin)
app.get('/api/features', requireAuth, requirePerm('manageUsers'), (req, res) => {
  res.json({ features: Object.entries(FEATURES).map(([key, f]) => ({ key, label: f.label, description: f.description, enabled: featureEnabled(key) })) });
});
app.put('/api/features/:key', requireAuth, requirePerm('manageUsers'), (req, res) => {
  if (!FEATURES[req.params.key]) return bad(res, 'Tuntematon toiminto.', 404);
  const on = req.body.enabled === true;
  setFeature(req.params.key, on);
  audit(req.user.id, on ? 'feature_enable' : 'feature_disable', 'feature', req.params.key);
  res.json({ key: req.params.key, enabled: on });
});

// Tilastot (dashboard): admin kaikki, tiiminvetäjä ja hanketyöntekijä omat hankkeet
app.get('/api/dashboard', requireAuth, (req, res) => {
  const s = scope(req.user, 'dashScope');
  if (s === 'none') return bad(res, 'Ei oikeutta.', 403);
  const projectIds = s === 'all' ? db.prepare('SELECT id FROM projects').all().map(r => r.id) : req.projectIds;
  const projectId = req.query.project_id ? Number(req.query.project_id) : null;
  if (projectId && !projectIds.includes(projectId)) return bad(res, 'Ei oikeutta.', 403);
  const from = isDate(req.query.from) ? req.query.from : today().slice(0, 4) + '-01-01';
  const to = isDate(req.query.to) ? req.query.to : today();
  if (from > to) return bad(res, 'Tarkista aikaväli.');
  const types = String(req.query.types || 'yksilo,ryhma').split(',').filter(t => ['yksilo', 'ryhma'].includes(t));
  if (!types.length) return bad(res, 'Valitse vähintään yksi kohtaamisen tyyppi.');
  const role = RECORDER_ROLES.includes(req.query.role) ? req.query.role : null;
  res.json(dashboard({ from, to, projectIds, projectId, types, role,
    ika: req.query.ika ? String(req.query.ika) : null, sukupuoli: req.query.sukupuoli ? String(req.query.sukupuoli) : null,
    compare: String(req.query.compare || 'none'), kaupunki: req.query.kaupunki ? String(req.query.kaupunki).slice(0, 100) : null }));
});

// Ohjauspalveluiden ylläpito (admin)
app.get('/api/referral-services', requireAuth, requirePerm('manageQuestions'), (req, res) => {
  res.json({ services: db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM referrals r WHERE r.service_id = s.id) referral_count
                                   FROM referral_services s ORDER BY sort, name`).all() });
});
app.post('/api/referral-services', requireAuth, requirePerm('manageQuestions'), (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name.length < 2) return bad(res, 'Anna palvelun nimi.');
  if (db.prepare('SELECT 1 FROM referral_services WHERE name = ?').get(name)) return bad(res, 'Palvelu on jo listalla.');
  const sort = (db.prepare('SELECT MAX(sort) m FROM referral_services').get().m || 0) + 10;
  const id = db.prepare('INSERT INTO referral_services (name, sort) VALUES (?, ?)').run(name, sort).lastInsertRowid;
  audit(req.user.id, 'referral_service_create', 'referral_service', id, { name });
  res.status(201).json({ id });
});
app.put('/api/referral-services/:id', requireAuth, requirePerm('manageQuestions'), (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name.length < 2) return bad(res, 'Anna palvelun nimi.');
  if (db.prepare('SELECT 1 FROM referral_services WHERE name = ? AND id <> ?').get(name, Number(req.params.id))) return bad(res, 'Palvelu on jo listalla.');
  const r = db.prepare('UPDATE referral_services SET name = ?, active = ?, sort = COALESCE(?, sort) WHERE id = ?')
    .run(name, req.body.active === false ? 0 : 1, Number.isInteger(req.body.sort) ? req.body.sort : null, Number(req.params.id));
  if (!r.changes) return bad(res, 'Palvelua ei löydy.', 404);
  audit(req.user.id, 'referral_service_update', 'referral_service', req.params.id, { name, active: req.body.active !== false });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Excel-vienti
// ---------------------------------------------------------------------------
app.get('/api/export', requireAuth, async (req, res) => {
  const s = scope(req.user, 'exportScope');
  if (s === 'none') return bad(res, 'Ei oikeutta.', 403);
  if (!isDate(req.query.from) || !isDate(req.query.to) || req.query.from > req.query.to) return bad(res, 'Anna kelvollinen aikaväli.');
  const allowed = s === 'all' ? db.prepare('SELECT id FROM projects').all().map(r => r.id) : req.projectIds;
  let ids = String(req.query.projects || '').split(',').filter(Boolean).map(Number);
  if (ids.length === 0) ids = allowed;                       // "kaikki" = kaikki sallitut
  if (!ids.every(id => allowed.includes(id))) return bad(res, 'Ei oikeutta valittuihin hankkeisiin.', 403);
  if (ids.length === 0) return bad(res, 'Ei hankkeita vietäväksi.');
  const wb = buildWorkbook({ from: req.query.from, to: req.query.to, projectIds: ids });
  audit(req.user.id, 'export', 'encounter', null, { from: req.query.from, to: req.query.to, projects: ids });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="kohtaamiset_${req.query.from}_${req.query.to}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// ---------------------------------------------------------------------------
// Ylläpito: käyttäjät
// ---------------------------------------------------------------------------
const tempPassword = () => crypto.randomBytes(9).toString('base64url');

app.get('/api/users', requireAuth, requirePerm('manageUsers'), (req, res) => {
  const users = db.prepare('SELECT id, email, name, role, recorder_role, active, last_login_at, created_at, auth_method, mfa_enabled, entra_oid IS NOT NULL entra_linked FROM users ORDER BY name').all();
  const links = db.prepare('SELECT user_id, project_id FROM user_projects').all();
  for (const u of users) u.project_ids = links.filter(l => l.user_id === u.id).map(l => l.project_id);
  res.json({ users });
});

function validateUserBody(b) {
  if (!b.name || String(b.name).trim().length < 2) return 'Anna nimi.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email || ''))) return 'Anna kelvollinen sähköpostiosoite.';
  if (!ROLES[b.role]) return 'Valitse rooli.';
  if (!Array.isArray(b.project_ids)) return 'Virheelliset hankkeet.';
  if (b.auth_method != null && !['local', 'entra'].includes(b.auth_method)) return 'Valitse kirjautumistapa.';
  return null;
}
// Kirjaajan rooli johdetaan aina käyttöoikeusroolista, sitä ei valita erikseen.
function recorderRoleFor(b) {
  return RECORDER_ROLES[DEFAULT_RECORDER_ROLE_INDEX[b.role]];
}
function setUserProjects(userId, ids) {
  db.prepare('DELETE FROM user_projects WHERE user_id = ?').run(userId);
  const ins = db.prepare('INSERT OR IGNORE INTO user_projects (user_id, project_id) SELECT ?, id FROM projects WHERE id = ?');
  for (const pid of ids) ins.run(userId, Number(pid));
}

app.post('/api/users', requireAuth, requirePerm('manageUsers'), (req, res) => {
  const err = validateUserBody(req.body); if (err) return bad(res, err);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(req.body.email)) return bad(res, 'Sähköpostiosoite on jo käytössä.');
  const method = req.body.auth_method || 'local';
  // Microsoft-tunnuksella ei ole salasanaa; kirjautuminen yhdistyy sähköpostiosoitteen perusteella
  const pw = method === 'local' ? tempPassword() : null;
  const id = db.transaction(() => {
    const id = db.prepare('INSERT INTO users (email, name, password_hash, role, recorder_role, auth_method, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(String(req.body.email).trim(), String(req.body.name).trim(), pw ? bcrypt.hashSync(pw, 12) : '!', req.body.role, recorderRoleFor(req.body), method, pw ? 1 : 0).lastInsertRowid;
    setUserProjects(id, req.body.project_ids);
    audit(req.user.id, 'user_create', 'user', id, { role: req.body.role, method });
    return id;
  })();
  res.status(201).json({ id, temporaryPassword: pw });
});

app.put('/api/users/:id', requireAuth, requirePerm('manageUsers'), (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return bad(res, 'Käyttäjää ei löydy.', 404);
  const err = validateUserBody(req.body); if (err) return bad(res, err);
  const other = db.prepare('SELECT id FROM users WHERE email = ? AND id <> ?').get(req.body.email, id);
  if (other) return bad(res, 'Sähköpostiosoite on jo käytössä.');
  const active = req.body.active === false ? 0 : 1;
  if (id === req.user.id && (req.body.role !== 'admin' || !active)) return bad(res, 'Et voi poistaa omaa admin-oikeuttasi.');
  const method = req.body.auth_method || u.auth_method;
  if (id === req.user.id && method !== u.auth_method) return bad(res, 'Et voi vaihtaa omaa kirjautumistapaasi.');
  let temporaryPassword = null;
  db.transaction(() => {
    db.prepare('UPDATE users SET email = ?, name = ?, role = ?, recorder_role = ?, active = ?, auth_method = ? WHERE id = ?')
      .run(String(req.body.email).trim(), String(req.body.name).trim(), req.body.role, recorderRoleFor(req.body), active, method, id);
    if (method !== u.auth_method) {
      // Kirjautumistavan vaihto: Microsoft → salasana saa väliaikaisen salasanan; salasana → Microsoft poistaa salasanan ja MFA:n
      if (method === 'local') { temporaryPassword = tempPassword(); db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, entra_oid = NULL WHERE id = ?').run(bcrypt.hashSync(temporaryPassword, 12), id); }
      else db.prepare("UPDATE users SET password_hash = '!', must_change_password = 0, mfa_secret = NULL, mfa_enabled = 0, mfa_last_step = NULL WHERE id = ?").run(id);
      db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?").run(id);
    }
    setUserProjects(id, req.body.project_ids);
    if (!active) db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?").run(id);
    audit(req.user.id, 'user_update', 'user', id, { role: req.body.role, active, method });
  })();
  res.json({ ok: true, temporaryPassword });
});

// Kadonnut puhelin tai uusi todennussovellus: käyttäjä ottaa MFA:n uudelleen käyttöön seuraavalla kirjautumisella
app.post('/api/users/:id/reset-mfa', requireAuth, requirePerm('manageUsers'), (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return bad(res, 'Käyttäjää ei löydy.', 404);
  db.prepare('UPDATE users SET mfa_secret = NULL, mfa_enabled = 0, mfa_last_step = NULL WHERE id = ?').run(id);
  db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?").run(id);
  audit(req.user.id, 'user_reset_mfa', 'user', id);
  res.json({ ok: true });
});

app.post('/api/users/:id/reset-password', requireAuth, requirePerm('manageUsers'), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT auth_method FROM users WHERE id = ?').get(id);
  if (!target) return bad(res, 'Käyttäjää ei löydy.', 404);
  if (target.auth_method === 'entra') return bad(res, 'Microsoft-tunnuksen salasanaa hallitaan Microsoftin palveluissa.');
  const pw = tempPassword();
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(bcrypt.hashSync(pw, 12), id);
  db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?").run(id);
  audit(req.user.id, 'user_reset_password', 'user', id);
  res.json({ temporaryPassword: pw });
});

// ---------------------------------------------------------------------------
// Ylläpito: hankkeet
// ---------------------------------------------------------------------------
// Teemaväri: '#rrggbb' tai '#rrggbb,#rrggbb'; tyhjä = ei väriä; false = virheellinen
function normColor(v) {
  if (v == null || v === '') return null;
  const parts = String(v).toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
  if (!parts.length || parts.length > 2 || !parts.every(x => /^#[0-9a-f]{6}$/.test(x))) return false;
  return parts.join(',');
}
app.get('/api/projects', requireAuth, requirePerm('manageProjects'), (req, res) => {
  res.json({ projects: db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM encounters e WHERE e.project_id = p.id AND e.deleted_at IS NULL) encounter_rows
                                   FROM projects p ORDER BY sort, name`).all() });
});
app.post('/api/projects', requireAuth, requirePerm('manageProjects'), (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const name = String(req.body.name || '').trim();
  if (!/^[A-Z0-9_]{2,20}$/.test(code)) return bad(res, 'Tunnus: 2–20 merkkiä, A–Z, 0–9 tai _.');
  if (name.length < 2) return bad(res, 'Anna hankkeen nimi.');
  if (db.prepare('SELECT 1 FROM projects WHERE code = ?').get(code)) return bad(res, 'Tunnus on jo käytössä.');
  const sort = (db.prepare('SELECT MAX(sort) m FROM projects').get().m || 0) + 10;
  const color = normColor(req.body.color);
  if (color === false) return bad(res, 'Virheellinen väri.');
  const id = db.prepare('INSERT INTO projects (code, name, sort, digital, color) VALUES (?, ?, ?, 0, ?)').run(code, name, sort, color).lastInsertRowid;
  audit(req.user.id, 'project_create', 'project', id, { code, name, digital: !!req.body.digital });
  res.status(201).json({ id });
});
app.put('/api/projects/:id', requireAuth, requirePerm('manageProjects'), (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body.name || '').trim();
  if (name.length < 2) return bad(res, 'Anna hankkeen nimi.');
  const color = normColor(req.body.color);
  if (color === false) return bad(res, 'Virheellinen väri.');
  const r = db.prepare('UPDATE projects SET name = ?, active = ?, color = ?, sort = COALESCE(?, sort) WHERE id = ?')
    .run(name, req.body.active === false ? 0 : 1, color, Number.isInteger(req.body.sort) ? req.body.sort : null, id);
  if (!r.changes) return bad(res, 'Hanketta ei löydy.', 404);
  audit(req.user.id, 'project_update', 'project', id, req.body);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Ylläpito: kysymykset
// ---------------------------------------------------------------------------
const Q_TYPES = ['text', 'textarea', 'number', 'choice', 'multichoice', 'rating', 'date'];
function validateQuestion(b, isNew) {
  if (String(b.label || '').trim().length < 2) return 'Anna kysymyksen teksti.';
  if (!Q_TYPES.includes(b.type)) return 'Valitse kysymystyyppi.';
  if (!['kaikki', 'yksilo', 'ryhma'].includes(b.applies_to)) return 'Valitse, mihin kirjauksiin kysymys liittyy.';
  if (['choice', 'multichoice'].includes(b.type)) {
    if (!Array.isArray(b.options) || b.options.filter(o => String(o).trim()).length < 2) return 'Anna vähintään kaksi vastausvaihtoehtoa.';
  }
  if (isNew && !/^[a-z0-9_]{2,40}$/.test(String(b.key || ''))) return 'Tunniste: 2–40 merkkiä, a–z, 0–9 tai _.';
  if (b.project_id != null && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(Number(b.project_id))) return 'Hanketta ei löydy.';
  if (!['show', 'hide'].includes(b.digital_mode || 'show')) return 'Virheellinen sijaintiasetus.';
  return null;
}
const digitalCols = (b) => [b.digital_mode === 'hide' ? 'hide' : 'show', null];
function normalizeOptions(b) {
  if (['choice', 'multichoice'].includes(b.type)) return JSON.stringify([...new Set(b.options.map(o => String(o).trim()).filter(Boolean))]);
  if (b.type === 'rating') return JSON.stringify([1, 2, 3, 4, 5]);
  return null;
}

app.get('/api/questions', requireAuth, requirePerm('manageQuestions'), (req, res) => {
  const qs = db.prepare(`SELECT q.*, (SELECT COUNT(*) FROM encounter_answers a WHERE a.question_id = q.id) answer_count
                         FROM questions q ORDER BY q.project_id IS NOT NULL, q.project_id, q.sort, q.id`).all()
    .map(q => ({ ...parseQ(q), answer_count: q.answer_count }));
  res.json({ questions: qs });
});
app.post('/api/questions', requireAuth, requirePerm('manageQuestions'), (req, res) => {
  const b = req.body; const err = validateQuestion(b, true); if (err) return bad(res, err);
  if (db.prepare('SELECT 1 FROM questions WHERE key = ?').get(b.key)) return bad(res, 'Tunniste on jo käytössä.');
  const pid = b.project_id == null ? null : Number(b.project_id);
  const sort = (db.prepare('SELECT MAX(sort) m FROM questions WHERE project_id IS ?').get(pid).m || 0) + 10;
  const id = db.prepare(`INSERT INTO questions (key, project_id, label, help, type, options, required, applies_to, free_text_warning, sort, digital_mode, digital_value, suggest)
                         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.key, pid, b.label.trim(), (b.help || '').trim() || null, b.type, normalizeOptions(b), b.required ? 1 : 0, b.applies_to,
         ['text', 'textarea'].includes(b.type) ? 1 : 0, sort, ...digitalCols(b), b.type === 'text' && b.suggest ? 1 : 0).lastInsertRowid;
  audit(req.user.id, 'question_create', 'question', id, { key: b.key });
  res.status(201).json({ id });
});
app.put('/api/questions/:id', requireAuth, requirePerm('manageQuestions'), (req, res) => {
  const id = Number(req.params.id);
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  if (!q) return bad(res, 'Kysymystä ei löydy.', 404);
  const b = { digital_mode: q.digital_mode, digital_value: q.digital_value, suggest: !!q.suggest, ...req.body, project_id: q.project_id };     // hanke ja tunniste ovat pysyviä
  const err = validateQuestion(b, false); if (err) return bad(res, err);
  const answered = db.prepare('SELECT COUNT(*) n FROM encounter_answers WHERE question_id = ?').get(id).n;
  if (answered && b.type !== q.type) return bad(res, 'Kysymystyyppiä ei voi muuttaa, kun kysymykseen on jo vastattu. Lisää uusi kysymys ja poista vanha käytöstä.');
  db.prepare(`UPDATE questions SET label=?, help=?, type=?, options=?, required=?, applies_to=?, active=?, digital_mode=?, digital_value=?, suggest=?, sort=COALESCE(?, sort), updated_at=datetime('now') WHERE id=?`)
    .run(b.label.trim(), (b.help || '').trim() || null, b.type, normalizeOptions(b), b.required ? 1 : 0, b.applies_to,
         b.active === false ? 0 : 1, ...digitalCols(b), b.type === 'text' && b.suggest ? 1 : 0, Number.isInteger(b.sort) ? b.sort : null, id);
  audit(req.user.id, 'question_update', 'question', id, { label: b.label, active: b.active });
  res.json({ ok: true });
});
app.post('/api/questions/reorder', requireAuth, requirePerm('manageQuestions'), (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
  const upd = db.prepare('UPDATE questions SET sort = ? WHERE id = ?');
  db.transaction(() => ids.forEach((id, i) => upd.run((i + 1) * 10, id)))();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Ylläpito: testidata (vain admin)
// ---------------------------------------------------------------------------
app.get('/api/admin/demo-data', requireAuth, requirePerm('manageUsers'), (req, res) => res.json(demo.demoCount()));
app.post('/api/admin/demo-data', requireAuth, requirePerm('manageUsers'), (req, res) => {
  const count = Math.min(Math.max(parseInt(req.body.count, 10) || 40, 1), 500);
  try {
    const created = demo.createDemoData({ count, userId: req.user.id, validate: validateEncounter, user: req.user, projectIds: req.projectIds });
    audit(req.user.id, 'demo_create', 'encounter', null, { created });
    res.status(201).json({ created, ...demo.demoCount() });
  } catch (e) { bad(res, e.message); }
});
app.delete('/api/admin/demo-data', requireAuth, requirePerm('manageUsers'), (req, res) => {
  const deleted = demo.deleteDemoData();
  audit(req.user.id, 'demo_delete', 'encounter', null, { deleted });
  res.json({ deleted });
});

app.get('/api/audit', requireAuth, requirePerm('manageUsers'), (req, res) => {
  res.json({ rows: db.prepare(`SELECT a.*, u.name user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 200`).all() });
});

// ---------------------------------------------------------------------------
// Staattinen käyttöliittymä
// ---------------------------------------------------------------------------
// Välimuisti: index.html haetaan aina uudelleen ja se viittaa tiedostoihin
// versiotunnisteella (?v=…), joka vaihtuu jokaisessa julkaisussa. Näin selain ei
// koskaan näytä vanhaa käyttöliittymää uuden julkaisun jälkeen.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const BUILD_ID = (process.env.RENDER_GIT_COMMIT || '').slice(0, 12) || Date.now().toString(36);
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
  .replace('href="/app.css"', `href="/app.css?v=${BUILD_ID}"`)
  .replace('src="/app.js"', `src="/app.js?v=${BUILD_ID}"`);
const sendIndex = (req, res) => { res.set('Cache-Control', 'no-cache, no-store, must-revalidate'); res.type('html').send(INDEX_HTML); };
app.get(['/', '/index.html'], sendIndex);
app.use(express.static(PUBLIC_DIR, { index: false, setHeaders: (res, filePath) => {
  // Versioidut tiedostot: selain tarkistaa muutokset aina (ETag), joten päivitys näkyy heti.
  res.setHeader('Cache-Control', 'no-cache');
} }));
app.get('/version', (req, res) => res.json({ build: BUILD_ID }));
app.get(/^\/(?!api\/).*/, sendIndex);
app.use('/api', (req, res) => bad(res, 'Ei löydy.', 404));
app.use((err, req, res, next) => { console.error(err); bad(res, 'Palvelinvirhe.', 500); });

if (require.main === module) {
  const created = ensureAdmin();
  if (created) {
    console.log('\n=== Ensimmäinen admin-käyttäjä luotu ===');
    console.log(`Sähköposti: ${created.email}`);
    console.log(`Salasana:   ${created.password}   (vaihdettava ensimmäisellä kirjautumisella)\n`);
  }
  if (!process.env.SESSION_SECRET) console.warn('VAROITUS: SESSION_SECRET puuttuu – istunnot katkeavat uudelleenkäynnistyksessä.');
  if (!clients.ENABLED) console.warn('VAROITUS: PSEUDONYM_KEY puuttuu (väh. 16 merkkiä) – asiakastunnisteet ja palveluohjausten seuranta eivät ole käytössä.');
  else if (!process.env.PSEUDONYM_KEY) console.warn('HUOM: käytetään kehitysavainta asiakastunnisteille. Aseta PSEUDONYM_KEY tuotannossa.');
  const migrated = clients.migratePlaintextPseudonyms();
  if (migrated) console.log(`Selväkieliset nimimerkit muutettu tiivisteiksi: ${migrated} kirjausta.`);
  clients.applyRetention();
  setInterval(() => { try { clients.applyRetention(); } catch (e) { console.error(e); } }, 24 * 3600e3).unref();
  app.listen(PORT, () => console.log(`Kohtaamisten raportointi käynnissä: http://localhost:${PORT}`));
}

module.exports = app;
module.exports.validateEncounter = validateEncounter;
