// @ts-check
const { test, expect } = require('@playwright/test');
const { login, USERS } = require('./helpers');

test('kirjautumaton käyttäjä ohjataan kirjautumissivulle', async ({ page }) => {
  await page.goto('/#/kirjaukset');
  await expect(page).toHaveURL(/#\/kirjaudu$/);
  await expect(page.getByRole('heading', { name: 'Kirjaudu sisään' })).toBeVisible();
});

test('väärä salasana näyttää virheen eikä päästä sisään', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Sähköposti').fill(USERS.admin.email);
  await page.getByLabel('Salasana').fill('väärä-salasana');
  await page.getByRole('button', { name: 'Kirjaudu' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Salasana')).toHaveValue('');
  await expect(page).toHaveURL(/#\/kirjaudu$/);
});

test('oikeilla tunnuksilla pääsee kirjauslomakkeelle', async ({ page }) => {
  await login(page);
  await expect(page).toHaveURL(/#\/kirjaa$/);
  await expect(page.getByRole('button', { name: 'Tallenna kirjaus' })).toBeDisabled();
});
