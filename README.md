# Styreapp for skytterlag (DFS)

Nettbasert verktøy for styret i et skytterlag tilknyttet Det frivillige Skyttervesen: møter, dokumenter med tilgangsnivåer, e-post til styret, medlemmer, våpen- og ammunisjonsregister, treninger, stevner og årsdokumenter – samlet ett sted.

## Funksjoner

| Område | Innhold |
|---|---|
| **Startside** | Lagets navn og logo, månedskalender, styreoversikt med verv og kontaktinfo, hvem som er pålogget nå, mine oppgaver, kommende hendelser, varsel om forfalte oppgaver og lav ammobeholdning |
| **Kalender** | Felles kalender for styremøter, årsmøter, treninger, stevner, påmeldingsfrister og oppgavefrister, med filter |
| **Styremøter** | Egen dokumentmappe per møte, saksliste med løpende saksnummer (1/26, 2/26 …) og vedtak, deltakere (styret inviteres automatisk), oppfølgingspunkter, protokoll for utskrift/PDF, innkalling og protokoll på e-post |
| **Google Meet** | Meet-lenke per møte, knapp for nytt Meet-rom, «Legg i Google Kalender» med alle deltakerne som gjester, og `.ics`-fil med deltakere for Outlook/Apple |
| **Fellesmapper** | Større saker · Møtereferat, eksterne · Annet · Økonomi · Lover og vedtekter (admin kan lage flere) |
| **Årsmøter** | Egen mappe per årsmøte (Årsmøter / Årsmøte 2027), mappe for innkallinger, saksliste og protokoll |
| **Dokumenter** | Mappetre, versjonering, søk og tilgangsnivåene Les / Rediger / Eier (se under) |
| **E-post** | Send til valgte styremedlemmer/medlemmer med valgte dokumenter som vedlegg eller som lenker, med logg over utsendelser |
| **Styret og medlemmer** | Medlemsregister med import fra MittDFS (CSV), eksport, flere verv per medlem (styreleder, nestleder, sekretær, kasserer, ungdomsleder, våpenansvarlig, baneansvarlig m.fl.), invitasjon til innlogging |
| **Våpen og ammo** | Rifler og våpendeler med serienummer, våpenkortnummer og kopi av våpenkort; ammo-innkjøp, salg til skytter fra medlemsregisteret, beholdning, betalingsstatus og lagerjustering |
| **Utlånserklæringer** | Redigerbar mal med flettefelt, fylles ut med skytter og våpen, kan redigeres, skrives ut og sendes på e-post (arkiveres automatisk) |
| **Treninger** | Kalender, enkeltøkter eller ukentlige serier, disiplin og skyteleder |
| **Stevner** | Terminliste, påmeldingsfrist, deltakere fra laget med klasse og resultat |
| **Årsmelding og årsrapport** | Egen mappe per år, nøkkeltall, og knapp som lager *utkast til hoveddokument* (RTF – åpnes i Word) fylt ut med styret, medlemstall, møter/saker, treninger, stevner og ammunisjon |
| **Stillingsinstrukser** | Én side per verv med instruksdokumenter og sjekklister som kan krysses av og nullstilles hver sesong |
| **Årshjul og oppgaver** | Forslag til årshjul (redigerbart), generering av årets oppgaver, ansvarlig og status |

## Tilganger

**Tilgangsnivå per bruker** (settes under *Styret og tilganger*):

- **Administrator** – alt, inkludert brukere, verv, mapper, logo og alle dokumenter.
- **Styremedlem** – bruker alle styrefunksjonene og får dokumentenes standardtilgang.
- **Kun lesetilgang** – f.eks. revisor eller valgkomité: ser kalender, møter og bare de dokumentene de får tilgang til eksplisitt.

**Verv** gir i tillegg rettigheter: *våpenansvarlig* kan endre våpenregister og utlån, *våpenansvarlig og kasserer* kan registrere ammunisjon, og den som har vervet kan krysse av i vervets sjekklister.

**Per dokument** – den som laster opp blir *eier*:

| Nivå | Kan |
|---|---|
| Les | se, laste ned, legge ved i e-post |
| Rediger | + laste opp nye versjoner, endre tittel/beskrivelse/mappe |
| Eier | + styre tilganger, overføre eierskap, slette |

Eieren velger standardtilgang for hele styret (ingen / les / rediger) og kan gi enkeltpersoner Les, Rediger eller Medeier.

## Kom i gang

Krever Node.js 22.13 eller nyere (bruker innebygd SQLite – ingen database å installere).

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm start
```

Åpne http://localhost:3000. Første gang blir du bedt om å opprette skytterlaget og din administratorkonto. Deretter:

1. **Administrasjon** → last opp lagets logo.
2. **Medlemmer** → *Importer fra MittDFS* (eksporter medlemslisten fra mittdfs.no som CSV).
3. Åpne hvert styremedlem og kryss av verv.
4. **Styret og tilganger** → gi styremedlemmene innlogging (de får invitasjon på e-post).
5. **Våpen og ammo** → *Utlånserklæringer* → *Rediger mal* og lim inn gjeldende mal fra MittDFS.

### E-post

Uten SMTP-oppsett blir e-post bare logget («simulert»), og invitasjonslenker vises til administratoren slik at de kan deles manuelt. Sett `SMTP_*` og `MAIL_FROM` i `.env` for ekte utsendelse (se `.env.example`).

### MittDFS

MittDFS har ikke et åpent API, så medlemmer hentes via CSV-eksport. Importen kjenner igjen vanlige kolonnenavn (Skytter-ID, Fornavn, Etternavn, Fødselsdato, E-post, Mobil, Adresse, Postnr, Poststed, Klasse), takler både UTF-8 og Excel-format, og oppdaterer eksisterende medlemmer i stedet for å lage duplikater.

### Drift

- Alt lagres i `data/` (database `styreapp.db` og `uploads/`). **Ta jevnlig sikkerhetskopi av hele mappen.**
- Kjør bak HTTPS (f.eks. Caddy eller nginx) og sett `SECURE_COOKIES=true` og `BASE_URL`.
- Passord lagres med scrypt, alle skjema har CSRF-beskyttelse, og innloggingsforsøk begrenses.

## Utvikling

```bash
npm run dev
```

```bash
npm test
```

Kode: `src/routes/` (én fil per modul), `views/` (EJS-maler), `public/` (CSS/JS), `src/db.js` (skjema og standarddata).
