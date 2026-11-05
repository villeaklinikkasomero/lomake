'use strict';
// Kadunnimet kunnittain täydennysehdotuksia varten. Aineisto on sovelluksen omalla palvelimella,
// joten käyttäjän kirjoittamaa tekstiä tai kuntaa ei lähetetä mihinkään ulkopuoliseen palveluun.
// Lähde: Digi- ja väestötietovirasto, rakennusten osoitetiedot (avoin data, CC BY 4.0), poiminta 3.2.2025.
// Muodostettu kadunnimet.json.gz: { "Kunta": ["Katu", ...] } (suomen- ja ruotsinkieliset nimet).
// Pois käytöstä: STREET_SOURCE=off.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let data = null;
function load() {
  if (!data) data = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'kadunnimet.json.gz'))).toString('utf8'));
  return data;
}
const enabled = () => process.env.STREET_SOURCE !== 'off';
const streetsFor = (municipality) => (enabled() && municipality ? load()[municipality] || null : null);

// Vain kadun nimi: talonumero, porras, huoneisto ja muut tarkennukset poistetaan, jotta kirjaukseen
// ei tallennu osoitetta, josta henkilön voisi tunnistaa. Esim. "Mannerheimintie 12 A 5" → "Mannerheimintie",
// "Kauppakatu 3, Tampere" → "Kauppakatu". Numerolla alkavat kadunnimet (esim. "2. linja") säilyvät.
function streetOnly(value) {
  let s = String(value || '').replace(/\s+/g, ' ').trim();
  s = s.split(/[,;(/]/)[0].trim();                      // pilkun, sulun tai kauttaviivan jälkeinen pois
  const words = s.split(' ');
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (i === 0 && /^\d+\.$/.test(w)) { out.push(w); continue; }   // "2. linja"
    if (/^\d/.test(w)) break;                                      // talonumero ja kaikki sen jälkeen
    const m = w.match(/^(\D+?)\d/);                                // "Mannerheimintie12" → "Mannerheimintie"
    if (m) { out.push(m[1]); break; }
    out.push(w);
  }
  return out.join(' ').replace(/[\s.,:;-]+$/, '').trim();
}

module.exports = { streetsFor, enabled, streetOnly, SOURCE: 'Digi- ja väestötietovirasto, rakennusten osoitetiedot 2025 (CC BY 4.0)' };
