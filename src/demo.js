'use strict';
// Testidatan generointi. Kirjaukset merkitään is_test = 1, jolloin ne voi
// poistaa kerralla ennen tuotantokäyttöä. Jokainen kirjaus ajetaan saman
// validoinnin läpi kuin lomakkeelta tuleva tallennus.

const crypto = require('crypto');
const { db, RECORDER_ROLES } = require('./db');

// Toistettava satunnaislukugeneraattori (mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const CITIES = {
  Helsinki: ['Mannerheimintie', 'Hämeentie', 'Itäväylä', 'Kaisaniemenkatu', 'Kauppatori'],
  Tampere: ['Hämeenkatu', 'Hatanpään valtatie', 'Tammelantori'],
  Turku: ['Aurakatu', 'Kauppiaskatu', 'Itäinen Rantakatu'],
  Oulu: ['Kirkkokatu', 'Isokatu'],
  Jyväskylä: ['Kauppakatu', 'Väinönkatu'],
  Lahti: ['Aleksanterinkatu', 'Rautatienkatu'],
};
const PSEUDONYMS = ['Kettu', 'Sininen', 'Mökö', 'Tähti', 'Jäkälä', 'Peikko', 'Kuura', 'Varis'];

// Vapaatekstit: realistisia, ei tunnistetietoja (läpäisevät tunnistetietotarkistuksen).
const NOTES = [
  'Keskustelu jäi kesken, asiakas lupasi palata asiaan.',
  'Puhuttiin päihteiden käytön vähentämisestä ja unen merkityksestä.',
  'Annettiin tietoa lähimmistä matalan kynnyksen palveluista.',
  'Asiakas kertoi toipumisen edistyneen viime kuukausina.',
  'Ohjattiin terveysneuvontapisteeseen, asiakas kiinnostunut.',
  'Läheisen huoli nuoren käytöstä, käytiin läpi keinoja ottaa asia puheeksi.',
  'Kysymyksiä dopingaineiden sivuvaikutuksista, annettiin tietoa.',
  'Ryhmässä hyvä tunnelma, uusia osallistujia mukana.',
  'Rahapelaamiseen liittyvää ahdistusta, ohjattiin vertaistukeen.',
  'Asiakas halusi vain jutella, vuorovaikutus jäi lyhyeksi.',
  'Käytiin läpi turvallisempaa käyttöä ja yliannostusriskejä.',
  'Keskusteltiin lapsuuden perheen päihteiden käytön vaikutuksista.',
];
const FEEDBACK = [
  'Hyvä kun on joku, jolle voi puhua.',
  'Sai uutta tietoa, aikoo kokeilla.',
  'Kiitos, tästä oli apua.',
  'Toivoisi pidempiä aukioloaikoja.',
  'Mukava ryhmä, tulee uudelleen.',
  'Vastaus tuli nopeasti.',
];

function generateDemoPayloads(count, seed = Date.now()) {
  const r = rng(seed);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const chance = (p) => r() < p;
  const int = (min, max) => min + Math.floor(r() * (max - min + 1));

  const projects = db.prepare('SELECT * FROM projects WHERE active = 1 ORDER BY sort').all();
  const questions = db.prepare('SELECT * FROM questions WHERE active = 1').all()
    .map(q => ({ ...q, options: q.options ? JSON.parse(q.options) : null }));

  // Päivämäärät: kuluvan vuoden alusta tähän päivään
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const start = new Date(today.getFullYear(), 0, 1, 12);
  const span = Math.max(1, Math.round((today - start) / 86400000));
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const out = [];
  for (let i = 0; i < count; i++) {
    // Kierretään kaikki hankkeet läpi, jotta jokaisella on dataa
    const project = i < projects.length ? projects[i] : pick(projects);
    const type = chance(0.68) ? 'yksilo' : 'ryhma';
    const d = new Date(start.getTime() + int(0, span) * 86400000);
    const payload = {
      project_id: project.id,
      encounter_date: fmt(d > today ? today : d),
      encounter_type: type,
      encounter_count: type === 'ryhma' ? int(3, 40) : 1,
      person_count: null,
      pseudonym: null,
      answers: {},
      _recorder_role: RECORDER_ROLES[0],   // admin = säätiön työntekijä
    };
    if (type === 'ryhma') {
      // Joskus osallistujamäärä ei ole tiedossa; muuten ≤ kohtaamisten määrä
      if (chance(0.75)) payload.person_count = Math.max(1, Math.round(payload.encounter_count * (0.3 + r() * 0.7)));
    } else if (chance(0.55)) {
      payload.pseudonym = pick(PSEUDONYMS);   // toistuvia nimimerkkejä → eri henkilöiden laskennan testaus
    }

    const digital = chance(0.35);
    for (const q of questions) {
      if (q.project_id != null && q.project_id !== project.id) continue;
      if (q.applies_to !== 'kaikki' && q.applies_to !== type) continue;
      const k = q.key;
      let v;
      switch (k) {
        case 'tyontekijan_arvio': v = String(pick([3, 4, 4, 4, 5, 5, 2])); break;
        case 'asiakkaan_arvio': v = chance(0.5) ? String(pick([3, 4, 5, 5, 4])) : null; break;
        case 'sijainti': v = digital ? 'Digialustalla' : pick(q.options.filter(o => o !== 'Digialustalla')); break;
        case 'kaupunki': v = digital ? null : pick(Object.keys(CITIES)); payload._city = v; break;
        case 'kadunnimi': v = !digital && payload._city && chance(0.6) ? pick(CITIES[payload._city]) : null; break;
        case 'tyontekijan_huomiot': v = chance(0.7) ? pick(NOTES) : null; break;
        case 'asiakkaan_palaute': v = chance(0.35) ? pick(FEEDBACK) : null; break;
        default:
          // Muut (myös myöhemmin lisätyt hankekohtaiset) kysymykset tyypin mukaan
          if (!q.required && chance(0.2)) { v = null; break; }
          if (q.type === 'choice') v = pick(q.options);
          else if (q.type === 'multichoice') v = q.options.filter(() => chance(0.4)).slice(0, 3);
          else if (q.type === 'rating') v = String(int(2, 5));
          else if (q.type === 'number') v = String(int(1, 20));
          else if (q.type === 'date') v = payload.encounter_date;
          else if (q.type === 'text' || q.type === 'textarea') v = q.required ? 'Testivastaus' : null;
      }
      if (v != null && !(Array.isArray(v) && !v.length)) payload.answers[k] = v;
    }
    delete payload._city;
    out.push(payload);
  }
  return out;
}

/**
 * Luo testikirjaukset. validate = server.js:n validateEncounter.
 * Palauttaa luotujen määrän.
 */
// Testityöntekijät (suljettuja tunnuksia, eivät voi kirjautua). Kirjaukset jaetaan
// heidän nimiinsä, jotta työntekijäkohtaista seurantaa voi testata.
const DEMO_WORKERS = [
  // rr = kirjaajan rooli: säätiön työntekijät 0, tuntityöntekijä (avustaja) 1
  { name: 'Testi Aino Aaltonen', role: 'hanketyontekija', rr: 0, weight: 5 },
  { name: 'Testi Mikko Laine', role: 'hanketyontekija', rr: 0, weight: 4 },
  { name: 'Testi Sanna Koski', role: 'tiimivetaja', rr: 0, weight: 2 },
  { name: 'Testi Joonas Heikkinen', role: 'tuntityontekija', rr: 1, weight: 3 },
  { name: 'Testi Leena Virta', role: 'tuntityontekija', rr: 1, weight: 2 },
];
function ensureDemoWorkers() {
  const projects = db.prepare('SELECT id FROM projects WHERE active = 1 ORDER BY sort').all().map(p => p.id);
  const ins = db.prepare(`INSERT INTO users (email, name, password_hash, role, recorder_role, active, must_change_password, is_test)
                          VALUES (?, ?, '!', ?, ?, 0, 1, 1)`);
  const link = db.prepare('INSERT OR IGNORE INTO user_projects (user_id, project_id) VALUES (?, ?)');
  return DEMO_WORKERS.map((w, i) => {
    const email = `testi${i + 1}@testidata.invalid`;
    let u = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!u) u = { id: ins.run(email, w.name, w.role, RECORDER_ROLES[w.rr]).lastInsertRowid };
    else db.prepare('UPDATE users SET role = ?, recorder_role = ? WHERE id = ?').run(w.role, RECORDER_ROLES[w.rr], u.id);
    // Jokainen testityöntekijä 2–3 hankkeeseen
    const own = [projects[i % projects.length], projects[(i + 2) % projects.length], projects[(i + 4) % projects.length]].slice(0, 2 + (i % 2));
    own.forEach(pid => link.run(u.id, pid));
    return { id: u.id, projects: own, recorder_role: RECORDER_ROLES[w.rr], weight: w.weight };
  });
}

function createDemoData({ count, userId, validate, user, projectIds }) {
  const payloads = generateDemoPayloads(count);
  const workers = ensureDemoWorkers();
  const pool = workers.flatMap(w => Array(w.weight).fill(w));
  const insE = db.prepare(`INSERT INTO encounters (id, project_id, encounter_date, encounter_type, encounter_count, person_count, pseudonym,
                             recorder_role, created_by, created_at, is_test)
                           VALUES (@id, @project_id, @encounter_date, @encounter_type, @encounter_count, @person_count, @pseudonym,
                             @recorder_role, @created_by, @created_at, 1)`);
  const insA = db.prepare('INSERT INTO encounter_answers (encounter_id, question_id, value) VALUES (?, ?, ?)');
  let created = 0;
  db.transaction(() => {
    for (const p of payloads) {
      const v = validate(p, user, projectIds);
      if (v.error) throw new Error('Testidatan validointi epäonnistui: ' + v.error);
      const id = crypto.randomUUID();
      // Tallennusaika = kohtaamispäivä + 0–2 vrk, kuten oikeassa käytössä
      const created_at = new Date(Date.parse(p.encounter_date + 'T08:00:00Z') + Math.floor(Math.random() * 2 * 86400000));
      const now = new Date();
      // Kirjaaja: testityöntekijä, jolla on kirjauksen hanke (painotettu), muuten admin
      const cands = pool.filter(w => w.projects.includes(p.project_id));
      const w = cands.length ? cands[Math.floor(Math.random() * cands.length)] : null;
      insE.run({ id, ...v.data, recorder_role: w ? w.recorder_role : p._recorder_role, created_by: w ? w.id : userId,
        created_at: (created_at > now ? now : created_at).toISOString().slice(0, 19).replace('T', ' ') });
      for (const a of v.answers) insA.run(id, a.question_id, a.value);
      created++;
    }
  })();
  return created;
}

function deleteDemoData() {
  return db.transaction(() => {
    const n = db.prepare('DELETE FROM encounters WHERE is_test = 1').run().changes;
    // Testityöntekijät poistetaan, jos heillä ei ole muita kuin testikirjauksia
    db.prepare(`DELETE FROM users WHERE is_test = 1 AND id NOT IN (SELECT created_by FROM encounters)
                AND id NOT IN (SELECT updated_by FROM encounters WHERE updated_by IS NOT NULL)
                AND id NOT IN (SELECT deleted_by FROM encounters WHERE deleted_by IS NOT NULL)`).run();
    return n;
  })();
}

function demoCount() {
  return db.prepare('SELECT COUNT(*) rows, COALESCE(SUM(encounter_count), 0) encounters FROM encounters WHERE is_test = 1 AND deleted_at IS NULL').get();
}

module.exports = { generateDemoPayloads, createDemoData, deleteDemoData, demoCount };
