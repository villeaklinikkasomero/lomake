'use strict';
// Kadunnimet kunnittain OpenStreetMapista (Overpass API) täydennysehdotuksia varten.
//  - Palvelulle lähetetään vain kunnan nimi (Suomen kuntaluettelosta), ei käyttäjän kirjoittamaa tekstiä.
//  - Nimet tallennetaan välimuistiin kantaan 90 päiväksi; epäonnistunut haku yritetään uudelleen tunnin päästä.
//  - Pois käytöstä: STREET_SOURCE=off. Oma palvelin: OVERPASS_URL.
// Aineisto: © OpenStreetMapin tekijät, ODbL-lisenssi.

const { db } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS street_cache (
  municipality TEXT PRIMARY KEY,
  names        TEXT,                 -- JSON-taulukko, NULL jos haku epäonnistui
  fetched_at   INTEGER NOT NULL
)`);

const enabled = () => process.env.STREET_SOURCE !== 'off';
// Useampi julkinen palvelin: jos ensimmäinen ei vastaa, kokeillaan seuraavaa
const URLS = () => (process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter')
  .split(',').map(s => s.trim()).filter(Boolean);
const FRESH_MS = 90 * 24 * 3600e3, RETRY_MS = 3600e3;
const inflight = new Map();

// Ahvenanmaan kunnista OSM käyttää ruotsinkielistä nimeä
const OSM_NAME = { 'Maarianhamina': 'Mariehamn' };

function query(municipality) {
  const name = (OSM_NAME[municipality] || municipality).replace(/["\\]/g, '');
  // Rajataan Suomeen, jottei samanniminen kunta muualla (esim. Salo Italiassa) sekoitu
  return `[out:json][timeout:25];
area["ISO3166-1"="FI"]["admin_level"="2"]->.fi;
rel(area.fi)["boundary"="administrative"]["admin_level"="8"]["name"="${name}"];
map_to_area->.a;
way(area.a)["highway"]["name"];
for (t["name"]) { make s name=_.val; out; }`;
}

async function fetchNames(municipality) {
  let data = null, lastErr = null;
  for (const url of URLS()) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json',
                   'User-Agent': 'kohtaamisten-raportointi/1.0 (A-klinikkasaatio)' },
        body: 'data=' + encodeURIComponent(query(municipality)),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
      data = await res.json(); break;
    } catch (e) { lastErr = e; }
  }
  if (!data) throw lastErr || new Error('Ei vastausta');
  const names = [...new Set((data.elements || []).map(e => e.tags && e.tags.name).filter(n => typeof n === 'string' && n.length >= 2 && n.length <= 80))];
  return names.sort((a, b) => a.localeCompare(b, 'fi'));
}

function load(municipality) {
  if (inflight.has(municipality)) return inflight.get(municipality);
  const p = fetchNames(municipality)
    .then(names => { db.prepare('INSERT OR REPLACE INTO street_cache (municipality, names, fetched_at) VALUES (?, ?, ?)').run(municipality, JSON.stringify(names), Date.now()); return names; })
    .catch(e => { console.error('Kadunnimien haku epäonnistui:', municipality, e.message);
      const old = db.prepare('SELECT names FROM street_cache WHERE municipality = ?').get(municipality);
      db.prepare('INSERT OR REPLACE INTO street_cache (municipality, names, fetched_at) VALUES (?, ?, ?)').run(municipality, old ? old.names : null, Date.now() - FRESH_MS + RETRY_MS);
      return old && old.names ? JSON.parse(old.names) : null; })
    .finally(() => inflight.delete(municipality));
  inflight.set(municipality, p);
  return p;
}

// Palauttaa kunnan kadunnimet. Ensimmäisellä kerralla odotetaan enintään waitMs; jos haku ei ehdi,
// palautetaan null ja haku jatkuu taustalla (seuraava näppäily saa jo tulokset).
async function streetsFor(municipality, waitMs = 4000) {
  if (!enabled() || !municipality) return null;
  const row = db.prepare('SELECT names, fetched_at FROM street_cache WHERE municipality = ?').get(municipality);
  const cached = row && row.names ? JSON.parse(row.names) : null;
  if (row && Date.now() - row.fetched_at < FRESH_MS) return cached;
  const p = load(municipality);
  if (cached) return cached;                       // vanhentunut välimuisti kelpaa sillä aikaa, kun päivitetään
  return Promise.race([p, new Promise(r => setTimeout(() => r(null), waitMs).unref())]);
}

module.exports = { streetsFor, enabled };
