'use strict';
// Roolien oikeudet. Roolit ja niiden oikeudet ovat tietokannassa (roles-taulu) ja
// ylläpidettävissä kohdassa Hallinta → Roolit. Valmiit roolit luodaan db.js:ssä.
//
// Oikeudet:
//  record        – voi kirjata kohtaamisia (omiin hankkeisiin, admin kaikkiin)
//  viewScope     – mitä kirjauksia voi selata: 'all' | 'projects' | 'own' | 'none'
//  editScope     – mitä kirjauksia voi korjata: 'all' | 'projects' | 'own' | 'none'
//  deleteScope   – mitä kirjauksia voi poistaa: 'all' | 'projects' | 'none'
//  exportScope   – Excel-vienti: 'all' | 'projects' | 'none'
//  staffScope    – työntekijäseuranta: 'all' | 'projects' | 'own' | 'none'
//                  (säätiön työntekijät näkyvät aina kaikkien hankkeiden luvuin; tuntityöntekijät
//                   all = kaikki, projects = omien hankkeiden, own = vain yhteismäärät)
//  pathScope     – asiakaspolut ja palveluohjaukset (koosteet): 'all' | 'projects' | 'none'
//  dashScope     – Tilastot-näkymä (koosteet): 'all' | 'projects' | 'none'
//  manageUsers / manageProjects / manageQuestions – ylläpito

const PERMISSION_FIELDS = [
  { key: 'record', type: 'bool', label: 'Kirjaa kohtaamisia', group: 'Kirjaukset' },
  { key: 'viewScope', type: 'scope', values: ['none', 'own', 'projects', 'all'], label: 'Selaa kirjauksia', group: 'Kirjaukset' },
  { key: 'editScope', type: 'scope', values: ['none', 'own', 'projects', 'all'], label: 'Korjaa kirjauksia', group: 'Kirjaukset' },
  { key: 'deleteScope', type: 'scope', values: ['none', 'projects', 'all'], label: 'Poistaa kirjauksia', group: 'Kirjaukset' },
  { key: 'dashScope', type: 'scope', values: ['none', 'projects', 'all'], label: 'Tilastot', group: 'Seuranta' },
  { key: 'staffScope', type: 'scope', values: ['none', 'own', 'projects', 'all'], label: 'Työntekijäseuranta', group: 'Seuranta' },
  { key: 'exportScope', type: 'scope', values: ['none', 'projects', 'all'], label: 'Excel-vienti (raakadata)', group: 'Seuranta' },
  { key: 'pathScope', type: 'scope', values: ['none', 'projects', 'all'], label: 'Asiakaspolut', group: 'Seuranta' },
  { key: 'manageQuestions', type: 'bool', label: 'Kysymykset, kirjaustyypit ja ohjauspalvelut', group: 'Ylläpito' },
  { key: 'manageProjects', type: 'bool', label: 'Hankkeet', group: 'Ylläpito' },
  { key: 'manageUsers', type: 'bool', label: 'Käyttäjät, roolit, toiminnot, testidata ja loki', group: 'Ylläpito' },
];
const NONE = Object.fromEntries(PERMISSION_FIELDS.map(f => [f.key, f.type === 'bool' ? false : 'none']));

// Normalisoi tallennettavat oikeudet (tuntemattomat avaimet ja arvot pois)
function normalizePermissions(input) {
  const out = { ...NONE };
  for (const f of PERMISSION_FIELDS) {
    const v = input && input[f.key];
    if (f.type === 'bool') out[f.key] = v === true || v === 'true' || v === 1;
    else if (f.values.includes(v)) out[f.key] = v;
  }
  // Korjaus- ja poisto-oikeus edellyttävät, että kirjaukset näkyvät
  const rank = { none: 0, own: 1, projects: 2, all: 3 };
  if (rank[out.editScope] > rank[out.viewScope]) out.editScope = out.viewScope === 'none' ? 'none' : out.viewScope;
  if (rank[out.deleteScope] > rank[out.viewScope]) out.deleteScope = out.viewScope === 'all' || out.viewScope === 'projects' ? out.viewScope : 'none';
  return out;
}

// Roolit luetaan tietokannasta; välimuisti tyhjennetään, kun rooleja muutetaan
let cache = null;
function load() {
  if (!cache) {
    const { db } = require('./db');
    const rows = db.prepare('SELECT * FROM roles ORDER BY sort, label').all();
    cache = Object.fromEntries(rows.map(r => [r.key, {
      key: r.key, label: r.label, description: r.description || '', recorderIndex: r.recorder_index, foundation: !!r.foundation,
      builtin: !!r.builtin, active: !!r.active, sort: r.sort, permissions: { ...NONE, ...JSON.parse(r.permissions || '{}') },
    }]));
  }
  return cache;
}
const invalidate = () => { cache = null; };
const roles = () => load();
const role = (key) => load()[key] || null;
const permissionsOf = (key) => (role(key) ? { ...role(key).permissions } : { ...NONE });
const recorderIndex = (key) => (role(key) ? role(key).recorderIndex : 0);
const isFoundation = (key) => !!(role(key) && role(key).foundation);
const foundationKeys = () => Object.values(load()).filter(r => r.foundation).map(r => r.key);
const roleLabel = (key) => (role(key) ? role(key).label : key);

function can(user, perm) { return !!(user && permissionsOf(user.role)[perm]); }
function scope(user, perm) { return (user && permissionsOf(user.role)[perm]) || 'none'; }

// Tarkistaa, kohdistuuko scope-tyyppinen oikeus tiettyyn kirjaukseen.
function allowsEncounter(user, perm, encounter, userProjectIds) {
  const s = scope(user, perm);
  if (s === 'all') return true;
  if (s === 'projects') return userProjectIds.includes(encounter.project_id);
  if (s === 'own') return encounter.created_by === user.id || encounter.performed_by === user.id;
  return false;
}

module.exports = {
  PERMISSION_FIELDS, normalizePermissions, invalidate, roles, role, permissionsOf, recorderIndex, isFoundation, foundationKeys, roleLabel,
  can, scope, allowsEncounter,
};
