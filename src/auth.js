'use strict';
// Kirjautumisen apuvälineet:
//  - TOTP-monivaiheinen tunnistautuminen (RFC 6238) paikallisille tunnuksille
//    (sähköposti + salasana + todennussovellus, esim. Microsoft Authenticator)
//  - Microsoft Entra ID -kirjautuminen (OpenID Connect, auth code + PKCE) säätiön työntekijöille

const crypto = require('crypto');

const IS_PROD = process.env.NODE_ENV === 'production';
const ISSUER_NAME = process.env.MFA_ISSUER || 'Kohtaamisten raportointi';

// ---------------------------------------------------------------------------
// MFA-salaisuuden salaus kantaan (AES-256-GCM). Avain johdetaan PSEUDONYM_KEY:stä,
// jota ei vaihdeta käytön aikana; erillinen MFA_KEY voidaan antaa halutessa.
// ---------------------------------------------------------------------------
function encKey() {
  const base = process.env.MFA_KEY || process.env.PSEUDONYM_KEY || (IS_PROD ? null : 'kehitys-avain-ei-tuotantoon');
  if (!base) throw new Error('MFA_KEY tai PSEUDONYM_KEY puuttuu.');
  return Buffer.from(crypto.hkdfSync('sha256', base, 'kohtaamiset', 'mfa-secret', 32));
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}
function decrypt(blob) {
  const [v, iv, tag, data] = String(blob).split('.');
  if (v !== 'v1') throw new Error('Tuntematon salausmuoto');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// TOTP
// ---------------------------------------------------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
const STEP = 30;
const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP);
function hotp(secretB32, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const off = mac[mac.length - 1] & 15;
  const code = ((mac.readUInt32BE(off) & 0x7fffffff) % 1e6).toString().padStart(6, '0');
  return code;
}
const totp = (secretB32, now = Date.now()) => hotp(secretB32, currentStep(now));
const newSecret = () => base32Encode(crypto.randomBytes(20));

// Palauttaa hyväksytyn aika-askeleen tai null. Sallii ±1 askeleen kellopoikkeaman.
// Uudelleenkäytön esto: askel on oltava suurempi kuin edellinen hyväksytty (lastStep).
function verifyTotp(secretB32, code, lastStep) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = currentStep();
  for (const s of [now - 1, now, now + 1]) {
    if (lastStep != null && s <= lastStep) continue;
    const expected = hotp(secretB32, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return s;
  }
  return null;
}
const otpauthUri = (secretB32, account) =>
  `otpauth://totp/${encodeURIComponent(ISSUER_NAME)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(ISSUER_NAME)}&algorithm=SHA1&digits=6&period=${STEP}`;

// MFA vaaditaan paikallisilta tunnuksilta, ellei sitä ole kehityksessä erikseen kytketty pois.
const mfaRequired = () => process.env.MFA_REQUIRED !== 'false';

// ---------------------------------------------------------------------------
// Microsoft Entra ID (OpenID Connect)
// ---------------------------------------------------------------------------
const entraConfig = () => ({
  tenant: process.env.ENTRA_TENANT_ID,
  clientId: process.env.ENTRA_CLIENT_ID,
  clientSecret: process.env.ENTRA_CLIENT_SECRET,
  redirectUri: process.env.ENTRA_REDIRECT_URI || (process.env.APP_URL ? process.env.APP_URL.replace(/\/$/, '') + '/auth/callback' : null),
  // Testejä varten voi antaa oman myöntäjän osoitteen
  authority: process.env.ENTRA_AUTHORITY || (process.env.ENTRA_TENANT_ID ? `https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID}/v2.0` : null),
});
const entraEnabled = () => { const c = entraConfig(); return !!(c.tenant && c.clientId && c.clientSecret && c.redirectUri && c.authority); };

let clientPromise = null, clientKey = null;
function entraClient() {
  const c = entraConfig();
  const key = JSON.stringify(c);
  if (!clientPromise || clientKey !== key) {
    const { Issuer } = require('openid-client');
    clientKey = key;
    clientPromise = Issuer.discover(c.authority).then(issuer => new issuer.Client({
      client_id: c.clientId, client_secret: c.clientSecret, redirect_uris: [c.redirectUri], response_types: ['code'],
    })).catch(e => { clientPromise = null; throw e; });
  }
  return clientPromise;
}

// Lyhytikäinen, allekirjoitettu evästeen sisältö kirjautumisen ajaksi (state, nonce, PKCE).
// Erillinen SameSite=Lax-eväste, koska paluu Microsoftilta on sivustojen välinen siirtymä.
function signState(obj, secret) {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + mac;
}
function readState(value, secret) {
  if (!value) return null;
  const [body, mac] = String(value).split('.');
  if (!body || !mac) return null;
  const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (expect.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(mac))) return null;
  const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  return obj.exp > Date.now() ? obj : null;
}
const readCookie = (req, name) => {
  const m = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
};

module.exports = {
  encrypt, decrypt, newSecret, totp, verifyTotp, currentStep, otpauthUri, mfaRequired,
  entraConfig, entraEnabled, entraClient, signState, readState, readCookie,
};
