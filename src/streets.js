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

module.exports = { streetsFor, enabled, SOURCE: 'Digi- ja väestötietovirasto, rakennusten osoitetiedot 2025 (CC BY 4.0)' };
