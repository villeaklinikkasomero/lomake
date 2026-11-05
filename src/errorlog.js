'use strict';
// Virheloki testausta ja ylläpitoa varten (Hallinta → Virheloki).
// Tallennetaan palvelinvirheet, hylätyt tallennukset (esim. validointi), selaimen JavaScript-virheet,
// yhteyskatkot sekä käyttäjien "Ilmoita ongelmasta" -viestit. Lokiin EI tallenneta lomakkeen sisältöä;
// viesteistä poistetaan henkilötunnukselta, sähköpostilta ja puhelinnumerolta näyttävät merkkijonot.

const crypto = require('crypto');
const { db } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS error_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  code       TEXT NOT NULL,           -- lyhyt virhekoodi, jonka käyttäjä näkee ja voi ilmoittaa
  source     TEXT NOT NULL,           -- server | client
  kind       TEXT NOT NULL,           -- server_error | rejected | js_error | network | feedback
  status     INTEGER,
  method     TEXT,
  path       TEXT,                    -- rajapinnan polku ilman kyselyosaa
  view       TEXT,                    -- sovelluksen näkymä (esim. #/kirjaa)
  message    TEXT,
  detail     TEXT,                    -- pinojälki tms. (lyhennetty)
  user_id    INTEGER,
  role       TEXT,
  device     TEXT,                    -- laite ja selain (esim. iPhone · Safari)
  build      TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_error_log_at ON error_log(at)');

const KINDS = ['server_error', 'rejected', 'js_error', 'network', 'feedback'];
const RETENTION_DAYS = Number(process.env.ERROR_LOG_RETENTION_DAYS || 90);

const newCode = () => crypto.randomBytes(3).toString('hex').toUpperCase();

// Tunnistetietojen poisto vapaasta tekstistä
function redact(text, max = 500) {
  if (text == null) return null;
  return String(text)
    .replace(/\b\d{6}[-+A-FU-Y]\d{3}[0-9A-FHJ-NPR-Y]\b/gi, '[htun]')
    .replace(/[^\s@]+@[^\s@]+\.[a-z]{2,}/gi, '[email]')
    .replace(/(\+358|\b0)\s?\d{1,3}[\s-]?\d{3}[\s-]?\d{3,4}\b/g, '[puh]')
    .slice(0, max);
}

// Laite ja selain lyhyesti (koko user agent -merkkijonoa ei tallenneta)
function deviceOf(ua) {
  ua = String(ua || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'muu';
  const br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'muu';
  return `${os} · ${br}`;
}

function log(e) {
  const code = e.code || newCode();
  try {
    db.prepare(`INSERT INTO error_log (code, source, kind, status, method, path, view, message, detail, user_id, role, device, build)
                VALUES (@code, @source, @kind, @status, @method, @path, @view, @message, @detail, @user_id, @role, @device, @build)`).run({
      code, source: e.source, kind: KINDS.includes(e.kind) ? e.kind : 'js_error', status: e.status ?? null, method: e.method || null,
      path: e.path ? String(e.path).split('?')[0].slice(0, 200) : null, view: e.view ? String(e.view).split('?')[0].slice(0, 100) : null,
      message: redact(e.message), detail: redact(e.detail, 2000), user_id: e.user_id ?? null, role: e.role || null,
      device: e.device || null, build: e.build || null,
    });
  } catch (err) { console.error('Virhelokiin kirjoitus epäonnistui', err); }
  return code;
}

function list({ days = 7, kind = null, limit = 500 } = {}) {
  const where = ["l.at >= datetime('now', ?)"]; const params = [`-${Math.max(1, Math.min(365, Number(days) || 7))} days`];
  if (kind && KINDS.includes(kind)) { where.push('l.kind = ?'); params.push(kind); }
  return db.prepare(`SELECT l.*, u.name user_name FROM error_log l LEFT JOIN users u ON u.id = l.user_id
    WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT ?`).all(...params, Math.min(2000, Number(limit) || 500));
}

const purge = () => db.prepare("DELETE FROM error_log WHERE at < datetime('now', ?)").run(`-${RETENTION_DAYS} days`).changes;
const clear = () => db.prepare('DELETE FROM error_log').run().changes;

module.exports = { log, list, purge, clear, redact, deviceOf, newCode, KINDS };
