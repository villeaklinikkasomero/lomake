# Kohtaamisten raportointi 2027 – raportointilomake (prototyyppi)

A-klinikkasäätiön hankkeiden yhteinen, itsenäinen kirjauslomake, jossa on käyttäjäkirjautuminen ja neljä roolia. Sisältö pohjautuu Microsoft Forms -testiversioon (tila 29.10.2026) sekä määrittelydokumenttiin *Kohtaamisten raportointi 2027*.

## Käynnistys

```bash
npm install
ADMIN_EMAIL=oma@osoite.fi SESSION_SECRET=pitka-satunnainen-merkkijono npm start
# → http://localhost:3000
```

Ensimmäisellä käynnistyksellä luodaan admin-käyttäjä. Väliaikainen salasana tulostuu konsoliin (tai sen voi antaa `ADMIN_PASSWORD`-muuttujalla), ja se vaihdetaan ensimmäisellä kirjautumisella. Muut asetukset löytyvät tiedostosta `.env.example`. Docker: `docker build -t kohtaamiset . && docker run -p 3000:3000 -v kohtaamiset:/data -e SESSION_SECRET=… kohtaamiset`.

Testit: `npm test` (13 testiä: roolit, validointi, tunnistetietojen esto, Excel-vienti ja kysymysten versiointi).

## Roolit

| | Admin | Tiimivetäjä | Hanketyöntekijä | Tuntityöntekijä |
|---|---|---|---|---|
| Kirjaa kohtaamisia | kaikki hankkeet | omat hankkeet | omat hankkeet | omat hankkeet |
| Selaa kirjauksia | kaikki | omien hankkeiden kaikki | vain omat | – |
| Korjaa / poistaa kirjauksia | kaikki | omat hankkeet | – | – |
| Excel-vienti | kaikki hankkeet | omat hankkeet | – | – |
| Työntekijäseuranta | kaikki | omien hankkeiden kirjaukset | – | – |
| Käyttäjät, hankkeet, kysymykset, loki | ✓ | – | – | – |

Oikeudet on koottu yhteen tiedostoon, `src/permissions.js`. Jos esimerkiksi hanketyöntekijän halutaan voivan korjata omia kirjauksiaan, muutetaan sinne `editScope: 'own'`.

## Lomake

- **Perustiedot**: ajankohta, hanke (näkyy vain käyttäjän omat hankkeet) sekä valinta yksi kohtaaminen / ryhmä. *Olen*-tietoa (kirjaajan rooli) ei kysytä lomakkeella. Se tulee käyttäjän profiilista, ja oletusarvo määräytyy käyttöoikeusroolista. Admin voi vaihtaa sen esimerkiksi vertaiselle. Kun kirjausta korjataan, alkuperäisen kirjaajan rooli säilyy.
- **Yksi kohtaaminen**: kohtaamisten määrä on 1, ja lisäksi voi antaa valinnaisen nimimerkin. **Ryhmä**: kohtaamisten määrä (1–9999, pakollinen) ja eri osallistujien määrä (valinnainen).
- **Yhteiset kysymykset** ja **hankekohtaiset kysymykset** näytetään valitun hankkeen ja kirjaustyypin mukaan (”Näytetään: kaikki / vain yksilö / vain ryhmä”).
- Vapaatekstikentissä muistutetaan tunnistetiedoista. Henkilötunnukselta, sähköpostiosoitteelta tai puhelinnumerolta näyttävä teksti estetään sekä selaimessa että palvelimella.
- ”Kirjaa seuraava” säilyttää hankkeen, päivän, roolin ja tyypin. Tämä nopeuttaa sarjakirjaamista esimerkiksi katutyössä. Lomake toimii myös puhelimella.

## Kysymysten ylläpito (admin)

Kysymyksiä voi lisätä, muokata, järjestää ja ottaa pois käytöstä. Kysymyksiä **ei poisteta**, ja jokaisella kysymyksellä on pysyvä tunniste (`key`). Näin aiempien vuosien raportointi säilyy, vaikka lomake muuttuisi. Kysymyksen tyyppiä ei voi muuttaa sen jälkeen, kun kysymykseen on vastattu. Tyypit ovat lyhyt teksti, pitkä teksti, luku, valinta (yksi tai useita), arvio 1–5 ja päivämäärä.

## Työntekijäseuranta (admin ja tiimivetäjä)

**Työntekijät**-sivulla näkyy jokaisen kirjaajan yhteenveto valitulta aikaväliltä ja hankkeesta: kohtaamiset, kirjaukset, yksilö- ja ryhmäkirjaukset, aktiivipäivät, kohtaamiset aktiivipäivää kohden sekä työntekijän ja asiakkaan arvioiden keskiarvot. Sarakkeen otsikkoa klikkaamalla taulukko järjestyy kyseisen sarakkeen mukaan. Listalla näkyvät myös työntekijät, jotka eivät ole vielä kirjanneet mitään.

Työntekijän omalla sivulla ovat tunnusluvut (mm. eri nimimerkit ja keskimääräinen kirjausviive), kuukausikaavio sekä jakaumat hankkeittain, sijainneittain ja oman arvion mukaan. **Näytä kirjaukset** avaa kirjauslistan valmiiksi rajattuna tähän työntekijään. Kirjauslistalla voi myös itse rajata kirjaajan mukaan.

Tiimivetäjä näkee vain omien hankkeidensa kirjaukset, vaikka työntekijä kirjaisi myös muihin hankkeisiin.

## Testidata (admin)

Hallinta → **Testidata** luo halutun määrän (oletuksena 40) vaihtelevia testikirjauksia. Kirjaukset jaetaan viidelle testityöntekijälle (suljettuja tunnuksia, joilla ei voi kirjautua), jotta työntekijäseurantaa voi testata. Kirjauksia tulee kaikkiin käytössä oleviin hankkeisiin kuluvan vuoden ajalle, ja mukana on yksilö- ja ryhmäkohtaamisia, toistuvia nimimerkkejä, eri kirjaajarooleja, kaupunkeja, arvioita ja vapaatekstejä. Ne tallennetaan samalla tarkistuksella kuin lomakkeelta tulevat kirjaukset. Testikirjaukset on merkitty (`is_test`): listassa ne näkyvät merkinnällä ”testi” ja Excelissä sarakkeessa ”Testidata”. **Poista kaikki testidata** -painike poistaa vain testikirjaukset ja testityöntekijät. Tee poisto ennen varsinaista käyttöönottoa.

## Excel-vienti

Viennissä valitaan aikaväli ja hankkeet (yksi, useita tai kaikki). Jokainen tallennus on oma rivinsä ja jokainen kysymys oma sarakkeensa. Ryhmä säilyy yhtenä rivinä, jolla näkyvät kohtaamisten ja osallistujien määrät. Mukana ovat myös tunniste, ajankohta, hanke sekä tallennus- ja muokkausaika. **Nimimerkkejä ja kirjaajan nimeä ei viedä.** Toisella välilehdellä ovat sarakkeiden pysyvät tunnisteet.

## Tietomalli (Sammio-siirtoa varten)

`users`, `projects`, `user_projects`, `questions`, `encounters` (yksi rivi = yksi tallennus), `encounter_answers` (vastaukset rivimuodossa: encounter_id, question_id, value) ja `audit_log`. Uudet kysymykset eivät vaadi skeemamuutoksia. Power BI voi lukea `encounters`- ja `encounter_answers`-tauluja suoraan tai niistä tehtyä pivot-näkymää. Poistot ovat pehmeitä (`deleted_at`).

## Ennen tuotantoa

- **Kirjautuminen**: prototyypissä on sähköposti ja salasana (bcrypt, istunnot, kirjautumisyritysten rajoitus, pakotettu salasananvaihto). Tuotannossa suositus on Microsoft Entra ID -kertakirjautuminen, jolloin roolit voi ohjata Entra-ryhmillä.
- **Tietokanta**: SQLite → Sammio (SQL Server / Azure SQL). Tietokantakerros on yhdessä tiedostossa (`src/db.js`).
- Avoimet kohdat määrittelystä: eri henkilöiden laskentasääntö (nimimerkit), lopulliset hankekohtaiset kysymykset sekä keskeneräisenä tallennus.

## Julkaisu Renderiin

1. Luo GitHubiin repo (esim. `kohtaamisten-raportointi`) ja pushaa tämä kansio:
   ```bash
   git init && git add . && git commit -m "Kohtaamisten raportointilomake"
   git branch -M main
   git remote add origin git@github.com:<organisaatio>/kohtaamisten-raportointi.git
   git push -u origin main
   ```
2. Valitse Renderissä **New → Blueprint** ja sitten repo. Render lukee asetukset `render.yaml`-tiedostosta.
3. Anna `ADMIN_EMAIL` ja väliaikainen `ADMIN_PASSWORD`. `SESSION_SECRET` luodaan automaattisesti.
4. Kirjaudu palvelun osoitteessa (`https://<nimi>.onrender.com`) ja vaihda salasana. Luo sen jälkeen käyttäjät Hallinta-sivulla.

Huomioita:
- Tietokanta on pysyvällä levyllä (`/var/data`). Levy vaatii maksullisen palvelutason (starter). Ilman levyä data katoaa jokaisessa deployssa.
- Render ottaa levystä päivittäisen snapshotin. Lisäksi Excel-vienti toimii käsin otettavana varmuuskopiona.
- Jokainen push `main`-haaraan julkaisee uuden version automaattisesti. Tietokanta säilyy.
- Alue on Frankfurt (EU). Tietosuojan kannalta tarkista Renderin DPA ennen oikeaa käyttöä.
