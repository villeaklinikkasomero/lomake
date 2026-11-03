'use strict';
// Asiakastunnisteet ja palveluohjaukset.
//
// Tietosuoja:
//  - Asiakkaan nimimerkkiä tai tunnusta EI tallenneta tietokantaan. Siitä
//    tallennetaan vain HMAC-SHA256-tiiviste, joka lasketaan palvelimen
//    ympäristömuuttujassa olevalla avaimella (PSEUDONYM_KEY). Pelkällä
//    tietokannalla (esim. varmuuskopio tai vuoto) tunnisteita ei voi palauttaa
//    eikä arvata.
//  - Tunniste on HANKEKOHTAINEN: hanke on mukana tiivisteen laskennassa, joten
//    saman nimimerkin tiivisteet eri hankkeissa eivät ole yhdistettävissä.
//    Hankkeen sisällä kaksi asiakasta ei voi saada samaa tunnistetta.
//    Hankkeiden välistä asiakaslinkitystä ei ole.
//  - Linkitys katkaistaan automaattisesti, kun asiakasta ei ole kohdattu
//    CLIENT_RETENTION_MONTHS kuukauteen (oletus 24).
//  - Avainta EI saa vaihtaa käytön aikana: vaihto katkaisee kaikki linkitykset.

const crypto = require('crypto');
const { db, audit } = require('./db');

const IS_PROD = process.env.NODE_ENV === 'production';
const DEV_KEY = 'kehitys-avain-ei-tuotantoon';
const KEY = process.env.PSEUDONYM_KEY || (IS_PROD ? null : DEV_KEY);
const ENABLED = !!KEY && KEY.length >= 16;
const RETENTION_MONTHS = Number(process.env.CLIENT_RETENTION_MONTHS || 24);

db.exec(`
CREATE TABLE IF NOT EXISTS clients (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER REFERENCES projects(id),
  ref_hash    TEXT NOT NULL,                 -- HMAC(avain, hanke + vakioitu tunniste); ei selväkielistä tunnistetta
  legacy      INTEGER NOT NULL DEFAULT 0,    -- 1 = vanha säätiötasoinen tiiviste, päivitetään hankekohtaiseksi ensimmäisellä haulla
  generated   INTEGER NOT NULL DEFAULT 0,    -- 1 = järjestelmän luoma satunnaistunnus
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  created_by  INTEGER REFERENCES users(id),
  is_test     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project_id, ref_hash)
);

CREATE TABLE IF NOT EXISTS referral_services (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL UNIQUE,
  active  INTEGER NOT NULL DEFAULT 1,
  sort    INTEGER NOT NULL DEFAULT 0
);

-- Palveluohjaus. Tila päivitetään asiakkaan myöhemmässä kohtaamisessa saman
-- hankkeen sisällä. Ilman asiakastunnistetta tila on 'ei_seurattavissa'.
CREATE TABLE IF NOT EXISTS referrals (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  encounter_id        TEXT NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  client_id           INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  service_id          INTEGER NOT NULL REFERENCES referral_services(id),
  referred_on         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'avoin' CHECK (status IN ('avoin','toteutui','ei_toteutunut','ei_seurattavissa')),
  status_on           TEXT,
  status_encounter_id TEXT REFERENCES encounters(id) ON DELETE SET NULL,
  status_by           INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS ix_ref_client ON referrals(client_id, status);
CREATE INDEX IF NOT EXISTS ix_ref_encounter ON referrals(encounter_id);
`);
if (!db.prepare('PRAGMA table_info(encounters)').all().some(c => c.name === 'client_id')) {
  db.exec('ALTER TABLE encounters ADD COLUMN client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL');
}
db.exec('CREATE INDEX IF NOT EXISTS ix_enc_client ON encounters(client_id)');

// Migraatio: säätiötasoiset asiakkaat → hankekohtaiset. Taulu rakennetaan uudelleen
// (UNIQUE-ehto muuttuu), ja asiakas, joka on kohdattu useassa hankkeessa, jaetaan
// hankekohtaisiksi asiakkaiksi. Hankkeiden välinen yhteys katkeaa.
if (!db.prepare('PRAGMA table_info(clients)').all().some(c => c.name === 'project_id')) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`CREATE TABLE clients_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER REFERENCES projects(id), ref_hash TEXT NOT NULL,
      legacy INTEGER NOT NULL DEFAULT 0, generated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER REFERENCES users(id), is_test INTEGER NOT NULL DEFAULT 0, UNIQUE (project_id, ref_hash));
      INSERT INTO clients_new (id, ref_hash, legacy, generated, created_at, created_by, is_test)
        SELECT id, ref_hash, 1, generated, created_at, created_by, is_test FROM clients;
      DROP TABLE clients;
      ALTER TABLE clients_new RENAME TO clients;`);
    const ins = db.prepare('INSERT INTO clients (project_id, ref_hash, legacy, generated, created_at, created_by, is_test) VALUES (?, ?, 1, ?, ?, ?, ?)');
    for (const c of db.prepare('SELECT * FROM clients').all()) {
      const projects = db.prepare('SELECT DISTINCT project_id FROM encounters WHERE client_id = ? ORDER BY project_id').all(c.id).map(r => r.project_id);
      if (!projects.length) { db.prepare('DELETE FROM clients WHERE id = ?').run(c.id); continue; }
      db.prepare('UPDATE clients SET project_id = ? WHERE id = ?').run(projects[0], c.id);
      for (const pid of projects.slice(1)) {
        const nid = ins.run(pid, c.ref_hash, c.generated, c.created_at, c.created_by, c.is_test).lastInsertRowid;
        db.prepare('UPDATE encounters SET client_id = ? WHERE client_id = ? AND project_id = ?').run(nid, c.id, pid);
        db.prepare('UPDATE referrals SET client_id = ? WHERE client_id = ? AND encounter_id IN (SELECT id FROM encounters WHERE project_id = ?)').run(nid, c.id, pid);
      }
    }
  })();
  db.pragma('foreign_keys = ON');
}

if (db.prepare('SELECT COUNT(*) n FROM referral_services').get().n === 0) {
  const ins = db.prepare('INSERT INTO referral_services (name, sort) VALUES (?, ?)');
  ['Päihde- ja riippuvuuspalvelut', 'Terveysneuvonta tai terveyspalvelut', 'Mielenterveyspalvelut', 'Sosiaalipalvelut',
   'Asumispalvelut', 'Vertaistuki tai ryhmätoiminta', 'Säätiön toinen palvelu', 'Muu palvelu']
    .forEach((n, i) => ins.run(n, (i + 1) * 10));
}

// --- Tunnisteen käsittely -----------------------------------------------------
// Vakiointi: Unicode-normalisointi, pienet kirjaimet, vain kirjaimet ja numerot.
// "Kettu 88", "kettu88" ja "KETTU-88" ovat sama tunniste.
function normalize(ref) {
  return String(ref || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
// Lisäksi ääkköset ja muut tarkkeet ohitetaan: "Mäyrä", "Mayra" ja "MÄYRÄ" ovat sama tunniste
// (puhelimella tai vieraalla näppäimistöllä ääkköset jäävät helposti pois).
function fold(ref) {
  return normalize(ref).normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC');
}
// Hankekohtainen tiiviste: sama nimimerkki eri hankkeissa → eri tiiviste
function hashRef(projectId, ref) {
  return crypto.createHmac('sha256', KEY).update(`asiakas:p${Number(projectId)}:` + fold(ref)).digest('hex');
}
// Aiempi tiiviste (ääkköset erotteleva) – vanhat rivit päivitetään haun yhteydessä
function hashRefV1(projectId, ref) {
  return crypto.createHmac('sha256', KEY).update(`asiakas:p${Number(projectId)}:` + normalize(ref)).digest('hex');
}
// Vanha (ennen hankekohtaisuutta) tiiviste – käytetään vain vanhojen rivien päivittämiseen
function legacyHash(ref) {
  return crypto.createHmac('sha256', KEY).update('asiakas:' + normalize(ref)).digest('hex');
}
// Satunnainen nimimerkki kahdesta sanasta (adjektiivi + luonnosta tai eläimistä), esim. "Sininen Kettu".
// Sanat on valittu neutraaleiksi: ei henkilönnimiä, yleisiä sukunimiä, arvottavia eikä arkaluonteisia sanoja.
const ADJECTIVES = ['Sininen', 'Vihreä', 'Punainen', 'Keltainen', 'Kultainen', 'Hopeinen', 'Iloinen', 'Rohkea', 'Nopea', 'Kirkas',
  'Lempeä', 'Tumma', 'Vaalea', 'Utelias', 'Vikkelä', 'Viisas', 'Reipas', 'Tyyni', 'Raikas', 'Lämmin', 'Kesäinen', 'Talvinen',
  'Syksyinen', 'Keväinen', 'Pehmeä', 'Vahva', 'Ketterä', 'Hohtava', 'Leikkisä', 'Sitkeä', 'Uljas', 'Valoisa', 'Villi',
  'Rauhallinen', 'Pirteä', 'Notkea', 'Tähtinen', 'Huurteinen', 'Aurinkoinen', 'Sumuinen', 'Tuulinen', 'Ripeä', 'Hellä',
  'Sinertävä', 'Vehreä', 'Kuulas', 'Ystävällinen', 'Oranssi', 'Violetti', 'Turkoosi'];
const NOUNS = ['Kettu', 'Karhu', 'Ilves', 'Jänis', 'Orava', 'Siili', 'Pöllö', 'Haukka', 'Joutsen', 'Kurki', 'Lokki', 'Harakka',
  'Tikka', 'Peippo', 'Sorsa', 'Hirvi', 'Majava', 'Saukko', 'Hylje', 'Hauki', 'Ahven', 'Muikku', 'Mäyrä', 'Näätä', 'Kärppä',
  'Myyrä', 'Sammakko', 'Perhonen', 'Kimalainen', 'Leppäkerttu', 'Kuu', 'Pilvi', 'Tuuli', 'Lumihiutale', 'Sateenkaari',
  'Revontuli', 'Puro', 'Metsä', 'Mänty', 'Pihlaja', 'Vaahtera', 'Kanerva', 'Mustikka', 'Puolukka', 'Mansikka', 'Vadelma',
  'Omena', 'Sammal', 'Niitty', 'Kukkula', 'Tunturi', 'Majakka', 'Kompassi', 'Purjevene', 'Lyhty', 'Kanootti', 'Käpy',
  'Simpukka', 'Meritähti', 'Delfiini', 'Pingviini', 'Kameli', 'Seepra', 'Koala', 'Pandakarhu', 'Tiikeri', 'Kilpikonna'];
function newCode(withNumber) {
  const pick = (arr) => arr[crypto.randomInt(arr.length)];
  return `${pick(ADJECTIVES)} ${pick(NOUNS)}` + (withNumber ? ` ${crypto.randomInt(2, 100)}` : '');
}
function validateRef(ref, sensitiveHit) {
  const n = normalize(ref);
  if (n.length < 3) return 'Tunnisteen on oltava vähintään 3 merkkiä (kirjaimia tai numeroita).';
  if (n.length > 40) return 'Tunniste on liian pitkä.';
  if (sensitiveHit && sensitiveHit(String(ref))) return 'Tunniste näyttää sisältävän tunnistetietoja. Älä käytä oikeaa nimeä, henkilötunnusta tai yhteystietoja.';
  return null;
}

// Hakee asiakkaan hankkeen sisältä. Vanha säätiötasoinen rivi päivitetään samalla hankekohtaiseksi.
function findClient(projectId, ref) {
  const hash = hashRef(projectId, ref);
  const c = db.prepare('SELECT * FROM clients WHERE project_id = ? AND ref_hash = ?').get(projectId, hash);
  if (c) return c;
  // Ennen ääkkösten ohitusta tallennettu tunniste löytyy, kun se kirjoitetaan samoin kuin tallennettaessa.
  // Rivi päivitetään samalla uuteen muotoon, jonka jälkeen kelpaa myös ääkkösetön kirjoitusasu.
  const v1 = hashRefV1(projectId, ref);
  if (v1 !== hash) {
    const o = db.prepare('SELECT * FROM clients WHERE project_id = ? AND ref_hash = ? AND legacy = 0').get(projectId, v1);
    if (o) {
      try { db.prepare('UPDATE clients SET ref_hash = ? WHERE id = ?').run(hash, o.id); return { ...o, ref_hash: hash }; }
      catch { return o; }   // harvinainen törmäys (esim. "Mäyrä" ja "Mayra" eri asiakkaina): jätetään ennalleen
    }
  }
  const old = db.prepare('SELECT * FROM clients WHERE project_id = ? AND legacy = 1 AND ref_hash = ?').get(projectId, legacyHash(ref));
  if (!old) return undefined;
  db.prepare('UPDATE clients SET ref_hash = ?, legacy = 0 WHERE id = ?').run(hash, old.id);
  return { ...old, ref_hash: hash, legacy: 0 };
}

function generateUniqueCode(projectId) {
  // Ensin pelkät sanat; jos hankkeessa on jo paljon asiakkaita, lisätään loppuun numero
  for (let i = 0; i < 40; i++) { const c = newCode(i >= 25); if (!findClient(projectId, c)) return c; }
  throw new Error('Tunnuksen luonti epäonnistui.');
}

// Palaavan asiakkaan yhteenveto kirjaajalle. Näytetään vain avoimet ohjaukset
// (palvelu ja päivämäärä), ei muiden hankkeiden vapaatekstejä tai muita tietoja.
function clientSummary(clientId) {
  const s = db.prepare(`SELECT COUNT(*) encounters, MIN(encounter_date) first_date, MAX(encounter_date) last_date
                        FROM encounters WHERE client_id = ? AND deleted_at IS NULL`).get(clientId);
  const open = db.prepare(`SELECT r.id, r.referred_on, rs.name service FROM referrals r
                           JOIN referral_services rs ON rs.id = r.service_id
                           JOIN encounters e ON e.id = r.encounter_id AND e.deleted_at IS NULL
                           WHERE r.client_id = ? AND r.status = 'avoin' ORDER BY r.referred_on`).all(clientId);
  return { encounters: s.encounters, first_month: s.first_date ? s.first_date.slice(0, 7) : null,
           last_date: s.last_date, open_referrals: open };
}

/**
 * Tarkistaa lomakkeen asiakastunniste- ja ohjausosan uutta kirjausta varten.
 * Palauttaa { error } tai { client: {mode, hash, id}, services: [id], updates: [{id, status}] }.
 */
function prepareClientPart(body, type, sensitiveHit, projectId) {
  const out = { client: null, services: [], updates: [] };
  if (type !== 'yksilo') return out;
  const mode = body.client_mode || 'none';
  if (!['none', 'existing', 'new'].includes(mode)) return { error: 'Virheellinen asiakastunnisteen valinta.' };
  if (mode !== 'none') {
    if (!ENABLED) return { error: 'Asiakastunnisteet eivät ole käytössä (PSEUDONYM_KEY puuttuu palvelimelta).' };
    const ref = String(body.client_ref || '');
    const err = validateRef(ref, sensitiveHit); if (err) return { error: err };
    const hash = hashRef(projectId, ref);
    const existing = findClient(projectId, ref);
    if (mode === 'existing' && !existing) return { error: 'Asiakastunnistetta ei löydy tästä hankkeesta. Tarkista kirjoitusasu tai valitse ”Uusi asiakas”.' };
    if (mode === 'new' && existing) return { error: 'Tunniste on jo toisen asiakkaan käytössä tässä hankkeessa. Valitse toinen tunniste tai luo satunnainen tunnus.' };
    out.client = { mode, hash, projectId, id: existing ? existing.id : null, generated: !!body.client_generated };
  }
  const services = Array.isArray(body.referrals) ? [...new Set(body.referrals.map(Number))] : [];
  if (services.length) {
    const ok = db.prepare(`SELECT id FROM referral_services WHERE active = 1 AND id IN (${services.map(() => '?').join(',')})`).all(...services);
    if (ok.length !== services.length) return { error: 'Virheellinen ohjauspalvelu.' };
    out.services = services;
  }
  const updates = Array.isArray(body.referral_updates) ? body.referral_updates : [];
  if (updates.length) {
    if (!out.client || !out.client.id) return { error: 'Ohjauksen tilan voi päivittää vain palaavalle asiakkaalle.' };
    for (const u of updates) {
      if (!['toteutui', 'ei_toteutunut'].includes(u.status)) continue;
      const r = db.prepare("SELECT id FROM referrals WHERE id = ? AND client_id = ? AND status = 'avoin'").get(Number(u.id), out.client.id);
      if (!r) return { error: 'Ohjausta ei löydy tai sen tila on jo päivitetty.' };
      out.updates.push({ id: r.id, status: u.status });
    }
  }
  return out;
}

/** Tallentaa asiakas- ja ohjausosan. Kutsutaan kirjauksen tallennustransaktion sisällä. */
function applyClientPart(part, { encounterId, encounterDate, userId, isTest = 0 }) {
  let clientId = null;
  if (part.client) {
    clientId = part.client.id;
    if (part.client.mode === 'new') {
      clientId = db.prepare('INSERT INTO clients (project_id, ref_hash, generated, created_by, is_test) VALUES (?, ?, ?, ?, ?)')
        .run(part.client.projectId, part.client.hash, part.client.generated ? 1 : 0, userId, isTest).lastInsertRowid;
    }
    db.prepare('UPDATE encounters SET client_id = ? WHERE id = ?').run(clientId, encounterId);
  }
  const insR = db.prepare('INSERT INTO referrals (encounter_id, client_id, service_id, referred_on, status) VALUES (?, ?, ?, ?, ?)');
  for (const sid of part.services) insR.run(encounterId, clientId, sid, encounterDate, clientId ? 'avoin' : 'ei_seurattavissa');
  const upd = db.prepare("UPDATE referrals SET status = ?, status_on = ?, status_encounter_id = ?, status_by = ? WHERE id = ? AND status = 'avoin'");
  for (const u of part.updates) upd.run(u.status, encounterDate, encounterId, userId, u.id);
  return clientId;
}

// Vanhat selväkieliset nimimerkit (ennen tätä versiota) muutetaan tiivisteiksi ja poistetaan.
function migratePlaintextPseudonyms() {
  if (!ENABLED) return 0;
  const rows = db.prepare('SELECT id, project_id, pseudonym, is_test FROM encounters WHERE pseudonym IS NOT NULL').all();
  if (!rows.length) return 0;
  db.transaction(() => {
    for (const r of rows) {
      let clientId = null;
      if (normalize(r.pseudonym).length >= 3) {
        const hash = hashRef(r.project_id, r.pseudonym);
        const c = db.prepare('SELECT id FROM clients WHERE project_id = ? AND ref_hash = ?').get(r.project_id, hash);
        clientId = c ? c.id : db.prepare('INSERT INTO clients (project_id, ref_hash, is_test) VALUES (?, ?, ?)').run(r.project_id, hash, r.is_test || 0).lastInsertRowid;
      }
      db.prepare('UPDATE encounters SET client_id = COALESCE(?, client_id), pseudonym = NULL WHERE id = ?').run(clientId, r.id);
    }
  })();
  return rows.length;
}

// Säilytysaika: linkitys katkaistaan asiakkailta, joita ei ole kohdattu N kuukauteen.
function applyRetention() {
  if (!(RETENTION_MONTHS > 0)) return 0;
  const stale = db.prepare(`SELECT c.id FROM clients c
    WHERE COALESCE((SELECT MAX(encounter_date) FROM encounters e WHERE e.client_id = c.id), substr(c.created_at, 1, 10))
          < date('now', ?)`).all(`-${RETENTION_MONTHS} months`).map(r => r.id);
  if (!stale.length) return 0;
  db.transaction(() => {
    for (const id of stale) {
      db.prepare('UPDATE encounters SET client_id = NULL WHERE client_id = ?').run(id);
      db.prepare("UPDATE referrals SET client_id = NULL, status = CASE status WHEN 'avoin' THEN 'ei_seurattavissa' ELSE status END WHERE client_id = ?").run(id);
      db.prepare('DELETE FROM clients WHERE id = ?').run(id);
    }
    audit(null, 'client_retention', 'client', null, { unlinked: stale.length, months: RETENTION_MONTHS });
  })();
  return stale.length;
}

// --- Asiakaspolkujen koostetiedot ---------------------------------------------
// Kaikki luvut ovat koosteita. Pienet asiakasmäärät (1–2) piilotetaan
// ristiintaulukoinnissa, jotta yksittäistä asiakasta ei voi päätellä.
function pathStats({ from, to, projectIds, projectId }) {
  const ph = projectIds.map(() => '?').join(',') || 'NULL';
  const encWhere = [`e.deleted_at IS NULL`, `e.project_id IN (${ph})`];
  const p = [...projectIds];
  if (from) { encWhere.push('e.encounter_date >= ?'); p.push(from); }
  if (to) { encWhere.push('e.encounter_date <= ?'); p.push(to); }
  if (projectId) { encWhere.push('e.project_id = ?'); p.push(projectId); }
  const W = encWhere.join(' AND ');

  const coverage = db.prepare(`SELECT COUNT(*) yksilo_rows, COUNT(e.client_id) with_client, COUNT(DISTINCT e.client_id) clients
                               FROM encounters e WHERE ${W} AND e.encounter_type = 'yksilo'`).get(...p);

  // Asiakkaat, jotka kohdattiin rajauksella; heidän historiansa hankkeessa loppupäivään asti.
  // Asiakas kuuluu aina yhteen hankkeeseen, joten hankkeiden välisiä lukuja ei ole.
  const toDate = to || '9999-12-31';
  const lifetime = db.prepare(`
    WITH c AS (SELECT DISTINCT e.client_id id FROM encounters e WHERE ${W} AND e.client_id IS NOT NULL)
    SELECT c.id, COUNT(x.id) visits, MIN(x.encounter_date) first_date
    FROM c JOIN encounters x ON x.client_id = c.id AND x.deleted_at IS NULL AND x.encounter_date <= ?
    GROUP BY c.id`).all(...p, toDate);

  const newClients = lifetime.filter(c => !from || c.first_date >= from).length;
  const returning = lifetime.filter(c => c.visits >= 2).length;
  const buckets = [['1 kohtaaminen', 1, 1], ['2–3', 2, 3], ['4–9', 4, 9], ['10 tai enemmän', 10, Infinity]]
    .map(([label, lo, hi]) => ({ label, value: lifetime.filter(c => c.visits >= lo && c.visits <= hi).length }));

  // Ohjaukset, jotka tehtiin rajauksen kirjauksissa
  const refs = db.prepare(`SELECT r.status, rs.name service, rs.id service_id,
                                  julianday(r.status_on) - julianday(r.referred_on) days
                           FROM referrals r JOIN encounters e ON e.id = r.encounter_id JOIN referral_services rs ON rs.id = r.service_id
                           WHERE ${W}`).all(...p);
  const byStatus = { avoin: 0, toteutui: 0, ei_toteutunut: 0, ei_seurattavissa: 0 };
  const bySvc = new Map();
  for (const r of refs) {
    byStatus[r.status]++;
    const s = bySvc.get(r.service) || { service: r.service, total: 0, avoin: 0, toteutui: 0, ei_toteutunut: 0, ei_seurattavissa: 0 };
    s.total++; s[r.status]++; bySvc.set(r.service, s);
  }
  const doneDays = refs.filter(r => r.status === 'toteutui' && r.days != null).map(r => r.days).sort((a, b) => a - b);
  const median = doneDays.length ? doneDays[Math.floor((doneDays.length - 1) / 2)] : null;
  const rate = (s) => (s.toteutui + s.ei_toteutunut ? s.toteutui / (s.toteutui + s.ei_toteutunut) : null);
  const services = [...bySvc.values()].map(s => ({ ...s, rate: rate(s) })).sort((a, b) => b.total - a.total);

  return {
    enabled: ENABLED,
    coverage: { ...coverage, share: coverage.yksilo_rows ? coverage.with_client / coverage.yksilo_rows : null },
    clients: { total: lifetime.length, new: newClients, returning },
    visitBuckets: buckets,
    referrals: { total: refs.length, ...byStatus, rate: rate(byStatus), median_days: median },
    services,
  };
}

module.exports = {
  ENABLED, RETENTION_MONTHS, normalize, hashRef, validateRef, findClient, generateUniqueCode, clientSummary,
  prepareClientPart, applyClientPart, migratePlaintextPseudonyms, applyRetention, pathStats,
};
