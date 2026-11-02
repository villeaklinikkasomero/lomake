'use strict';
// Rooli- ja toimintotestit: node --test test/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kohtaamiset-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
const app = require('../src/server');
const { db, ensureAdmin } = require('../src/db');
const bcrypt = require('bcryptjs');

let server, base;
before(async () => {
  ensureAdmin();
  db.prepare("UPDATE users SET email='admin@t.fi', password_hash=?, must_change_password=0 WHERE role='admin'").run(bcrypt.hashSync('Admin-salasana-1', 4));
  server = app.listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); });

function client() {
  let cookie = '';
  return async (method, p, body, raw) => {
    const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'kohtaamiset', cookie },
      body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    if (raw) return res;
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
}
async function login(email, pw) { const c = client(); const r = await c('POST', '/login', { email, password: pw }); assert.equal(r.status, 200, JSON.stringify(r.data)); return c; }

const P = () => Object.fromEntries(db.prepare('SELECT code, id FROM projects').all().map(r => [r.code, r.id]));
const today = new Date().toISOString().slice(0, 10);
const basePayload = (pid, extra = {}) => ({ project_id: pid, encounter_date: today,
  encounter_type: 'yksilo', pseudonym: 'Kettu', answers: { tyontekijan_arvio: '4', ika: '18–29 vuotta', tyontekijan_huomiot: 'Hyvä keskustelu.' }, ...extra });

const users = {};
test('admin luo käyttäjät ja väliaikainen salasana pakottaa vaihdon', async () => {
  const a = await login('admin@t.fi', 'Admin-salasana-1');
  const p = P();
  const mk = async (email, role, projects) => {
    const r = await a('POST', '/users', { name: email.split('@')[0], email, role, project_ids: projects });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const c = await login(email, r.data.temporaryPassword);
    assert.equal((await c('GET', '/form')).status, 403);            // salasana vaihdettava ensin
    assert.equal((await c('POST', '/me/password', { current: r.data.temporaryPassword, next: 'Uusi-salasana-123' })).status, 200);
    users[role] = await login(email, 'Uusi-salasana-123');
  };
  await mk('tv@t.fi', 'tiimivetaja', [p.KATUKLINIKKA, p.AK21]);
  await mk('ht@t.fi', 'hanketyontekija', [p.KATUKLINIKKA]);
  await mk('tt@t.fi', 'tuntityontekija', [p.KATUKLINIKKA]);
  users.admin = a;
});

test('kirjaus: validointi, hankerajaus ja tunnistetietojen esto', async () => {
  const p = P(); const ht = users.hanketyontekija;
  let r = await ht('POST', '/encounters', basePayload(p.KATUKLINIKKA));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  r = await ht('POST', '/encounters', basePayload(p.JALMA));
  assert.equal(r.status, 400); assert.match(r.data.error, /oikeutta/);
  r = await ht('POST', '/encounters', basePayload(p.KATUKLINIKKA, { answers: { tyontekijan_arvio: '3', tyontekijan_huomiot: 'Hetu 010190-123A' } }));
  assert.equal(r.status, 400); assert.match(r.data.error, /henkilötunnu/);
  r = await ht('POST', '/encounters', basePayload(p.KATUKLINIKKA, { answers: {} }));
  assert.equal(r.status, 400); assert.match(r.data.error, /Työntekijän arvio/);
  r = await ht('POST', '/encounters', basePayload(p.KATUKLINIKKA, { encounter_date: '2999-01-01' }));
  assert.equal(r.status, 400);
  r = await ht('POST', '/encounters', basePayload(p.KATUKLINIKKA, { encounter_type: 'ryhma', encounter_count: 0 }));
  assert.equal(r.status, 400);
});

test('ryhmäkirjaus ja hankekohtainen kysymys', async () => {
  const p = P(); const tv = users.tiimivetaja;
  const r = await tv('POST', '/encounters', basePayload(p.AK21, { encounter_type: 'ryhma', encounter_count: 25, person_count: 8, pseudonym: 'ei tallennu',
    answers: { tyontekijan_arvio: '5', ika: '18–29 vuotta', ak21_toimintamuoto: 'Selvä suunta -ryhmä' } }));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const d = await tv('GET', '/encounters/' + r.data.id);
  assert.equal(d.data.encounter.pseudonym, null);
  assert.equal(d.data.encounter.answers.ak21_toimintamuoto, 'Selvä suunta -ryhmä');
  assert.equal(d.data.encounter.answers.ika, undefined);     // ikä koskee vain yksilökohtaamisia
});

test('tuntityöntekijä: kirjaus kyllä, selaus ja vienti ei', async () => {
  const p = P(); const tt = users.tuntityontekija;
  const r = await tt('POST', '/encounters', basePayload(p.KATUKLINIKKA, { recorder_role: 'A-klinikkasäätiön asiantuntija tai ohjaaja' }));
  assert.equal(r.status, 201);
  assert.equal((await tt('GET', '/encounters')).status, 403);
  assert.equal((await tt('GET', '/encounters/' + r.data.id)).status, 404);
  assert.equal((await tt('GET', `/export?from=2020-01-01&to=${today}`)).status, 403);
  assert.equal((await tt('GET', '/users')).status, 403);
});

test('hanketyöntekijä näkee vain omat, ei voi korjata/poistaa/viedä', async () => {
  const ht = users.hanketyontekija;
  const list = await ht('GET', '/encounters');
  assert.equal(list.status, 200);
  assert.ok(list.data.rows.length >= 1);
  assert.ok(list.data.rows.every(r => r.created_by_name === 'ht'));
  const id = list.data.rows[0].id;
  assert.equal((await ht('PUT', '/encounters/' + id, basePayload(P().KATUKLINIKKA))).status, 403);
  assert.equal((await ht('DELETE', '/encounters/' + id)).status, 403);
  assert.equal((await ht('GET', `/export?from=2020-01-01&to=${today}`)).status, 403);
});

test('kirjaajan rooli tulee profiilista eikä muutu korjauksessa', async () => {
  const TT = 'Tuntityöntekijä tai ulkopuolinen asiantuntija, ohjaaja, avustaja tai neuvontapalvelun vastaaja';
  const rows = db.prepare(`SELECT e.id, e.recorder_role FROM encounters e JOIN users u ON u.id = e.created_by WHERE u.email = 'tt@t.fi'`).all();
  assert.ok(rows.length && rows.every(r => r.recorder_role === TT), 'lomakkeelta lähetetty rooli ohitetaan');
  const upd = await users.tiimivetaja('PUT', '/encounters/' + rows[0].id, basePayload(P().KATUKLINIKKA));
  assert.equal(upd.status, 200, JSON.stringify(upd.data));
  assert.equal(db.prepare('SELECT recorder_role FROM encounters WHERE id = ?').get(rows[0].id).recorder_role, TT);
  // Kirjaajan rooli johdetaan aina käyttöoikeusroolista, lähetetty arvo ohitetaan
  const SAATIO = 'A-klinikkasäätiön asiantuntija tai ohjaaja';
  const r = await users.admin('POST', '/users', { name: 'Avustaja', email: 'v@t.fi', role: 'tuntityontekija', recorder_role: SAATIO, project_ids: [] });
  assert.equal(r.status, 201);
  assert.equal(db.prepare("SELECT recorder_role FROM users WHERE email='v@t.fi'").get().recorder_role, TT);
  const vid = db.prepare("SELECT id FROM users WHERE email='v@t.fi'").get().id;
  await users.admin('PUT', '/users/' + vid, { name: 'Avustaja', email: 'v@t.fi', role: 'tiimivetaja', project_ids: [] });
  assert.equal(db.prepare('SELECT recorder_role FROM users WHERE id = ?').get(vid).recorder_role, SAATIO);
});

test('tiimivetäjä näkee hankkeidensa kaikki, korjaa ja poistaa', async () => {
  const tv = users.tiimivetaja;
  const list = await tv('GET', '/encounters');
  const names = new Set(list.data.rows.map(r => r.created_by_name));
  assert.ok(names.has('ht') && names.has('tt') && names.has('tv'));
  const target = list.data.rows.find(r => r.created_by_name === 'ht');
  const upd = await tv('PUT', '/encounters/' + target.id, basePayload(P().KATUKLINIKKA, { answers: { tyontekijan_arvio: '2' } }));
  assert.equal(upd.status, 200, JSON.stringify(upd.data));
  const d = await tv('GET', '/encounters/' + target.id);
  assert.equal(d.data.encounter.answers.tyontekijan_arvio, '2');
  // Ei pääsyä toisen hankkeen vientiin
  assert.equal((await tv('GET', `/export?from=2020-01-01&to=${today}&projects=${P().JALMA}`)).status, 403);
  assert.equal((await tv('GET', '/questions')).status, 403);
});

test('Excel-vienti: rivit, sarakkeet, ei nimimerkkejä', async () => {
  const ExcelJS = require('exceljs');
  const res = await users.tiimivetaja('GET', `/export?from=2020-01-01&to=${today}`, null, true);
  assert.equal(res.status, 200);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const ws = wb.getWorksheet('Kohtaamiset');
  const headers = ws.getRow(1).values.slice(1);
  assert.ok(headers.includes('Kohtaamisen ajankohta') && headers.includes('Tallennettu') && headers.includes('Tunniste'));
  assert.ok(headers.some(h => /Toimintamuoto/.test(h)));
  assert.ok(!headers.some(h => /nimimerk/i.test(h)));
  const total = db.prepare('SELECT COUNT(*) n FROM encounters WHERE deleted_at IS NULL').get().n;
  assert.equal(ws.rowCount - 1, total);
  let found = false; ws.eachRow((row) => { row.values.forEach(v => { if (v === 'Kettu') found = true; }); });
  assert.equal(found, false, 'nimimerkki ei saa päätyä vientiin');
});

test('admin: kysymyksen lisäys ja käytöstä poisto säilyttää vanhat vastaukset', async () => {
  const a = users.admin; const p = P();
  let r = await a('POST', '/questions', { key: 'katu_tarjottu_tuki', project_id: p.KATUKLINIKKA, label: 'Tarjottu tuki', type: 'multichoice',
    options: ['Neuvonta', 'Välineet', 'Ohjaus palveluihin'], applies_to: 'kaikki', required: false });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const qid = r.data.id;
  r = await users.hanketyontekija('POST', '/encounters', basePayload(p.KATUKLINIKKA, { answers: { tyontekijan_arvio: '4', katu_tarjottu_tuki: ['Neuvonta', 'Välineet'] } }));
  assert.equal(r.status, 201);
  const encId = r.data.id;
  r = await a('PUT', '/questions/' + qid, { label: 'Tarjottu tuki', type: 'text', applies_to: 'kaikki', options: [] });
  assert.equal(r.status, 400);  // tyypin muutos estetty
  r = await a('PUT', '/questions/' + qid, { label: 'Tarjottu tuki', type: 'multichoice', applies_to: 'kaikki', options: ['Neuvonta', 'Välineet', 'Ohjaus palveluihin'], active: false });
  assert.equal(r.status, 200);
  const d = await a('GET', '/encounters/' + encId);
  assert.deepEqual(d.data.encounter.answers.katu_tarjottu_tuki, ['Neuvonta', 'Välineet']);
  // Tuntityöntekijän lomakkeella kysymystä ei enää näy
  const f = await users.tuntityontekija('GET', '/form');
  assert.ok(!f.data.questions.some(q => q.key === 'katu_tarjottu_tuki'));
});

test('suljettu tunnus ei pääse sisään ja CSRF-otsake vaaditaan', async () => {
  const a = users.admin;
  const u = db.prepare("SELECT id FROM users WHERE email='tt@t.fi'").get();
  const r = await a('PUT', '/users/' + u.id, { name: 'tt', email: 'tt@t.fi', role: 'tuntityontekija', project_ids: [], active: false });
  assert.equal(r.status, 200);
  assert.equal((await users.tuntityontekija('GET', '/form')).status, 401);
  const c = client(); const res = await c('POST', '/login', { email: 'tt@t.fi', password: 'Uusi-salasana-123' });
  assert.equal(res.status, 401);
  const noHeader = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403);
});

test('testidata: vähintään 30 erilaista kirjausta, kaikki hankkeet, poisto koskee vain testidataa', async () => {
  const a = users.admin;
  const realBefore = db.prepare('SELECT COUNT(*) n FROM encounters WHERE is_test = 0').get().n;
  const r = await a('POST', '/admin/demo-data', { count: 40 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.created, 40);
  const rows = db.prepare(`SELECT e.*, (SELECT group_concat(question_id || '=' || value, '|') FROM encounter_answers WHERE encounter_id = e.id) ans
                           FROM encounters e WHERE is_test = 1`).all();
  const distinct = new Set(rows.map(e => [e.project_id, e.encounter_date, e.encounter_type, e.encounter_count, e.person_count, e.pseudonym, e.recorder_role, e.ans].join('#')));
  assert.ok(distinct.size >= 30, `erilaisia ${distinct.size}`);
  const activeProjects = db.prepare('SELECT COUNT(*) n FROM projects WHERE active = 1').get().n;
  assert.equal(new Set(rows.map(e => e.project_id)).size, activeProjects);
  assert.ok(rows.some(e => e.encounter_type === 'ryhma') && rows.some(e => e.encounter_type === 'yksilo'));
  assert.ok(new Set(rows.map(e => e.recorder_role)).size >= 2);
  assert.ok(rows.every(e => e.encounter_date <= new Date().toISOString().slice(0, 10)));
  assert.equal((await users.tiimivetaja('POST', '/admin/demo-data', { count: 5 })).status, 403);
  const d = await a('DELETE', '/admin/demo-data');
  assert.equal(d.data.deleted, 40);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM encounters WHERE is_test = 0').get().n, realBefore);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM encounter_answers WHERE encounter_id NOT IN (SELECT id FROM encounters)').get().n, 0);
});

test('työntekijäseuranta: admin kaikki, tiimivetäjä vain omat hankkeet, muut ei', async () => {
  const p = P();
  // ht kirjaa Katuklinikkaan (tv:n hanke); admin kirjaa Jalmaan (ei tv:n hanke)
  await users.hanketyontekija('POST', '/encounters', basePayload(p.KATUKLINIKKA, { encounter_type: 'ryhma', encounter_count: 12, person_count: 5, answers: { tyontekijan_arvio: '5' } }));
  await users.admin('POST', '/encounters', basePayload(p.JALMA));
  const htId = db.prepare("SELECT id FROM users WHERE email='ht@t.fi'").get().id;
  const adminId = db.prepare("SELECT id FROM users WHERE email='admin@t.fi'").get().id;

  const all = await users.admin('GET', '/staff');
  assert.equal(all.status, 200);
  const htRow = all.data.rows.find(r => r.id === htId);
  assert.ok(htRow && htRow.encounters >= 12 && htRow.worker_rating != null);

  const tv = await users.tiimivetaja('GET', '/staff');
  assert.equal(tv.status, 200);
  assert.ok(!tv.data.rows.some(r => r.id === adminId), 'tiimivetäjä ei näe toisen hankkeen kirjaajaa');
  const jalmaRows = db.prepare('SELECT COUNT(*) n FROM encounters WHERE project_id = ? AND deleted_at IS NULL').get(p.JALMA).n;
  assert.ok(jalmaRows > 0);
  const tvTotal = tv.data.totals.rows;
  const allowed = db.prepare(`SELECT COUNT(*) n FROM encounters WHERE deleted_at IS NULL AND project_id IN (?, ?)`).get(p.KATUKLINIKKA, p.AK21).n;
  assert.equal(tvTotal, allowed);

  const det = await users.tiimivetaja('GET', `/staff/${htId}`);
  assert.equal(det.status, 200);
  assert.ok(det.data.kpi.encounters >= 12 && det.data.monthly.length >= 1 && det.data.byProject.length >= 1);
  assert.equal((await users.tiimivetaja('GET', `/staff/${adminId}`)).status, 404);

  assert.equal((await users.hanketyontekija('GET', '/staff')).status, 403);
  assert.equal((await users.hanketyontekija('GET', `/staff/${htId}`)).status, 403);

  // Kirjauslistan kirjaajasuodatin
  const list = await users.tiimivetaja('GET', `/encounters?created_by=${htId}`);
  assert.ok(list.data.rows.length > 0 && list.data.rows.every(r => r.created_by === htId));
  // Hanketyöntekijä ei voi ohittaa omaa rajaustaan
  const own = await users.hanketyontekija('GET', `/encounters?created_by=${adminId}`);
  assert.ok(own.data.rows.every(r => r.created_by === htId));
});

test('testidata jakautuu testityöntekijöille ja poistuu heidän kanssaan', async () => {
  const a = users.admin;
  await a('POST', '/admin/demo-data', { count: 40 });
  const workers = db.prepare('SELECT u.id, COUNT(e.id) n FROM users u JOIN encounters e ON e.created_by = u.id WHERE u.is_test = 1 GROUP BY u.id').all();
  assert.ok(workers.length >= 4, `testityöntekijöitä ${workers.length}`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE is_test = 1 AND active = 1').get().n, 0, 'testitunnukset ovat suljettuja');
  const staff = await a('GET', '/staff');
  assert.ok(staff.data.rows.filter(r => r.is_test && r.rows > 0).length >= 4);
  await a('DELETE', '/admin/demo-data');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE is_test = 1').get().n, 0);
});
