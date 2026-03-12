const SUPABASE_URL = 'https://nhlkpscafaevbemeqyzc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5obGtwc2NhZmFldmJlbWVxeXpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNTY1MTYsImV4cCI6MjA4ODgzMjUxNn0.ywXf2afjo9XN1eMEEZLmb10638VEhu8Dmdo5qF5ctnw';

async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=representation',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Supabase error ${res.status}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

let DATA = null;
let state = {
  lang: 'de', currentUser: null, currentGuess: '', currentRow: 0,
  gameOver: false, targetWord: '', todayKey: '', startTime: null,
  keyColors: {}, guesses: [], ui: {},
  gameId: 0,
  isAnimating: false  // blocks input + language switch during reveal animation
};

async function loadData() {
  try {
    const resp = await fetch('data.json');
    DATA = await resp.json();
  } catch (e) {
    DATA = {
      config: { wordLength: 5, maxAttempts: 6, defaultLanguage: 'de' },
      languages: {
        de: { name: 'Deutsch', flag: '🇩🇪', words: ['APFEL','BLUME','KRAFT','RAUCH','STARK','TISCH','VOGEL','WELLE','ADLER','BRAND','EISEN','FISCH','GABEL','JUBEL','KISTE','LICHT','REGEN','SONNE','TIGER','WOLKE','ZUNGE','ABEND','MAUER','NACHT','PFEIL'] },
        en: { name: 'English', flag: '🇬🇧', words: ['FLAME','BLAST','CRISP','DRAPE','ELDER','FAINT','GROAN','HASTE','IVORY','JOUST','KNEEL','LANKY','MIRTH','NOBLE','OLIVE','PERCH','QUILL','RAVEN','SLOTH','WALTZ','XENON','ZESTY','ABIDE','BLOWN','CLEFT'] }
      },
      ui: {
        de: { title:'WÖRDLE',subtitle:'Das tägliche Wort-Rätsel',login:'Anmelden',register:'Registrieren',logout:'Abmelden',profile:'Profil',leaderboard:'Bestenliste',play:'Spielen',username:'Benutzername',password:'Passwort',email:'E-Mail',streak:'Serie',longestStreak:'Längste Serie',avgAttempts:'Ø Versuche',gamesPlayed:'Spiele',gamesWon:'Gewonnen',todayLeaderboard:'Heutige Bestenliste',rank:'Rang',player:'Spieler',attempts:'Versuche',time:'Zeit',guessWord:'Tippe ein Wort...',submit:'Eingabe',newWordIn:'Neues Wort in',congratulations:'Glückwunsch!',solvedIn:'Gelöst in',gameOver:'Spiel vorbei!',wordWas:'Das Wort war',alreadyPlayed:'Du hast heute schon gespielt!',registerSuccess:'Registrierung erfolgreich!',loginSuccess:'Willkommen zurück!',invalidWord:'Kein gültiges Wort!',wordTooShort:'Das Wort ist zu kurz!',noAccount:'Noch kein Konto?',hasAccount:'Bereits ein Konto?',currentStreak:'Aktuelle Serie',statistics:'Statistiken',shareResult:'Ergebnis teilen',copied:'Kopiert!',top10Today:'Top 10 heute',languageSwitch:'Sprache' },
        en: { title:'WORDLE',subtitle:'The Daily Word Puzzle',login:'Login',register:'Register',logout:'Logout',profile:'Profile',leaderboard:'Leaderboard',play:'Play',username:'Username',password:'Password',email:'Email',streak:'Streak',longestStreak:'Best Streak',avgAttempts:'Avg. Attempts',gamesPlayed:'Games Played',gamesWon:'Games Won',todayLeaderboard:"Today's Leaderboard",rank:'Rank',player:'Player',attempts:'Attempts',time:'Time',guessWord:'Type a word...',submit:'Enter',newWordIn:'New word in',congratulations:'Congratulations!',solvedIn:'Solved in',gameOver:'Game Over!',wordWas:'The word was',alreadyPlayed:'You already played today!',registerSuccess:'Registration successful!',loginSuccess:'Welcome back!',invalidWord:'Not a valid word!',wordTooShort:'Word is too short!',noAccount:'No account yet?',hasAccount:'Already have an account?',currentStreak:'Current Streak',statistics:'Statistics',shareResult:'Share Result',copied:'Copied!',top10Today:'Top 10 Today',languageSwitch:'Language' }
      }
    };
  }
  await loadWordlists().catch(e => console.warn("Wordlists failed:", e));
  init();
}

function getSessionUser() { return JSON.parse(localStorage.getItem('wordle_session') || 'null'); }
function saveSessionUser(u) { localStorage.setItem('wordle_session', JSON.stringify(u)); }
function clearSession() { localStorage.removeItem('wordle_session'); }
function getGameState(username, todayKey) { return JSON.parse(localStorage.getItem(`wg_${username}_${todayKey}`) || 'null'); }
function saveGameState(username, todayKey, gs) { localStorage.setItem(`wg_${username}_${todayKey}`, JSON.stringify(gs)); }

function getTodayKey(lang) {
  const d = new Date();
  return `${lang}_${d.getFullYear()}_${d.getMonth()}_${d.getDate()}`;
}
function getDailyWord(lang) {
  const words = DATA.languages[lang].words;
  // Festes Startdatum: 1. Januar 2025 = Tag 0
  // dayIndex wächst jeden Tag um 1, unabhängig von der Listenlänge.
  // Neue Wörter immer ans ENDE der Liste anhängen — nie einfügen oder umsortieren!
  // Dann bleibt jedes bisherige Tageswort für immer gleich.
  const epoch = new Date(2025, 0, 1);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayIndex = Math.floor((today - epoch) / 86400000);
  return words[dayIndex % words.length];
}

function init() {
  state.lang = localStorage.getItem('wordle_lang') || DATA.config.defaultLanguage;
state.currentUser = getSessionUser();
applyLanguage(state.lang);
  updateHeaderAuth();
  navigate('home');
  startCountdownHeader();
}

// Safe DOM helpers — silently skip if element doesn't exist (prevents crash when
// applyLanguage runs before the full HTML is in the DOM, e.g. on page reload)
function setEl(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
function setElHTML(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }
function setElTitle(id, text) { const el = document.getElementById(id); if (el) el.title = text; }

function applyLanguage(lang) {
  state.lang = lang;
  state.ui = DATA.ui[lang];
  localStorage.setItem('wordle_lang', lang);
  document.querySelectorAll('.lang-btn').forEach(b => b.classList.toggle('active', b.dataset.lang === lang));

  setEl('logo-text', state.ui.title);
  setEl('hero-title', state.ui.title);
  setEl('hero-sub', state.ui.subtitle);
  setEl('btn-play', state.ui.play + ' →');
  setEl('btn-leaderboard-home', '🏆 ' + state.ui.leaderboard);
  setEl('btn-login', state.ui.login);
  setEl('btn-register', state.ui.register);
  setEl('btn-logout', state.ui.logout);
  setElTitle('btn-profile', state.ui.profile);
  setEl('modal-login-title', state.ui.login.toUpperCase());
  setEl('modal-register-title', state.ui.register.toUpperCase());
  setEl('label-username', state.ui.username);
  setEl('label-password', state.ui.password);
  setEl('label-reg-username', state.ui.username);
  setEl('label-reg-email', state.ui.email);
  setEl('label-reg-password', state.ui.password);
  setEl('btn-do-login', state.ui.login);
  setEl('btn-do-register', state.ui.register);
  setEl('no-account-text', state.ui.noAccount);
  setEl('switch-to-register', ' ' + state.ui.register);
  setEl('has-account-text', state.ui.hasAccount);
  setEl('switch-to-login', ' ' + state.ui.login);
  setEl('stat-streak-label', state.ui.currentStreak + ' 🔥');
  setEl('stat-best-streak-label', state.ui.longestStreak + ' 🏆');
  setEl('stat-played-label', state.ui.gamesPlayed);
  setEl('stat-won-label', state.ui.gamesWon);
  setEl('stat-avg-label', state.ui.avgAttempts);
  setEl('stat-winrate-label', '% ' + state.ui.gamesWon);
  setEl('lb-section-title', state.ui.top10Today);
  setEl('res-attempts-label', state.ui.attempts);
  setEl('res-streak-label', state.ui.streak + ' 🔥');
  setEl('btn-to-lb', '🏆 ' + state.ui.leaderboard);
  setEl('btn-close-result-2', lang === 'de' ? '✕ Schließen' : '✕ Close');
  setEl('btn-share', state.ui.shareResult);
  setEl('msg-login-profile', state.ui.login + ' ' + state.ui.profile);
  setEl('played-title', state.ui.alreadyPlayed);
  setElHTML('result-countdown-text', state.ui.newWordIn + ' <span id="result-timer">00:00:00</span>');
  setEl('game-subtitle', lang === 'de' ? 'WORT DES TAGES' : 'WORD OF THE DAY');
  setEl('played-sub', state.ui.newWordIn + ' ...');

  setEl('footer-logo', state.ui.title);
  setEl('footer-imp', lang === 'de' ? 'Impressum' : 'Legal Notice');
  setEl('footer-ds', lang === 'de' ? 'Datenschutz' : 'Privacy Policy');
  setEl('footer-agb', lang === 'de' ? 'Nutzungsbedingungen' : 'Terms of Use');
  setEl('footer-ko', lang === 'de' ? 'Kontakt' : 'Contact');
  setEl('footer-copy', lang === 'de' ? '© 2026 Henrik Seebach · Alle Rechte vorbehalten.' : '© 2026 Henrik Seebach · All rights reserved.');

  ['imp','ds','agb','ko'].forEach(p => {
    const el = document.getElementById(`back-home-${p}`);
    if (el) el.textContent = lang === 'de' ? 'Zurück' : 'Back';
  });

  if (lang === 'de') {
    setEl('imp-title', 'Impressum');
    setEl('imp-angaben', 'Angaben gemäß § 5 TMG');
    setEl('imp-verantwortlich', 'Verantwortlich für den Inhalt');
    setEl('imp-hinweis-title', 'Hinweis');
    setEl('imp-hinweis-text', 'Dieses Projekt ist ein privates, nicht-kommerzielles Freizeitprojekt. Es wird kein Umsatz generiert und keine kommerzielle Absicht verfolgt.');
    setEl('imp-haftung-title', 'Haftungsausschluss');
    setEl('imp-haftung-text', 'Die Inhalte dieser Seite wurden mit größter Sorgfalt erstellt. Für die Richtigkeit, Vollständigkeit und Aktualität der Inhalte kann keine Gewähr übernommen werden.');
    setEl('ds-title', 'Datenschutzerklärung');
    setEl('ds-verantwortlicher-title', 'Verantwortlicher');
    setElHTML('ds-verantwortlicher-text', 'Henrik Seebach, erreichbar unter <a href="mailto:henneswordle@gmail.com">henneswordle@gmail.com</a>');
    setEl('ds-welche-title', 'Welche Daten wir speichern');
    setEl('ds-welche-text', 'Bei der Registrierung werden folgende Daten in unserer Datenbank (Supabase, gehostet in der EU) gespeichert:');
    setEl('ds-li1', 'Benutzername');
    setEl('ds-li2', 'E-Mail-Adresse');
    setEl('ds-li3', 'Passwort (als SHA-256-Hash, nicht im Klartext)');
    setEl('ds-li4', 'Spielstatistiken (Anzahl Spiele, Siege, Serien)');
    setEl('ds-li5', 'Leaderboard-Einträge (Benutzername, Versuche, Zeit)');
    setEl('ds-zweck-title', 'Zweck der Verarbeitung');
    setEl('ds-zweck-text', 'Die Daten werden ausschließlich für den Betrieb des Spiels verwendet — zur Anmeldung, zur Anzeige persönlicher Statistiken und für die tägliche Bestenliste. Es findet keine kommerzielle Nutzung statt.');
    setEl('ds-hosting-title', 'Hosting & Datenbank');
    setEl('ds-hosting-text', 'Die Webseite wird über Netlify (USA, Standardvertragsklauseln) gehostet. Die Datenbank läuft auf Supabase (Frankfurt, EU). Beide Anbieter verarbeiten Daten gemäß DSGVO.');
    setEl('ds-speicher-title', 'Speicherdauer');
    setEl('ds-speicher-text', 'Deine Daten werden gespeichert, solange dein Account existiert. Du kannst jederzeit die Löschung deines Accounts und aller damit verbundenen Daten per E-Mail anfordern.');
    setEl('ds-cookies-title', 'Cookies & lokale Speicherung');
    setEl('ds-cookies-text', 'Wir verwenden keine Tracking-Cookies. Es wird lediglich der lokale Browser-Speicher (localStorage) genutzt, um deine Sitzung und Spracheinstellung zu speichern. Diese Daten verlassen nicht deinen Browser.');
    setEl('ds-rechte-title', 'Deine Rechte');
    setElHTML('ds-rechte-text', 'Du hast das Recht auf Auskunft, Berichtigung und Löschung deiner gespeicherten Daten. Kontaktiere uns dafür unter <a href="mailto:henneswordle@gmail.com">henneswordle@gmail.com</a>.');
    setEl('ko-title', 'Kontakt');
    setEl('ko-intro', 'Du hast Fragen, Feedback oder möchtest deinen Account löschen? Melde dich gerne:');
    setEl('ko-response', 'Ich versuche, innerhalb von 48 Stunden zu antworten.');
    setEl('agb-title', 'Nutzungsbedingungen');
    setEl('agb-nutzung-title', 'Nutzung');
    setEl('agb-nutzung-text', 'Wördle ist ein kostenloses, privates Freizeitprojekt. Die Nutzung ist kostenlos und freiwillig. Es besteht kein Anspruch auf dauerhafte Verfügbarkeit.');
    setEl('agb-account-title', 'Account');
    setEl('agb-account-text', 'Pro Person ist ein Account erlaubt. Das Erstellen von Fake-Accounts oder das Manipulieren von Spielergebnissen ist nicht gestattet und kann zur Sperrung führen.');
    setEl('agb-verhalten-title', 'Verhalten');
    setEl('agb-verhalten-text', 'Bitte wähle einen angemessenen Benutzernamen. Namen die andere beleidigen oder diskriminieren sind nicht erlaubt und werden ohne Vorwarnung gelöscht.');
    setEl('agb-haftung-title', 'Haftung');
    setEl('agb-haftung-text', 'Dieses Projekt wird ohne Gewähr betrieben. Für Datenverlust oder Ausfälle wird keine Haftung übernommen.');
  } else {
    setEl('imp-title', 'Legal Notice');
    setEl('imp-angaben', 'Information according to § 5 TMG');
    setEl('imp-verantwortlich', 'Responsible for content');
    setEl('imp-hinweis-title', 'Note');
    setEl('imp-hinweis-text', 'This is a private, non-commercial hobby project. No revenue is generated and no commercial intent is pursued.');
    setEl('imp-haftung-title', 'Disclaimer');
    setEl('imp-haftung-text', 'The content of this site has been created with the utmost care. No guarantee can be given for the accuracy, completeness or timeliness of the content.');
    setEl('ds-title', 'Privacy Policy');
    setEl('ds-verantwortlicher-title', 'Controller');
    setElHTML('ds-verantwortlicher-text', 'Henrik Seebach, contact: <a href="mailto:henneswordle@gmail.com">henneswordle@gmail.com</a>');
    setEl('ds-welche-title', 'What data we store');
    setEl('ds-welche-text', 'When registering, the following data is stored in our database (Supabase, hosted in the EU):');
    setEl('ds-li1', 'Username');
    setEl('ds-li2', 'Email address');
    setEl('ds-li3', 'Password (as SHA-256 hash, never in plain text)');
    setEl('ds-li4', 'Game statistics (games played, wins, streaks)');
    setEl('ds-li5', 'Leaderboard entries (username, attempts, time)');
    setEl('ds-zweck-title', 'Purpose of processing');
    setEl('ds-zweck-text', 'Data is used exclusively to operate the game — for login, personal statistics, and the daily leaderboard. No commercial use takes place.');
    setEl('ds-hosting-title', 'Hosting & Database');
    setEl('ds-hosting-text', 'The website is hosted via Netlify (USA, standard contractual clauses). The database runs on Supabase (Frankfurt, EU). Both providers process data in accordance with GDPR.');
    setEl('ds-speicher-title', 'Retention period');
    setEl('ds-speicher-text', 'Your data is stored as long as your account exists. You can request deletion of your account and all associated data at any time by email.');
    setEl('ds-cookies-title', 'Cookies & local storage');
    setEl('ds-cookies-text', 'We do not use tracking cookies. Only the local browser storage (localStorage) is used to save your session and language preference. This data never leaves your browser.');
    setEl('ds-rechte-title', 'Your rights');
    setElHTML('ds-rechte-text', 'You have the right to access, correct and delete your stored data. Contact us at <a href="mailto:henneswordle@gmail.com">henneswordle@gmail.com</a>.');
    setEl('ko-title', 'Contact');
    setEl('ko-intro', 'Questions, feedback or want to delete your account? Feel free to reach out:');
    setEl('ko-response', 'I try to respond within 48 hours.');
    setEl('agb-title', 'Terms of Use');
    setEl('agb-nutzung-title', 'Usage');
    setEl('agb-nutzung-text', 'Wördle is a free, private hobby project. Use is free and voluntary. There is no guarantee of permanent availability.');
    setEl('agb-account-title', 'Account');
    setEl('agb-account-text', 'One account per person is allowed. Creating fake accounts or manipulating game results is not permitted and may result in a ban.');
    setEl('agb-verhalten-title', 'Conduct');
    setEl('agb-verhalten-text', 'Please choose an appropriate username. Names that are offensive or discriminatory are not allowed and will be deleted without warning.');
    setEl('agb-haftung-title', 'Liability');
    setEl('agb-haftung-text', 'This project is operated without warranty. No liability is assumed for data loss or outages.');
  }
}

// ALT
function switchLanguage(lang) {
  applyLanguage(lang);
  setupProfilePage();
  setupLeaderboardPage();
  if (document.getElementById('page-game').classList.contains('active')) setupGamePage();
}

// NEU
function switchLanguage(lang) {
  if (state.isAnimating) return;
  applyLanguage(lang);
  const activePage = document.querySelector('.page.active');
  if (!activePage) return;
  const pageId = activePage.id;
  if (pageId === 'page-game') setupGamePage();
  else if (pageId === 'page-profile') setupProfilePage();
  else if (pageId === 'page-leaderboard') setupLeaderboardPage();
}

function navigate(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  if (page === 'game') setupGamePage();
  if (page === 'profile') setupProfilePage();
  if (page === 'leaderboard') setupLeaderboardPage();
}
function startGame() { navigate('game'); }

function updateHeaderAuth() {
  const authDiv = document.getElementById('header-auth');
  const userDiv = document.getElementById('header-user');
  if (state.currentUser) { authDiv.style.display = 'none'; userDiv.style.display = 'flex'; }
  else { authDiv.style.display = 'flex'; userDiv.style.display = 'none'; }
}

function openModal(type) {
  document.getElementById('modal-overlay').classList.add('open');
  document.getElementById('modal-login').style.display = type === 'login' ? '' : 'none';
  document.getElementById('modal-register').style.display = type === 'register' ? '' : 'none';
  document.getElementById('login-error').classList.remove('visible');
  document.getElementById('register-error').classList.remove('visible');
  setTimeout(() => {
    const inp = type === 'login' ? document.getElementById('input-username') : document.getElementById('input-reg-username');
    inp && inp.focus();
  }, 150);
}
function closeModal() { document.getElementById('modal-overlay').classList.remove('open'); }
function closeModalOutside(e) { if (e.target === document.getElementById('modal-overlay')) closeModal(); }

async function hashPassword(password) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function doLogin() {
  const username = document.getElementById('input-username').value.trim();
  const password = document.getElementById('input-password').value;
  const errEl = document.getElementById('login-error');
  errEl.classList.remove('visible');
  if (!username || !password) { errEl.classList.add('visible'); return; }
  try {
    const hash = await hashPassword(password);
    const rows = await sbFetch(`users?username=eq.${encodeURIComponent(username)}&password_hash=eq.${hash}&select=id,username,email`);
    if (!rows || rows.length === 0) { errEl.classList.add('visible'); return; }
    const user = rows[0];
    state.currentUser = { id: user.id, username: user.username, email: user.email };
    saveSessionUser(state.currentUser);
    updateHeaderAuth();
    closeModal();
    showToast(state.ui.loginSuccess, 'success');
    document.getElementById('input-username').value = '';
    document.getElementById('input-password').value = '';
  } catch (e) { errEl.textContent = 'Verbindungsfehler.'; errEl.classList.add('visible'); }
}

async function doRegister() {
  const username = document.getElementById('input-reg-username').value.trim();
  const email = document.getElementById('input-reg-email').value.trim();
  const password = document.getElementById('input-reg-password').value;
  const errEl = document.getElementById('register-error');
  errEl.classList.remove('visible');
  if (!username || username.length < 2) { errEl.textContent = 'Name zu kurz (mind. 2 Zeichen)'; errEl.classList.add('visible'); return; }
  if (!email || !email.includes('@')) { errEl.textContent = 'Ungültige E-Mail'; errEl.classList.add('visible'); return; }
  if (!password || password.length < 6) { errEl.textContent = 'Passwort mind. 6 Zeichen'; errEl.classList.add('visible'); return; }
  try {
    const hash = await hashPassword(password);
    const rows = await sbFetch('users', { method: 'POST', body: JSON.stringify({ username, email, password_hash: hash }), prefer: 'return=representation' });
    const user = rows[0];
    state.currentUser = { id: user.id, username: user.username, email: user.email };
    saveSessionUser(state.currentUser);
    updateHeaderAuth();
    closeModal();
    showToast(state.ui.registerSuccess, 'success');
    document.getElementById('input-reg-username').value = '';
    document.getElementById('input-reg-email').value = '';
    document.getElementById('input-reg-password').value = '';
  } catch (e) {
    errEl.textContent = e.message.includes('unique') ? (state.lang === 'de' ? 'Name oder E-Mail bereits vergeben!' : 'Username or email already taken!') : 'Fehler: ' + e.message;
    errEl.classList.add('visible');
  }
}

function logout() {
  state.currentUser = null; clearSession(); updateHeaderAuth(); navigate('home');
  showToast(state.lang === 'de' ? 'Tschüss! 👋' : 'Bye! 👋', 'info');
}

function setupGamePage() {
  // Increment gameId so any running animation callbacks from the previous game are ignored
  state.gameId = (state.gameId || 0) + 1;
  state.isAnimating = false;  // reset in case we navigated away mid-animation

  state.todayKey = getTodayKey(state.lang);
  state.targetWord = getDailyWord(state.lang);

  // Always add today's word to valid sets
  if (wordlistsReady) {
    VALID_WORDS_DE.add(state.targetWord);
    VALID_WORDS_EN.add(state.targetWord);
  }

  if (!state.currentUser) {
    state.gameOver = false;
    state.currentGuess = '';
    state.currentRow = 0;
    state.keyColors = {};
    state.guesses = [];
    state.startTime = Date.now();
    buildGrid();
    buildKeyboard();
    document.getElementById('played-banner').style.display = 'none';
    return;
  }

  const savedGame = getGameState(state.currentUser.username, state.todayKey);
  state.gameOver = savedGame ? savedGame.gameOver : false;
  state.guesses = savedGame ? savedGame.guesses : [];
  state.currentRow = state.guesses.length;  // always derived from guesses — never out of sync
  state.keyColors = savedGame ? savedGame.keyColors : {};
  state.currentGuess = '';
  state.startTime = savedGame ? savedGame.startTime : Date.now();

  document.getElementById('played-banner').style.display = state.gameOver ? 'block' : 'none';
  buildGrid();
  buildKeyboard();
  restoreGuesses();
}

function buildGrid() {
  const grid = document.getElementById('game-grid');
  grid.innerHTML = '';
  for (let r = 0; r < DATA.config.maxAttempts; r++) {
    const row = document.createElement('div');
    row.className = 'grid-row'; row.id = `row-${r}`;
    for (let c = 0; c < DATA.config.wordLength; c++) {
      const tile = document.createElement('div');
      tile.className = 'grid-tile'; tile.id = `tile-${r}-${c}`;
      row.appendChild(tile);
    }
    grid.appendChild(row);
  }
}

function buildKeyboard() {
  const keyboard = document.getElementById('game-keyboard');
  keyboard.innerHTML = '';
  const rows = state.lang === 'de'
    ? [['Q','W','E','R','T','Z','U','I','O','P','Ü'],['A','S','D','F','G','H','J','K','L','Ö','Ä'],['ENTER','Y','X','C','V','B','N','M','⌫']]
    : [['Q','W','E','R','T','Y','U','I','O','P'],['A','S','D','F','G','H','J','K','L'],['ENTER','Z','X','C','V','B','N','M','⌫']];
  rows.forEach(row => {
    const rowEl = document.createElement('div');
    rowEl.className = 'keyboard-row';
    row.forEach(key => {
      const btn = document.createElement('button');
      btn.className = 'key' + (key === 'ENTER' || key === '⌫' ? ' wide' : '');
      btn.textContent = key === 'ENTER' ? (state.ui.submit || 'ENTER') : key;
      btn.dataset.key = key; btn.id = `key-${key}`;
      if (state.keyColors[key]) btn.className += ' ' + state.keyColors[key];
      btn.addEventListener('click', () => handleKey(key));
      rowEl.appendChild(btn);
    });
    keyboard.appendChild(rowEl);
  });
}

function restoreGuesses() {
  state.guesses.forEach((guess, rowIdx) => {
    const result = evaluateGuess(guess, state.targetWord);
    for (let c = 0; c < DATA.config.wordLength; c++) {
      const tile = document.getElementById(`tile-${rowIdx}-${c}`);
      if (tile) { tile.textContent = guess[c]; tile.className = 'grid-tile ' + result[c]; }
    }
  });
}

function handleKey(key) {
  if (state.gameOver) return;
  if (state.isAnimating) return;  // block all input during reveal
  if (!state.currentUser) { showToast(state.lang === 'de' ? 'Bitte anmelden!' : 'Please login!', 'error'); return; }
  if (key === '⌫' || key === 'Backspace') {
    if (state.currentGuess.length > 0) { state.currentGuess = state.currentGuess.slice(0, -1); updateCurrentRow(); }
    return;
  }
  if (key === 'ENTER' || key === 'Enter') { submitGuess(); return; }
  if (/^[A-ZÄÖÜa-zäöü]$/.test(key) && state.currentGuess.length < DATA.config.wordLength) {
    state.currentGuess += key.toUpperCase(); updateCurrentRow();
  }
}

function updateCurrentRow() {
  for (let c = 0; c < DATA.config.wordLength; c++) {
    const tile = document.getElementById(`tile-${state.currentRow}-${c}`);
    if (tile) {
      const char = state.currentGuess[c] || '';
      tile.textContent = char;
      tile.className = 'grid-tile' + (char ? ' filled' : '');
    }
  }
}

function evaluateGuess(guess, target) {
  const result = Array(DATA.config.wordLength).fill('absent');
  const targetArr = target.split(''), guessArr = guess.split('');
  guessArr.forEach((ch, i) => { if (ch === targetArr[i]) { result[i] = 'correct'; targetArr[i] = null; } });
  guessArr.forEach((ch, i) => { if (result[i] !== 'correct') { const idx = targetArr.indexOf(ch); if (idx !== -1) { result[i] = 'present'; targetArr[idx] = null; } } });
  return result;
}

function submitGuess() {
  if (state.currentGuess.length < DATA.config.wordLength) { shakeRow(state.currentRow); showToast(state.ui.wordTooShort, 'error'); return; }

  if (wordlistsReady) {
    const validSet = state.lang === 'de' ? VALID_WORDS_DE : VALID_WORDS_EN;
    if (!validSet.has(state.currentGuess)) {
      shakeRow(state.currentRow);
      showToast(state.ui.invalidWord, 'error');
      return;
    }
  }

  const guess = state.currentGuess;
  const result = evaluateGuess(guess, state.targetWord);
  const rowIdx = state.currentRow;
  const capturedGameId = state.gameId;  // snapshot — callback will check this

  // ── THE FIX ──────────────────────────────────────────────────────────────
  // Update all state IMMEDIATELY before the animation starts.
  // This way a language switch during animation cannot corrupt guesses/currentRow.
  state.currentGuess = '';
  state.currentRow++;
  state.guesses.push(guess);
  updateCurrentRow(); // clear the now-next row
  // ─────────────────────────────────────────────────────────────────────────

  const won = result.every(r => r === 'correct');

  revealRow(rowIdx, guess, result, async () => {
    // Ignore callback if user switched game (language/navigate) during animation
    if (state.gameId !== capturedGameId) return;

    if (won || state.currentRow >= DATA.config.maxAttempts) {
      state.gameOver = true;
      document.getElementById('played-banner').style.display = 'block';
      saveCurrentGame();
      await updateStats(won);
      setTimeout(() => showResult(won), 500);
    } else {
      saveCurrentGame();
    }
  });
}

function revealRow(rowIdx, guess, result, callback) {
  const stagger = 400;
  const flipMs = 600;
  const flipHalf = flipMs / 2;
  const totalDuration = DATA.config.wordLength * stagger + flipMs + 100;

  state.isAnimating = true;

  for (let c = 0; c < DATA.config.wordLength; c++) {
    const tile = document.getElementById(`tile-${rowIdx}-${c}`);
    setTimeout(() => {
      tile.style.transition = `transform ${flipHalf}ms ease-in`;
      tile.style.transform = 'scaleY(0)';
      setTimeout(() => {
        tile.textContent = guess[c];
        tile.className = 'grid-tile ' + result[c];
        tile.style.transition = `transform ${flipHalf}ms ease-out`;
        tile.style.transform = 'scaleY(1)';
        updateKeyColor(guess[c], result[c]);
      }, flipHalf);
    }, c * stagger);
  }

  setTimeout(() => {
    state.isAnimating = false;
    callback();
  }, totalDuration);
}

function updateKeyColor(letter, status) {
  const priority = { correct: 3, present: 2, absent: 1 };
  const current = state.keyColors[letter];
  if (!current || priority[status] > priority[current]) {
    state.keyColors[letter] = status;
    const keyEl = document.getElementById(`key-${letter}`);
    if (keyEl) keyEl.className = 'key ' + status + (keyEl.classList.contains('wide') ? ' wide' : '');
  }
}

function shakeRow(rowIdx) {
  document.getElementById(`row-${rowIdx}`).querySelectorAll('.grid-tile').forEach(t => {
    t.classList.add('shake');
    t.addEventListener('animationend', () => t.classList.remove('shake'), { once: true });
  });
}

function saveCurrentGame() {
  if (!state.currentUser) return;
  saveGameState(state.currentUser.username, state.todayKey, {
    gameOver: state.gameOver, guesses: state.guesses,
    keyColors: state.keyColors, startTime: state.startTime
  });
}

async function updateStats(won) {
  const userId = state.currentUser.id, lang = state.lang, today = new Date().toDateString();
  const elapsedSec = Math.floor((Date.now() - state.startTime) / 1000);
  try {
    const existing = await sbFetch(`stats?user_id=eq.${userId}&lang=eq.${lang}`);
    const s = existing && existing.length > 0 ? existing[0] : null;
    let streak = s ? (s.streak || 0) : 0, bestStreak = s ? (s.best_streak || 0) : 0;
    let played = (s ? s.played : 0) + 1, wonCount = s ? s.won : 0, totalAttempts = s ? s.total_attempts : 0;
    if (won) {
      wonCount++; totalAttempts += state.currentRow;
      const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
      if (s && s.last_played_date === yesterday.toDateString()) streak++;
      else if (s && s.last_played_date === today) {}
      else streak = 1;
      bestStreak = Math.max(bestStreak, streak);
    } else { streak = 0; }
    const statsData = { user_id: userId, username: state.currentUser.username, lang, played, won: wonCount, total_attempts: totalAttempts, streak, best_streak: bestStreak, last_played_date: won ? today : (s ? s.last_played_date : null) };
    if (s) await sbFetch(`stats?user_id=eq.${userId}&lang=eq.${lang}`, { method: 'PATCH', body: JSON.stringify(statsData), prefer: 'return=minimal' });
    else await sbFetch('stats', { method: 'POST', body: JSON.stringify(statsData), prefer: 'return=minimal' });
    if (won) {
      const lbEx = await sbFetch(`leaderboard?user_id=eq.${userId}&lang=eq.${lang}&day_key=eq.${state.todayKey}`);
      if (!lbEx || lbEx.length === 0) await sbFetch('leaderboard', { method: 'POST', body: JSON.stringify({ user_id: userId, username: state.currentUser.username, lang, day_key: state.todayKey, attempts: state.currentRow, time_seconds: elapsedSec }), prefer: 'return=minimal' });
    }
  } catch (e) { console.error('Stats error:', e); }
}

async function showResult(won) {
  document.getElementById('result-emoji').textContent = won ? '🎉' : '😔';
  document.getElementById('result-title').textContent = won ? state.ui.congratulations : state.ui.gameOver;
  document.getElementById('result-word').textContent = state.targetWord;
  document.getElementById('res-attempts').textContent = won ? state.guesses.length : '✕';
  document.getElementById('res-time-label').textContent = state.lang === 'de' ? 'Zeit' : 'Time';
  if (!won) document.getElementById('res-attempts-label').textContent = state.lang === 'de' ? 'Versuche' : 'Attempts';
  if (state.currentUser) {
    try {
      const rows = await sbFetch(`stats?user_id=eq.${state.currentUser.id}&lang=eq.${state.lang}`);
      document.getElementById('res-streak').textContent = rows && rows.length > 0 ? (rows[0].streak || 0) : 0;
    } catch (e) { document.getElementById('res-streak').textContent = 0; }
  }
  document.getElementById('res-time').textContent = formatTime(Math.floor((Date.now() - state.startTime) / 1000));
  document.getElementById('result-overlay').classList.add('open');
  startResultCountdown();
}

function closeResult() { document.getElementById('result-overlay').classList.remove('open'); }

let resultCountdownInterval = null;
function startResultCountdown() {
  if (resultCountdownInterval) clearInterval(resultCountdownInterval);
  function update() {
    const el = document.getElementById('result-timer');
    if (!el) return;
    const diff = new Date().setHours(24,0,0,0) - Date.now();
    const h = Math.floor(diff/3600000), m = Math.floor((diff%3600000)/60000), s = Math.floor((diff%60000)/1000);
    el.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }
  update(); resultCountdownInterval = setInterval(update, 1000);
}

function startCountdownHeader() {
  function update() {
    const el = document.getElementById('header-countdown');
    if (!el) return;
    const diff = new Date().setHours(24,0,0,0) - Date.now();
    const h = Math.floor(diff/3600000), m = Math.floor((diff%3600000)/60000), s = Math.floor((diff%60000)/1000);
    el.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }
  update(); setInterval(update, 1000);
}

async function setupProfilePage() {
  if (!state.currentUser) {
    document.getElementById('profile-logged-out').style.display = 'flex';
    document.getElementById('profile-content').style.display = 'none';
    return;
  }
  document.getElementById('profile-logged-out').style.display = 'none';
  document.getElementById('profile-content').style.display = 'block';
  const flag = DATA.languages[state.lang].flag, langName = DATA.languages[state.lang].name;
  document.getElementById('profile-avatar').textContent = state.currentUser.username[0].toUpperCase();
  document.getElementById('profile-username').textContent = state.currentUser.username;
  document.getElementById('profile-email').textContent = state.currentUser.email + ' · ' + flag + ' ' + langName;
  ['stat-streak','stat-best-streak','stat-played','stat-won'].forEach(id => document.getElementById(id).textContent = '…');
  document.getElementById('stat-avg').textContent = '…';
  document.getElementById('stat-winrate').textContent = '…';
  try {
    const rows = await sbFetch(`stats?user_id=eq.${state.currentUser.id}&lang=eq.${state.lang}`);
    const s = rows && rows.length > 0 ? rows[0] : null;
    document.getElementById('stat-streak').textContent = s ? (s.streak || 0) : 0;
    document.getElementById('stat-best-streak').textContent = s ? (s.best_streak || 0) : 0;
    document.getElementById('stat-played').textContent = s ? (s.played || 0) : 0;
    document.getElementById('stat-won').textContent = s ? (s.won || 0) : 0;
    document.getElementById('stat-avg').textContent = s && s.won ? (s.total_attempts / s.won).toFixed(1) : '—';
    document.getElementById('stat-winrate').textContent = s && s.played ? Math.round((s.won / s.played) * 100) + '%' : '0%';
  } catch (e) { console.error('Profile error:', e); }
}

async function setupLeaderboardPage() {
  renderLeaderboard();
}

const lbState = { tab: 'today', sortToday: 'attempts', sortAll: 'avg' };

function renderLeaderboard() {
  const de = state.lang === 'de';
  const container = document.getElementById('leaderboard-container-inner');
  if (!container) return;
  container.innerHTML = `
    <div class="lb-tabs">
      <button class="lb-tab${lbState.tab === 'today' ? ' active' : ''}" onclick="lbSetTab('today')">${de ? '📅 Heute' : '📅 Today'}</button>
      <button class="lb-tab${lbState.tab === 'all' ? ' active' : ''}" onclick="lbSetTab('all')">${de ? '🏆 Gesamt' : '🏆 All-time'}</button>
    </div>
    <div class="lb-sort-row" id="lb-sort-row"></div>
    <div class="leaderboard-list" id="leaderboard-list"><div class="lb-empty">⏳</div></div>
  `;
  renderSortPills();
  fetchAndRenderList();
}

function renderSortPills() {
  const de = state.lang === 'de';
  const row = document.getElementById('lb-sort-row');
  if (!row) return;
  const pills = lbState.tab === 'today'
    ? [{ key: 'attempts', label: de ? 'Versuche' : 'Attempts' }, { key: 'time', label: de ? 'Zeit' : 'Time' }]
    : [{ key: 'avg', label: de ? 'Ø Versuche' : 'Avg. Attempts' }, { key: 'streak', label: de ? 'Aktuelle Serie' : 'Current Streak' }, { key: 'best', label: de ? 'Längste Serie' : 'Best Streak' }];
  const current = lbState.tab === 'today' ? lbState.sortToday : lbState.sortAll;
  row.innerHTML = pills.map(p =>
    `<button class="lb-pill${p.key === current ? ' active' : ''}" onclick="lbSetSort('${p.key}')">${p.label}</button>`
  ).join('');
}

function lbSetTab(tab) { lbState.tab = tab; renderLeaderboard(); }

function lbSetSort(sort) {
  if (lbState.tab === 'today') lbState.sortToday = sort;
  else lbState.sortAll = sort;
  renderSortPills();
  fetchAndRenderList();
}

async function fetchAndRenderList() {
  const list = document.getElementById('leaderboard-list');
  if (!list) return;
  list.innerHTML = '<div class="lb-empty">⏳</div>';
  const de = state.lang === 'de';
  const medals = ['🥇','🥈','🥉'];
  try {
    if (lbState.tab === 'today') {
      const todayKey = getTodayKey(state.lang);
      const order = lbState.sortToday === 'time' ? 'time_seconds.asc,attempts.asc' : 'attempts.asc,time_seconds.asc';
      const entries = await sbFetch(`leaderboard?day_key=eq.${todayKey}&lang=eq.${state.lang}&order=${order}&limit=10`);
      if (!entries || entries.length === 0) { list.innerHTML = `<div class="lb-empty">${de ? 'Noch keine Einträge heute.' : 'No entries today yet.'}</div>`; return; }
      list.innerHTML = entries.map((e, i) => {
        const isMe = state.currentUser && e.user_id === state.currentUser.id;
        const rank = i < 3 ? `<span class="lb-rank-medal">${medals[i]}</span>` : `<span class="lb-rank">#${i+1}</span>`;
        const hi = lbState.sortToday === 'time'
          ? `<div class="lb-stat-hi">${formatTime(e.time_seconds)}</div><div class="lb-stat-lo">${e.attempts}/${DATA.config.maxAttempts}</div>`
          : `<div class="lb-stat-hi">${e.attempts}/${DATA.config.maxAttempts}</div><div class="lb-stat-lo">${formatTime(e.time_seconds)}</div>`;
        return `<div class="lb-entry rank-${i+1}${isMe ? ' current-user' : ''}" style="animation-delay:${i*0.06}s">
          ${rank}
          <div class="lb-avatar">${e.username[0].toUpperCase()}</div>
          <div class="lb-name">${e.username}${isMe ? `<span class="lb-you">${de ? 'Du' : 'You'}</span>` : ''}</div>
          ${hi}
        </div>`;
      }).join('');
    } else {
      const sort = lbState.sortAll;
      const order = sort === 'avg' ? 'total_attempts.asc,won.desc' : sort === 'streak' ? 'streak.desc,best_streak.desc' : 'best_streak.desc,streak.desc';
      const rows = await sbFetch(`stats?lang=eq.${state.lang}&won=gt.0&order=${order}&limit=10&select=*,users(username)`);
      if (!rows || rows.length === 0) { list.innerHTML = `<div class="lb-empty">${de ? 'Noch keine Daten.' : 'No data yet.'}</div>`; return; }
      list.innerHTML = rows.map((s, i) => {
        const isMe = state.currentUser && s.user_id === state.currentUser.id;
        const rank = i < 3 ? `<span class="lb-rank-medal">${medals[i]}</span>` : `<span class="lb-rank">#${i+1}</span>`;
        const name = s.users?.username || s.username || '?';
        const avg = s.won > 0 ? (s.total_attempts / s.won).toFixed(1) : '—';
        const hi = sort === 'avg'
          ? `<div class="lb-stat-hi">${avg}</div><div class="lb-stat-lo">${s.won}W / ${s.played}G</div>`
          : sort === 'streak'
          ? `<div class="lb-stat-hi">🔥 ${s.streak}</div><div class="lb-stat-lo">${de ? 'Beste' : 'Best'}: ${s.best_streak}</div>`
          : `<div class="lb-stat-hi">🏆 ${s.best_streak}</div><div class="lb-stat-lo">${de ? 'Aktuell' : 'Now'}: ${s.streak}</div>`;
        return `<div class="lb-entry rank-${i+1}${isMe ? ' current-user' : ''}" style="animation-delay:${i*0.06}s">
          ${rank}
          <div class="lb-avatar">${name[0].toUpperCase()}</div>
          <div class="lb-name">${name}${isMe ? `<span class="lb-you">${de ? 'Du' : 'You'}</span>` : ''}</div>
          ${hi}
        </div>`;
      }).join('');
    }
  } catch(e) {
    const l = document.getElementById('leaderboard-list');
    if (l) l.innerHTML = `<div class="lb-empty">${de ? 'Fehler beim Laden.' : 'Error loading.'}</div>`;
  }
}

function shareResult() {
  const won = state.guesses.length > 0 && state.guesses[state.guesses.length - 1] === state.targetWord;
  const emoji = state.guesses.map(guess => evaluateGuess(guess, state.targetWord).map(s => s === 'correct' ? '🟩' : s === 'present' ? '🟨' : '⬛').join('')).join('\n');
  const text = `${state.ui.title} ${state.todayKey}\n${won ? state.guesses.length : 'X'}/${DATA.config.maxAttempts}\n\n${emoji}`;
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => showToast(state.ui.copied, 'success'));
  else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); showToast(state.ui.copied, 'success'); }
}

function formatTime(sec) { return `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`; }

function showToast(msg, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`; toast.textContent = msg;
  document.getElementById('toast-container').appendChild(toast);
  setTimeout(() => toast.remove(), 2800);
}

document.addEventListener('keydown', e => {
  if (document.getElementById('modal-overlay').classList.contains('open')) return;
  if (!document.getElementById('page-game').classList.contains('active')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Backspace') { handleKey('Backspace'); return; }
  if (e.key === 'Enter') { handleKey('Enter'); return; }
  if (/^[a-zA-ZäöüÄÖÜ]$/.test(e.key)) handleKey(e.key.toUpperCase());
});
document.getElementById('input-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('input-reg-password').addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });

loadData();
