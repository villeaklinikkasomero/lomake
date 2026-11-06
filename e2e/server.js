'use strict';
// Käynnistää sovelluksen E2E-testejä varten omalla, tyhjällä tietokannalla.
// Playwright käynnistää tämän automaattisesti (ks. playwright.config.js).
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kohtaamiset-e2e-'));
process.env.DB_PATH = path.join(tmp, 'e2e.db');
process.env.MFA_REQUIRED = 'false';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.STREET_SOURCE = 'off';

const bcrypt = require('bcryptjs');
const app = require('../src/server');
const { db, ensureAdmin } = require('../src/db');
const { USERS } = require('./users');

ensureAdmin();
const hash = (pw) => bcrypt.hashSync(pw, 4);
db.prepare("UPDATE users SET email = ?, name = 'Testi Admin', password_hash = ?, must_change_password = 0 WHERE role = 'admin'")
  .run(USERS.admin.email, hash(USERS.admin.password));

const PORT = Number(process.env.E2E_PORT || 3100);
app.listen(PORT, '127.0.0.1', () => console.log(`E2E-palvelin: http://127.0.0.1:${PORT}`));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
