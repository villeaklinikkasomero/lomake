// @ts-check
const { test, expect } = require('@playwright/test');
const { login, fillMinimalKatuklinikka } = require('./helpers');

test.beforeEach(async ({ page }) => { await login(page); });

test('yksilökohtaamisen kirjaus tallentuu ja näkyy kirjauksissa', async ({ page }) => {
  await fillMinimalKatuklinikka(page);
  const huomio = `E2E-huomio ${Date.now()}`;
  await page.getByRole('textbox', { name: 'Työntekijän huomiot' }).fill(huomio);
  await page.getByRole('button', { name: 'Tallenna kirjaus' }).click();

  await expect(page.getByRole('heading', { name: 'Kirjaus tallennettu' })).toBeVisible();
  await expect(page.getByText(/Katuklinikka · .* · 1 kohtaaminen/)).toBeVisible();

  await page.getByRole('link', { name: 'Näytä kirjaus' }).click();
  await expect(page.getByText(huomio)).toBeVisible();
});

test('"Kirjaa seuraava" säilyttää hankkeen ja tyypin', async ({ page }) => {
  await fillMinimalKatuklinikka(page);
  await page.getByRole('button', { name: 'Tallenna kirjaus' }).click();
  await page.getByRole('button', { name: 'Kirjaa seuraava' }).click();

  await expect(page.getByRole('radio', { name: 'Katuklinikka' })).toBeChecked();
  await expect(page.getByRole('radio', { name: /^Yksi kohtaaminen/ })).toBeChecked();
});

test('henkilötunnusta ei voi tallentaa vapaatekstikenttään', async ({ page }) => {
  await fillMinimalKatuklinikka(page);
  await page.getByRole('textbox', { name: 'Työntekijän huomiot' }).fill('Asiakkaan hetu 010190-123A');
  await page.getByRole('button', { name: 'Tallenna kirjaus' }).click();

  await expect(page.getByText(/henkilötunnu/i).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Kirjaus tallennettu' })).toHaveCount(0);
});

test('pakollisen kysymyksen puuttuminen estää tallennuksen', async ({ page }) => {
  await page.getByText('Katuklinikka', { exact: true }).click();
  await page.getByText('Yksi kohtaaminen', { exact: true }).click();
  await page.getByRole('button', { name: 'Tallenna kirjaus' }).click();

  await expect(page.getByText('Vastaa kysymykseen: Työntekijän arvio kohtaamisen hyödystä')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Kirjaus tallennettu' })).toHaveCount(0);
});
