'use strict';
// Roolien oikeudet yhdessä paikassa. Muuta tätä taulukkoa, jos oikeuksia
// halutaan säätää (esim. sallia hanketyöntekijälle omien kirjausten korjaus).

const ROLES = {
  admin:           { label: 'Admin',                      description: 'A-klinikkasäätiön työntekijä, pääkäyttäjä' },
  tiimivetaja:     { label: 'Tiiminvetäjä',                description: 'A-klinikkasäätiön työntekijä' },
  hanketyontekija: { label: 'Hanketyöntekijä',            description: 'A-klinikkasäätiön työntekijä' },
  tuntityontekija: { label: 'Tuntityöntekijä (avustaja)', description: 'Tuntityöntekijä tai avustaja' },
};

// Oikeudet:
//  record        – voi kirjata kohtaamisia (omiin hankkeisiin, admin kaikkiin)
//  viewScope     – mitä kirjauksia voi selata: 'all' | 'projects' | 'own' | 'none'
//  editScope     – mitä kirjauksia voi korjata: 'all' | 'projects' | 'own' | 'none'
//  deleteScope   – mitä kirjauksia voi poistaa: 'all' | 'projects' | 'none'
//  exportScope   – Excel-vienti: 'all' | 'projects' | 'none'
//  staffScope    – työntekijäkohtainen seuranta: 'all' | 'projects' | 'own' (omat tiedot + hankkeiden kokonaismäärät) | 'none'
//  pathScope     – asiakaspolut ja palveluohjaukset (koosteet): 'all' | 'projects' | 'none'
//  dashScope     – Tilastot-näkymä (koosteet): 'all' | 'projects' | 'none'
//  manageUsers / manageProjects / manageQuestions – ylläpito
const PERMISSIONS = {
  admin: {
    record: true, viewScope: 'all', editScope: 'all', deleteScope: 'all', exportScope: 'all', staffScope: 'all', pathScope: 'all', dashScope: 'all',
    manageUsers: true, manageProjects: true, manageQuestions: true,
  },
  tiimivetaja: {
    record: true, viewScope: 'projects', editScope: 'projects', deleteScope: 'projects', exportScope: 'projects', staffScope: 'projects', pathScope: 'projects', dashScope: 'projects',
    manageUsers: false, manageProjects: false, manageQuestions: false,
  },
  hanketyontekija: {
    record: true, viewScope: 'own', editScope: 'own', deleteScope: 'none', exportScope: 'none', staffScope: 'own', pathScope: 'none', dashScope: 'projects',
    manageUsers: false, manageProjects: false, manageQuestions: false,
  },
  tuntityontekija: {
    record: true, viewScope: 'none', editScope: 'none', deleteScope: 'none', exportScope: 'none', staffScope: 'none', pathScope: 'none', dashScope: 'none',
    manageUsers: false, manageProjects: false, manageQuestions: false,
  },
};

// Kirjaajan rooli (lomakkeen "Olen"-tieto) määräytyy käyttöoikeusroolista:
// admin, tiiminvetäjä ja hanketyöntekijä ovat A-klinikkasäätiön työntekijöitä,
// tuntityöntekijä on avustaja. Indeksi viittaa db.js:n RECORDER_ROLES-listaan.
const DEFAULT_RECORDER_ROLE_INDEX = { admin: 0, tiimivetaja: 0, hanketyontekija: 0, tuntityontekija: 1 };

function can(user, perm) { return !!(user && PERMISSIONS[user.role] && PERMISSIONS[user.role][perm]); }
function scope(user, perm) { return (user && PERMISSIONS[user.role] && PERMISSIONS[user.role][perm]) || 'none'; }

// Tarkistaa, kohdistuuko scope-tyyppinen oikeus tiettyyn kirjaukseen.
function allowsEncounter(user, perm, encounter, userProjectIds) {
  const s = scope(user, perm);
  if (s === 'all') return true;
  if (s === 'projects') return userProjectIds.includes(encounter.project_id);
  if (s === 'own') return encounter.created_by === user.id || encounter.performed_by === user.id;
  return false;
}

module.exports = { ROLES, PERMISSIONS, DEFAULT_RECORDER_ROLE_INDEX, can, scope, allowsEncounter };
