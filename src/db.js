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
  encounter_type  TEXT NOT NULL CHECK (encounter_type IN ('yksilo','ryhma')),
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

module.exports = { db, ensureAdmin, audit, RECORDER_ROLES, DIGITAL_LOCATION, FEATURES, featureEnabled, setFeature, features };
