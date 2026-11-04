'use strict';
// Tietokantakerros (SQLite). Rakenne on suunniteltu niin, että sen voi siirtää
// sellaisenaan Sammioon (SQL Server / Azure SQL): taulut ovat tavallisia
// relaatiotauluja ja vastaukset tallennetaan rivimuotoon (encounter_answers),
// jolloin uusien kysymysten lisääminen ei vaadi skeemamuutoksia.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'kohtaamiset.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','tiimivetaja','hanketyontekija','tuntityontekija')),
  active        INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  recorder_role TEXT,               -- kirjaajan rooli raportoinnissa (Olen-tieto)
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_projects (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, project_id)
);

-- Kysymykset: project_id NULL = yhteinen kysymys, muuten hankekohtainen.
-- Kysymyksiä ei poisteta koskaan, vaan ne poistetaan käytöstä (active = 0),
-- jotta aiempien vuosien raportointi ei rikkoudu. "key" on pysyvä tunniste,
-- jota käytetään Excel-viennin ja Power BI:n sarakkeena.
CREATE TABLE IF NOT EXISTS questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL UNIQUE,
  project_id  INTEGER REFERENCES projects(id),
  label       TEXT NOT NULL,
  help        TEXT,
  type        TEXT NOT NULL CHECK (type IN ('text','textarea','number','choice','multichoice','rating','date')),
  options     TEXT,              -- JSON-taulukko valintavaihtoehdoista
  required    INTEGER NOT NULL DEFAULT 0,
  applies_to  TEXT NOT NULL DEFAULT 'kaikki' CHECK (applies_to IN ('kaikki','yksilo','ryhma')),
  free_text_warning INTEGER NOT NULL DEFAULT 0,
  sort        INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT
);

-- Yksi rivi = yksi lomaketallennus (yksi tai useampi kohtaaminen).
CREATE TABLE IF NOT EXISTS encounters (
  id              TEXT PRIMARY KEY,               -- UUID
  project_id      INTEGER NOT NULL REFERENCES projects(id),
  encounter_date  TEXT NOT NULL,                  -- YYYY-MM-DD
  encounter_type  TEXT NOT NULL,                  -- kirjaustyypin avain (record_types)
  encounter_count INTEGER NOT NULL CHECK (encounter_count BETWEEN 1 AND 9999),
  person_count    INTEGER CHECK (person_count IS NULL OR person_count BETWEEN 1 AND 9999),
  pseudonym       TEXT,                           -- vain yksilökohtaamisissa, ei Excel-vientiin
  recorder_role   TEXT NOT NULL,
  created_by      INTEGER NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by      INTEGER REFERENCES users(id),
  updated_at      TEXT,
  deleted_at      TEXT,
  deleted_by      INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS ix_enc_project_date ON encounters(project_id, encounter_date);
CREATE INDEX IF NOT EXISTS ix_enc_created_by ON encounters(created_by);

CREATE TABLE IF NOT EXISTS encounter_answers (
  encounter_id TEXT NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  question_id  INTEGER NOT NULL REFERENCES questions(id),
  value        TEXT NOT NULL,                    -- monivalinnassa JSON-taulukko
  PRIMARY KEY (encounter_id, question_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL DEFAULT (datetime('now')),
  user_id   INTEGER,
  action    TEXT NOT NULL,
  entity    TEXT,
  entity_id TEXT,
  details   TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  sess    TEXT NOT NULL,
  expires INTEGER NOT NULL
);
`);

// ---------------------------------------------------------------------------
// Perusdata: hankkeet ja kysymykset Microsoft Forms -testiversion pohjalta
// (Kohtaamisten raportointi 2027, tila 29.10.2026).
// ---------------------------------------------------------------------------
const RECORDER_ROLES = [
  'A-klinikkasäätiön asiantuntija tai ohjaaja',
  'Tuntityöntekijä tai ulkopuolinen asiantuntija, ohjaaja, avustaja tai neuvontapalvelun vastaaja',
  'Vertainen, kokemusasiantuntija tai vapaaehtoinen',
];

function seed() {
  const hasProjects = db.prepare('SELECT COUNT(*) n FROM projects').get().n > 0;
  if (hasProjects) return;

  const insP = db.prepare('INSERT INTO projects (code, name, sort) VALUES (?, ?, ?)');
  const projects = [
    ['AK21', 'Ak21 Päihdelinkki ja Nuortenlinkki (sis. neuvontapalvelu)'],
    ['DOPINGLINKKI', 'Dopinglinkki (sis. neuvontapalvelu)'],
    ['JALMA', 'Jalma'],
    ['KATUKLINIKKA', 'Katuklinikka'],
    ['LASINEN', 'Lasinen lapsuus'],
    ['OSIS', 'Osis (sis. vaparit)'],
    ['VOLJY', 'Völjy'],
  ];
  const pid = {};
  projects.forEach(([code, name], i) => { pid[code] = insP.run(code, name, (i + 1) * 10).lastInsertRowid; });

  const insQ = db.prepare(`INSERT INTO questions
    (key, project_id, label, help, type, options, required, applies_to, free_text_warning, sort)
    VALUES (@key, @project_id, @label, @help, @type, @options, @required, @applies_to, @free_text_warning, @sort)`);
  const q = (o) => insQ.run({
    project_id: null, help: null, options: null, required: 0, applies_to: 'kaikki', free_text_warning: 0, ...o,
    options: o.options ? JSON.stringify(o.options) : null,
  });

  // Yhteiset kysymykset (ydinkentät ajankohta, hanke, tyyppi, määrät, nimimerkki
  // ja kirjaajan rooli ovat encounters-taulun omia sarakkeita).
  q({ key: 'tyontekijan_arvio', label: 'Työntekijän arvio kohtaamisen hyödystä', type: 'rating', options: [1, 2, 3, 4, 5], required: 1, sort: 10 });
  q({ key: 'asiakkaan_arvio', label: 'Asiakkaalta kysytty arvio kohtaamisen hyödystä',
      help: 'Jätä tyhjäksi, jos ei tiedossa tai jos asiakaspalaute kerätään eri lomakkeella tai työkalulla.', type: 'rating', options: [1, 2, 3, 4, 5], applies_to: 'yksilo', sort: 20 });
  q({ key: 'ika', label: 'Ikä (arvio)', help: 'Jos ei tiedossa, jätä tyhjäksi.', type: 'choice', applies_to: 'yksilo',
      options: ['0–7 vuotta', '8–17 vuotta', '18–29 vuotta', '30–62 vuotta', '63–79 vuotta', 'Yli 80 vuotta'], sort: 30 });
  q({ key: 'sukupuoli', label: 'Oletettu sukupuoli', help: 'Jos ei tiedossa, jätä tyhjäksi.', type: 'choice', applies_to: 'yksilo',
      options: ['Nainen', 'Mies', 'Muu'], sort: 40 });
  q({ key: 'sijainti', label: 'Kohtaamisen sijainti', type: 'choice',
      options: ['Kadulla tai muulla julkisella paikalla', 'Säätiön kohtaamispaikassa', 'Muussa sisätilassa', 'Digialustalla'], sort: 50 });
  q({ key: 'kaupunki', label: 'Kaupunki', help: 'Jätä tyhjäksi, jos kohtaaminen tai ryhmä toteutui digialustalla.', type: 'text', sort: 60 });
  q({ key: 'kadunnimi', label: 'Kadunnimi, esim. Mannerheimintie, Kauppakatu',
      help: 'Jätä tyhjäksi, jos ei tiedossa tai kohtaaminen tapahtui digialustalla. Älä kirjoita koko osoitetta, esimerkiksi talon numeroa.', type: 'text', free_text_warning: 1, sort: 70 });
  q({ key: 'asiakkaan_palaute', label: 'Asiakkaan tai ryhmän palaute',
      help: 'Jos asiakaspalautetta kerätään muulla työkalulla, voit kirjata tähän päällimmäiset kommentit tilanteesta.', type: 'textarea', free_text_warning: 1, sort: 80 });
  q({ key: 'tyontekijan_huomiot', label: 'Työntekijän huomiot',
      help: 'Kirjaa esimerkiksi kohtaamisen välitön hyöty, olennaiset havainnot tai esiin nousseet ilmiöt.', type: 'textarea', free_text_warning: 1, sort: 90 });

  // Hankekohtaiset kysymykset (testiversiossa toistaiseksi vain AK21:llä).
  q({ key: 'ak21_toimintamuoto', project_id: pid.AK21, label: 'Toimintamuoto', type: 'choice',
      options: ['Chat', 'Ajanvaraus-chat', 'Neuvontapalvelu', 'Selvä suunta -ryhmä', 'Jodel AMA'], sort: 10 });
}

function ensureAdmin() {
  const n = db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin'").get().n;
  if (n > 0) return null;
  const email = process.env.ADMIN_EMAIL || 'admin@example.org';
  const password = process.env.ADMIN_PASSWORD || require('crypto').randomBytes(9).toString('base64url');
  db.prepare(`INSERT INTO users (email, name, password_hash, role, must_change_password, recorder_role)
              VALUES (?, 'Pääkäyttäjä', ?, 'admin', 1, ?)`).run(email, bcrypt.hashSync(password, 12), RECORDER_ROLES[0]);
  return { email, password };
}

seed();

// Migraatio: kirjaajan rooli käyttäjäprofiiliin (aiemmat tietokannat)
if (!db.prepare("PRAGMA table_info(users)").all().some(c => c.name === 'recorder_role')) {
  db.exec('ALTER TABLE users ADD COLUMN recorder_role TEXT');
}
// Kirjaajan rooli seuraa aina käyttöoikeusroolia (tuntityöntekijä = avustaja, muut = säätiön työntekijä)
db.prepare(`UPDATE users SET recorder_role = CASE role WHEN 'tuntityontekija' THEN ? ELSE ? END`)
  .run(RECORDER_ROLES[1], RECORDER_ROLES[0]);

// Migraatio: testidatan merkintä
if (!db.prepare("PRAGMA table_info(encounters)").all().some(c => c.name === 'is_test')) {
  db.exec('ALTER TABLE encounters ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0');
}
if (!db.prepare("PRAGMA table_info(users)").all().some(c => c.name === 'is_test')) {
  db.exec('ALTER TABLE users ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0');
}

// Migraatio: digipalvelut. Digipalvelun hankkeissa sijainti täytetään automaattisesti
// ("Digialustalla") ja kaupunki/kadunnimi piilotetaan. Käytös on kysymyskohtainen:
//   digital_mode = 'show' (näytetään) | 'hide' (piilotetaan) | 'fixed' (täytetään arvolla digital_value)
if (!db.prepare("PRAGMA table_info(projects)").all().some(c => c.name === 'digital')) {
  db.exec('ALTER TABLE projects ADD COLUMN digital INTEGER NOT NULL DEFAULT 0');
  db.prepare("UPDATE projects SET digital = 1 WHERE code IN ('AK21', 'DOPINGLINKKI', 'LASINEN')").run();
}
if (!db.prepare("PRAGMA table_info(questions)").all().some(c => c.name === 'digital_mode')) {
  db.exec("ALTER TABLE questions ADD COLUMN digital_mode TEXT NOT NULL DEFAULT 'show'");
  db.exec('ALTER TABLE questions ADD COLUMN digital_value TEXT');
  db.prepare("UPDATE questions SET digital_mode = 'fixed', digital_value = 'Digialustalla' WHERE key = 'sijainti'").run();
  db.prepare("UPDATE questions SET digital_mode = 'hide' WHERE key IN ('kaupunki', 'kadunnimi')").run();
}

// Kirjautumistapa: 'local' = sähköposti + salasana + MFA (esim. tuntityöntekijät),
// 'entra' = säätiön Microsoft-tunnus (Entra ID). MFA-salaisuus on salattuna.
{
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('auth_method')) db.exec("ALTER TABLE users ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'local'");
  if (!cols.includes('entra_oid')) db.exec('ALTER TABLE users ADD COLUMN entra_oid TEXT');
  if (!cols.includes('mfa_secret')) db.exec('ALTER TABLE users ADD COLUMN mfa_secret TEXT');
  if (!cols.includes('mfa_enabled')) db.exec('ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('mfa_last_step')) db.exec('ALTER TABLE users ADD COLUMN mfa_last_step INTEGER');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_users_entra_oid ON users(entra_oid) WHERE entra_oid IS NOT NULL');
}

// Täydennysehdotukset tekstikysymyksiin (esim. kaupunki ja kadunnimi)
if (!db.prepare('PRAGMA table_info(questions)').all().some(c => c.name === 'suggest')) {
  db.exec('ALTER TABLE questions ADD COLUMN suggest INTEGER NOT NULL DEFAULT 0');
  db.prepare("UPDATE questions SET suggest = 1 WHERE key IN ('kaupunki', 'kadunnimi')").run();
}

// Kertaluonteiset tietomuutokset (ajetaan kerran, eivät ohita adminin myöhempiä muutoksia)
function once(name, fn) {
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get('migration.' + name)) return;
  db.transaction(() => { fn(); db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('migration.' + name, new Date().toISOString()); })();
}

// Sijainti valitaan joka kirjauksessa (myös digihankkeilla on livekohtaamisia).
// Kaupunki ja kadunnimi piilotetaan, kun sijainniksi valitaan "Digialustalla".
//   digital_mode = 'show' (näytetään aina) | 'hide' (piilotetaan, kun sijainti on Digialustalla)
once('sijainti_joka_kerta', () => {
  db.prepare("UPDATE questions SET digital_mode = 'show', digital_value = NULL WHERE digital_mode = 'fixed'").run();
});
// Kaupunki ja kadunnimi piiloon, kun sijainti on Digialustalla (varmistus vanhoille tietokannoille)
once('kaupunki_katu_digialustalla', () => {
  db.prepare("UPDATE questions SET digital_mode = 'hide' WHERE key IN ('kaupunki', 'kadunnimi')").run();
});
// Hankkeen teemaväri (yksi tai kaksi hex-väriä pilkulla erotettuna) helpottaa hankkeen löytämistä lomakkeella.
// Digipalveluiden värit ovat niiden verkkosivujen pääväreistä; muille säätiön väripaletista.
if (!db.prepare('PRAGMA table_info(projects)').all().some(c => c.name === 'color')) {
  db.exec('ALTER TABLE projects ADD COLUMN color TEXT');
}
once('hankevarit', () => {
  const set = db.prepare('UPDATE projects SET color = ? WHERE code = ? AND color IS NULL');
  for (const [code, color] of [['AK21', '#008900,#00a0f4'], ['DOPINGLINKKI', '#ffe000'], ['LASINEN', '#a437b8'],
    ['KATUKLINIKKA', '#0037d3'], ['JALMA', '#00ea00'], ['OSIS', '#919396'], ['VOLJY', '#000000']]) set.run(color, code);
});
// Asiakkaalta kysytty arvio vain yksilökohtaamisiin (ryhmän vastaus ei voi olla yksi luku)
once('asiakkaan_arvio_yksilo', () => {
  db.prepare("UPDATE questions SET applies_to = 'yksilo' WHERE key = 'asiakkaan_arvio'").run();
});

// Kohtaamisen toteuttaja: kirjauksen voi tehdä toisen puolesta.
//   performer_type = 'kayttaja' (performed_by = käyttäjä) | 'vapaaehtoinen' (performed_by NULL)
if (!db.prepare("PRAGMA table_info(encounters)").all().some(c => c.name === 'performed_by')) {
  db.exec('ALTER TABLE encounters ADD COLUMN performed_by INTEGER REFERENCES users(id)');
  db.exec("ALTER TABLE encounters ADD COLUMN performer_type TEXT NOT NULL DEFAULT 'kayttaja'");
  db.exec('UPDATE encounters SET performed_by = created_by');
}
db.exec('CREATE INDEX IF NOT EXISTS ix_enc_performed_by ON encounters(performed_by)');

// ---------------------------------------------------------------------------
// Kirjaustyypit ("Valitse, mitä raportoit") ovat ylläpidettäviä. Jokaisella tyypillä on
// toimintatapa (kind), joka määrää lomakkeen määräkentät ja tilastoinnin:
//   yksilo        = yksi kohtaaminen (määrä 1, asiakastunniste mahdollinen)
//   ryhma         = ryhmä tai useita kohtaamisia (kohtaamisten ja osallistujien määrä)
//   tavoittaminen = yleisötilaisuus tms. (tavoitettujen määrä, tilastoidaan erikseen kohtaamisista)
// ---------------------------------------------------------------------------
const RECORD_KINDS = {
  yksilo: 'Yksi kohtaaminen (määrä 1, asiakastunniste)',
  ryhma: 'Ryhmä tai useita kohtaamisia (kohtaamisten ja osallistujien määrä)',
  tavoittaminen: 'Tavoittaminen (tavoitettujen määrä, tilastoidaan erikseen)',
};
db.exec(`CREATE TABLE IF NOT EXISTS record_types (
  key         TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  description TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('yksilo','ryhma','tavoittaminen')),
  count_label TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0
)`);
once('kirjaustyypit', () => {
  const ins = db.prepare('INSERT OR IGNORE INTO record_types (key, label, description, kind, count_label, sort) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run('yksilo', 'Yksi kohtaaminen', 'Yksi henkilö, yksi keskustelu', 'yksilo', null, 10);
  ins.run('ryhma', 'Ryhmä tai useita kohtaamisia', 'Ryhmä tai useampi kohtaaminen kerralla', 'ryhma', 'Kohtaamisten määrä', 20);
  ins.run('tavoittaminen', 'Tavoittaminen', 'Koulutus, luento, webinaari tai muu yleisötilaisuus', 'tavoittaminen', 'Tavoitettujen määrä', 30);
});

// Kirjauksen tyyppi ei enää rajoitu kiinteisiin arvoihin: poistetaan CHECK-ehto (taulun uudelleenrakennus)
// ja lisätään kind-sarake (tyypin toimintatapa kirjaushetkellä), jota tilastot käyttävät.
{
  const t = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'encounters'").get();
  if (/CHECK\s*\(encounter_type IN/.test(t.sql)) {
    const newSql = t.sql.replace(/CREATE TABLE "?encounters"?/, 'CREATE TABLE encounters_new').replace(/\s*CHECK\s*\(encounter_type IN \([^)]*\)\)/, '');
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'encounters' AND sql IS NOT NULL").all().map(r => r.sql);
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(newSql);
      db.exec('INSERT INTO encounters_new SELECT * FROM encounters');
      db.exec('DROP TABLE encounters');
      db.exec('ALTER TABLE encounters_new RENAME TO encounters');
      for (const sql of idx) db.exec(sql);
      const bad = db.pragma('foreign_key_check');
      if (bad.length) throw new Error('Viite-eheys rikkoutui kirjausten uudelleenrakennuksessa');
    })();
    db.pragma('foreign_keys = ON');
  }
  if (!db.prepare('PRAGMA table_info(encounters)').all().some(c => c.name === 'kind')) {
    db.exec("ALTER TABLE encounters ADD COLUMN kind TEXT NOT NULL DEFAULT 'yksilo'");
    db.exec("UPDATE encounters SET kind = encounter_type WHERE encounter_type IN ('yksilo','ryhma')");
  }
}

// Kysymysten näkyvyys:
//   applies   = JSON-taulukko kirjaustyyppien avaimista, joissa kysymys näytetään (NULL = kaikissa)
//   show_if   = JSON { key, values[] }: näytetään vain, jos toisen kysymyksen vastaus on jokin arvoista.
//               key '_toteuttaja' = kohtaamisen toteuttajan rooli (esim. vain ammattilaisten kirjauksissa)
//   min_value = lukukysymyksen pienin sallittu arvo (oletus 0)
{
  const cols = db.prepare('PRAGMA table_info(questions)').all().map(c => c.name);
  if (!cols.includes('applies')) {
    db.exec('ALTER TABLE questions ADD COLUMN applies TEXT');
    db.exec(`UPDATE questions SET applies = CASE applies_to WHEN 'yksilo' THEN '["yksilo"]' WHEN 'ryhma' THEN '["ryhma"]' ELSE NULL END`);
  }
  if (!cols.includes('show_if')) db.exec('ALTER TABLE questions ADD COLUMN show_if TEXT');
  if (!cols.includes('min_value')) db.exec('ALTER TABLE questions ADD COLUMN min_value INTEGER');
}

// Kysymykset 2027 (määrittelytaulukko "Kohtaamisten raportointi 2027 kysymykset ja huomiot"):
// tavoittamisen kysymys, uusi yhteinen kysymys ja hankekohtaiset kysymykset.
once('kysymykset_2027', () => {
  const pid = Object.fromEntries(db.prepare('SELECT code, id FROM projects').all().map(r => [r.code, r.id]));
  const exists = db.prepare('SELECT 1 FROM questions WHERE key = ?');
  const ins = db.prepare(`INSERT INTO questions (key, project_id, label, help, type, options, required, applies_to, applies, show_if, min_value, free_text_warning, sort)
                          VALUES (@key, @project_id, @label, @help, @type, @options, @required, 'kaikki', @applies, @show_if, @min_value, @free_text_warning, @sort)`);
  const Y = ['yksilo'], YR = ['yksilo', 'ryhma'], T = ['tavoittaminen'];
  const PRO = { key: '_toteuttaja', values: [RECORDER_ROLES[0], RECORDER_ROLES[1]] };
  const q = (o) => {
    if (exists.get(o.key)) return;
    if (o.project && !pid[o.project]) return;
    ins.run({ project_id: o.project ? pid[o.project] : null, help: null, required: 0, show_if: null, min_value: null, sort: 100, ...o,
      options: o.options ? JSON.stringify(o.options) : null, applies: o.applies ? JSON.stringify(o.applies) : null,
      show_if: o.show_if ? JSON.stringify(o.show_if) : null, free_text_warning: o.type === 'text' || o.type === 'textarea' ? 1 : 0, required: o.required ? 1 : 0 });
  };
  // Yhteiset
  q({ key: 'tavoittamisen_muoto', label: 'Tavoittamisen muoto', type: 'choice', options: ['Koulutus', 'Luento', 'Webinaari', 'Muu yleisötilaisuus'], required: 1, applies: T, sort: 5 });
  q({ key: 'myonteiset_seuraukset', label: 'Mitä myönteisiä seurauksia kohtaamisella arvioit olevan asiakkaalle?', type: 'multichoice', applies: Y, sort: 25,
    options: ['Asiakas sai tietoa tai ymmärrystä tilanteestaan', 'Asiakas koki tulleensa kuulluksi tai saaneensa tukea', 'Asiakkaan motivaatio tai valmius muutokseen vahvistui',
      'Asiakas löysi keinoja tilanteensa käsittelyyn', 'Asiakkaan hakeutuminen palveluihin tai tuen piiriin edistyi',
      'Asiakkaan elämäntilanteeseen liittyvä konkreettinen asia eteni tai ratkesi', 'Asiakkaan turvallisuus tai haittojen ehkäisy vahvistui'] });
  // Päihdelinkki ja Nuortenlinkki (AK21) – korvaa aiemman toimintamuotokysymyksen
  db.prepare("UPDATE questions SET active = 0 WHERE key = 'ak21_toimintamuoto'").run();
  q({ key: 'ak21_palvelu', project: 'AK21', label: 'Mihin palveluun kohtaaminen liittyi?', type: 'choice', options: ['Päihdelinkki', 'Nuortenlinkki'], required: 1, applies: YR, sort: 10 });
  q({ key: 'ak21_toimintamuoto_2027', project: 'AK21', label: 'Missä toimintamuodossa kohtaaminen toteutui?', type: 'choice', required: 1, applies: YR, sort: 20,
    options: ['Päivystyschat', 'Ajanvarauschat', 'Neuvontapalvelu', 'Jodel AMA', 'Walk in -videochat', 'Selvä suunta -ryhmä', 'Henkilökohtainen vertaistuki (Toivo)', 'Muu kohtaaminen'] });
  q({ key: 'ak21_kenen_tilanne', project: 'AK21', label: 'Kenen tilanteeseen yhteydenotto liittyi?', type: 'choice', options: ['Oma tilanne', 'Läheisen tilanne', 'Muu / ei tiedossa'], applies: Y, sort: 30 });
  q({ key: 'ak21_tuen_tarve', project: 'AK21', label: 'Mihin tuen tarpeeseen tai huoleen kohtaaminen liittyi?', type: 'multichoice', applies: Y, sort: 40,
    options: ['Alkoholi', 'Huumeet', 'Nikotiini', 'Rahapelaaminen', 'Muu riippuvuuskäyttäytyminen', 'Muu nuoren elämäntilanteeseen liittyvä huoli', 'Läheisen tilanne', 'Muu', 'Ei tiedossa'] });
  q({ key: 'ak21_selkiytyminen', project: 'AK21', label: 'Selkiytyikö käyttäjän tilanne kohtaamisen aikana?', type: 'choice', options: ['Kyllä', 'Osittain', 'Ei'], required: 1, applies: Y, show_if: PRO, sort: 50 });
  q({ key: 'ak21_seuraava_askel', project: 'AK21', label: 'Ilmaisiko käyttäjä aikomuksen ottaa seuraavan askeleen?', type: 'choice', options: ['Kyllä', 'Ehkä', 'Ei', 'Ei saatu tietoa'], applies: Y, show_if: PRO, sort: 60,
    help: 'Kirjaa käyttäjän ilmaisema aikomus, ei omaa oletustasi.' });
  // Dopinglinkki
  q({ key: 'doping_kanava', project: 'DOPINGLINKKI', label: 'Missä kanavassa kohtaaminen toteutui?', type: 'choice', options: ['Verkkolomake', 'Viestisovellus', 'Live chat', 'Puhelin', 'Jodel AMA', 'Muu'], required: 1, applies: Y, sort: 10 });
  q({ key: 'doping_tilanne', project: 'DOPINGLINKKI', label: 'Mikä on yhteydenottajan tilanne?', type: 'choice', applies: Y, sort: 20,
    options: ['Käyttää aineita', 'Harkitsee käytön aloittamista', 'Harkitsee lopettamista', 'Lopettanut käytön', 'Läheinen', 'Muu', 'Ei tiedossa'] });
  q({ key: 'doping_aiheet', project: 'DOPINGLINKKI', label: 'Mitä aiheita kohtaaminen käsitteli?', type: 'multichoice', applies: Y, sort: 30,
    options: ['Aineiden vaikutukset ja riskit', 'Käytön aloittaminen', 'Käytön lopettaminen', 'Haittojen vähentäminen', 'Riippuvuus', 'Terveyshaitat', 'Läheisen tilanne', 'Hoitoon tai muuhun apuun hakeutuminen', 'Muu'] });
  q({ key: 'doping_aineet', project: 'DOPINGLINKKI', label: 'Mitä aineita kohtaaminen käsitteli?', type: 'text', applies: Y, sort: 40 });
  q({ key: 'doping_selkiytyminen', project: 'DOPINGLINKKI', label: 'Selkiytyikö kohdatun tilanne ja/tai löytyikö seuraava askel?', type: 'choice', options: ['Kyllä', 'Ei', 'Ei osaa arvioida'], required: 1, applies: Y, sort: 50 });
  // Jalma
  q({ key: 'jalma_tukimuodot', project: 'JALMA', label: 'Mitä tukimuotoja nuoren kohtaamisessa toteutui?', type: 'multichoice', required: 1, applies: YR, sort: 10,
    options: ['Päihdeneuvonta', 'Mielenterveysneuvonta', 'Yksilöohjaus', 'Palveluohjaus', 'Psykososiaalinen tuki'] });
  q({ key: 'jalma_ratkenneet', project: 'JALMA', label: 'Kuinka monta nuoren elämäntilanteen kannalta tärkeää asiaa ratkesi?', type: 'number', min_value: 0, required: 1, applies: YR, sort: 20 });
  q({ key: 'jalma_etenemiset', project: 'JALMA', label: 'Minkälaisia konkreettisia etenemisiä tai ratkaisuja nuoren tilanteessa toteutui?', type: 'multichoice', required: 1, applies: YR, sort: 30,
    options: ['Palveluun pääsy', 'Hakemuksen tekeminen', 'Asumistilanteen eteneminen', 'Opiskeluun liittyvän tilanteen eteneminen', 'Työllistymiseen liittyvän tilanteen eteneminen', 'Muu konkreettinen eteneminen', 'Ei etenemistä tai ratkaisua'] });
  q({ key: 'jalma_laheiset', project: 'JALMA', label: 'Kuinka monta tilaisuuden osallistujista oli nuoren läheisiä tai muita monikielisen yhteisön jäseniä?', type: 'number', min_value: 0, required: 1, applies: T, sort: 40 });
  q({ key: 'jalma_ammattilaiset', project: 'JALMA', label: 'Kuinka monta tilaisuuden osallistujista oli nuorten kanssa työskenteleviä ammattilaisia?', type: 'number', min_value: 0, required: 1, applies: T, sort: 50 });
  // Katuklinikka
  q({ key: 'katu_tukimuodot', project: 'KATUKLINIKKA', label: 'Mitä tukimuotoja kohtaamisessa toteutui?', type: 'multichoice', required: 1, applies: Y, sort: 10,
    options: ['Palveluohjaus', 'Saatto, kuljetus tai tuettu asiointi', 'Tiivis yksilötyöskentely', 'Haittoja vähentävä terveysneuvonta', 'Sosiaalineuvonta', 'Muu tuki'] });
  q({ key: 'katu_luottamus', project: 'KATUKLINIKKA', label: 'Syntyikö tai vahvistuiko kohtaamisessa asiakkaan ja Katuklinikan välinen luottamuksellinen kontakti?', type: 'rating', options: [1, 2, 3, 4, 5], required: 1, applies: Y, sort: 20 });
  q({ key: 'katu_palveluprosessi', project: 'KATUKLINIKKA', label: 'Edistikö Katuklinikan tuki asiakkaan palveluprosessin etenemistä tai jatkuvuutta?', type: 'rating', options: [1, 2, 3, 4, 5], applies: Y, sort: 30,
    help: 'Vastaa, jos kohtaaminen liittyi asiakkaan palveluprosessiin.' });
  q({ key: 'katu_apu', project: 'KATUKLINIKKA', label: 'Saiko asiakas kohtaamisessa tarpeisiinsa vastaavaa apua tai tukea?', type: 'rating', options: [1, 2, 3, 4, 5], required: 1, applies: Y, sort: 40 });
  q({ key: 'katu_haittojen_vahentaminen', project: 'KATUKLINIKKA', label: 'Saiko asiakas tietoa tai keinoja huumeiden käytöstä aiheutuvien haittojen vähentämiseen?', type: 'rating', options: [1, 2, 3, 4, 5], applies: Y, sort: 50,
    help: 'Vastaa, jos kohtaaminen liittyi haittojen vähentämiseen.' });
  // Lasinen lapsuus
  q({ key: 'lasinen_toimintamuoto', project: 'LASINEN', label: 'Mihin Lasisen lapsuuden toimintamuotoon kirjaus liittyi?', type: 'choice', required: 1, sort: 10,
    options: ['Yksilötapaaminen', 'Anonyymi neuvontapalvelu', 'Suljettu vertaistukiryhmä', 'Toimiva ry:n kanssa järjestetty vertaistukiryhmä', 'Luova vertaistukiryhmä', 'Avoin ryhmächat',
      'Siruista sinuksi -keskusteluilta', 'Nuorten avoin vertaistapaaminen', 'Jatkoryhmä', 'AMA-tapahtuma', 'Hyvinvointituokio tai muu verkkotapahtuma', 'Kokemusasiantuntijoiden kehittämistyöpaja',
      'Ammattilais- tai opiskelijatapahtuma', 'Muu'] });
  // Osis: toimintamuoto ohjaa, mitkä lisäkysymykset näytetään
  const OSIS_YT = { key: 'osis_toimintamuoto', values: ['Yksilötuki'] };
  const OSIS_JV = { key: 'osis_toimintamuoto', values: ['Jalkautuva vapaaehtoistoiminta'] };
  q({ key: 'osis_toimintamuoto', project: 'OSIS', label: 'Mitä Osiksen toimintamuotoa kirjaus koskee?', type: 'choice', required: 1, sort: 5,
    options: ['Yksilötuki', 'Vertaisvuoro', 'Jalkautuva vapaaehtoistoiminta', 'Muu toiminta'] });
  q({ key: 'osis_kasitellyt_asiat', project: 'OSIS', label: 'Mitä asioita yksilötuessa käsiteltiin?', type: 'multichoice', required: 1, applies: YR, show_if: OSIS_YT, sort: 10,
    options: ['Palveluihin hakeutuminen tai palveluohjaus', 'Viranomaisasiointi', 'Asuminen tai asunnottomuus', 'Toimeentulo ja etuudet', 'Päihde- tai terveysasiat', 'Mielenterveys tai psykososiaalinen tuki', 'Muu arjen asia'] });
  q({ key: 'osis_saatto', project: 'OSIS', label: 'Toteutuiko yksilötyössä saatto tai muu arjen asiointituki?', type: 'multichoice', required: 1, applies: YR, show_if: OSIS_YT, sort: 20,
    options: ['Saatto palveluun tai viranomaisasiointiin', 'Muu rinnalla kulkeminen tai asiointiapu', 'Ei toteutunut'] });
  q({ key: 'osis_eteneminen', project: 'OSIS', label: 'Etenikö tai ratkesiko asiakkaalle merkityksellinen asia?', type: 'choice', required: 1, applies: YR, show_if: OSIS_YT, sort: 30,
    options: ['Eteni', 'Ratkesi', 'Ei edennyt tai ratkennut', 'Ei arvioitavissa'] });
  q({ key: 'osis_vertaisvuorot', project: 'OSIS', label: 'Kuinka monta vertaisvuoroa kirjaukseen sisältyy?', type: 'number', min_value: 1, required: 1, show_if: { key: 'osis_toimintamuoto', values: ['Vertaisvuoro'] }, sort: 40 });
  q({ key: 'osis_vapaaehtoiset', project: 'OSIS', label: 'Kuinka monta vapaaehtoista osallistui jalkautumiseen?', type: 'number', min_value: 0, required: 1, show_if: OSIS_JV, sort: 50 });
  q({ key: 'osis_jalkautuminen_tuki', project: 'OSIS', label: 'Millaista tukea tai konkreettista apua jalkautumisessa annettiin?', type: 'multichoice', required: 1, show_if: OSIS_JV, sort: 60,
    options: ['Keskustelu tai kuuntelu', 'Ruoka tai juoma', 'Muu konkreettinen apu', 'Palveluohjaus tai ammatillinen tuki', 'Ei apua annettu'] });
  q({ key: 'osis_ohjaus', project: 'OSIS', label: 'Ohjattiinko jalkautumisessa joku ammatilliseen tai kiireelliseen apuun?', type: 'choice', required: 1, show_if: OSIS_JV, sort: 70,
    options: ['Ammatilliseen apuun', 'Kiireelliseen apuun', 'Molempiin', 'Ei'] });
  // Völjy
  q({ key: 'voljy_toimintamuoto', project: 'VOLJY', label: 'Mitä Völjyn toimintamuotoa kirjaus koskee?', type: 'choice', required: 1, applies: YR, sort: 10,
    options: ['Kohtaamispaikan toiminta', 'Kotiin vietävä tuki / kotikäynti', 'Yksilötyö tai palveluohjaus', 'Retki, ryhmä tai tapahtuma', 'Muu kohtaaminen'] });
  q({ key: 'voljy_asumistuki', project: 'VOLJY', label: 'Annettiinko kohtaamisessa asumiseen liittyvää tukea?', type: 'choice', options: ['Kyllä', 'Ei'], required: 1, applies: YR, sort: 20 });
  const VA = { key: 'voljy_asumistuki', values: ['Kyllä'] };
  q({ key: 'voljy_asuminen_toimenpiteet', project: 'VOLJY', label: 'Kuinka monta asumista turvaavaa toimenpidettä ratkesi tämän kirjauksen yhteydessä?', type: 'number', min_value: 0, required: 1, applies: YR, show_if: VA, sort: 30 });
  q({ key: 'voljy_asuminen_tulos', project: 'VOLJY', label: 'Mikä asumista koskeva tulos toteutui tai varmistui?', type: 'multichoice', required: 1, applies: YR, show_if: VA, sort: 40,
    options: ['Häätö ehkäistiin', 'Vuokrasuhde säilyi / asuminen turvattiin', 'Uusi asumisratkaisu löytyi', 'Ei vielä varmistunutta tulosta'] });
});

// Yhteisten kysymysten näkyvyys määrittelytaulukon mukaan: tavoittamisessa ei kysytä kohtaamiskohtaisia tietoja
once('yhteiset_2027_nakyvyys', () => {
  db.prepare(`UPDATE questions SET applies = '["yksilo","ryhma"]' WHERE applies IS NULL AND project_id IS NULL
              AND key IN ('tyontekijan_arvio', 'sijainti', 'kaupunki', 'kadunnimi', 'asiakkaan_palaute')`).run();
});

const DIGITAL_LOCATION = 'Digialustalla';

function audit(userId, action, entity, entityId, details) {
  db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (?,?,?,?,?)')
    .run(userId ?? null, action, entity ?? null, entityId == null ? null : String(entityId), details ? JSON.stringify(details) : null);
}

// ---------------------------------------------------------------------------
// Kytkettävät toiminnot (admin voi aktivoida Hallinta → Toiminnot).
// ---------------------------------------------------------------------------
const FEATURES = {
  paths: { label: 'Asiakaspolut', description: 'Asiakaspolkujen ja palveluohjausten koostenäkymä (admin ja tiiminvetäjä). Piilotettuna näkymä ja sen valikkolinkki eivät näy, eikä rajapinta palauta tietoja. Asiakastunnisteiden ja palveluohjausten kirjaaminen lomakkeella toimii tästä riippumatta.', default: false },
};
function featureEnabled(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get('feature.' + key);
  return r ? r.value === '1' : !!(FEATURES[key] && FEATURES[key].default);
}
function setFeature(key, on) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('feature.' + key, on ? '1' : '0');
}
const features = () => Object.fromEntries(Object.keys(FEATURES).map(k => [k, featureEnabled(k)]));

module.exports = { db, ensureAdmin, audit, RECORDER_ROLES, RECORD_KINDS, DIGITAL_LOCATION, FEATURES, featureEnabled, setFeature, features };
