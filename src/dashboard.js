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

function buildWhere({ from, to, projectIds, projectId, types, role, ika, sukupuoli, kaupunki }) {
  const w = ['e.deleted_at IS NULL', `e.project_id IN (${projectIds.map(() => '?').join(',') || 'NULL'})`];
  const p = [...projectIds];
  if (from) { w.push('e.encounter_date >= ?'); p.push(from); }
  if (to) { w.push('e.encounter_date <= ?'); p.push(to); }
  if (projectId) { w.push('e.project_id = ?'); p.push(projectId); }
  if (types && types.length) {
    const all = db.prepare('SELECT COUNT(*) n FROM record_types').get().n;
    if (types.length < all) { w.push(`e.encounter_type IN (${types.map(() => '?').join(',')})`); p.push(...types); }
  }
  if (role) { w.push('e.recorder_role = ?'); p.push(role); }
  for (const [key, val] of [['ika', ika], ['sukupuoli', sukupuoli]]) {
    if (!val) continue;
    w.push('EXISTS (SELECT 1 FROM encounter_answers a WHERE a.encounter_id = e.id AND a.question_id = ? AND a.value = ?)');
    p.push(qid(key), val);
  }
  if (kaupunki) {
    w.push('EXISTS (SELECT 1 FROM encounter_answers a WHERE a.encounter_id = e.id AND a.question_id = ? AND lower(trim(a.value)) = ?)');
    p.push(qid('kaupunki'), String(kaupunki).trim().toLowerCase());
  }
  return { sql: w.join(' AND '), params: p };
}

// Paikkakunnat ja kadut (vapaatekstiä: kirjoitusasut yhdistetään kirjainkoosta ja välilyönneistä riippumatta).
// Näytettäväksi nimeksi valitaan yleisin kirjoitusasu.
function places(filters, W) {
  const cq = qid('kaupunki'), sq = qid('kadunnimi');
  const group = (where, params, qidv, extraJoin = '', extraSelect = '') => db.prepare(`SELECT lower(trim(a.value)) k, trim(a.value) v, ${extraSelect}
      COUNT(*) rows, SUM(CASE WHEN e.kind <> 'tavoittaminen' THEN e.encounter_count ELSE 0 END) encounters FROM encounters e
      JOIN encounter_answers a ON a.encounter_id = e.id AND a.question_id = ? ${extraJoin}
      WHERE ${where} AND trim(a.value) <> '' GROUP BY k, v ${extraSelect ? ', ck' : ''}`).all(qidv, ...params);
  const merge = (rows, keyOf) => {
    const m = new Map();
    for (const r of rows) {
      const key = keyOf(r); const o = m.get(key) || { label: r.v, best: 0, rows: 0, encounters: 0, city: r.cv || null };
      o.rows += r.rows; o.encounters += r.encounters;
      if (r.rows > o.best) { o.best = r.rows; o.label = r.v; if (r.cv) o.city = r.cv; }
      m.set(key, o);
    }
    return [...m.values()].sort((a, b) => b.encounters - a.encounters || a.label.localeCompare(b.label, 'fi'));
  };
  // Paikkakunnat ilman paikkakuntarajausta (rajaus valitsee yhden niistä)
  const WC = buildWhere({ ...filters, kaupunki: null });
  const cities = merge(group(WC.sql, WC.params, cq), r => r.k);
  const totalEnc = db.prepare(`SELECT COALESCE(SUM(CASE WHEN e.kind <> 'tavoittaminen' THEN e.encounter_count END), 0) n FROM encounters e WHERE ${WC.sql}`).get(...WC.params).n;
  const withCity = cities.reduce((t, c) => t + c.encounters, 0);
  const streetRows = group(W.sql, W.params, sq,
    'LEFT JOIN encounter_answers c ON c.encounter_id = e.id AND c.question_id = ' + Number(cq), 'lower(trim(c.value)) ck, trim(c.value) cv,');
  const streets = merge(streetRows, r => r.k + '|' + (filters.kaupunki ? '' : (r.ck || '')));
  const strip = (x) => ({ label: x.label, city: x.city, rows: x.rows, encounters: x.encounters });
  return {
    cities: cities.map(strip), withoutCity: Math.max(0, totalEnc - withCity),
    streets: streets.slice(0, 20).map(strip), streetCount: streets.length,
  };
}

function totals(W) {
  // Kohtaamiset = yksilö- ja ryhmätyyppiset kirjaukset; tavoittaminen tilastoidaan erikseen (reach)
  const t = db.prepare(`SELECT COUNT(*) rows, COALESCE(SUM(CASE WHEN e.kind <> 'tavoittaminen' THEN e.encounter_count END), 0) encounters,
      COALESCE(SUM(CASE WHEN e.kind = 'tavoittaminen' THEN e.encounter_count END), 0) reach,
      COALESCE(SUM(e.kind = 'tavoittaminen'), 0) reach_rows,
      COALESCE(SUM(CASE WHEN e.kind = 'yksilo' THEN e.encounter_count END), 0) yksilo,
      COALESCE(SUM(CASE WHEN e.kind = 'ryhma' THEN e.encounter_count END), 0) ryhma,
      COUNT(DISTINCT e.client_id) identified,
      COALESCE(SUM(CASE WHEN e.kind = 'ryhma' THEN e.person_count END), 0) group_persons,
      COALESCE(SUM(CASE WHEN e.kind = 'yksilo' AND e.client_id IS NULL THEN 1 END), 0) unidentified,
      COALESCE(SUM(CASE WHEN e.kind = 'ryhma' AND e.person_count IS NULL THEN 1 END), 0) groups_without_count,
      -- Täysin anonyymit kohtaamiset: yksilö ilman nimimerkkiä + ryhmien kohtaamiset, joista osallistujamäärä puuttuu.
      -- Näistä ei voi päätellä eri henkilöiden määrää, joten ne jäävät arvion ulkopuolelle.
      COALESCE(SUM(CASE WHEN e.kind = 'yksilo' AND e.client_id IS NULL THEN e.encounter_count END), 0) anon_individual,
      COALESCE(SUM(CASE WHEN e.kind = 'ryhma' AND e.person_count IS NULL THEN e.encounter_count END), 0) anon_group
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

  const monthlyFor = (w) => db.prepare(`SELECT substr(e.encounter_date, 1, 7) month, COUNT(*) rows,
      COALESCE(SUM(CASE WHEN e.kind <> 'tavoittaminen' THEN e.encounter_count END), 0) encounters,
      COALESCE(SUM(CASE WHEN e.kind = 'tavoittaminen' THEN e.encounter_count END), 0) reach,
      COALESCE(SUM(CASE WHEN e.kind = 'yksilo' THEN e.encounter_count END), 0) yksilo,
      COALESCE(SUM(CASE WHEN e.kind = 'ryhma' THEN e.encounter_count END), 0) ryhma
    FROM encounters e WHERE ${w.sql} GROUP BY month ORDER BY month`).all(...w.params);
  const monthly = monthlyFor(W);
  const monthlyPrev = PW ? monthlyFor(PW) : null;

  const byProject = db.prepare(`SELECT p.id, p.name, COUNT(*) rows, COALESCE(SUM(CASE WHEN e.kind <> 'tavoittaminen' THEN e.encounter_count END), 0) encounters,
      COALESCE(SUM(CASE WHEN e.kind = 'tavoittaminen' THEN e.encounter_count END), 0) reach
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
    // Kirjaustyypeittäin (kohtaamiset ja tavoitetut)
    byType: db.prepare(`SELECT e.encounter_type key, rt.label, rt.kind, COUNT(*) rows, SUM(e.encounter_count) count FROM encounters e
      LEFT JOIN record_types rt ON rt.key = e.encounter_type WHERE ${W.sql} GROUP BY e.encounter_type ORDER BY rt.sort`).all(...W.params),
    ratings: { worker: ratingStats('tyontekijan_arvio'), client: ratingStats('asiakkaan_arvio') },
    referrals: { ...ref, rate: ref.toteutui + ref.ei_toteutunut ? ref.toteutui / (ref.toteutui + ref.ei_toteutunut) : null },
    distributions, updated, places: places(filters, W),
    options: { roles: RECORDER_ROLES, ika: opt('ika'), sukupuoli: opt('sukupuoli') },
  };
}

module.exports = { dashboard, shiftPeriod, shiftYear };
