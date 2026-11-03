'use strict';
// Tilastonäkymän (dashboard) koosteet. Vain koottuja lukuja – ei tunnisteita,
// nimimerkkejä eikä vapaatekstejä.

const { db, RECORDER_ROLES } = require('./db');

const qid = (key) => (db.prepare('SELECT id FROM questions WHERE key = ?').get(key) || {}).id || -1;

function shiftPeriod(from, to) {
  // Edellinen yhtä pitkä jakso juuri ennen valittua aikaväliä
  const f = new Date(from + 'T00:00:00Z'), t = new Date(to + 'T00:00:00Z');
  const days = Math.round((t - f) / 86400000) + 1;
  const pt = new Date(f.getTime() - 86400000), pf = new Date(f.getTime() - days * 86400000);
  return [pf.toISOString().slice(0, 10), pt.toISOString().slice(0, 10)];
}

// Sama jakso vuotta aiemmin (29.2. → 28.2.)
function shiftYear(from, to) {
  const back = (d) => { const [y, m, dd] = d.split('-').map(Number); const last = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
    return `${y - 1}-${String(m).padStart(2, '0')}-${String(Math.min(dd, last)).padStart(2, '0')}`; };
  return [back(from), back(to)];
}

function buildWhere({ from, to, projectIds, projectId, types, role, ika, sukupuoli }) {
  const w = ['e.deleted_at IS NULL', `e.project_id IN (${projectIds.map(() => '?').join(',') || 'NULL'})`];
  const p = [...projectIds];
  if (from) { w.push('e.encounter_date >= ?'); p.push(from); }
  if (to) { w.push('e.encounter_date <= ?'); p.push(to); }
  if (projectId) { w.push('e.project_id = ?'); p.push(projectId); }
  if (types && types.length && types.length < 2) { w.push('e.encounter_type = ?'); p.push(types[0]); }
  if (role) { w.push('e.recorder_role = ?'); p.push(role); }
  for (const [key, val] of [['ika', ika], ['sukupuoli', sukupuoli]]) {
    if (!val) continue;
    w.push('EXISTS (SELECT 1 FROM encounter_answers a WHERE a.encounter_id = e.id AND a.question_id = ? AND a.value = ?)');
    p.push(qid(key), val);
  }
  return { sql: w.join(' AND '), params: p };
}

function totals(W) {
  const t = db.prepare(`SELECT COUNT(*) rows, COALESCE(SUM(e.encounter_count), 0) encounters,
      COALESCE(SUM(CASE WHEN e.encounter_type = 'yksilo' THEN e.encounter_count END), 0) yksilo,
      COALESCE(SUM(CASE WHEN e.encounter_type = 'ryhma' THEN e.encounter_count END), 0) ryhma,
      COUNT(DISTINCT e.client_id) identified,
      COALESCE(SUM(CASE WHEN e.encounter_type = 'ryhma' THEN e.person_count END), 0) group_persons,
      COALESCE(SUM(CASE WHEN e.encounter_type = 'yksilo' AND e.client_id IS NULL THEN 1 END), 0) unidentified,
      COALESCE(SUM(CASE WHEN e.encounter_type = 'ryhma' AND e.person_count IS NULL THEN 1 END), 0) groups_without_count,
      -- Täysin anonyymit kohtaamiset: yksilö ilman nimimerkkiä + ryhmien kohtaamiset, joista osallistujamäärä puuttuu.
      -- Näistä ei voi päätellä eri henkilöiden määrää, joten ne jäävät arvion ulkopuolelle.
      COALESCE(SUM(CASE WHEN e.encounter_type = 'yksilo' AND e.client_id IS NULL THEN e.encounter_count END), 0) anon_individual,
      COALESCE(SUM(CASE WHEN e.encounter_type = 'ryhma' AND e.person_count IS NULL THEN e.encounter_count END), 0) anon_group
    FROM encounters e WHERE ${W.sql}`).get(...W.params);
  // Eri henkilöiden arvio = tunnistetut asiakkaat + ryhmien ilmoitetut osallistujat
  t.persons = t.identified + t.group_persons;
  t.anonymous = t.anon_individual + t.anon_group;
  t.anonymous_share = t.encounters ? t.anonymous / t.encounters : null;
  return t;
}

function dashboard(filters) {
  const W = buildWhere(filters);
  const cur = totals(W);
  // Vertailu valinnan mukaan: ei vertailua, edellinen yhtä pitkä jakso tai sama jakso vuotta aiemmin
  const compare = ['prev', 'year'].includes(filters.compare) ? filters.compare : 'none';
  const [pf, pt] = compare === 'year' ? shiftYear(filters.from, filters.to) : shiftPeriod(filters.from, filters.to);
  const PW = compare === 'none' ? null : buildWhere({ ...filters, from: pf, to: pt });
  const prev = PW ? totals(PW) : null;

  const monthlyFor = (w) => db.prepare(`SELECT substr(e.encounter_date, 1, 7) month, COUNT(*) rows, SUM(e.encounter_count) encounters,
      COALESCE(SUM(CASE WHEN e.encounter_type = 'yksilo' THEN e.encounter_count END), 0) yksilo,
      COALESCE(SUM(CASE WHEN e.encounter_type = 'ryhma' THEN e.encounter_count END), 0) ryhma
    FROM encounters e WHERE ${w.sql} GROUP BY month ORDER BY month`).all(...w.params);
  const monthly = monthlyFor(W);
  const monthlyPrev = PW ? monthlyFor(PW) : null;

  const byProject = db.prepare(`SELECT p.id, p.name, COUNT(*) rows, SUM(e.encounter_count) encounters
    FROM encounters e JOIN projects p ON p.id = e.project_id WHERE ${W.sql} GROUP BY p.id ORDER BY encounters DESC`).all(...W.params);

  const ratingStats = (key) => {
    const id = qid(key);
    const r = db.prepare(`SELECT AVG(CAST(a.value AS REAL)) avg, COUNT(*) n FROM encounters e
      JOIN encounter_answers a ON a.encounter_id = e.id AND a.question_id = ? WHERE ${W.sql}`).get(id, ...W.params);
    const dist = db.prepare(`SELECT a.value v, COUNT(*) n FROM encounters e JOIN encounter_answers a ON a.encounter_id = e.id AND a.question_id = ?
      WHERE ${W.sql} GROUP BY a.value`).all(id, ...W.params);
    return { avg: r.avg, n: r.n, dist: [1, 2, 3, 4, 5].map(v => ({ value: v, n: (dist.find(d => Number(d.v) === v) || { n: 0 }).n })) };
  };

  // Vastausjakaumat valinta- ja arviokysymyksistä (yhteiset + valitun hankkeen omat)
  const qs = db.prepare(`SELECT q.*, p.name project_name FROM questions q LEFT JOIN projects p ON p.id = q.project_id
    WHERE q.type IN ('choice', 'multichoice', 'rating') AND q.key NOT IN ('tyontekijan_arvio', 'asiakkaan_arvio')
      AND (q.project_id IS NULL OR q.project_id = ?) ORDER BY q.project_id IS NOT NULL, q.sort, q.id`).all(filters.projectId || -1);
  const distributions = [];
  for (const q of qs) {
    const rows = db.prepare(`SELECT a.value FROM encounters e JOIN encounter_answers a ON a.encounter_id = e.id AND a.question_id = ?
      WHERE ${W.sql}`).all(q.id, ...W.params);
    if (!rows.length) continue;
    const counts = new Map();
    for (const r of rows) {
      const vals = q.type === 'multichoice' ? JSON.parse(r.value) : [r.value];
      for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
    }
    const options = q.type === 'rating' ? ['1', '2', '3', '4', '5'] : JSON.parse(q.options || '[]');
    const items = options.map(o => ({ label: String(o), value: counts.get(String(o)) || 0 }));
    for (const [k, v] of counts) if (!options.map(String).includes(k)) items.push({ label: k, value: v }); // poistuneet vaihtoehdot
    distributions.push({ key: q.key, label: q.label, project: q.project_name || null, multiple: q.type === 'multichoice', answered: rows.length, items });
  }

  const ref = db.prepare(`SELECT COUNT(*) total, COALESCE(SUM(r.status = 'toteutui'), 0) toteutui, COALESCE(SUM(r.status = 'ei_toteutunut'), 0) ei_toteutunut,
      COALESCE(SUM(r.status = 'avoin'), 0) avoin FROM referrals r JOIN encounters e ON e.id = r.encounter_id WHERE ${W.sql}`).get(...W.params);

  const updated = db.prepare(`SELECT MAX(COALESCE(e.updated_at, e.created_at)) t FROM encounters e WHERE ${W.sql}`).get(...W.params).t;

  const opt = (key) => { const q = db.prepare('SELECT options FROM questions WHERE key = ?').get(key); return q && q.options ? JSON.parse(q.options) : []; };
  return {
    period: { from: filters.from, to: filters.to, compare, prevFrom: PW ? pf : null, prevTo: PW ? pt : null },
    totals: cur, previous: prev, monthly, monthlyPrev, byProject,
    ratings: { worker: ratingStats('tyontekijan_arvio'), client: ratingStats('asiakkaan_arvio') },
    referrals: { ...ref, rate: ref.toteutui + ref.ei_toteutunut ? ref.toteutui / (ref.toteutui + ref.ei_toteutunut) : null },
    distributions, updated,
    options: { roles: RECORDER_ROLES, ika: opt('ika'), sukupuoli: opt('sukupuoli') },
  };
}

module.exports = { dashboard, shiftPeriod, shiftYear };
