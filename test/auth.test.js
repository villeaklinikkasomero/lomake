'use strict';
// Kirjautumistestit: paikallinen tunnus + MFA (TOTP) ja Entra ID (OpenID Connect, testimyöntäjä)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'); const path = require('path'); const fs = require('fs');
const http = require('http');
const express = require('express');
const jose = require('jose');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kohtaamiset-auth-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.MFA_REQUIRED = 'true';

// --- Testimyöntäjä (Entra ID:n kaltainen OIDC-palvelu)
let issuerUrl, nextClaims = {}, keyPair, jwk;
const idp = express();
idp.use(express.urlencoded({ extended: false }));
idp.get('/.well-known/openid-configuration', (req, res) => res.json({
  issuer: issuerUrl, authorization_endpoint: issuerUrl + '/authorize', token_endpoint: issuerUrl + '/token',
  jwks_uri: issuerUrl + '/jwks', response_types_supported: ['code'], subject_types_supported: ['pairwise'], id_token_signing_alg_values_supported: ['RS256'],
}));
idp.get('/jwks', (req, res) => res.json({ keys: [jwk] }));
let lastNonce = null;
idp.post('/token', async (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const id_token = await new jose.SignJWT({ nonce: lastNonce, tid: 'tenant-1', ...nextClaims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(issuerUrl).setAudience('client-1').setIssuedAt(now).setExpirationTime(now + 600)
    .setSubject(nextClaims.oid || 'sub').sign(keyPair.privateKey);
  res.json({ token_type: 'Bearer', id_token, access_token: 'x', expires_in: 600 });
});

let app, server, base, idpServer;
const { db, ensureAdmin } = (() => { app = null; return {}; })();
before(async () => {
  keyPair = await jose.generateKeyPair('RS256');
  jwk = { ...(await jose.exportJWK(keyPair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  idpServer = http.createServer(idp).listen(0); await new Promise(r => idpServer.once('listening', r));
  issuerUrl = `http://127.0.0.1:${idpServer.address().port}`;
  Object.assign(process.env, { ENTRA_TENANT_ID: 'tenant-1', ENTRA_CLIENT_ID: 'client-1', ENTRA_CLIENT_SECRET: 's', ENTRA_AUTHORITY: issuerUrl });
  app = require('../src/server');
  const dbm = require('../src/db'); dbm.ensureAdmin();
  server = app.listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.ENTRA_REDIRECT_URI = base + '/auth/callback';
});
after(() => { server.close(); idpServer.close(); });

function client() {
  const jar = {};
  const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const store = (res) => { for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (v) jar[k] = v; else delete jar[k]; } };
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'kohtaamiset', cookie: cookieHeader() }, body: body ? JSON.stringify(body) : undefined });
    store(res);
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data, location: res.headers.get('location') };
  };
  return call;
}

test('paikallinen tunnus: salasana + TOTP-käyttöönotto, uudelleenkäytön esto ja nollaus', async () => {
  const { db } = require('../src/db'); const auth = require('../src/auth'); const bcrypt = require('bcryptjs');
  db.prepare("UPDATE users SET email='admin@t.fi', password_hash=?, must_change_password=0 WHERE role='admin'").run(bcrypt.hashSync('Admin-salasana-1', 4));
  const c = client();
  let r = await c('POST', '/api/login', { email: 'admin@t.fi', password: 'Admin-salasana-1' });
  assert.equal(r.status, 200); assert.equal(r.data.mfa, 'setup');
  assert.match(r.data.qr, /^data:image\/png;base64,/);
  assert.equal((await c('GET', '/api/me')).status, 401, 'ei vielä kirjautunut');
  const secret = r.data.secret.replace(/\s/g, '');
  assert.equal((await c('POST', '/api/login/mfa', { code: '000000' })).status, 401);
  const code1 = auth.totp(secret);
  r = await c('POST', '/api/login/mfa', { code: code1 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await c('GET', '/api/me')).status, 200);
  const row = db.prepare("SELECT mfa_secret, mfa_enabled FROM users WHERE email='admin@t.fi'").get();
  assert.equal(row.mfa_enabled, 1); assert.ok(!row.mfa_secret.includes(secret), 'salaisuus salattuna');
  // Uusi kirjautuminen: sama koodi ei kelpaa uudelleen (sama aika-askel)
  const c2 = client();
  r = await c2('POST', '/api/login', { email: 'admin@t.fi', password: 'Admin-salasana-1' });
  assert.equal(r.data.mfa, 'verify');
  assert.equal((await c2('POST', '/api/login/mfa', { code: code1 })).status, 401, 'koodin uudelleenkäyttö estetty');
  // Seuraavan aika-askeleen koodi kelpaa (±1 askel sallittu)
  assert.equal((await c2('POST', '/api/login/mfa', { code: auth.totp(secret, Date.now() + 30000) })).status, 200);
  // Admin luo tuntityöntekijän ja nollaa hänen MFA:nsa
  const u = await c('POST', '/api/users', { name: 'Tuntityöntekijä', email: 'tt@t.fi', role: 'tuntityontekija', project_ids: [], auth_method: 'local' });
  assert.equal(u.status, 201); assert.ok(u.data.temporaryPassword);
  const t = client();
  r = await t('POST', '/api/login', { email: 'tt@t.fi', password: u.data.temporaryPassword });
  const ts = r.data.secret.replace(/\s/g, '');
  assert.equal((await t('POST', '/api/login/mfa', { code: auth.totp(ts) })).status, 200);
  assert.equal((await t('GET', '/api/me')).data.user.mustChangePassword, true, 'salasana vaihdettava MFA:n jälkeen');
  assert.equal((await c('POST', `/api/users/${u.data.id}/reset-mfa`, {})).status, 200);
  assert.equal((await t('GET', '/api/me')).status, 401, 'nollaus katkaisee istunnot');
  r = await client()('POST', '/api/login', { email: 'tt@t.fi', password: u.data.temporaryPassword });
  assert.equal(r.data.mfa, 'setup');
  // Viisi väärää koodia katkaisee yrityksen
  const w = client();
  await w('POST', '/api/login', { email: 'tt@t.fi', password: u.data.temporaryPassword });
  for (let i = 0; i < 4; i++) await w('POST', '/api/login/mfa', { code: '111111' });
  r = await w('POST', '/api/login/mfa', { code: '111111' });
  assert.match(r.data.error, /alusta/);
});

async function entraLogin(claims) {
  const c = client();
  let r = await c('GET', '/auth/entra');
  assert.equal(r.status, 302, JSON.stringify(r));
  const url = new URL(r.location);
  assert.equal(url.origin, issuerUrl);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  lastNonce = url.searchParams.get('nonce'); nextClaims = claims;
  r = await c('GET', `/auth/callback?code=abc&state=${encodeURIComponent(url.searchParams.get('state'))}`);
  return { c, r };
}

test('Entra ID: rooli sovellusroolista, käyttäjä luodaan; ilman roolia ei pääsyä; väärä state hylätään', async () => {
  const { db } = require('../src/db');
  assert.equal((await client()('GET', '/api/auth/config')).data.entra, true);
  let { c, r } = await entraLogin({ oid: 'oid-tv', email: 'Tiina.Vetaja@a-klinikka.fi', name: 'Tiina Vetäjä', roles: ['tiimivetaja'] });
  assert.equal(r.status, 302); assert.equal(r.location, '/#/kirjaa');
  const me = await c('GET', '/api/me');
  assert.equal(me.status, 200); assert.equal(me.data.user.role, 'tiimivetaja'); assert.equal(me.data.user.authMethod, 'entra');
  assert.equal(me.data.user.mustChangePassword, false);
  assert.equal(db.prepare("SELECT entra_oid FROM users WHERE email = 'tiina.vetaja@a-klinikka.fi'").get().entra_oid, 'oid-tv');
  // Rooli päivittyy Entrasta seuraavalla kirjautumisella
  ({ c, r } = await entraLogin({ oid: 'oid-tv', email: 'tiina.vetaja@a-klinikka.fi', name: 'Tiina Vetäjä', roles: ['hanketyontekija'] }));
  assert.equal((await c('GET', '/api/me')).data.user.role, 'hanketyontekija');
  // Salasanakirjautuminen ei toimi Entra-tunnukselle
  const p = await client()('POST', '/api/login', { email: 'tiina.vetaja@a-klinikka.fi', password: 'x' });
  assert.equal(p.status, 401); assert.match(p.data.error, /Microsoft/);
  // Ilman roolia eikä ennalta luotua tunnusta: ei pääsyä
  ({ r } = await entraLogin({ oid: 'oid-x', email: 'muu@a-klinikka.fi', name: 'Muu' }));
  assert.match(decodeURIComponent(r.location), /ei ole vielä käyttöoikeutta/);
  // Admin luo Microsoft-tunnuksen etukäteen: yhdistyy sähköpostilla, rooli sovelluksesta
  const auth = require('../src/auth'); const bcrypt = require('bcryptjs');
  const a = client();
  db.prepare("UPDATE users SET mfa_enabled = 0, mfa_secret = NULL WHERE email = 'admin@t.fi'").run();
  const s1 = await a('POST', '/api/login', { email: 'admin@t.fi', password: 'Admin-salasana-1' });
  const m1 = await a('POST', '/api/login/mfa', { code: auth.totp(s1.data.secret.replace(/\s/g, '')) });
  assert.equal(m1.status, 200, JSON.stringify(m1.data));
  const nu = await a('POST', '/api/users', { name: 'Hanna', email: 'hanna@a-klinikka.fi', role: 'hanketyontekija', project_ids: [], auth_method: 'entra' });
  assert.equal(nu.status, 201, JSON.stringify(nu.data)); assert.equal(nu.data.temporaryPassword, null);
  ({ c, r } = await entraLogin({ oid: 'oid-hanna', email: 'hanna@a-klinikka.fi', name: 'Hanna H' }));
  assert.equal(r.location, '/#/kirjaa');
  assert.equal((await c('GET', '/api/me')).data.user.id, nu.data.id);
  // Sama sähköposti paikallisena tunnuksena ei yhdisty Microsoft-kirjautumiseen
  ({ r } = await entraLogin({ oid: 'oid-admin', email: 'admin@t.fi', roles: ['admin'] }));
  assert.match(decodeURIComponent(r.location), /salasanatunnus/);
  // Väärä state
  const x = client();
  r = await x('GET', '/auth/entra');
  r = await x('GET', '/auth/callback?code=abc&state=vaara');
  assert.match(decodeURIComponent(r.location), /epäonnistui/);
  // Väärä organisaatio (tid)
  ({ r } = await entraLogin({ oid: 'oid-ext', email: 'x@muu.fi', roles: ['admin'], tid: 'toinen' }));
  assert.match(decodeURIComponent(r.location), /organisaatioon/);
});
