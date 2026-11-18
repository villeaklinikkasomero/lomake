'use strict';
// Asetusten siirto ympäristöstä toiseen (esim. Render → Azure): hankkeet, kirjaustyypit,
// toteuttajat, ohjauspalvelut ja kysymykset. Ei käyttäjiä eikä kirjausdataa.
// Rivit täsmäytetään pysyvillä avaimilla (hankekoodi, avain, palvelun nimi), ei tietokannan id:illä.
// Tuonnissa tiedosto on lähde: puuttuvat lisätään, eroavat päivitetään ja kohdeympäristön
// ylimääräiset otetaan pois käytöstä (niitä ei poisteta, jotta vanhat kirjaukset säilyvät).

const { db } = require('./db');

const FORMAT = 'kohtaamiset-asetukset';
const VERSION = 1;

// Osiot: taulu, täsmäytysavain ja siirrettävät kentät (järjestys = tuontijärjestys)
const SECTIONS = [
  { key: 'projects', label: 'Hankkeet', table: 'projects', id: 'code', name: 'name',
    fields: ['code', 'name', 'active', 'sort', 'digital', 'color'] },
  { key: 'record_types', label: 'Kirjaustyypit', table: 'record_types', id: 'key', name: 'label',
    fields: ['key', 'label', 'description', 'kind', 'count_label', 'active', 'sort'] },
  { key: 'performer_types', label: 'Toteuttajat', table: 'performer_types', id: 'key', name: 'label',
    fields: ['key', 'label', 'recorder_index', 'active', 'sort'] },
  { key: 'referral_services', label: 'Ohjauspalvelut', table: 'referral_services', id: 'name', name: 'name',
    fields: ['name', 'active', 'sort'] },
  { key: 'questions', label: 'Kysymykset', table: 'questions', id: 'key', name: 'label',
    fields: ['key', 'project_code', 'label', 'help', 'type', 'options', 'required', 'applies', 'show_if', 'min_value',
      'free_text_warning', 'sort', 'active', 'digital_mode', 'digital_value', 'suggest'] },
];
const QUESTION_TYPES = ['text', 'textarea', 'number', 'choice', 'multichoice', 'rating', 'date'];
const KINDS = ['yksilo', 'ryhma', 'tavoittaminen'];

// Arvojen vertailu: numerot ja tekstit samaan muotoon (SQLite ja PostgreSQL palauttavat eri tyyppejä)
const norm = (v) => (v === undefined || v === '' ? null : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? v : /^-?\d+$/.test(String(v)) ? Number(v) : String(v));

function currentRows(section) {
  if (section.key === 'questions') {
    return db.prepare(`SELECT q.*, p.code project_code FROM questions q LEFT JOIN projects p ON p.id = q.project_id ORDER BY q.sort, q.id`).all();
  }
  return db.prepare(`SELECT * FROM ${section.table} ORDER BY sort`).all();
}
const pick = (row, fields) => Object.fromEntries(fields.map(f => [f, row[f] === undefined ? null : row[f]]));

function exportConfig() {
  const out = { format: FORMAT, version: VERSION, exported_at: new Date().toISOString() };
  for (const s of SECTIONS) out[s.key] = currentRows(s).map(r => pick(r, s.fields));
  return out;
}

// Tarkistaa tiedoston rakenteen; palauttaa virheilmoituksen tai null
function validate(data) {
  if (!data || data.format !== FORMAT) return 'Tiedosto ei ole kohtaamisten raportoinnin asetustiedosto.';
  if (Number(data.version) !== VERSION) return `Tiedoston versio ${data.version} ei ole tuettu.`;
  for (const s of SECTIONS) {
    if (!Array.isArray(data[s.key])) return `Tiedostosta puuttuu osio ${s.label}.`;
    const seen = new Set();
    for (const r of data[s.key]) {
      const id = r && r[s.id];
      if (!id || typeof id !== 'string') return `${s.label}: rivi ilman tunnistetta (${s.id}).`;
      if (seen.has(id)) return `${s.label}: tunniste ${id} on tiedostossa kahdesti.`;
      seen.add(id);
      if (s.key === 'record_types' && !KINDS.includes(r.kind)) return `Kirjaustyyppi ${id}: tuntematon laji ${r.kind}.`;
      if (s.key === 'questions' && !QUESTION_TYPES.includes(r.type)) return `Kysymys ${id}: tuntematon tyyppi ${r.type}.`;
    }
  }
  const codes = new Set(data.projects.map(p => p.code));
  const bad = data.questions.find(q => q.project_code && !codes.has(q.project_code));
  if (bad) return `Kysymys ${bad.key} viittaa hankkeeseen ${bad.project_code}, jota tiedostossa ei ole.`;
  return null;
}

// Muutossuunnitelma: mitä lisätään, päivitetään ja otetaan pois käytöstä
function plan(data) {
  const err = validate(data); if (err) return { error: err };
  const sections = SECTIONS.map(s => {
    const cur = new Map(currentRows(s).map(r => [r[s.id], r]));
    const incoming = new Set();
    const create = [], update = [], deactivate = [];
    let unchanged = 0;
    for (const r of data[s.key]) {
      incoming.add(r[s.id]);
      const c = cur.get(r[s.id]);
      if (!c) { create.push({ id: r[s.id], name: r[s.name] || r[s.id] }); continue; }
      const changed = s.fields.filter(f => f !== s.id && norm(r[f]) !== norm(c[f]));
      if (changed.length) update.push({ id: r[s.id], name: r[s.name] || r[s.id], fields: changed });
      else unchanged++;
    }
    for (const [id, c] of cur) if (!incoming.has(id) && Number(c.active) === 1) deactivate.push({ id, name: c[s.name] || id });
    return { key: s.key, label: s.label, create, update, deactivate, unchanged };
  });
  const total = sections.reduce((a, s) => a + s.create.length + s.update.length + s.deactivate.length, 0);
  return { sections, total, exported_at: data.exported_at || null };
}

function apply(data) {
  const p = plan(data); if (p.error) return p;
  db.transaction(() => {
    for (const s of SECTIONS) {
      const rows = data[s.key];
      const cols = s.key === 'questions' ? s.fields.filter(f => f !== 'project_code').concat('project_id') : s.fields;
      const projectId = s.key === 'questions'
        ? Object.fromEntries(db.prepare('SELECT code, id FROM projects').all().map(r => [r.code, r.id])) : null;
      const exists = db.prepare(`SELECT 1 FROM ${s.table} WHERE ${s.id} = ?`);
      for (const r of rows) {
        const v = Object.fromEntries(cols.map(f => [f, f === 'project_id' ? (r.project_code ? projectId[r.project_code] : null) : (r[f] === undefined ? null : r[f])]));
        for (const k of ['active', 'sort', 'digital', 'required', 'free_text_warning', 'suggest']) if (k in v) v[k] = Number(v[k]) || 0;
        if ('digital_mode' in v && !v.digital_mode) v.digital_mode = 'show';
        if ('recorder_index' in v) v.recorder_index = Number(v.recorder_index);
        if (exists.get(r[s.id])) {
          const set = cols.filter(f => f !== s.id).map(f => `${f} = @${f}`).join(', ');
          db.prepare(`UPDATE ${s.table} SET ${set}${s.key === 'questions' ? ", updated_at = datetime('now')" : ''} WHERE ${s.id} = @${s.id}`).run(v);
        } else {
          db.prepare(`INSERT INTO ${s.table} (${cols.join(', ')}) VALUES (${cols.map(f => '@' + f).join(', ')})`).run(v);
        }
      }
      const keep = rows.map(r => r[s.id]);
      if (keep.length) db.prepare(`UPDATE ${s.table} SET active = 0 WHERE active = 1 AND ${s.id} NOT IN (${keep.map(() => '?').join(',')})`).run(...keep);
      else db.prepare(`UPDATE ${s.table} SET active = 0 WHERE active = 1`).run();
    }
  })();
  return p;
}

module.exports = { exportConfig, plan, apply, FORMAT, VERSION };
