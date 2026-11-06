# Kohtaamisten raportointi 2027 – raportointilomake (prototyyppi)

A-klinikkasäätiön hankkeiden yhteinen, itsenäinen kirjauslomake, jossa on käyttäjäkirjautuminen ja neljä roolia. Sisältö pohjautuu Microsoft Forms -testiversioon (tila 29.10.2026) sekä määrittelydokumenttiin *Kohtaamisten raportointi 2027*.

## Käynnistys

```bash
npm install
ADMIN_EMAIL=oma@osoite.fi SESSION_SECRET=pitka-satunnainen-merkkijono npm start
# → http://localhost:3000
```

Ensimmäisellä käynnistyksellä luodaan admin-käyttäjä. Väliaikainen salasana tulostuu konsoliin (tai sen voi antaa `ADMIN_PASSWORD`-muuttujalla), ja se vaihdetaan ensimmäisellä kirjautumisella. Muut asetukset löytyvät tiedostosta `.env.example`. Docker: `docker build -t kohtaamiset . && docker run -p 3000:3000 -v kohtaamiset:/data -e SESSION_SECRET=… kohtaamiset`.

Testit: `npm test` (19 testiä: roolit, validointi, tunnistetietojen esto, Excel-vienti ja kysymysten versiointi).

## Ulkoasu

Ulkoasu noudattaa A-klinikkasäätiön graafista ohjeistoa (15.12.2023):
- **Värit:** päävärit sininen `#0037D3`, musta ja valkoinen. Kaavioissa käytetään brändin sinistä, vaaleansinistä (`#00A0F4`) ja vihreää (`#008900`). Yhdistelmä on tarkistettu värisokeille erottuvaksi.
- **Fontti:** Work Sans (otsikot Semibold, leipäteksti Regular). Fontti on isännöity sovelluksen omalla palvelimella (`public/fonts`, OFL-lisenssi), joten Googlen palvelimiin ei oteta yhteyttä.
- **Tunnus:** `public/brand/tunnus.svg` on piirretty ohjeiston mittasuhteista. Ohjeiston mukaan logoissa käytetään alkuperäistiedostoja, joten korvaa tiedosto viestinnän virallisella SVG:llä. Sovellus käyttää sen sellaisenaan (elementin id `tunnus`).
- **Navigaatio:** työpöydällä sivupalkki, jossa kohdat on ryhmitelty (Kirjaukset, Seuranta, Ylläpito). Mobiilissa yläpalkki ja avattava valikko.

## Kirjautuminen

| Kuka | Kirjautumistapa |
|---|---|
| A-klinikkasäätiön työntekijät (admin, tiiminvetäjä, hanketyöntekijä) | **Microsoft-tunnus (Entra ID)**. Kaksivaiheinen tunnistautuminen hoidetaan Microsoftin puolella. |
| Tuntityöntekijät ja muut ilman säätiön tunnusta | **Sähköposti + salasana + todennussovellus** (TOTP, esim. Microsoft Authenticator) |

Kirjautumistapa valitaan käyttäjäkohtaisesti kohdassa Hallinta → Käyttäjät. Uuden käyttäjän oletustapa määräytyy roolin mukaan.

**Todennussovellus:** salasanatunnus ottaa sovelluksen käyttöön ensimmäisellä kirjautumisella lukemalla QR-koodin. Sen jälkeen jokaisella kirjautumisella kysytään 6-numeroinen koodi. Samaa koodia ei voi käyttää kahdesti, ja viisi väärää koodia katkaisee kirjautumisyrityksen. Salaisuus tallennetaan kantaan salattuna (AES-256-GCM, avain johdetaan `PSEUDONYM_KEY`:stä tai erillisestä `MFA_KEY`:stä). Jos puhelin katoaa, admin valitsee **Nollaa todennussovellus**. `MFA_REQUIRED=false` kytkee pakotuksen pois, mutta vain kehityskäytössä.

**Puhelimella:** käyttöönotossa näytetään QR-koodin sijaan painike *Lisää todennussovellukseen*, joka avaa todennussovelluksen suoraan, sekä *Kopioi avain* käsin syöttämistä varten. QR-koodi on piilotettuna toista laitetta varten. Koodikenttä lähettää koodin automaattisesti, kun siinä on kuusi numeroa, ja *Liitä koodi* hakee koodin leikepöydältä. Kirjautuminen odottaa koodia 10 minuuttia, joten sovellusten välillä ehtii vaihtaa.

**Muista tämä laite:** koodin syötön yhteydessä voi valita, ettei koodia kysytä samalla laitteella uudelleen `TRUSTED_DEVICE_DAYS` päivään (oletus 30, `0` = pois käytöstä). Puhelimella valinta on oletuksena päällä ja tietokoneella pois. Salasana kysytään aina. Muistaminen perustuu allekirjoitettuun evästeeseen, ja se mitätöityy, kun salasana vaihtuu, todennussovellus nollataan tai `SESSION_SECRET` vaihdetaan. Muistetut kirjautumiset näkyvät tapahtumalokissa.

**Microsoft Entra ID:** Microsoft-kirjautuminen otetaan käyttöön asettamalla `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` ja `APP_URL`. Paluuosoite on `APP_URL/auth/callback`. Kirjautumissivulle tulee silloin painike *Kirjaudu Microsoft-tunnuksella*.

- Sovellusrekisteröinnissä määritellään sovellusroolit, joiden arvot ovat roolien tunnisteet: `admin`, `tiimivetaja`, `hanketyontekija`, `tuntityontekija` ja itse luotujen roolien tunnisteet (näkyvät kohdassa Hallinta → Roolit). Jos käyttäjällä on Entrassa useita rooleja, valitaan roolilistassa ensimmäisenä oleva. Kun Entrassa on annettu rooli, se ohittaa sovelluksen roolin ja päivittyy jokaisella kirjautumisella. Käyttäjä, jolla on rooli, luodaan automaattisesti ensimmäisellä kirjautumisella.
- Ilman Entra-roolia käyttäjä pääsee sisään vain, jos admin on luonut hänelle etukäteen Microsoft-tunnuksen samalla sähköpostiosoitteella. Silloin rooli tulee sovelluksesta.
- Hankkeisiin liittäminen tehdään aina sovelluksessa.
- Toisen organisaation tunnuksilla ei pääse sisään. Sähköpostiosoite, jolle on sovelluksessa salasanatunnus, ei yhdisty Microsoft-kirjautumiseen ilman adminin päätöstä.
- Kirjautuminen käyttää valtuutuskoodia PKCE-suojauksella, ja state, nonce ja PKCE-tunniste ovat lyhytikäisessä allekirjoitetussa evästeessä.

## Roolit

Roolit ja niiden oikeudet ovat ylläpidettäviä kohdassa **Hallinta → Roolit** (vaatii käyttäjienhallintaoikeuden). Admin voi luoda uusia rooleja ja määrittää jokaiselle oikeudelle laajuuden: *Ei*, *Omat*, *Omat hankkeet* tai *Kaikki*. Esimerkiksi rooli, jolla on pelkkä lukuoikeus tilastoihin ja työntekijäseurantaan, luodaan asettamalla Tilastot ja Työntekijäseuranta arvoon *Kaikki* ja jättämällä muut oikeudet pois. Käyttäjä ilman kirjausoikeutta ohjataan kirjautuessaan suoraan ensimmäiseen näkymään, johon hänellä on oikeus.

- **A-klinikkasäätiön työntekijä** -valinta: säätiöläiset näkyvät työntekijäseurannassa kaikille nimeltä ja kaikkien hankkeiden luvuin.
- **Kirjaajan rooli** määrää, mikä *Olen*-tieto kirjauksiin tallentuu. Muutos koskee uusia kirjauksia, ja jo tallennetut kirjaukset säilyvät ennallaan.
- Korjaus- ja poisto-oikeus voi olla enintään yhtä laaja kuin selausoikeus.
- Admin-rooli pitää aina kaikki oikeudet, eikä sitä voi muuttaa. Valmiita rooleja ei voi poistaa, mutta niitä voi muokata. Roolin voi poistaa käytöstä tai poistaa vasta, kun kenelläkään ei ole sitä.
- Muutokset tulevat voimaan heti, ja ne kirjataan tapahtumalokiin.

Valmiiden roolien oletusoikeudet:

| | Admin | Tiiminvetäjä | Hanketyöntekijä | Tuntityöntekijä (avustaja) |
|---|---|---|---|---|
| Kuka | säätiön työntekijä | säätiön työntekijä | säätiön työntekijä | tuntityöntekijä / avustaja |
| Kirjaa kohtaamisia | kaikki hankkeet | omat hankkeet | omat hankkeet | omat hankkeet |
| Selaa kirjauksia | kaikki | omien hankkeiden kaikki | vain omat (myös hänen puolestaan kirjatut) | – |
| Korjaa kirjauksia | kaikki | omat hankkeet | vain omat | – |
| Poistaa kirjauksia | kaikki | omat hankkeet | – | – |
| Excel-vienti | kaikki hankkeet | omat hankkeet | – | – |
| Työntekijäseuranta | kaikki | säätiöläiset (kaikki hankkeet) + omien hankkeiden tuntityöntekijät | säätiöläiset (kaikki hankkeet); tuntityöntekijöistä vain yhteismäärät | – |
| Tilastot (dashboard) | kaikki hankkeet | kaikki hankkeet | kaikki hankkeet | – |
| Asiakaspolut (koosteet, hankekohtaiset; oletuksena piilotettu) | kaikki | omien hankkeiden kirjaukset | – | – |
| Asiakastunnisteen haku kirjatessa | ✓ | ✓ | ✓ | ✓ |
| Käyttäjät, hankkeet, kysymykset, loki | ✓ | – | – | – |

Oikeuksien kuvaukset ja sallitut arvot ovat tiedostossa `src/permissions.js`, ja valmiiden roolien oletukset ovat tiedostossa `src/db.js`. Roolit tallennetaan tietokannan `roles`-tauluun.

Kirjauslistassa ja kirjauksen tiedoissa ei näy nimimerkkejä: niitä ei tallenneta selväkielisinä lainkaan (ks. Asiakastunnisteet), joten niitä ei voi näyttää kenellekään.

## Lomake

- **Perustiedot**: ajankohta, hanke (näkyy vain käyttäjän omat hankkeet) sekä valinta yksi kohtaaminen / ryhmä. **Kohtaamisen toteutti**: oletuksena kirjaaja itse. Kohtaamisen voi kirjata toisen puolesta valitsemalla listalta hankkeen toisen käyttäjän tai *Vapaaehtoinen tai vertainen*. Kirjaajaksi tallentuu edelleen kirjauksen tekijä, ja työntekijäseuranta laskee kohtaamisen toteuttajalle. *Olen*-tietoa (rooli) ei kysytä, vaan se määräytyy toteuttajasta: admin, tiiminvetäjä ja hanketyöntekijä ovat A-klinikkasäätiön työntekijöitä (”A-klinikkasäätiön asiantuntija tai ohjaaja”), tuntityöntekijä on avustaja (”Tuntityöntekijä tai ulkopuolinen asiantuntija, ohjaaja, avustaja…”) ja vapaaehtoinen on ”Vertainen, kokemusasiantuntija tai vapaaehtoinen”. Rooli tallentuu kirjaukseen, eikä se muutu korjauksessa, ellei toteuttajaa vaihdeta.
- **Yksi kohtaaminen**: kohtaamisten määrä on 1, ja lisäksi voi antaa valinnaisen nimimerkin. **Ryhmä**: kohtaamisten määrä (1–9999, pakollinen) ja eri osallistujien määrä (valinnainen).
- **Yhteiset kysymykset** ja **hankekohtaiset kysymykset** näytetään valitun hankkeen ja kirjaustyypin mukaan (”Näytetään: kaikki / vain yksilö / vain ryhmä”). Esimerkiksi ikä, sukupuoli ja asiakkaalta kysytty arvio näytetään vain yksilökohtaamisissa.
- **Hankkeiden teemavärit**: hankevalinnan korteissa ja kirjauslistassa on hankkeen värinen raita tai pallo, jotta oman hankkeen löytää nopeasti. Digipalveluiden värit ovat niiden verkkosivujen pääväreistä: Päihdelinkki `#008900` ja Nuortenlinkki `#00a0f4` (Ak21-hankkeessa molemmat), Dopinglinkki `#ffe000` ja Lasinen lapsuus `#a437b8`. Jalmalla, Katuklinikalla, Osiksella ja Völjyllä ei ole omaa väriä, joten niille on valittu säätiön paletista sininen, kirkkaanvihreä, harmaa ja musta. Värit vaihdetaan kohdassa Hallinta → Hankkeet. Väri on vain apukeino, ja hankkeen nimi näkyy aina.
- **Täydennysehdotukset**: kaupunki- ja kadunnimikentässä näytetään ehdotuksia, kun on kirjoitettu vähintään 2 merkkiä. Kaupungille ehdotetaan Suomen kuntia ja aiemmin kirjattuja arvoja, kadunnimelle aiemmin kirjattuja katuja valitussa kaupungissa. Ehdotukset tulevat vain käyttäjän omien hankkeiden kirjauksista. Arvo ehdotetaan vain, jos sitä on käytetty vähintään kahdessa kirjauksessa tai käyttäjä on kirjannut sen itse, joten yksittäinen virheellinen teksti ei näy muille. Kun kaupungiksi on valittu Suomen kunta, kadunnimelle ehdotetaan lisäksi kunnan katuja sovelluksen omasta aineistosta (`src/kadunnimet.json.gz`, noin 300 000 suomen- ja ruotsinkielistä nimeä 308 kunnasta). Mitään ei lähetetä ulkopuolisiin palveluihin. Lähde: Digi- ja väestötietovirasto, rakennusten osoitetiedot, poiminta 3.2.2025 (avoin data, CC BY 4.0, funet-peili). Lähdemerkintä näkyy ehdotuslistassa. Haun saa pois päältä asetuksella `STREET_SOURCE=off`. Ehdotukset voi kytkeä mihin tahansa lyhyeen tekstikysymykseen kohdassa Hallinta → Kysymykset → *Täydennysehdotukset*.
- Vapaatekstikentissä muistutetaan tunnistetiedoista. Henkilötunnukselta, sähköpostiosoitteelta tai puhelinnumerolta näyttävä teksti estetään sekä selaimessa että palvelimella.
- ”Kirjaa seuraava” säilyttää hankkeen, päivän, toteuttajan ja tyypin. Tämä nopeuttaa sarjakirjaamista esimerkiksi katutyössä. Lomake toimii myös puhelimella.

## Sijainti ja digialustat

Kohtaamisen sijainti valitaan jokaisessa kirjauksessa, koska myös digihankkeilla on livekohtaamisia ja päinvastoin. Kun sijainniksi valitaan **Digialustalla**, kaupunkia ja kadunnimeä ei kysytä eikä tallenneta. Asetuksen voi tehdä mille tahansa kysymykselle kohdassa Hallinta → Kysymykset → **Digialustalla tapahtuneet kohtaamiset**: *Näytetään aina* tai *Piilotetaan, kun sijainti on ”Digialustalla”*.

## Kirjaustyypit (admin)

Lomakkeen kohdan *Valitse, mitä raportoit* vaihtoehdot ovat ylläpidettäviä (Hallinta → Kirjaustyypit). Valmiina on kolme tyyppiä: *Yksi kohtaaminen*, *Ryhmä tai useita kohtaamisia* ja *Tavoittaminen* (koulutus, luento, webinaari tai muu yleisötilaisuus). Tyypille valitaan toimintatapa:

| Toimintatapa | Lomakkeella | Tilastoissa |
|---|---|---|
| Yksi kohtaaminen | määrä 1, asiakastunniste | kohtaamiset |
| Ryhmä | kohtaamisten ja osallistujien määrä | kohtaamiset |
| Tavoittaminen | tavoitettujen määrä | **erikseen** (tavoitetut eivät ole kohtaamisia) |

Tyyppejä ei poisteta vaan ne otetaan pois käytöstä, jolloin vanhat kirjaukset säilyvät. Toimintatapaa ei voi muuttaa jälkikäteen.

**Kysymysten näkyvyys:** kysymys voidaan rajata koskemaan vain tiettyjä kirjaustyyppejä ja näyttää ehdollisesti. Ehto voi olla *toisen kysymyksen vastaus* (esim. Völjyn asumiskysymykset vain, kun asumiseen liittyvää tukea annettiin, tai Osiksen lisäkysymykset toimintamuodon mukaan) tai *kohtaamisen toteuttajan rooli* (esim. Päihdelinkin arviot vain ammattilaisten kirjauksissa). Piilotettua kysymystä ei vaadita eikä tallenneta. Lukukysymyksille voi asettaa pienimmän sallitun arvon.

**Vuoden 2027 kysymykset** ovat määrittelytaulukon mukaiset: Tavoittamisen muoto, uusi yhteinen kysymys *Mitä myönteisiä seurauksia kohtaamisella arvioit olevan asiakkaalle?* ja hankekohtaiset kysymykset. Ak21:n aiempi toimintamuotokysymys on otettu pois käytöstä, mutta sen vastaukset säilyvät. Osikselle lisättiin kysymys *Mitä Osiksen toimintamuotoa kirjaus koskee?*, koska taulukon lisäkysymykset riippuvat toimintamuodosta.

## Kysymysten ylläpito (admin)

Kysymyksiä voi lisätä, muokata, järjestää ja ottaa pois käytöstä. Kysymyksiä **ei poisteta**, ja jokaisella kysymyksellä on pysyvä tunniste (`key`). Näin aiempien vuosien raportointi säilyy, vaikka lomake muuttuisi. Kysymyksen tyyppiä ei voi muuttaa sen jälkeen, kun kysymykseen on vastattu. Tyypit ovat lyhyt teksti, pitkä teksti, luku, valinta (yksi tai useita), arvio 1–5 ja päivämäärä.

## Virheloki ja ongelmailmoitukset

**Hallinta → Virheloki** kokoaa testauksen ja ylläpidon tueksi:

- palvelinvirheet pinojälkineen; käyttäjä näkee virhekoodin, jonka voi ilmoittaa
- hylätyt tallennukset ja oikeusvirheet (esim. tarkistuksen virheilmoitus)
- selaimen JavaScript-virheet sekä yhteyskatkot (esim. Safarin ”Load failed”), jotka lähetetään, kun yhteys palaa
- käyttäjien ilmoitukset valikon kohdasta **Ilmoita ongelmasta**.

Riveihin tallentuu aika, näkymä, rooli, laite ja selain sekä sovelluksen versio. Lomakkeiden sisältöä ei tallenneta, ja henkilötunnukselta, sähköpostilta ja puhelinnumerolta näyttävät merkkijonot poistetaan. **Kopioi lista** kopioi rivit tekstinä, ja **Lataa CSV** lataa ne Exceliin. Rivit poistuvat `ERROR_LOG_RETENTION_DAYS` päivän jälkeen (oletus 90).

## Tilastot (dashboard)

Määrittelydokumentin dashboard-mallin mukainen näkymä (valikossa **Tilastot**). Säätiön työntekijät (admin, tiiminvetäjä ja hanketyöntekijä) näkevät kaikkien hankkeiden tilastot. Tilastot ovat koosteita, joten yksittäisiä kirjauksia ei näe; Excel-raakadata noudattaa edelleen vientioikeutta (tiiminvetäjä: omat hankkeet).

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
- **Uusin kirjaus tallennettu** kertoo rajauksiin osuvan uusimman kirjauksen tallennus- tai korjausajan. Tilastot lasketaan aina suoraan tietokannasta, joten ne ovat ajan tasalla.


**Paikkakunnat ja kadut:** kortit *Kohtaamiset paikkakunnittain* ja *Kohtaamiset kaduittain* näyttävät kirjauksiin merkityt kaupungit ja kadut. Kirjoitusasut yhdistetään kirjainkoosta ja välilyönneistä riippumatta. Paikkakuntaa napauttamalla, tai rajausten valinnalla *Paikkakunta*, koko näkymä rajautuu siihen, ja katukortti näyttää kyseisen paikkakunnan kadut. Kohtaamiset, joilla ei ole paikkakuntaa (esim. digialustalla), näytetään omana lukunaan. Kaikki kadut ovat myös Excel-viennissä.

**Vertailuluvut** näytetään vain pyydettäessä (rajausten kohta *Vertailu*):
- *Edellinen jakso*: yhtä pitkä jakso juuri ennen valittua aikaväliä.
- *Vuotta aiemmin*: sama aikaväli edellisenä vuonna.

Vertailu näyttää muutosprosentin ja vertailujakson luvun kohtaamisten kokonaismäärässä ja eri henkilöiden arviossa. Kuukausikaaviossa vertailujakson kokonaismäärä näkyy harmaana katkoviivana, ja se on mukana myös taulukkonäkymässä.

## Työntekijäseuranta (admin, tiiminvetäjä ja hanketyöntekijä)

**Työntekijät**-sivulla näkyy jokaisen kirjaajan yhteenveto valitulta aikaväliltä ja hankkeesta: kohtaamiset, kirjaukset, yksilö- ja ryhmäkirjaukset, aktiivipäivät, kohtaamiset aktiivipäivää kohden sekä työntekijän ja asiakkaan arvioiden keskiarvot. Sarakkeen otsikkoa klikkaamalla taulukko järjestyy kyseisen sarakkeen mukaan. Listalla näkyvät myös työntekijät, jotka eivät ole vielä kirjanneet mitään.

Työntekijän omalla sivulla ovat tunnusluvut (mm. eri nimimerkit ja keskimääräinen kirjausviive), kuukausikaavio sekä jakaumat hankkeittain, sijainneittain ja oman arvion mukaan. **Näytä kirjaukset** avaa kirjauslistan valmiiksi rajattuna tähän työntekijään. Kirjauslistalla voi myös itse rajata kirjaajan mukaan.

Näkyvyys roolin mukaan:

- **Säätiön työntekijät** (tiiminvetäjät, hanketyöntekijät ja kirjauksia tehneet adminit) näkyvät kaikille seurannan käyttäjille nimeltä, ja heidän lukunsa lasketaan kaikista hankkeista.
- **Tuntityöntekijät**: admin näkee kaikki, tiiminvetäjä omien hankkeidensa tuntityöntekijät eriteltyinä ja hanketyöntekijä omien hankkeidensa tuntityöntekijöistä vain yhteismäärät ilman nimiä.
- Muille kuin adminille ei näytetä toisten sähköpostiosoitetta eikä viimeisintä kirjautumisaikaa.
- **Näytä kirjaukset** noudattaa kirjausten selausoikeutta: tiiminvetäjä näkee listassa vain omien hankkeidensa kirjaukset ja hanketyöntekijä vain omansa, joten hanketyöntekijällä painike on vain omalla sivullaan.

## Asiakastunnisteet ja palveluohjaukset

**Tarkoitus:** seurata hankkeen sisällä, palaako asiakas ja ohjautuuko hän palveluihin.

**Tunnisteet ovat hankekohtaisia.** Jokaisella hankkeella on omat nimimerkkinsä. Sama nimimerkki voi olla eri hankkeissa eri asiakkaalla, eikä hankkeiden välillä ole asiakaslinkitystä. Hanke on mukana tiivisteen laskennassa, joten saman nimimerkin tiivisteet eri hankkeissa eivät täsmää edes tietokannassa.

**Kirjaaminen** (yksilökohtaaminen, hanke valittuna):
- **Ei tunnistetta / Palaava asiakas / Uusi asiakas.** Uudelle asiakkaalle keksitään nimimerkki tai luodaan satunnainen kaksisanainen nimimerkki (esim. *Sininen Kettu*; jos hankkeessa on jo paljon asiakkaita, loppuun lisätään numero, esim. *Sininen Kettu 12*). Tunniste on yksilöllinen hankkeen sisällä, ja kirjainkoko, välilyönnit, väliviivat ja ääkköset (ä = a) eivät vaikuta tunnistamiseen.
- **Palaavan asiakkaan haku** näyttää vain kohtaamisten määrän tässä hankkeessa, ensimmäisen kohtaamisen kuukauden ja hankkeen avoimet ohjaukset. Avoimet ohjaukset voi kuitata: *toteutui* tai *ei toteutunut*.
- **Ohjattiinko asiakas palveluun?** Palvelulistaa ylläpidetään kohdassa Hallinta → Ohjauspalvelut. Ilman tunnistetta ohjauksen tila on *ei seurattavissa*.

**Asiakaspolut-sivu** (admin ja tiiminvetäjä; oletuksena piilotettu – admin aktivoi kohdassa Hallinta → Toiminnot, jolloin näkymä ja valikkolinkki tulevat näkyviin): tunnistetut, uudet ja palaavat asiakkaat, tunnisteen käyttöaste, ohjaukset palveluittain, toteutumisaste, mediaaniaika toteutumiseen ja kohtaamiset asiakasta kohden. Kaikki luvut ovat koosteita, eikä hankkeiden välisiä lukuja ole.

**Suojaus:**
- Kantaan tallennetaan vain `HMAC-SHA256(PSEUDONYM_KEY, hanke + vakioitu tunniste)`. Avain on vain palvelimen ympäristömuuttujassa.
- Tunniste ei näy kirjauksissa, raporteissa, tapahtumalokissa eikä Excel-viennissä.
- Tunnistehakuja rajoitetaan käyttäjäkohtaisesti (`CLIENT_LOOKUP_LIMIT`), ja haku on mahdollinen vain omiin hankkeisiin.
- Säilytysaika: linkitys katkaistaan, jos asiakasta ei ole kohdattu `CLIENT_RETENTION_MONTHS` kuukauteen (oletus 24).
- **Siirto aiemmasta versiosta:** aiemmin säätiötasoiset asiakkaat jaetaan julkaisussa automaattisesti hankekohtaisiksi. Asiakas, joka oli kohdattu kahdessa hankkeessa, muuttuu kahdeksi erilliseksi asiakkaaksi. Vanhat tiivisteet päivittyvät hankekohtaisiksi sitä mukaa, kun niitä haetaan.

**Käyttöönotto Renderissä:** `PSEUDONYM_KEY` ympäristömuuttujaksi. Älä vaihda avainta käytön aikana.

**Ennen tuotantokäyttöä:** käy käsittely läpi tietosuojavastaavan kanssa (vaikutustenarviointi, käsittelyperuste, säilytysaika).

## Testidata (admin)

Hallinta → **Testidata** luo halutun määrän (oletuksena 40) vaihtelevia testikirjauksia. Kirjaukset jaetaan viidelle testityöntekijälle (suljettuja tunnuksia, joilla ei voi kirjautua), jotta työntekijäseurantaa voi testata. Kirjauksia tulee kaikkiin käytössä oleviin hankkeisiin kuluvan vuoden ajalle, ja mukana on yksilö- ja ryhmäkohtaamisia, toistuvia nimimerkkejä, eri kirjaajarooleja, kaupunkeja, arvioita ja vapaatekstejä. Ne tallennetaan samalla tarkistuksella kuin lomakkeelta tulevat kirjaukset. Testikirjaukset on merkitty (`is_test`): listassa ne näkyvät merkinnällä ”testi” ja Excelissä sarakkeessa ”Testidata”. **Poista kaikki testidata** -painike poistaa vain testikirjaukset ja testityöntekijät. Tee poisto ennen varsinaista käyttöönottoa.

## Excel-vienti

Viennissä valitaan aikaväli ja hankkeet (yksi, useita tai kaikki). Jokainen tallennus on oma rivinsä ja jokainen kysymys oma sarakkeensa. Ryhmä säilyy yhtenä rivinä, jolla näkyvät kohtaamisten ja osallistujien määrät. Mukana ovat myös tunniste, ajankohta, hanke sekä tallennus- ja muokkausaika. Mukana ovat toteuttajan rooli ja tieto siitä, onko kirjaus tehty toisen puolesta. Palveluohjaukset ovat mukana vain, kun Asiakaspolut-toiminto on käytössä. **Nimimerkkejä eikä kirjaajan tai toteuttajan nimeä viedä.** Vienti on käytössä adminilla ja tiiminvetäjillä. Toisella välilehdellä ovat sarakkeiden pysyvät tunnisteet.

## Tietomalli (Sammio-siirtoa varten)

`users`, `projects`, `user_projects`, `questions`, `encounters` (yksi rivi = yksi tallennus), `encounter_answers` (vastaukset rivimuodossa: encounter_id, question_id, value) ja `audit_log`. Uudet kysymykset eivät vaadi skeemamuutoksia. Power BI voi lukea `encounters`- ja `encounter_answers`-tauluja suoraan tai niistä tehtyä pivot-näkymää. Poistot ovat pehmeitä (`deleted_at`).

## Testit

**Rajapintatestit** (`test/`, Noden oma testityökalu `node --test`) tarkistavat roolit, oikeudet, validoinnin ja kirjautumisen suoraan API:a vasten:

```bash
npm test
```

**Selaintestit eli E2E-testit** (`e2e/`, [Playwright](https://playwright.dev)) käyttävät sovellusta oikeassa selaimessa kuten käyttäjä: kirjautuminen, kirjauksen tallennus, pakolliset kentät ja henkilötunnuksen esto. Jokainen testi ajetaan sekä työpöytä- että mobiilikoossa.

```bash
npx playwright install chromium   # kerran: lataa testiselaimen
npm run test:e2e                  # aja testit
npm run test:e2e:ui               # avaa Playwrightin käyttöliittymä (testien seuraaminen ja vianetsintä)
npx playwright show-report        # näytä edellisen ajon raportti
```

Playwright käynnistää sovelluksen itse (`e2e/server.js`) porttiin 3100 omalla väliaikaisella tietokannalla, joten testit eivät koske kehitys- tai tuotantodataan. Testikäyttäjät ovat tiedostossa `e2e/users.js`.

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
