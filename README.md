# Kohtaamisten raportointi 2027 – raportointilomake (prototyyppi)

A-klinikkasäätiön hankkeiden yhteinen, itsenäinen kirjauslomake, jossa on käyttäjäkirjautuminen ja neljä roolia. Sisältö pohjautuu Microsoft Forms -testiversioon (tila 29.10.2026) sekä määrittelydokumenttiin *Kohtaamisten raportointi 2027*.

## Käynnistys

```bash
npm install
ADMIN_EMAIL=oma@osoite.fi SESSION_SECRET=pitka-satunnainen-merkkijono npm start
# → http://localhost:3000
```

Ensimmäisellä käynnistyksellä luodaan admin-käyttäjä. Väliaikainen salasana tulostuu konsoliin (tai sen voi antaa `ADMIN_PASSWORD`-muuttujalla), ja se vaihdetaan ensimmäisellä kirjautumisella. Muut asetukset löytyvät tiedostosta `.env.example`. Docker: `docker build -t kohtaamiset . && docker run -p 3000:3000 -v kohtaamiset:/data -e SESSION_SECRET=… kohtaamiset`.

Testit: `npm test` (18 testiä: roolit, validointi, tunnistetietojen esto, Excel-vienti ja kysymysten versiointi).

## Roolit

| | Admin | Tiimivetäjä | Hanketyöntekijä | Tuntityöntekijä (avustaja) |
|---|---|---|---|---|
| Kuka | säätiön työntekijä | säätiön työntekijä | säätiön työntekijä | tuntityöntekijä / avustaja |
| Kirjaa kohtaamisia | kaikki hankkeet | omat hankkeet | omat hankkeet | omat hankkeet |
| Selaa kirjauksia | kaikki | omien hankkeiden kaikki | vain omat | – |
| Korjaa / poistaa kirjauksia | kaikki | omat hankkeet | – | – |
| Excel-vienti | kaikki hankkeet | omat hankkeet | – | – |
| Työntekijäseuranta | kaikki | omien hankkeiden kirjaukset | – | – |
| Tilastot (dashboard) | kaikki | omat hankkeet | omat hankkeet | – |
| Asiakaspolut (koosteet) | kaikki | omien hankkeiden kirjaukset | – | – |
| Asiakastunnisteen haku kirjatessa | ✓ | ✓ | ✓ | ✓ |
| Käyttäjät, hankkeet, kysymykset, loki | ✓ | – | – | – |

Oikeudet on koottu yhteen tiedostoon, `src/permissions.js`. Jos esimerkiksi hanketyöntekijän halutaan voivan korjata omia kirjauksiaan, muutetaan sinne `editScope: 'own'`.

## Lomake

- **Perustiedot**: ajankohta, hanke (näkyy vain käyttäjän omat hankkeet) sekä valinta yksi kohtaaminen / ryhmä. *Olen*-tietoa (kirjaajan rooli) ei kysytä lomakkeella, vaan se määräytyy käyttäjän roolista: admin, tiimivetäjä ja hanketyöntekijä ovat A-klinikkasäätiön työntekijöitä (”A-klinikkasäätiön asiantuntija tai ohjaaja”), ja tuntityöntekijä on avustaja (”Tuntityöntekijä tai ulkopuolinen asiantuntija, ohjaaja, avustaja…”). Rooli tallentuu kirjaukseen, eikä se muutu, vaikka kirjausta korjataan.
- **Yksi kohtaaminen**: kohtaamisten määrä on 1, ja lisäksi voi antaa valinnaisen nimimerkin. **Ryhmä**: kohtaamisten määrä (1–9999, pakollinen) ja eri osallistujien määrä (valinnainen).
- **Yhteiset kysymykset** ja **hankekohtaiset kysymykset** näytetään valitun hankkeen ja kirjaustyypin mukaan (”Näytetään: kaikki / vain yksilö / vain ryhmä”).
- Vapaatekstikentissä muistutetaan tunnistetiedoista. Henkilötunnukselta, sähköpostiosoitteelta tai puhelinnumerolta näyttävä teksti estetään sekä selaimessa että palvelimella.
- ”Kirjaa seuraava” säilyttää hankkeen, päivän, roolin ja tyypin. Tämä nopeuttaa sarjakirjaamista esimerkiksi katutyössä. Lomake toimii myös puhelimella.

## Digipalvelut

Hankkeelle voi asettaa kohdassa Hallinta → Hankkeet asetuksen **Digipalvelu**. Asetus on oletuksena päällä hankkeilla Ak21 (Päihdelinkki ja Nuortenlinkki), Dopinglinkki ja Lasinen lapsuus. Digipalvelun kirjauksissa sijainniksi tallentuu automaattisesti ”Digialustalla”, eikä kaupunkia ja kadunnimeä kysytä. Käytöksen voi säätää kysymyskohtaisesti kohdassa Hallinta → Kysymykset → **Digipalvelun hankkeissa**: *Näytetään*, *Piilotetaan* tai *Täytetään automaattisesti*. Automaattisen arvon asettaa palvelin, joten lomakkeelta lähetetty arvo ei voi ohittaa sitä.

## Kysymysten ylläpito (admin)

Kysymyksiä voi lisätä, muokata, järjestää ja ottaa pois käytöstä. Kysymyksiä **ei poisteta**, ja jokaisella kysymyksellä on pysyvä tunniste (`key`). Näin aiempien vuosien raportointi säilyy, vaikka lomake muuttuisi. Kysymyksen tyyppiä ei voi muuttaa sen jälkeen, kun kysymykseen on vastattu. Tyypit ovat lyhyt teksti, pitkä teksti, luku, valinta (yksi tai useita), arvio 1–5 ja päivämäärä.

## Tilastot (dashboard)

Määrittelydokumentin dashboard-mallin mukainen näkymä (valikossa **Tilastot**). Admin näkee kaikki hankkeet, tiimivetäjä ja hanketyöntekijä omat hankkeensa.

- **Rajaukset:** aikaväli (pikavalinnat: tämä vuosi, edellinen vuosi, 30 pv, tämä kk), hanke, kohtaamisen tyyppi, kirjaajan rooli, ikä ja sukupuoli. Rajaukset koskevat kaikkia näkymän lukuja. **Lataa raakadata (Excel)** käyttää aikaväliä ja hanketta.
- **Kohtaamiset yhteensä** ja **eri henkilöiden määrä (arvio)** näytetään erillisinä tunnuslukuina, ja kumpaankin lasketaan muutos edelliseen yhtä pitkään jaksoon.
- **Eri henkilöiden arvio** = tunnistetut asiakkaat + ryhmien ilmoitetut osallistujat. Ilman tunnistetta kirjatut yksilökohtaamiset näytetään erikseen, koska samaa henkilöä ei niistä voi tunnistaa. Laskentasääntö kerrotaan (i)-painikkeen takana.
- **Kaaviot:**
  - kohtaamisen tyyppi (rengaskaavio)
  - kohtaamiset kuukausittain (yhteensä, yksilö, ryhmä; tarkastelulinja ja taulukkonäkymä)
  - kohtaamiset hankkeittain
  - työntekijän ja asiakkaan arviot
  - palveluohjausten yhteenveto
  - vastausjakaumat (yhteiset kysymykset, ja hankkeen valinnan jälkeen myös hankekohtaiset).
- Kaikki luvut ovat koosteita. Tunnisteita, nimimerkkejä ja vapaatekstejä ei näytetä.

## Työntekijäseuranta (admin ja tiimivetäjä)

**Työntekijät**-sivulla näkyy jokaisen kirjaajan yhteenveto valitulta aikaväliltä ja hankkeesta: kohtaamiset, kirjaukset, yksilö- ja ryhmäkirjaukset, aktiivipäivät, kohtaamiset aktiivipäivää kohden sekä työntekijän ja asiakkaan arvioiden keskiarvot. Sarakkeen otsikkoa klikkaamalla taulukko järjestyy kyseisen sarakkeen mukaan. Listalla näkyvät myös työntekijät, jotka eivät ole vielä kirjanneet mitään.

Työntekijän omalla sivulla ovat tunnusluvut (mm. eri nimimerkit ja keskimääräinen kirjausviive), kuukausikaavio sekä jakaumat hankkeittain, sijainneittain ja oman arvion mukaan. **Näytä kirjaukset** avaa kirjauslistan valmiiksi rajattuna tähän työntekijään. Kirjauslistalla voi myös itse rajata kirjaajan mukaan.

Tiimivetäjä näkee vain omien hankkeidensa kirjaukset, vaikka työntekijä kirjaisi myös muihin hankkeisiin.

## Asiakastunnisteet ja palveluohjaukset

**Tarkoitus:** seurata, ohjautuvatko asiakkaat palveluihin, myös silloin kun he käyttävät useampaa säätiön palvelua.

**Kirjaaminen** (yksilökohtaaminen):
- **Ei tunnistetta / Palaava asiakas / Uusi asiakas.** Uudelle asiakkaalle keksitään nimimerkki tai luodaan satunnainen tunnus (esim. `88Y-C7QR`).
- **Yksi tunniste koko säätiössä.** Sama tunniste ei voi kuulua kahdelle asiakkaalle. Kirjainkoko, välilyönnit ja väliviivat eivät vaikuta tunnistamiseen.
- **Palaavan asiakkaan haku** näyttää kirjaajalle vain aiempien kohtaamisten määrän, ensimmäisen kohtaamisen kuukauden ja avoimet ohjaukset (palvelu ja päivämäärä). Avoimet ohjaukset voi kuitata: *toteutui* tai *ei toteutunut*. Muiden hankkeiden nimiä tai kirjauksia ei näytetä.
- **Ohjattiinko asiakas palveluun?** Palvelulistaa ylläpidetään kohdassa Hallinta → Ohjauspalvelut. Ilman tunnistetta ohjauksen tila on *ei seurattavissa*.

**Asiakaspolut-sivu** (admin ja tiimivetäjä): tunnistetut, uudet, palaavat ja useamman palvelun asiakkaat, tunnisteen käyttöaste, ohjaukset palveluittain, toteutumisaste, mediaaniaika toteutumiseen, kohtaamiset asiakasta kohden sekä hankkeiden yhteiset asiakkaat. Kaikki luvut ovat koosteita. Alle kolmen asiakkaan määrät piilotetaan.

**Suojaus:**
- Tunnistetta ei tallenneta selväkielisenä. Kantaan jää vain `HMAC-SHA256(PSEUDONYM_KEY, vakioitu tunniste)`. Avain on vain palvelimen ympäristömuuttujassa, joten tietokannasta tai sen varmuuskopiosta tunnisteita ei voi palauttaa eikä arvata.
- Tunniste ei näy kirjauksissa, raporteissa, tapahtumalokissa eikä Excel-viennissä. Excelissä on vain sarakkeet ”Tunnistettu asiakas (kyllä/ei)” ja ”Ohjattu palveluun”.
- Tunnistehakuja rajoitetaan käyttäjäkohtaisesti (oletus 60 / 15 min, `CLIENT_LOOKUP_LIMIT`), ja jokainen haku kirjataan lokiin ilman tunnistetta.
- Säilytysaika: jos asiakasta ei ole kohdattu `CLIENT_RETENTION_MONTHS` kuukauteen (oletus 24), linkitys katkaistaan automaattisesti. Kirjaukset säilyvät tilastoissa, mutta niitä ei voi enää yhdistää samaan asiakkaaseen.
- Aiemmat selväkieliset nimimerkit muutetaan tiivisteiksi ja poistetaan automaattisesti ensimmäisellä käynnistyksellä.

**Käyttöönotto Renderissä:** lisää palvelun Environment-välilehdelle `PSEUDONYM_KEY`, joka on pitkä satunnainen merkkijono (esim. `openssl rand -base64 32`). Ota avaimesta kopio turvalliseen paikkaan, esimerkiksi salasanojen hallintaan. **Älä vaihda avainta käytön aikana:** vaihto katkaisee kaikki asiakaslinkitykset. Ilman avainta tunnisteominaisuus on pois päältä, ja muu sovellus toimii normaalisti.

**Ennen tuotantokäyttöä:** linkitys koskee pseudonymisoituja henkilötietoja ja todennäköisesti terveystietoja. Käy käsittely läpi tietosuojavastaavan kanssa (vaikutustenarviointi, käsittelyperuste, säilytysaika, asiakkaille kerrottavat tiedot).

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
