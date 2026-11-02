'use strict';
// Raakadatan Excel-vienti.
//  - Yksi rivi = yksi lomaketallennus (ryhmäkirjaus säilyy yhtenä rivinä).
//  - Jokainen kysymys omassa sarakkeessaan (yhteiset + hankekohtaiset).
//  - Yksilökohtaamisten nimimerkkiä EI viedä (tietosuoja); eri henkilöiden
//    määrä näytetään vain ryhmäkirjauksille.
//  - Kirjaajan henkilöllisyyttä ei viedä, vain kirjaajan rooli.

const ExcelJS = require('exceljs');
const { db } = require('./db');

const TZ = 'Europe/Helsinki';
function utcToLocalDate(sqliteUtc) {
  if (!sqliteUtc) return null;
  // Excel ei tunne aikavyöhykkeitä: muodostetaan Helsingin paikallisaika "naiivina" päivämääränä.
  const d = new Date(sqliteUtc.replace(' ', 'T') + 'Z');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d).map(p => [p.type, p.value]));
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second));
}
const dateOnly = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };

function buildWorkbook({ from, to, projectIds }) {
  const ph = projectIds.map(() => '?').join(',');
  const encounters = db.prepare(`
    SELECT e.*, p.code project_code, p.name project_name
    FROM encounters e JOIN projects p ON p.id = e.project_id
    WHERE e.deleted_at IS NULL AND e.encounter_date BETWEEN ? AND ? AND e.project_id IN (${ph})
    ORDER BY e.encounter_date, e.created_at`).all(from, to, ...projectIds);

  // Sarakkeiksi kaikki aktiiviset kysymykset + käytöstä poistetut, joihin on vastauksia aineistossa.
  const questions = db.prepare(`
    SELECT q.*, p.name project_name FROM questions q LEFT JOIN projects p ON p.id = q.project_id
    WHERE (q.project_id IS NULL OR q.project_id IN (${ph}))
      AND (q.active = 1 OR EXISTS (SELECT 1 FROM encounter_answers a JOIN encounters e ON e.id = a.encounter_id
                                  WHERE a.question_id = q.id AND e.deleted_at IS NULL AND e.encounter_date BETWEEN ? AND ?))
    ORDER BY q.project_id IS NOT NULL, p.sort, q.sort, q.id`).all(...projectIds, from, to);

  // Ohjaukset kirjauksittain (palveluiden nimet). Asiakastunnistetta ei viedä.
  const refMap = new Map();
  if (encounters.length) {
    const rs = db.prepare(`SELECT r.encounter_id, group_concat(s.name, '; ') services FROM referrals r JOIN referral_services s ON s.id = r.service_id
                           JOIN encounters e ON e.id = r.encounter_id
                           WHERE e.deleted_at IS NULL AND e.encounter_date BETWEEN ? AND ? AND e.project_id IN (${ph}) GROUP BY r.encounter_id`).all(from, to, ...projectIds);
    for (const r of rs) refMap.set(r.encounter_id, r.services);
  }
  const answers = new Map();
  if (encounters.length) {
    const stmt = db.prepare(`SELECT a.encounter_id, a.question_id, a.value FROM encounter_answers a
                             JOIN encounters e ON e.id = a.encounter_id
                             WHERE e.deleted_at IS NULL AND e.encounter_date BETWEEN ? AND ? AND e.project_id IN (${ph})`);
    for (const a of stmt.iterate(from, to, ...projectIds)) {
      if (!answers.has(a.encounter_id)) answers.set(a.encounter_id, {});
      answers.get(a.encounter_id)[a.question_id] = a.value;
    }
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Kohtaamisten raportointi';
  wb.created = new Date();
  const ws = wb.addWorksheet('Kohtaamiset', { views: [{ state: 'frozen', ySplit: 1 }] });

  const base = [
    { header: 'Tunniste', key: 'id', width: 38 },
    { header: 'Kohtaamisen ajankohta', key: 'encounter_date', width: 14, style: { numFmt: 'd.m.yyyy' } },
    { header: 'Hanke', key: 'project_name', width: 32 },
    { header: 'Hanketunnus', key: 'project_code', width: 14 },
    { header: 'Kirjaajan rooli', key: 'recorder_role', width: 40 },
    { header: 'Kirjauksen tyyppi', key: 'encounter_type', width: 16 },
    { header: 'Kohtaamisten määrä', key: 'encounter_count', width: 12 },
    { header: 'Eri henkilöiden määrä (ryhmä)', key: 'person_count', width: 14 },
    { header: 'Tunnistettu asiakas (yksilö)', key: 'client_linked', width: 14 },
    { header: 'Ohjattu palveluun', key: 'referrals', width: 36 },
  ];
  const qCols = questions.map(q => ({
    header: q.project_id ? `${q.project_name}: ${q.label}` : q.label,
    key: 'q_' + q.id, width: q.type === 'textarea' ? 50 : Math.min(Math.max(q.label.length, 12), 40),
  }));
  const tail = [
    { header: 'Tallennettu', key: 'created_at', width: 18, style: { numFmt: 'd.m.yyyy h:mm' } },
    { header: 'Muokattu', key: 'updated_at', width: 18, style: { numFmt: 'd.m.yyyy h:mm' } },
    { header: 'Testidata', key: 'is_test', width: 10 },
  ];
  ws.columns = [...base, ...qCols, ...tail];

  for (const e of encounters) {
    const row = {
      id: e.id,
      encounter_date: dateOnly(e.encounter_date),
      project_name: e.project_name,
      project_code: e.project_code,
      recorder_role: e.recorder_role,
      encounter_type: e.encounter_type === 'ryhma' ? 'Ryhmä' : 'Yksi kohtaaminen',
      encounter_count: e.encounter_count,
      person_count: e.encounter_type === 'ryhma' ? e.person_count : null,
      client_linked: e.encounter_type === 'yksilo' ? (e.client_id ? 'kyllä' : 'ei') : null,
      referrals: refMap.get(e.id) || null,
      created_at: utcToLocalDate(e.created_at),
      updated_at: utcToLocalDate(e.updated_at),
      is_test: e.is_test ? 'kyllä' : 'ei',
    };
    const ans = answers.get(e.id) || {};
    for (const q of questions) {
      const v = ans[q.id];
      if (v == null) continue;
      if (q.type === 'multichoice') row['q_' + q.id] = JSON.parse(v).join('; ');
      else if (q.type === 'rating' || q.type === 'number') row['q_' + q.id] = Number(v);
      else if (q.type === 'date') row['q_' + q.id] = dateOnly(v);
      else row['q_' + q.id] = v;
    }
    ws.addRow(row);
  }

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  header.alignment = { vertical: 'middle', wrapText: true };
  header.height = 36;
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };

  // Selitesivu: sarakkeiden pysyvät tunnisteet (Power BI / jatkoanalyysi).
  const info = wb.addWorksheet('Sarakkeet');
  info.columns = [
    { header: 'Sarake', key: 'header', width: 50 },
    { header: 'Pysyvä tunniste', key: 'key', width: 26 },
    { header: 'Hanke', key: 'project', width: 30 },
    { header: 'Tyyppi', key: 'type', width: 14 },
    { header: 'Koskee', key: 'applies', width: 12 },
    { header: 'Käytössä', key: 'active', width: 10 },
  ];
  info.getRow(1).font = { bold: true };
  for (const c of base) info.addRow({ header: c.header, key: c.key, project: 'Yhteinen', type: 'perustieto', applies: 'kaikki', active: 'kyllä' });
  questions.forEach((q, i) => info.addRow({ header: qCols[i].header, key: q.key, project: q.project_name || 'Yhteinen', type: q.type,
    applies: q.applies_to, active: q.active ? 'kyllä' : 'ei' }));
  info.addRow({});
  info.addRow({ header: `Aikaväli ${from} – ${to}. Rivejä ${encounters.length}, kohtaamisia yhteensä ${encounters.reduce((s, e) => s + e.encounter_count, 0)}.` });
  info.addRow({ header: 'Asiakastunnisteet (nimimerkit) eivät sisälly vientiin tietosuojasyistä. Sarake ”Tunnistettu asiakas” kertoo vain, käytettiinkö tunnistetta.' });

  return wb;
}

module.exports = { buildWorkbook };
