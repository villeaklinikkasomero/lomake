'use strict';
const { expect } = require('@playwright/test');
const { USERS } = require('./users');

/** Kirjautuu sisään lomakkeen kautta kuten oikea käyttäjä. */
async function login(page, user = USERS.admin) {
  await page.goto('/');
  await page.getByLabel('Sähköposti').fill(user.email);
  await page.getByLabel('Salasana').fill(user.password);
  await page.getByRole('button', { name: 'Kirjaudu' }).click();
  await expect(page.getByRole('heading', { name: 'Uusi kirjaus', level: 1 })).toBeVisible();
}

/**
 * Valitsee vaihtoehdon radio- tai valintaruuturyhmästä.
 * Lomakkeen omat tyylitellyt painikkeet peittävät varsinaisen inputin, joten klikataan tekstiä kuten käyttäjäkin.
 */
async function choose(page, groupName, optionText) {
  const group = page.getByRole('radiogroup', { name: groupName }).or(page.getByRole('group', { name: groupName }));
  await group.getByText(optionText, { exact: true }).click();
}

/** Täyttää Katuklinikan yksilökohtaamisen pakolliset kentät. */
async function fillMinimalKatuklinikka(page) {
  await page.getByText('Katuklinikka', { exact: true }).click();
  await page.getByText('Yksi kohtaaminen', { exact: true }).click();
  await choose(page, 'Työntekijän arvio kohtaamisen hyödystä*', '4');
  await choose(page, 'Mitä tukimuotoja kohtaamisessa toteutui?*', 'Sosiaalineuvonta');
  await choose(page, /luottamuksellinen kontakti\?\*/, '5');
  await choose(page, 'Saiko asiakas kohtaamisessa tarpeisiinsa vastaavaa apua tai tukea?*', '4');
}

module.exports = { login, choose, fillMinimalKatuklinikka, USERS };
