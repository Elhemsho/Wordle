const SUPABASE_URL = 'https://nhlkpscafaevbemeqyzc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5obGtwc2NhZmFldmJlbWVxeXpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNTY1MTYsImV4cCI6MjA4ODgzMjUxNn0.ywXf2afjo9XN1eMEEZLmb10638VEhu8Dmdo5qF5ctnw';

window.addEventListener('offline', () => {
  // Zeige ein Overlay an, das alles blockiert
  document.body.classList.add('is-offline');
  alert(state.lang === 'de' ? "Du bist offline. Das Spiel wurde pausiert." : "You are offline. Game paused.");
});

window.addEventListener('online', () => {
  // Overlay wieder entfernen
  document.body.classList.remove('is-offline');
});

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

// Neue Hilfsfunktion, irgendwo oben einfügen:
async function isOnline() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      method: 'HEAD',
      headers: { 'apikey': SUPABASE_KEY },
      cache: 'no-store',
      signal: AbortSignal.timeout(1500)
    });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

let DATA = null;
let state = {
  lang: 'de', currentUser: null, currentGuess: '', currentRow: 0,
  gameOver: false, targetWord: '', todayKey: '', startTime: null,
  keyColors: {}, guesses: [], ui: {},
  gameId: 0,
  isAnimating: false,  // blocks input + language switch during reveal animation
  cursorCol: 0
};

async function loadData() {
  try {
    // 1. Versuch: Lade die Konfiguration/UI aus der JSON
    const resp = await fetch('data.json');
    if (!resp.ok) throw new Error("Network response was not ok");
    DATA = await resp.json();
  } catch (e) {
    console.error("Could not fetch data.json, using minimal UI config:", e);
    // Hier nur noch das Nötigste für die UI, KEINE Wortlisten mehr!
    DATA = {
      config: { wordLength: 5, maxAttempts: 6, defaultLanguage: 'de', minGamesForLeaderboard: 3 },
      languages: { de: { name: 'Deutsch', flag: '🇩🇪' }, en: { name: 'English', flag: '🇬🇧' } },
      ui: { /* ... dein UI-Objekt von oben, aber ohne die 'words' Listen ... */ }
    };
  }

  // 2. Wortlisten laden (Deine separaten JS-Dateien)
  try {
    await loadWordlists(); 
    // Falls loadWordlists fehlschlägt, merken wir das hier
  } catch (e) {
    console.warn("Wordlists failed to load (Offline?):", e);
    showToast(state.lang === 'de' ? 'Wortlisten konnten nicht geladen werden!' : 'Could not load wordlists!');
    return; // Abbruch! Ohne Wörter kein Spiel.
  }

  // 3. WICHTIG: Sicherstellen, dass ein targetWord existiert
  // Wenn kein Wort geladen werden konnte, darf init() nicht einfach starten
  if (!state.targetWord && typeof getTargetWord === 'function') {
      try {
          state.targetWord = getTargetWord(); // Oder wie auch immer du das Wort des Tages holst
      } catch (e) {
          console.error("Target word selection failed");
      }
  }

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
  const words = lang === 'de'
    ? (DAILY_WORDS_DE.length > 0 ? DAILY_WORDS_DE : DATA.languages[lang].words)
    : (DAILY_WORDS_EN.length > 0 ? DAILY_WORDS_EN : DATA.languages[lang].words);

  const today = new Date();
  const seed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
  let hash = seed;
  hash = ((hash >> 16) ^ hash) * 0x45d9f3b;
  hash = ((hash >> 16) ^ hash) * 0x45d9f3b;
  hash = (hash >> 16) ^ hash;
  return words[Math.abs(hash) % words.length];
}
/*
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
*/
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
  setEl('stats-section-title', lang === 'de' ? 'Statistiken' : 'Statistics');
  setEl('switch-to-login', ' ' + state.ui.login);
  setEl('badge-section-title', lang === 'de' ? 'Abzeichen' : 'Badges');
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
  if (state.gameOver && state.targetWord) {
    setEl('played-sub', (state.lang === 'de' ? 'Heutiges Wort: ' : "Today's word: ") + state.targetWord);
  }
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
    setEl('ds-analyse-title', 'Reichweitenanalyse (Umami)');
    setEl('ds-analyse-text', 'Wir nutzen Umami, um die Nutzung unserer Website statistisch auszuwerten. Umami verwendet keine Cookies und speichert keine personenbezogenen Daten. Die Daten werden anonymisiert in der EU verarbeitet.');
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
    setEl('ds-analyse-title', 'Traffic Analysis (Umami)');
    setEl('ds-analyse-text', 'We use Umami to statistically evaluate the use of our website. Umami does not use cookies and does not store personal data. Data is processed anonymously within the EU.');
  }
  if (typeof updateDrawerLanguage === 'function') updateDrawerLanguage(lang);
}
async function switchLanguage(lang) {
  // 1. Verhindern, dass während Animationen gewechselt wird
  if (state.isAnimating || funState.isAnimating) return;

  // 2. Internet-Check: Sprachwechsel braucht Internet, um neue Wörter zu laden
  if (!(await isOnline())) {
    showToast(state.lang === 'de' ? 'Sprachwechsel nur mit Internet möglich!' : 'Language switch requires internet!');
    return;
  }

  // 3. Sprache anwenden
  applyLanguage(lang);

  // 4. Nur die Seite aktualisieren, die gerade wirklich offen ist
  const activePage = document.querySelector('.page.active');
  if (!activePage) return;

  const pageId = activePage.id;
  if (pageId === 'page-game') {
    // Falls wir im Spiel sind, müssen wir die neuen Wortlisten laden
    await loadData(); 
    setupGamePage();
  } 
  else if (pageId === 'page-funmode') {
    if (funState.isAnimating) return;
    // Sprach-Reset: State forcieren damit setupFunMode neu startet
    funState.guesses = [];
    funState.gameOver = false;
    setupFunMode(funState.mode);
  }
  else if (pageId === 'page-profile') setupProfilePage();
  else if (pageId === 'page-leaderboard') setupLeaderboardPage();
  else if (pageId === 'page-friends') setupFriendsPage();
  else if (pageId === 'page-friend-profile') openFriendProfile(currentFriendProfileId, currentFriendProfileName);
}

function navigate(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  if (page === 'game') setupGamePage();
  if (page === 'profile') setupProfilePage();
  if (page === 'leaderboard') setupLeaderboardPage();
  if (page === 'friends') setupFriendsPage();
  if (page === 'friend-profile') { /* setup passiert in openFriendProfile */ }
}
function startGame() {
  state.isAnimating = false;   // sicherstellen dass kein Fun-Mode-Lock übrig ist
  funState.isAnimating = false;
  navigate('game');
}

function updateHeaderAuth() {
  const authDiv = document.getElementById('header-auth');
  const userDiv = document.getElementById('header-user');
  const langSwitcher = document.querySelector('.lang-switcher'); // Wählt den Sprachumschalter aus

  if (state.currentUser) {
    // Wenn eingeloggt: Login-Buttons weg, User-Profil und Sprachwahl da
    authDiv.style.display = 'none';
    userDiv.style.display = 'flex';
    if (langSwitcher) langSwitcher.style.display = 'flex'; 
  } else {
    // Wenn nicht eingeloggt: Login-Buttons da, User-Profil und Sprachwahl weg
    authDiv.style.display = 'flex';
    userDiv.style.display = 'none';
    if (langSwitcher) langSwitcher.style.display = 'none'; 
  }
  updateFriendRequestBadge();
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
  // 1. IDs und Status zurücksetzen
  state.gameId = (state.gameId || 0) + 1;
  state.isAnimating = false;

  // 2. ERST das Wort und den Key generieren
  state.todayKey = getTodayKey(state.lang);
  state.targetWord = getDailyWord(state.lang);

  // 3. JETZT prüfen, ob das Wort geladen wurde
  if (!state.targetWord) {
    showToast(state.lang === 'de' ? "Fehler beim Laden des Wortes. Bitte Seite neu laden." : "Error loading word. Please refresh.");
    return;
  }

  // 4. Das Zielwort sicherheitshalber zu den validen Listen hinzufügen
  if (wordlistsReady) {
    VALID_WORDS_DE.add(state.targetWord);
    VALID_WORDS_EN.add(state.targetWord);
  }

  // --- LOGIK FÜR NICHT ANGEMELDETE USER (GÄSTE) ---
  if (!state.currentUser) {
    state.gameOver = false;
    state.currentGuess = '';
    state.cursorCol = 0;
    state.currentRow = 0;
    state.keyColors = {};
    state.guesses = [];
    state.startTime = Date.now();
    
    buildGrid();
    buildKeyboard();
    
    // Banner bei Gästen standardmäßig aus
    document.getElementById('played-banner').style.display = 'none';
    return;
  }

  // --- LOGIK FÜR ANGEMELDETE USER ---
  const savedGame = getGameState(state.currentUser.username, state.todayKey);
  state.gameOver = savedGame ? savedGame.gameOver : false;
  state.guesses = savedGame ? savedGame.guesses : [];
  state.currentRow = state.guesses.length; 
  state.keyColors = savedGame ? savedGame.keyColors : {};
  state.currentGuess = '';
  state.cursorCol = 0;
  state.startTime = savedGame ? savedGame.startTime : Date.now();

  // Banner zeigen, falls das Spiel schon beendet wurde
  if (state.gameOver) {
    document.getElementById('played-banner').style.display = 'block';
    setEl('played-sub', (state.lang === 'de' ? 'Heutiges Wort: ' : "Today's word: ") + state.targetWord);
  } else {
    document.getElementById('played-banner').style.display = 'none';
  }

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
      tile.addEventListener('click', () => handleTileClick(r, c));
      row.appendChild(tile);
    }
    grid.appendChild(row);
  }
}

function handleTileClick(row, col) {
  if (state.gameOver || state.isAnimating) return;
  if (!state.currentUser) return;
  if (row !== state.currentRow) return; // nur aktive Zeile
  state.cursorCol = col;
  updateCurrentRow();
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
  if (state.isAnimating) return;
  if (!state.currentUser) { showToast(state.lang === 'de' ? 'Bitte anmelden!' : 'Please login!', 'error'); return; }

  if (key === 'ArrowLeft') {
    state.cursorCol = Math.max(0, state.cursorCol - 1);
    updateCurrentRow(); return;
  }
  if (key === 'ArrowRight') {
    state.cursorCol = Math.min(DATA.config.wordLength - 1, state.cursorCol + 1);
    updateCurrentRow(); return;
  }

  if (key === '⌫' || key === 'Backspace') {
    if (state.currentGuess.length > 0) {
      state.currentGuess = state.currentGuess.slice(0, -1);
      state.cursorCol = state.currentGuess.length; // Cursor folgt dem Ende
    }
    updateCurrentRow(); return;
  }

  if (key === 'ENTER' || key === 'Enter') { submitGuess(); return; }

  if (/^[A-ZÄÖÜa-zäöü]$/.test(key)) {
  const arr = state.currentGuess.padEnd(DATA.config.wordLength, ' ').split('');
  arr[state.cursorCol] = key.toUpperCase();
  state.currentGuess = arr.join('').trimEnd();
  if (state.cursorCol < DATA.config.wordLength - 1) state.cursorCol++;
  updateCurrentRow();
}
}

function updateCurrentRow() {
  for (let c = 0; c < DATA.config.wordLength; c++) {
    const tile = document.getElementById(`tile-${state.currentRow}-${c}`);
    if (tile) {
      const char = state.currentGuess[c] || '';
      tile.textContent = char;
      let cls = 'grid-tile';
      if (char) cls += ' filled';
      if (c === state.cursorCol && !state.gameOver && !state.isAnimating) cls += ' cursor';
      tile.className = cls;
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

// 1. FIX: Hier muss "async" vor function stehen, damit await funktioniert
async function submitGuess() {
  // 1. ALLE SPERREN AM ANFANG ENTFERNT (Damit es auf Netlify/Handy sicher läuft)
  if (!(await isOnline())) {
    showToast(state.lang === 'de' ? 'Keine Internetverbindung!' : 'No internet connection!', 'error');
    return;
  }
  const guessArr = (state.currentGuess || '').padEnd(DATA.config.wordLength, '').split('');
  const filledCount = guessArr.filter(c => c.trim()).length;
  
  if (filledCount < DATA.config.wordLength) { 
    if (typeof shakeRow === 'function') shakeRow(state.currentRow); 
    showToast(state.ui.wordTooShort, 'error'); 
    return; 
  }

  if (wordlistsReady) {
    const validSet = state.lang === 'de' ? VALID_WORDS_DE : VALID_WORDS_EN;
    if (!validSet.has(state.currentGuess)) {
      if (typeof shakeRow === 'function') shakeRow(state.currentRow);
      showToast(state.ui.invalidWord, 'error');
      return;
    }
  }

  const guess = (state.currentGuess || '').padEnd(DATA.config.wordLength, ' ').substring(0, DATA.config.wordLength).toUpperCase();
  const result = evaluateGuess(guess, state.targetWord);
  const rowIdx = state.currentRow;
  const capturedGameId = state.gameId;

  // State sofort lokal aktualisieren
  state.currentGuess = '';
  state.cursorCol = 0;
  state.currentRow++;
  state.guesses.push(guess);
  if (typeof updateCurrentRow === 'function') updateCurrentRow(); 

  const won = result.every(r => r === 'correct');

  // Animation und Abschluss
  revealRow(rowIdx, guess, result, async () => {
     if (won || state.currentRow >= DATA.config.maxAttempts) {
      state.gameOver = true;
      // Banner NICHT hier zeigen — erst nach Animation in showResult
      
      saveCurrentGame();
      
      if (state.currentUser) {
        const isOnline = navigator.onLine;
        if (!isOnline) {
          state._offlineWarningPending = true;
        } else {
          try {
            await updateStats(won);
          } catch (e) {
            console.error("Sync failed:", e);
            // Nochmal prüfen falls Verbindung während Request weg
            if (!navigator.onLine) {
              state._offlineWarningPending = true;
            }
          }
        }
      }
      
      showResult(won);
    } else {
      saveCurrentGame();
      state.cursorCol = 0;
      if (typeof updateCurrentRow === 'function') updateCurrentRow();
    }
  });
}

function revealRow(rowIdx, guess, result, callback) {
  const stagger = 300;
  const flipMs = 600;
  const flipHalf = flipMs / 2;
  const totalDuration = (DATA.config.wordLength - 1) * stagger + flipMs;

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
    callback();
    state.isAnimating = false;
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

    // ✅ FIX: Verhindere doppeltes Zählen wenn heute schon gespielt wurde
    if (s && s.last_played_date === today) return;

    let streak = s ? (s.streak || 0) : 0, bestStreak = s ? (s.best_streak || 0) : 0;
    let played = (s ? s.played : 0) + 1, wonCount = s ? s.won : 0, totalAttempts = s ? s.total_attempts : 0;
    if (won) {
      wonCount++; totalAttempts += state.guesses.length; // ✅ FIX: guesses.length statt currentRow
      const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
if (s && s.last_played_date === yesterday.toDateString()) streak++;
      else streak = 1;
      bestStreak = Math.max(bestStreak, streak);
      checkAndAwardBadges({
  mode: 'daily',
  won,
  guesses: won ? state.guesses.length : 7
});
    } else { streak = 0; totalAttempts += 6;}

    // ✅ FIX: last_played_date immer auf heute setzen (auch bei Niederlage)
    const statsData = { user_id: userId, lang, played, won: wonCount, total_attempts: totalAttempts, streak, best_streak: bestStreak, last_played_date: today };
    if (s) await sbFetch(`stats?user_id=eq.${userId}&lang=eq.${lang}`, { method: 'PATCH', body: JSON.stringify(statsData), prefer: 'return=minimal' });
    else await sbFetch('stats', { method: 'POST', body: JSON.stringify(statsData), prefer: 'return=minimal' });

    const correctDayKey = getTodayKey(lang); // statt state.todayKey
const lbEx = await sbFetch(`leaderboard?user_id=eq.${userId}&lang=eq.${lang}&day_key=eq.${correctDayKey}`);

if (!lbEx || lbEx.length === 0) {
  await sbFetch('leaderboard', { method: 'POST', body: JSON.stringify({
    user_id: userId, username: state.currentUser.username, lang,
    day_key: state.todayKey,
    attempts: won ? state.guesses.length : 7,
    time_seconds: elapsedSec
  }), prefer: 'return=minimal' });
}
  } catch (e) { console.error('Stats error:', e); throw e;}
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
  const banner = document.getElementById('played-banner');
  if (banner) {
    setEl('played-sub', (state.lang === 'de' ? 'Heutiges Wort: ' : "Today's word: ") + state.targetWord);
    banner.style.display = 'block';
  }
  document.getElementById('result-overlay').classList.add('open');
  startResultCountdown();
  if (state._offlineWarningPending) {
    const msg = state.lang === 'de'
      ? 'Keine Verbindung – Statistik nicht gespeichert.'
      : 'Offline – stats not saved.';
    document.getElementById('offline-warning-banner').textContent = msg;
    document.getElementById('offline-warning-banner').style.display = 'block';
    state._offlineWarningPending = false;
  } else {
    document.getElementById('offline-warning-banner').style.display = 'none';
  }
}

function closeResult() {
  document.getElementById('result-overlay').classList.remove('open');
  document.getElementById('offline-warning-banner').style.display = 'none';
  // played-sub sofort korrekt befüllen
  if (state.gameOver && state.targetWord) {
    setEl('played-sub', (state.lang === 'de' ? 'Heutiges Wort: ' : "Today's word: ") + state.targetWord);
    const banner = document.getElementById('played-banner');
    if (banner) banner.style.display = 'block';
  }
}

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
  const de2 = state.lang === 'de';
const editTitle = de2 ? 'Bearbeiten' : 'Edit';

const unameEl = document.getElementById('profile-username');
unameEl.innerHTML = `${state.currentUser.username} <button class="edit-icon-btn" title="${editTitle}" onclick="updateUsernameOrEmail('username')">✏️</button>`;

const emailEl = document.getElementById('profile-email');
emailEl.innerHTML = `${state.currentUser.email} <button class="edit-icon-btn" title="${editTitle}" onclick="updateUsernameOrEmail('email')">✏️</button>`;
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
    document.getElementById('stat-avg').textContent = s && s.played ? (s.total_attempts / s.played).toFixed(1) : '—';
    document.getElementById('stat-winrate').textContent = s && s.played ? Math.round((s.won / s.played) * 100) + '%' : '0%';
  } catch (e) { console.error('Profile error:', e); }
}

async function updateUsernameOrEmail(field) {
  const de = state.lang === 'de';
  const isUsername = field === 'username';

  const currentVal = isUsername ? state.currentUser.username : state.currentUser.email;
  const label = isUsername
    ? (de ? 'Neuer Benutzername' : 'New username')
    : (de ? 'Neue E-Mail-Adresse' : 'New email address');

  const newVal = prompt(label + ':', currentVal);
  if (!newVal || newVal.trim() === currentVal) return;
  const trimmed = newVal.trim();

  // Validierung
  if (isUsername && trimmed.length < 2) {
    showToast(de ? 'Name zu kurz (mind. 2 Zeichen)' : 'Name too short (min. 2 chars)', 'error'); return;
  }
  if (!isUsername && !trimmed.includes('@')) {
    showToast(de ? 'Ungültige E-Mail' : 'Invalid email', 'error'); return;
  }

  try {
    // 1. users-Tabelle updaten
    await sbFetch(`users?id=eq.${state.currentUser.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ [field]: trimmed }),
      prefer: 'return=minimal'
    });

    // 2. Falls Username geändert: leaderboard-Einträge mitziehen
    if (isUsername) {
      await sbFetch(`leaderboard?user_id=eq.${state.currentUser.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ username: trimmed }),
        prefer: 'return=minimal'
      });
    }

    // 3. Session + State aktualisieren
    state.currentUser[field] = trimmed;
    saveSessionUser(state.currentUser);

    showToast(de ? 'Erfolgreich gespeichert ✓' : 'Saved successfully ✓', 'success');
    setupProfilePage(); // Profil neu rendern
  } catch (e) {
    const dupMsg = e.message.includes('unique')
      ? (de ? 'Name oder E-Mail bereits vergeben!' : 'Username or email already taken!')
      : (de ? 'Fehler beim Speichern.' : 'Error saving.');
    showToast(dupMsg, 'error');
  }
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

${lbState.tab === 'all' ? `<div style="font-size: 0.7rem; color: var(--text-muted); text-align: center; margin-bottom: 8px;">
        ${de ? 'Mindestens 3 Spiele erforderlich' : 'Min. 3 games required'}
    </div>` : ''}

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
    : [{ key: 'avg', label: de ? 'Ø Versuche' : 'Avg. Attempts' }, { key: 'wins', label: de ? 'Siege' : 'Wins' }, { key: 'winrate', label: de ? 'Win Rate' : 'Win Rate' }, { key: 'streak', label: de ? 'Aktuelle Serie' : 'Current Streak' }, { key: 'best', label: de ? 'Längste Serie' : 'Best Streak' }];
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
        const attemptsDisplay = e.attempts === 7 ? '✕' : `${e.attempts}/${DATA.config.maxAttempts}`;
        const hi = lbState.sortToday === 'time'
          ? `<div class="lb-stat-hi">${formatTime(e.time_seconds)}</div><div class="lb-stat-lo">${attemptsDisplay}</div>`
          : `<div class="lb-stat-hi">${attemptsDisplay}</div><div class="lb-stat-lo">${formatTime(e.time_seconds)}</div>`;
        return `<div class="lb-entry rank-${i+1}${isMe ? ' current-user' : ''}" data-uid="${e.user_id}" style="animation-delay:${i*0.06}s">
          ${rank}
          <div class="lb-avatar">${e.username[0].toUpperCase()}</div>
          <div class="lb-name">
            <span class="lb-name-click" data-uid="${e.user_id}" data-name="${e.username}">${e.username}</span>
            ${isMe ? `<span class="lb-you">${de ? 'Du' : 'You'}</span>` : ''}
          </div>
          ${hi}
        </div>`;
      }).join('');
    } else {
      const sort = lbState.sortAll;
      const order = sort === 'avg' ? 'total_attempts.asc,won.desc' : sort === 'streak' ? 'streak.desc,best_streak.desc' : sort === 'best' ? 'best_streak.desc,streak.desc' : sort === 'wins' ? 'won.desc,played.asc' : 'won.desc,played.asc';
      let rows = await sbFetch(`stats?lang=eq.${state.lang}&won=gt.0&played=gte.3&order=${order}&limit=10&select=*,users(username)`);
      if (!rows || rows.length === 0) {
        list.innerHTML = `<div class="lb-empty">${de ? 'Noch nicht genug Daten (min. 3 Spiele nötig).' : 'Not enough data yet (min. 3 games required).'}</div>`;
        return;
      }
      if (sort === 'winrate') {
        rows = rows.sort((a, b) => {
          const rateA = a.played > 0 ? a.won / a.played : 0;
          const rateB = b.played > 0 ? b.won / b.played : 0;
          if (rateB !== rateA) return rateB - rateA;
          return b.won - a.won;
        });
      } else if (sort === 'avg') {
        rows = rows.sort((a, b) => {
          const avgA = a.played > 0 ? a.total_attempts / a.played : 0;
          const avgB = b.played > 0 ? b.total_attempts / b.played : 0;
          if (avgA !== avgB) return avgA - avgB;
          return b.won - a.won;
        });
      } else if (sort === 'wins') {
        rows = rows.sort((a, b) => {
          if (b.won !== a.won) return b.won - a.won;
          return a.played - b.played;
        });
      }
      list.innerHTML = rows.map((s, i) => {
        const isMe = state.currentUser && s.user_id === state.currentUser.id;
        const rank = i < 3 ? `<span class="lb-rank-medal">${medals[i]}</span>` : `<span class="lb-rank">#${i+1}</span>`;
        const name = s.users?.username || s.username || '?';
        const avg = s.played > 0 ? (s.total_attempts / s.played).toFixed(1) : '—';
        const winrate = s.played > 0 ? Math.round((s.won / s.played) * 100) + '%' : '0%';
        const hi = sort === 'avg'
          ? `<div class="lb-stat-hi">${avg}</div><div class="lb-stat-lo">${s.won}W / ${s.played}G</div>`
          : sort === 'wins'
          ? `<div class="lb-stat-hi">🏆 ${s.won}</div><div class="lb-stat-lo" style="color:var(--text-muted)">${s.played - s.won} L</div>`
          : sort === 'winrate'
          ? `<div class="lb-stat-hi">${winrate}</div><div class="lb-stat-lo">${s.won}W / ${s.played}G</div>`
          : sort === 'streak'
          ? `<div class="lb-stat-hi">🔥 ${s.streak}</div><div class="lb-stat-lo">${de ? 'Beste' : 'Best'}: ${s.best_streak}</div>`
          : `<div class="lb-stat-hi">🏆 ${s.best_streak}</div><div class="lb-stat-lo">${de ? 'Aktuell' : 'Now'}: ${s.streak}</div>`;
        return `<div class="lb-entry rank-${i+1}${isMe ? ' current-user' : ''}" data-uid="${s.user_id}" style="animation-delay:${i*0.06}s">
          ${rank}
          <div class="lb-avatar">${name[0].toUpperCase()}</div>
          <div class="lb-name">
            <span class="lb-name-click" data-uid="${s.user_id}" data-name="${name}">${name}</span>
            ${isMe ? `<span class="lb-you">${de ? 'Du' : 'You'}</span>` : ''}
          </div>
          ${hi}
        </div>`;
      }).join('');
    }

    // Pinned Badges im Leaderboard
    try {
      const allUids = [...document.querySelectorAll('.lb-name-click')].map(s => s.dataset.uid).filter(Boolean);
      await Promise.all(allUids.map(async uid => {
        const pinned = await loadPinnedBadges(uid);
        if (!pinned.length) return;
        const span = document.querySelector(`.lb-name-click[data-uid="${uid}"]`);
        if (!span) return;
        const html = pinned.map(bid => {
          const def = getBadgeDef(bid);
          if (!def) return '';
          return `<span class="lb-pinned-badge tier-${def.tier}" title="${def.name[state.lang]}">${def.emoji}</span>`;
        }).join('');
        span.insertAdjacentHTML('afterend', `<span class="lb-pinned">${html}</span>`);
      }));
    } catch(e) {}

    // Freund-Icons
    if (state.currentUser) {
      try {
        const friendIds = await getFriendIds(state.currentUser.id);
        document.querySelectorAll('.lb-name-click').forEach(span => {
          if (friendIds.has(span.dataset.uid)) {
            span.insertAdjacentHTML('afterend', '<span class="lb-friend-icon">👥</span>');
          }
        });
      } catch(e) {}
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

function showToast(msg, type = 'info', duration = 3000, isBoard = false) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type} ${isBoard ? 'toast-board' : ''}`;
  toast.innerHTML = msg;
  
  container.appendChild(toast);

  const close = () => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
    document.removeEventListener('click', close);
    document.removeEventListener('touchstart', close);
  };

  // Wenn es ein Board ist, überall Klicks erlauben zum Schließen
  if (isBoard) {
    setTimeout(() => {
      document.addEventListener('click', close);
      document.addEventListener('touchstart', close, { passive: true });
    }, 400); // 400ms Sperre, damit der "Senden"-Klick nicht zählt
  }

  // Für normale Toasts: Auto-Close
  setTimeout(() => { if(toast.parentNode) close(); }, duration);
}

document.addEventListener('keydown', e => {
  if (document.getElementById('modal-overlay').classList.contains('open')) return;
  if (!document.getElementById('page-game').classList.contains('active')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Backspace') { handleKey('Backspace'); return; }
  if (e.key === 'Enter') { handleKey('Enter'); return; }
  if (e.key === 'ArrowLeft') { e.preventDefault(); handleKey('ArrowLeft'); return; }
  if (e.key === 'ArrowRight') { e.preventDefault(); handleKey('ArrowRight'); return; }
  if (/^[a-zA-ZäöüÄÖÜ]$/.test(e.key)) handleKey(e.key.toUpperCase());
});
document.getElementById('input-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('input-reg-password').addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });

// ===== DRAWER =====
function toggleDrawer() {
  const drawer = document.getElementById('side-drawer');
  const overlay = document.getElementById('drawer-overlay');
  const open = drawer.classList.toggle('open');
  overlay.classList.toggle('open', open);
}
function closeDrawer() {
  document.getElementById('side-drawer').classList.remove('open');
  document.getElementById('drawer-overlay').classList.remove('open');
}

// ===== FUN MODE =====
const FUN_CONFIG = {
  solo:    { grids: 1, attempts: 6 },
  dordle:  { grids: 2, attempts: 7 },
  quordle: { grids: 4, attempts: 9 },
  octordle:{ grids: 8, attempts: 13 }
};

let funState = {
  mode: 'solo', targets: [], guesses: [], gridDone: [],
  currentGuess: '', cursorCol: 0, gameOver: false, isAnimating: false,
  keySegments: {}, wordLength: 5
};

function getRandomWord(lang) {
  const list = lang === 'de'
    ? (typeof DAILY_WORDS_DE !== 'undefined' && DAILY_WORDS_DE.length > 0 ? DAILY_WORDS_DE : [])
    : (typeof DAILY_WORDS_EN !== 'undefined' && DAILY_WORDS_EN.length > 0 ? DAILY_WORDS_EN : []);
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

function setupFunMode(mode) {
  if (funState.isAnimating) return; 
    if (funState.guesses.length > 0 && !funState.gameOver && mode === funState.mode) return;
  funState.mode = mode;
  const cfg = FUN_CONFIG[mode];
  const lang = state.lang;

  const targets = [];
  const used = new Set();
  for (let i = 0; i < cfg.grids; i++) {
    let w, tries = 0;
    do { w = getRandomWord(lang); tries++; } while (used.has(w) && tries < 300);
    if (!w) { showToast(lang === 'de' ? 'Wortlisten nicht geladen!' : 'Wordlists not loaded!', 'error'); return; }
    used.add(w);
    targets.push(w);
  }

  funState = {
    mode, targets, guesses: [],
    gridDone: Array(cfg.grids).fill(false),
    currentGuess: '', cursorCol: 0,
    gameOver: false, isAnimating: false,
    keySegments: {}, wordLength: DATA.config.wordLength,
    visibleRows: 0,
    sessionId: Date.now()   // ← neu
  };

  const modeNames = {
    de: { solo: 'WÖRDLE', dordle: 'DORDLE', quordle: 'QUORDLE', octordle: 'OCTORDLE' },
    en: { solo: 'WORDLE', dordle: 'DORDLE', quordle: 'QUORDLE', octordle: 'OCTORDLE' }
  };
  setEl('funmode-title', modeNames[lang][mode]);

  navigate('funmode');
  buildFunGrids(cfg, targets);
  buildFunKeyboard(lang, cfg.grids);
  updateFunCurrentRow();
}

function buildFunGrids(cfg, targets) {
  const container = document.getElementById('funmode-grids');
  container.innerHTML = '';
  container.className = `funmode-grids grids-${cfg.grids}`;

  // --- NEU: Dynamische Berechnung der sichtbaren Reihen ---
  let initialVisible;

  if (cfg.grids === 4 || cfg.grids === 8) {
  const w = window.innerWidth;
  if (cfg.grids === 8) {
    if (w >= 900)       initialVisible = 5;
    else if (w >= 800)   initialVisible = 4;
    else if (w >= 600)   initialVisible = 3;
    else                 initialVisible = 3;
  } else {
    // Quordle bleibt wie bisher
    if (w < 450)         initialVisible = 6;
    else if (w >= 900)   initialVisible = 6;
    else if (w >= 800)   initialVisible = 6;
    else if (w < 800)    initialVisible = 4;
    else                 initialVisible = 3;
  }
} else {
    // Für Solo oder Dordle (2 Grids) bleiben alle Versuche sichtbar
    initialVisible = cfg.attempts;
}

  funState.visibleRows = initialVisible;
  // -------------------------------------------------------

  for (let g = 0; g < cfg.grids; g++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'fun-grid-wrapper';
    wrapper.id = `fun-grid-wrapper-${g}`;

    const label = document.createElement('div');
    label.className = 'fun-grid-label';
    label.id = `fun-grid-label-${g}`;
    label.textContent = cfg.grids > 1 ? `#${g + 1}` : '';
    wrapper.appendChild(label);

    const grid = document.createElement('div');
    grid.className = 'fun-grid';
    grid.id = `fun-grid-${g}`;

    for (let r = 0; r < cfg.attempts; r++) {
      const row = document.createElement('div');
      row.className = 'grid-row'; 
      row.id = `fun-row-${g}-${r}`;
      
      // Rows über initialVisible verstecken
      if (r >= initialVisible) row.style.display = 'none';

      for (let c = 0; c < funState.wordLength; c++) {
        const tile = document.createElement('div');
        tile.className = 'fun-tile grid-tile';
        tile.id = `fun-tile-${g}-${r}-${c}`;
        tile.addEventListener('click', () => handleFunTileClick(g, r, c));
        row.appendChild(tile);
      }
      grid.appendChild(row);
    }
    wrapper.appendChild(grid);
    container.appendChild(wrapper);
  }
}

function restartFunMode() {
  if (funState.isAnimating) return;
  funState.guesses = [];
  funState.gameOver = false;
  setupFunMode(funState.mode);
}

function handleFunTileClick(gridIdx, rowIdx, col) {
  if (funState.gameOver || funState.isAnimating) return;
  if (rowIdx !== funState.guesses.length) return; // nur aktive Zeile
  if (funState.gridDone[gridIdx]) return;
  funState.cursorCol = col;
  updateFunCurrentRow();
}

function buildFunKeyboard(lang, numGrids) {
  const keyboard = document.getElementById('funmode-keyboard');
  if (!keyboard) return;
  keyboard.innerHTML = '';
  const rows = lang === 'de'
    ? [['Q','W','E','R','T','Z','U','I','O','P','Ü'],['A','S','D','F','G','H','J','K','L','Ö','Ä'],['ENTER','Y','X','C','V','B','N','M','⌫']]
    : [['Q','W','E','R','T','Y','U','I','O','P'],['A','S','D','F','G','H','J','K','L'],['ENTER','Z','X','C','V','B','N','M','⌫']];

  rows.forEach(row => {
    const rowEl = document.createElement('div');
    rowEl.className = 'keyboard-row';
    row.forEach(key => {
      const btn = document.createElement('button');
      const isWide = key === 'ENTER' || key === '⌫';
      btn.className = 'key fun-key' + (isWide ? ' wide' : '');
      btn.dataset.key = key;
      btn.id = `fun-key-${key}`;

      if (isWide || numGrids === 1) {
        btn.textContent = key === 'ENTER' ? (state.ui?.submit || 'ENTER') : key;
      }

      if (!isWide) {
        const letterSpan = document.createElement('span');
        letterSpan.className = 'key-letter';
        letterSpan.textContent = key;
        btn.innerHTML = '';
        btn.appendChild(letterSpan);

        if (numGrids > 1) {
          btn.setAttribute('data-multi', '1');
          const segWrap = document.createElement('div');
          segWrap.className = `key-segments segs-${numGrids}`;
          segWrap.id = `fun-key-segs-${key}`;
          for (let s = 0; s < numGrids; s++) {
            const seg = document.createElement('div');
            seg.className = 'key-seg';
            seg.id = `fun-seg-${key}-${s}`;
            segWrap.appendChild(seg);
          }
          btn.appendChild(segWrap);
        }
      }

      btn.addEventListener('click', () => handleFunKey(key));
      rowEl.appendChild(btn);
    });
    keyboard.appendChild(rowEl);
  });
}

function handleFunKey(key) {
  if (funState.gameOver || funState.isAnimating) return;
  if (key === 'ArrowLeft') { funState.cursorCol = Math.max(0, funState.cursorCol - 1); updateFunCurrentRow(); return; }
  if (key === 'ArrowRight') { funState.cursorCol = Math.min(funState.wordLength - 1, funState.cursorCol + 1); updateFunCurrentRow(); return; }
  if (key === '⌫' || key === 'Backspace') {
    if (funState.currentGuess.length > 0) { funState.currentGuess = funState.currentGuess.slice(0, -1); funState.cursorCol = funState.currentGuess.length; }
    updateFunCurrentRow(); return;
  }
  if (key === 'ENTER' || key === 'Enter') { submitFunGuess(); return; }
  if (/^[A-ZÄÖÜa-zäöü]$/.test(key)) {
    const arr = funState.currentGuess.padEnd(funState.wordLength, ' ').split('');
    arr[funState.cursorCol] = key.toUpperCase();
    funState.currentGuess = arr.join('').trimEnd();
    if (funState.cursorCol < funState.wordLength - 1) funState.cursorCol++;
    updateFunCurrentRow();
  }
}

function updateFunCurrentRow() {
  const rowIdx = funState.guesses.length;
  if (rowIdx === 0 && funState.guesses.length === 0) {
    console.trace('updateFunCurrentRow called with rowIdx=0, stack:');
  }
  
  const cfg = FUN_CONFIG[funState.mode];
  for (let g = 0; g < cfg.grids; g++) {
    if (funState.gridDone[g]) continue;
    for (let c = 0; c < funState.wordLength; c++) {
      const tile = document.getElementById(`fun-tile-${g}-${rowIdx}-${c}`);
      if (!tile) continue;
      const char = funState.currentGuess[c] || '';
      tile.textContent = char;
      let cls = 'fun-tile grid-tile';
      if (char) cls += ' filled';
      if (c === funState.cursorCol && !funState.gameOver && !funState.isAnimating) cls += ' cursor';
      tile.className = cls;
    }
  }
}

function submitFunGuess() {
  const lang = state.lang;
  const cfg = FUN_CONFIG[funState.mode];
  const rowIdx = funState.guesses.length;
  const guessRaw = funState.currentGuess || '';
  const filled = guessRaw.replace(/ /g, '').length;

  function shakeFun() {
    for (let g = 0; g < cfg.grids; g++) {
      if (funState.gridDone[g]) continue;
      document.getElementById(`fun-row-${g}-${rowIdx}`)?.querySelectorAll('.fun-tile').forEach(t => {
        t.classList.add('shake'); t.addEventListener('animationend', () => t.classList.remove('shake'), { once: true });
      });
    }
  }

  if (filled < funState.wordLength) { shakeFun(); showToast(state.ui.wordTooShort, 'error'); return; }

  if (wordlistsReady) {
    const validSet = lang === 'de' ? VALID_WORDS_DE : VALID_WORDS_EN;
    if (!validSet.has(guessRaw.toUpperCase()) && !validSet.has(guessRaw)) { shakeFun(); showToast(state.ui.invalidWord, 'error'); return; }
  }

  funState.isAnimating = true;
  const capturedSessionId = funState.sessionId;

  const guess = guessRaw.padEnd(funState.wordLength, ' ').substring(0, funState.wordLength).toUpperCase();
  funState.currentGuess = '';
  funState.cursorCol = 0;
  funState.guesses.push(guess);

  const results = funState.targets.map(t => evaluateGuess(guess, t));

  for (let g = 0; g < cfg.grids; g++) {
    const row = document.getElementById(`fun-row-${g}-${rowIdx}`);
    if (row) row.style.display = '';
  }
  let pending = 0;
  for (let g = 0; g < cfg.grids; g++) { if (!funState.gridDone[g]) pending++; }
  let done = 0;
  for (let g = 0; g < cfg.grids; g++) {
    if (funState.gridDone[g]) continue;
    revealFunRow(g, rowIdx, guess, results[g], () => {
      if (funState.sessionId !== capturedSessionId) return;  // ← neu
      done++;
      if (done === pending) afterFunReveal(rowIdx, results);
    });
  }
  setTimeout(() => {
    const t = document.getElementById(`fun-tile-0-${rowIdx}-0`);
    console.log('Tile nach 50ms:', t?.textContent, t?.className, t?.style.display);
  }, 50);
  setTimeout(() => {
    const t = document.getElementById(`fun-tile-0-${rowIdx}-0`);
    console.log('Tile nach 500ms:', t?.textContent, t?.className, t?.style.display);
  }, 500);

  for (let i = 0; i < funState.wordLength; i++) {
    const delay = i * 350 + 480 + 50; // nach dem Flip des i-ten Buchstabens
    setTimeout(() => updateFunKeySegmentForIndex(guess, results, cfg.grids, i), delay);
  }
}

// Neue Funktion einfügen (z.B. direkt nach updateFunKeySegments):
function updateFunKeySegmentForIndex(guess, results, numGrids, i) {
  const priority = { correct: 3, present: 2, absent: 1 };
  const letter = guess[i];
  if (!letter || !letter.trim()) return;
  if (!funState.keySegments[letter]) funState.keySegments[letter] = Array(numGrids).fill(null);
  for (let g = 0; g < numGrids; g++) {
    const s = results[g][i];
    const cur = funState.keySegments[letter][g];
    if (!cur || priority[s] > priority[cur]) {
      funState.keySegments[letter][g] = s;
      if (numGrids > 1) {
        const seg = document.getElementById(`fun-seg-${letter}-${g}`);
        if (seg) seg.className = 'key-seg ' + s;
      } else {
        const keyEl = document.getElementById(`fun-key-${letter}`);
        if (keyEl) {
          const existing = keyEl.dataset.colorStatus;
          const kPriority = { correct: 3, present: 2, absent: 1 };
          if (!existing || kPriority[s] > kPriority[existing]) {
            keyEl.dataset.colorStatus = s;
            keyEl.className = 'key fun-key' + (keyEl.classList.contains('wide') ? ' wide' : '') + ' ' + s;
          }
        }
      }
    }
  }
}

function revealFunRow(gridIdx, rowIdx, guess, result, callback) {
  const stagger = 300;
  const flipMs = 600;
  const flipHalf = flipMs / 2;
  const total = (DATA.config.wordLength - 1) * stagger + flipMs;
  const wl = funState.wordLength;

  for (let c = 0; c < wl; c++) {
    const tile = document.getElementById(`fun-tile-${gridIdx}-${rowIdx}-${c}`);
    if (!tile) continue;
    setTimeout(() => {
      tile.style.transition = `transform ${flipHalf}ms ease-in`;
      tile.style.transform = 'scaleY(0)';
      setTimeout(() => {
        tile.textContent = guess[c];
        tile.className = 'fun-tile grid-tile ' + result[c];
        tile.style.transition = `transform ${flipHalf}ms ease-out`;
        tile.style.transform = 'scaleY(1)';
      }, flipHalf);
    }, c * stagger);
  }

  setTimeout(() => { callback(); }, total);
}

function updateFunKeySegments(guess, results, numGrids) {
  const priority = { correct: 3, present: 2, absent: 1 };
  for (let i = 0; i < funState.wordLength; i++) {
    const letter = guess[i];
    if (!letter || !letter.trim()) continue;
    if (!funState.keySegments[letter]) funState.keySegments[letter] = Array(numGrids).fill(null);

    for (let g = 0; g < numGrids; g++) {
      const s = results[g][i];
      const cur = funState.keySegments[letter][g];
      if (!cur || priority[s] > priority[cur]) {
        funState.keySegments[letter][g] = s;
        if (numGrids > 1) {
          const seg = document.getElementById(`fun-seg-${letter}-${g}`);
          if (seg) seg.className = 'key-seg ' + s;
        } else {
          const keyEl = document.getElementById(`fun-key-${letter}`);
          if (keyEl) {
            const kPriority = { correct: 3, present: 2, absent: 1 };
            const existing = keyEl.dataset.colorStatus;
            if (!existing || kPriority[s] > kPriority[existing]) {
              keyEl.dataset.colorStatus = s;
              keyEl.className = 'key fun-key' + (keyEl.classList.contains('wide') ? ' wide' : '') + ' ' + s;
            }
          }
        }
      }
    }
  }
}

function afterFunReveal(rowIdx, results) {
   funState.isAnimating = false;
  const lang = state.lang;

  const cfg = FUN_CONFIG[funState.mode];
  // Nur bei Quordle (4) oder Octordle (8)
if ((cfg.grids === 4 || cfg.grids === 8) && funState.visibleRows < cfg.attempts) {
    
    // NEU: Nur erhöhen, wenn wir gerade in die LETZTE sichtbare Zeile geschrieben haben
    // rowIdx ist 0-basiert, also ist (rowIdx + 1) die Nummer des aktuellen Versuchs.
    if ((rowIdx + 1) >= funState.visibleRows) {
        
        funState.visibleRows++;
        
        for (let g = 0; g < cfg.grids; g++) {
            const nextRow = document.getElementById(`fun-row-${g}-${funState.visibleRows - 1}`);
            // Wir nutzen 'flex', damit die Zeile korrekt erscheint (oder dein Standard-Display)
            if (nextRow) nextRow.style.display = ''; 
        }
    }
}

  for (let g = 0; g < cfg.grids; g++) {
    if (funState.gridDone[g]) continue;
    const won = results[g].every(r => r === 'correct');
    if (won || rowIdx + 1 >= cfg.attempts) {
      funState.gridDone[g] = true;
      const wrapper = document.getElementById(`fun-grid-wrapper-${g}`);
      const label = document.getElementById(`fun-grid-label-${g}`);
      if (won) {
        if (wrapper) wrapper.classList.add('grid-solved');
        if (label) label.textContent = '✓ ' + funState.targets[g];
      } else {
        if (wrapper) wrapper.classList.add('grid-failed');
        if (label) label.textContent = '✕ ' + funState.targets[g];
      }
    }
  }

  const allDone = funState.gridDone.every(d => d);
  if (allDone || rowIdx + 1 >= cfg.attempts) {
    funState.gameOver = true;
    setTimeout(() => {
      const solvedCount = funState.targets.filter(t => funState.guesses.includes(t)).length;
      const allWon = solvedCount === cfg.grids;
      
      const de = lang === 'de';
      let msg;
      if (allWon && state.currentUser) {
  recordFunWin(funState.mode);
  checkAndAwardBadges({ mode: funState.mode, won: true });
}
      if (cfg.grids === 1) {
        msg = allWon
          ? (de ? `🎉 Gelöst in ${funState.guesses.length} Versuch${funState.guesses.length === 1 ? '' : 'en'}!` : `🎉 Solved in ${funState.guesses.length} attempt${funState.guesses.length === 1 ? '' : 's'}!`)
          : (de ? `Das Wort war: ${funState.targets[0]}` : `The word was: ${funState.targets[0]}`);
      } else {
        msg = allWon
  ? (de ? `🎉 Alle ${cfg.grids} Wörter gefunden!` : `🎉 All ${cfg.grids} words found!`)
  : (de ? `<b>${solvedCount}/${cfg.grids} Wörter gefunden:</b><br>` : `<b>${solvedCount}/${cfg.grids} words found:</b><br>`)
    + funState.targets.map((t) => (funState.guesses.includes(t) ? '✓' : '✕') + ' ' + t).join('<br>'); 
    // .join('<br>') sorgt dafür, dass jedes Wort eine neue Zeile bekommt
      }
      showToast(msg, allWon ? 'success' : 'info', 8000, true);
    }, 600);
  } else {
    updateFunCurrentRow();
  }
}

document.addEventListener('keydown', e => {
  if (!document.getElementById('page-funmode')?.classList.contains('active')) return;
  if (document.getElementById('modal-overlay').classList.contains('open')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Backspace') { handleFunKey('Backspace'); return; }
  if (e.key === 'Enter') { handleFunKey('Enter'); return; }
  if (e.key === 'ArrowLeft') { e.preventDefault(); handleFunKey('ArrowLeft'); return; }
  if (e.key === 'ArrowRight') { e.preventDefault(); handleFunKey('ArrowRight'); return; }
  if (/^[a-zA-ZäöüÄÖÜ]$/.test(e.key)) handleFunKey(e.key.toUpperCase());
});

function updateDrawerLanguage(lang) {
  const de = lang === 'de';
  setEl('drawer-title', de ? 'SPIELMODI' : 'GAME MODES');
  setEl('drawer-label-daily', de ? 'Täglich' : 'Daily');
  setEl('drawer-label-fun', de ? 'Spielwiese' : 'Playground');
  setEl('drawer-name-daily', de ? 'Wördle' : 'Wordle');
  setEl('drawer-desc-daily', de ? 'Wort des Tages' : 'Word of the Day');
  setEl('drawer-name-solo', de ? 'Wördle' : 'Wordle');
  setEl('drawer-desc-solo', de ? '1 Wort · 6 Versuche · Ungewertet' : '1 Word · 6 Attempts · Unranked');
  setEl('drawer-desc-dordle', de ? '2 Wörter · 7 Versuche' : '2 Words · 7 Attempts');
  setEl('drawer-desc-quordle', de ? '4 Wörter · 9 Versuche' : '4 Words · 9 Attempts');
  setEl('drawer-desc-octordle', de ? '8 Wörter · 13 Versuche' : '8 Words · 13 Attempts');
  setEl('funmode-back-label', de ? 'Zurück' : 'Back');
  setEl('funmode-restart-label', de ? 'Neu' : 'New');
  if (document.getElementById('page-funmode')?.classList.contains('active')) {
    const cfg = FUN_CONFIG[funState.mode];
    // Titel aktualisieren
    const modeNames = {
      de: { solo: 'WÖRDLE', dordle: 'DORDLE', quordle: 'QUORDLE', octordle: 'OCTORDLE' },
      en: { solo: 'WORDLE', dordle: 'DORDLE', quordle: 'QUORDLE', octordle: 'OCTORDLE' }
    };
    setEl('funmode-title', modeNames[lang][funState.mode]);
    buildFunKeyboard(lang, cfg.grids);
    // Segment-Farben wiederherstellen
    for (const [letter, segs] of Object.entries(funState.keySegments)) {
      for (let g = 0; g < cfg.grids; g++) {
        if (cfg.grids > 1) {
          const seg = document.getElementById(`fun-seg-${letter}-${g}`);
          if (seg && segs[g]) seg.className = 'key-seg ' + segs[g];
        }
      }
    }
  }
}

// ============================================================
//  BADGE SYSTEM
// ============================================================

const BADGE_DEFS = [
  // --- Upgradeable: Siege gesamt (DE+EN zusammen) ---
  { id: 'wins_bronze', group: 'wins', tier: 'bronze', emoji: '🏅', name: { de: 'Siegesläufer', en: 'Winner' },        desc: { de: '10 Siege gesamt',   en: '10 total wins' },    threshold: 10 },
  { id: 'wins_silver', group: 'wins', tier: 'silver', emoji: '🥈', name: { de: 'Siegesläufer', en: 'Winner' },        desc: { de: '50 Siege gesamt',   en: '50 total wins' },    threshold: 50 },
  { id: 'wins_gold',   group: 'wins', tier: 'gold',   emoji: '🥇', name: { de: 'Siegesläufer', en: 'Winner' },        desc: { de: '100 Siege gesamt',  en: '100 total wins' },   threshold: 100 },

  // --- Upgradeable: Längste Streak ---
  { id: 'streak_bronze', group: 'streak', tier: 'bronze', emoji: '🔥', name: { de: 'Flammenwerfer', en: 'On Fire' },  desc: { de: '7 Tage Serie',      en: '7-day streak' },     threshold: 7 },
  { id: 'streak_silver', group: 'streak', tier: 'silver', emoji: '🔥', name: { de: 'Flammenwerfer', en: 'On Fire' },  desc: { de: '30 Tage Serie',     en: '30-day streak' },    threshold: 30 },
  { id: 'streak_gold',   group: 'streak', tier: 'gold',   emoji: '🔥', name: { de: 'Flammenwerfer', en: 'On Fire' },  desc: { de: '100 Tage Serie',    en: '100-day streak' },   threshold: 100 },

  // --- Upgradeable: Dordle ---
  { id: 'dordle_bronze', group: 'dordle', tier: 'bronze', emoji: '⚔️', name: { de: 'Doppelkämpfer', en: 'Duelist' },  desc: { de: '5× Dordle gewonnen',  en: '5× Dordle wins' },  threshold: 5 },
  { id: 'dordle_silver', group: 'dordle', tier: 'silver', emoji: '⚔️', name: { de: 'Doppelkämpfer', en: 'Duelist' },  desc: { de: '25× Dordle gewonnen', en: '25× Dordle wins' }, threshold: 25 },
  { id: 'dordle_gold',   group: 'dordle', tier: 'gold',   emoji: '⚔️', name: { de: 'Doppelkämpfer', en: 'Duelist' },  desc: { de: '50× Dordle gewonnen', en: '50× Dordle wins' }, threshold: 50 },

  // --- Upgradeable: Quordle ---
  { id: 'quordle_bronze', group: 'quordle', tier: 'bronze', emoji: '🔲', name: { de: 'Vierfalt', en: 'Quadrant' },    desc: { de: '5× Quordle gewonnen',  en: '5× Quordle wins' },  threshold: 5 },
  { id: 'quordle_silver', group: 'quordle', tier: 'silver', emoji: '🔲', name: { de: 'Vierfalt', en: 'Quadrant' },    desc: { de: '25× Quordle gewonnen', en: '25× Quordle wins' }, threshold: 25 },
  { id: 'quordle_gold',   group: 'quordle', tier: 'gold',   emoji: '🔲', name: { de: 'Vierfalt', en: 'Quadrant' },    desc: { de: '50× Quordle gewonnen', en: '50× Quordle wins' }, threshold: 50 },

  // --- Upgradeable: Octordle ---
  { id: 'octordle_bronze', group: 'octordle', tier: 'bronze', emoji: '🐙', name: { de: 'Achtarmig', en: 'Octopus' },  desc: { de: '5× Octordle gewonnen',  en: '5× Octordle wins' },  threshold: 5 },
  { id: 'octordle_silver', group: 'octordle', tier: 'silver', emoji: '🐙', name: { de: 'Achtarmig', en: 'Octopus' },  desc: { de: '25× Octordle gewonnen', en: '25× Octordle wins' }, threshold: 25 },
  { id: 'octordle_gold',   group: 'octordle', tier: 'gold',   emoji: '🐙', name: { de: 'Achtarmig', en: 'Octopus' },  desc: { de: '50× Octordle gewonnen', en: '50× Octordle wins' }, threshold: 50 },

  // --- Einmalig: Glückspilz (1 Versuch) ---
  { id: 'lucky',   group: 'lucky',   tier: 'gold', emoji: '🍀', name: { de: 'Glückspilz',    en: 'Lucky Guess' },   desc: { de: 'Daily in 1 Versuch gelöst',           en: 'Solved daily in 1 attempt' } },

  // --- Einmalig: Nachteule ---
  { id: 'owl',     group: 'owl',     tier: 'gold', emoji: '🦉', name: { de: 'Nachteule',      en: 'Night Owl' },     desc: { de: 'Daily 5 Min vor Mitternacht gelöst',  en: 'Solved daily 5 min before midnight' } },

  // --- Einmalig: Frühaufsteher ---
  { id: 'bird',    group: 'bird',    tier: 'gold', emoji: '🐦', name: { de: 'Frühaufsteher',  en: 'Early Bird' },    desc: { de: 'Daily 10 Min nach Mitternacht gelöst', en: 'Solved daily 10 min after midnight' } },

  { id: 'first_friend', group: 'first_friend', tier: 'gold', emoji: '🤝', name: { de: 'Sozial', en: 'Social' }, desc: { de: 'Ersten Freund hinzugefügt', en: 'Added your first friend' } },

  // --- Einmalig: Alles an einem Tag ---
  { id: 'allday',  group: 'allday',  tier: 'gold', emoji: '👑', name: { de: 'König des Tages', en: 'Day King' },      desc: { de: 'Daily + Dordle, Quordle & Octordle (je DE+EN) an einem Tag', en: 'Daily + Dordle, Quordle & Octordle (DE+EN each) in one day' } },
];

// Alle Badge-IDs als Set für schnellen Lookup
const BADGE_ID_SET = new Set(BADGE_DEFS.map(b => b.id));

// Queue für Popups (falls mehrere auf einmal)
let badgePopupQueue = [];
let badgePopupActive = false;

// ---- Hilfsfunktionen ----

function getBadgeDef(id) { return BADGE_DEFS.find(b => b.id === id); }

async function loadEarnedBadges(userId) {
  try {
    const rows = await sbFetch(`user_badges?user_id=eq.${userId}&select=badge_id`);
    return new Set((rows || []).map(r => r.badge_id));
  } catch { return new Set(); }
}

async function awardBadge(userId, badgeId) {
  try {
    // Erst prüfen ob schon vorhanden
    const existing = await sbFetch(`user_badges?user_id=eq.${userId}&badge_id=eq.${badgeId}&select=id`);
    if (existing && existing.length > 0) return false;
    await sbFetch('user_badges', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, badge_id: badgeId }),
      prefer: 'return=minimal'
    });
    return true;
  } catch(e) {
    console.warn('Badge award error:', e);
    return false;
  }
}

function queueBadgePopup(badgeDef) {
  badgePopupQueue.push(badgeDef);
  if (!badgePopupActive) showNextBadgePopup();
}

function showNextBadgePopup() {
  if (badgePopupQueue.length === 0) { badgePopupActive = false; return; }
  badgePopupActive = true;
  const def = badgePopupQueue.shift();
  const lang = state.lang;
  document.getElementById('badge-popup-emoji').textContent = def.emoji;
  document.getElementById('badge-popup-name').textContent = def.name[lang];
  document.getElementById('badge-popup-desc').textContent = def.desc[lang];
  // "Neues Abzeichen!" Text
  document.querySelector('.badge-popup-new').textContent = lang === 'de' ? 'Neues Abzeichen! 🎊' : 'New Badge! 🎊';
  document.querySelector('.badge-popup .btn').textContent = lang === 'de' ? 'Cool! 🎉' : 'Awesome! 🎉';
  document.getElementById('badge-popup-overlay').classList.add('open');
}

function closeBadgePopup() {
  document.getElementById('badge-popup-overlay').classList.remove('open');
  setTimeout(() => showNextBadgePopup(), 300);
}

// ---- Haupt-Check-Funktion ----

async function checkAndAwardBadges(context = {}) {
  console.log('checkAndAwardBadges called', context, state.currentUser);
  if (!state.currentUser) return;
  const userId = state.currentUser.id;
  const lang = state.lang;
  const de = lang === 'de';

  const earned = await loadEarnedBadges(userId);

  // Alle Stats laden (beide Sprachen für wins/streak)
  let statsDE, statsEN;
  try {
    const deRows = await sbFetch(`stats?user_id=eq.${userId}&lang=eq.de`);
    const enRows = await sbFetch(`stats?user_id=eq.${userId}&lang=eq.en`);
    statsDE = deRows && deRows.length > 0 ? deRows[0] : null;
    statsEN = enRows && enRows.length > 0 ? enRows[0] : null;
  } catch { return; }

  const totalWins = (statsDE?.won || 0) + (statsEN?.won || 0);
  const bestStreak = Math.max(statsDE?.best_streak || 0, statsEN?.best_streak || 0);

  // Fun wins laden
  let funWins = { dordle: 0, quordle: 0, octordle: 0 };
  try {
    const fw = await sbFetch(`fun_wins?user_id=eq.${userId}&select=mode`);
    (fw || []).forEach(r => { if (funWins[r.mode] !== undefined) funWins[r.mode]++; });
  } catch {}

  const newBadges = [];

  async function tryAward(badgeId) {
    if (earned.has(badgeId)) return;
    const ok = await awardBadge(userId, badgeId);
    if (ok) {
      earned.add(badgeId);
      const def = getBadgeDef(badgeId);
      if (def) newBadges.push(def);
    }
  }

  // Siege
  if (totalWins >= 10)  await tryAward('wins_bronze');
  if (totalWins >= 50)  await tryAward('wins_silver');
  if (totalWins >= 100) await tryAward('wins_gold');

  // Streak
  if (bestStreak >= 7)   await tryAward('streak_bronze');
  if (bestStreak >= 30)  await tryAward('streak_silver');
  if (bestStreak >= 100) await tryAward('streak_gold');

  // Dordle
  if (funWins.dordle >= 5)  await tryAward('dordle_bronze');
  if (funWins.dordle >= 25) await tryAward('dordle_silver');
  if (funWins.dordle >= 50) await tryAward('dordle_gold');

  // Quordle
  if (funWins.quordle >= 5)  await tryAward('quordle_bronze');
  if (funWins.quordle >= 25) await tryAward('quordle_silver');
  if (funWins.quordle >= 50) await tryAward('quordle_gold');

  // Octordle
  if (funWins.octordle >= 5)  await tryAward('octordle_bronze');
  if (funWins.octordle >= 25) await tryAward('octordle_silver');
  if (funWins.octordle >= 50) await tryAward('octordle_gold');

  // Glückspilz
  if (context.guesses === 1 && context.mode === 'daily') await tryAward('lucky');

  // Nachteule: 5 Min vor Mitternacht = nach 23:55
  if (context.mode === 'daily' && context.won) {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    if (h === 23 && m >= 55) await tryAward('owl');
    if (h === 0 && m < 10)   await tryAward('bird');
  }

  if (context.mode === 'friend_added') {
    const friendIds = await getFriendIds(userId);
    if (friendIds.size >= 1) await tryAward('first_friend');
  }

  // König des Tages — prüfe ob heute alle 5 Modi gewonnen
  if (context.mode && context.won) await checkAllDayBadge(userId, earned, tryAward);

  // Popups anzeigen
  newBadges.forEach(def => queueBadgePopup(def));

  // Profil neu rendern falls offen
  if (document.getElementById('page-profile')?.classList.contains('active')) {
    renderBadges(earned);
  }
}

// Hilfsfunktion: Prüft ob heute alle Modi gewonnen wurden
async function checkAllDayBadge(userId, earned, tryAward) {
  if (earned.has('allday')) return;
  const today = new Date().toDateString();
  const todayDE = getTodayKey('de');
  const todayEN = getTodayKey('en');
  try {
    const lbDE = await sbFetch(`leaderboard?user_id=eq.${userId}&lang=eq.de&day_key=eq.${todayDE}&attempts=lt.7`);
    const lbEN = await sbFetch(`leaderboard?user_id=eq.${userId}&lang=eq.en&day_key=eq.${todayEN}&attempts=lt.7`);
    if (!lbDE?.length || !lbEN?.length) return;

    const fw = await sbFetch(`fun_wins?user_id=eq.${userId}&select=mode,lang,won_at`);
    const todayFun = {
      dordle_de: false, dordle_en: false,
      quordle_de: false, quordle_en: false,
      octordle_de: false, octordle_en: false
    };
    (fw || []).forEach(r => {
      const d = new Date(r.won_at).toDateString();
      const key = `${r.mode}_${r.lang}`;
      if (d === today && todayFun[key] !== undefined) todayFun[key] = true;
    });
    if (Object.values(todayFun).every(v => v)) {
      await tryAward('allday');
    }
  } catch {}
}

// ---- Badge rendern im Profil ----

async function renderBadges(earnedSet) {
  const grid = document.getElementById('badge-grid');
  if (!grid) return;
  const lang = state.lang;
  const pinned = state.currentUser ? await loadPinnedBadges(state.currentUser.id) : [];
  renderProfilePinned(pinned);

  const tierOrder = { gold: 0, silver: 1, bronze: 2 };
  const groups = {};
  BADGE_DEFS.forEach(b => {
    if (!groups[b.group]) groups[b.group] = { defs: [], earned: null };
    groups[b.group].defs.push(b);
    if (earnedSet.has(b.id)) groups[b.group].earned = b;
  });
  const sortedGroups = Object.values(groups).sort((a, b) => {
    const aEarned = !!a.earned;
    const bEarned = !!b.earned;
    if (aEarned !== bEarned) return bEarned - aEarned;
    if (aEarned && bEarned) return tierOrder[a.earned.tier] - tierOrder[b.earned.tier];
    return 0;
  });

  grid.innerHTML = sortedGroups.map(g => {
    const tiers = ['gold','silver','bronze'];
    let display = null;
    for (const t of tiers) {
      const found = g.defs.find(d => d.tier === t && earnedSet.has(d.id));
      if (found) { display = found; break; }
    }
    const locked = !display;
    const def = display || g.defs[g.defs.length - 1];
    const tierClass = locked ? 'tier-locked' : `tier-${def.tier}`;
    const tierLabel = locked ? '' : `<div class="badge-tier-dot">${def.tier === 'bronze' ? 'B' : def.tier === 'silver' ? 'S' : 'G'}</div>`;
    const nextDef = locked
      ? g.defs.find(d => d.tier === 'bronze')
      : g.defs.find(d => !earnedSet.has(d.id) && tierOrder[d.tier] < tierOrder[def.tier]);
    const tooltipBase = locked ? (nextDef ? nextDef.desc[lang] : def.desc[lang]) : def.desc[lang];
    const isPinned = !locked && pinned.includes(def.id);

    return `<div class="badge-item${locked ? '' : ' earned'}${isPinned ? ' pinned' : ''}"
      onclick="${locked
        ? `toggleBadgeTooltip(this,'${def.name[lang]}','${tooltipBase}')`
        : `handleBadgeClick(this,'${def.id}','${def.name[lang]}','${tooltipBase}')`}">
      <div class="badge-icon-wrap ${tierClass}">
        ${def.emoji}
        ${tierLabel}
      </div>
      <div class="badge-label">${def.name[lang]}</div>
      <div class="badge-tooltip"></div>
    </div>`;
  }).join('');
}

// ---- Profil-Hook ----
// In setupProfilePage() am Ende aufrufen — füge diese Zeilen
// am Ende des try-Blocks in setupProfilePage() ein:
//   const earned = await loadEarnedBadges(state.currentUser.id);
//   renderBadges(earned);
// ABER weil wir setupProfilePage nicht ersetzen wollen, patchen wir:

const _origSetupProfile = setupProfilePage;
setupProfilePage = async function() {
  await _origSetupProfile();
  if (!state.currentUser) return;
  await backfillBadges();
  const earned = await loadEarnedBadges(state.currentUser.id);
  renderBadges(earned);
};

// ---- Fun-Mode Hook ----
// Nach dem bestehenden afterFunReveal, füge einen Win-Eintrag ein.
// Suche in afterFunReveal: "const allWon = solvedCount === cfg.grids;"
// und direkt danach (vor dem Toast) diese Logik einfügen:
// → Wir patchen via afterFunReveal kann nicht direkt gepatcht werden,
//   daher rufe am Ende der afterFunReveal-Funktion dies auf:

async function recordFunWin(mode) {
  if (!state.currentUser) return;
  try {
    await sbFetch('fun_wins', {
      method: 'POST',
      body: JSON.stringify({ user_id: state.currentUser.id, mode, lang: state.lang }),
      prefer: 'return=minimal'
    });
  } catch(e) { console.warn('fun_wins insert error:', e); }
}

async function backfillBadges() {
  if (!state.currentUser) return;
  const userId = state.currentUser.id;
  try {
    const deRows = await sbFetch(`stats?user_id=eq.${userId}&lang=eq.de`);
    const enRows = await sbFetch(`stats?user_id=eq.${userId}&lang=eq.en`);
    const statsDE = deRows?.[0] || null;
    const statsEN = enRows?.[0] || null;
    const totalWins = (statsDE?.won || 0) + (statsEN?.won || 0);
    const bestStreak = Math.max(statsDE?.best_streak || 0, statsEN?.best_streak || 0);

    const earned = await loadEarnedBadges(userId);
    const newBadges = [];

    async function tryAward(badgeId) {
      if (earned.has(badgeId)) return;
      const ok = await awardBadge(userId, badgeId);
      if (ok) { earned.add(badgeId); const def = getBadgeDef(badgeId); if (def) newBadges.push(def); }
    }

    if (totalWins >= 10)  await tryAward('wins_bronze');
    if (totalWins >= 50)  await tryAward('wins_silver');
    if (totalWins >= 100) await tryAward('wins_gold');
    if (bestStreak >= 7)   await tryAward('streak_bronze');
    if (bestStreak >= 30)  await tryAward('streak_silver');
    if (bestStreak >= 100) await tryAward('streak_gold');

    // Fun wins
    const fw = await sbFetch(`fun_wins?user_id=eq.${userId}&select=mode`);
    const funWins = { dordle: 0, quordle: 0, octordle: 0 };
    (fw || []).forEach(r => { if (funWins[r.mode] !== undefined) funWins[r.mode]++; });
    if (funWins.dordle >= 5)  await tryAward('dordle_bronze');
    if (funWins.dordle >= 25) await tryAward('dordle_silver');
    if (funWins.dordle >= 50) await tryAward('dordle_gold');
    if (funWins.quordle >= 5)  await tryAward('quordle_bronze');
    if (funWins.quordle >= 25) await tryAward('quordle_silver');
    if (funWins.quordle >= 50) await tryAward('quordle_gold');
    if (funWins.octordle >= 5)  await tryAward('octordle_bronze');
    if (funWins.octordle >= 25) await tryAward('octordle_silver');
    if (funWins.octordle >= 50) await tryAward('octordle_gold');

    newBadges.forEach(def => queueBadgePopup(def));
    if (newBadges.length > 0) renderBadges(earned);
  } catch(e) { console.warn('backfill error:', e); }
}

function toggleBadgeTooltip(el, name, desc) {
  // Alle anderen schließen
  document.querySelectorAll('.badge-item.tooltip-open').forEach(b => {
    if (b !== el) b.classList.remove('tooltip-open');
  });
  const tip = el.querySelector('.badge-tooltip');
  if (tip) tip.textContent = desc;
  el.classList.toggle('tooltip-open');

  // Schließen bei Klick außerhalb
  setTimeout(() => {
    document.addEventListener('click', function close(e) {
      if (!el.contains(e.target)) {
        el.classList.remove('tooltip-open');
        document.removeEventListener('click', close);
      }
    });
  }, 10);
}

// ============================================================
//  FRIENDS SYSTEM
// ============================================================

let friendsTab = 'list';
let friendReqTarget = null; // { id, username } — für Popup
let friendsSearchTimer = null;
let currentFriendProfileId = null;
let currentFriendProfileName = null;

// ---- Navigation Hook ----
const _origNavigate = navigate;
// navigate wird weiter unten gepatcht nach Definition

function friendsSetTab(tab) {
  friendsTab = tab;
  const de = state.lang === 'de';
  document.getElementById('friends-tab-list').classList.toggle('active', tab === 'list');
  document.getElementById('friends-tab-add').classList.toggle('active', tab === 'add');
  document.getElementById('friends-panel-list').style.display = tab === 'list' ? '' : 'none';
  document.getElementById('friends-panel-add').style.display = tab === 'add' ? '' : 'none';
  if (tab === 'list') loadFriendsList();
  else loadFriendRequests();
}

async function setupFriendsPage() {
  if (!state.currentUser) { navigate('home'); return; }
  updateFriendsLanguage();
  friendsSetTab(friendsTab);
  updateFriendRequestBadge();
}

function updateFriendsLanguage() {
  const de = state.lang === 'de';
  setEl('friends-tab-list-label',   de ? 'Freunde' : 'Friends');
  setEl('friends-tab-add-label',    de ? 'Hinzufügen' : 'Add');
  setEl('friends-requests-title',   de ? 'Offene Anfragen' : 'Pending Requests');
  setEl('friend-profile-back-label', de ? 'Zurück' : 'Back');
  setEl('friend-badge-title',       de ? 'Abzeichen' : 'Badges');
  setEl('friend-stats-title',       de ? 'Statistiken' : 'Statistics');
  const inp = document.getElementById('friends-search-input');
  if (inp) inp.placeholder = de ? 'Benutzername suchen…' : 'Search username…';
  setEl('friend-req-confirm', de ? 'Senden' : 'Send');
  setEl('friend-req-cancel',  de ? 'Abbrechen' : 'Cancel');
}

// ---- Freundesliste laden ----
async function loadFriendsList() {
  const list = document.getElementById('friends-list');
  if (!list) return;
  list.innerHTML = '<div class="lb-empty">⏳</div>';
  const de = state.lang === 'de';
  const userId = state.currentUser.id;

  try {
    const sent = await sbFetch(`friendships?requester_id=eq.${userId}&status=eq.accepted&select=receiver_id`);
    const recv = await sbFetch(`friendships?receiver_id=eq.${userId}&status=eq.accepted&select=requester_id`);
    const friendIds = [
      ...(sent || []).map(r => r.receiver_id),
      ...(recv || []).map(r => r.requester_id)
    ];
    if (friendIds.length === 0) {
      list.innerHTML = `<div class="lb-empty">${de ? 'Noch keine Freunde.' : 'No friends yet.'}</div>`;
      return;
    }

    const todayDE = getTodayKey('de');
    const todayEN = getTodayKey('en');
    const friends = await Promise.all(friendIds.map(async fid => {
      const uRows = await sbFetch(`users?id=eq.${fid}&select=id,username`);
      const u = uRows?.[0];
      if (!u) return null;
      const sLang = await sbFetch(`stats?user_id=eq.${fid}&lang=eq.${state.lang}&select=won,played,total_attempts`);
      const sl = sLang?.[0];
      const avg = sl?.played > 0 ? (sl.total_attempts / sl.played).toFixed(1) : '—';
      const lbDE = await sbFetch(`leaderboard?user_id=eq.${fid}&day_key=eq.${todayDE}&select=attempts`);
      const lbEN = await sbFetch(`leaderboard?user_id=eq.${fid}&day_key=eq.${todayEN}&select=attempts`);
      const todayAttempts = lbDE?.[0]?.attempts || lbEN?.[0]?.attempts || null;
      const pinned = await loadPinnedBadges(fid) || [];
      return { id: fid, username: u.username, avg, todayAttempts, pinned };
    }));

    const valid = friends.filter(Boolean).sort((a, b) => {
      if (a.avg === '—' && b.avg === '—') return 0;
      if (a.avg === '—') return 1;
      if (b.avg === '—') return -1;
      return parseFloat(a.avg) - parseFloat(b.avg);
    });

    list.innerHTML = valid.map(f => {
      const todayStr = f.todayAttempts
        ? (f.todayAttempts === 7 ? '✕' : `${f.todayAttempts}/6`)
        : '—';
      const pinnedHtml = f.pinned.map(bid => {
        const def = getBadgeDef(bid);
        if (!def) return '';
        return `<span class="lb-pinned-badge tier-${def.tier}" title="${def.name[state.lang]}">${def.emoji}</span>`;
      }).join('');
      return `<div class="friend-entry" onclick="openFriendProfile('${f.id}', '${f.username}')">
        <div class="lb-avatar">${f.username[0].toUpperCase()}</div>
        <div class="friend-entry-name">${f.username}<span class="lb-pinned">${pinnedHtml}</span></div>
        <div class="friend-entry-avg">${f.avg}</div>
        <div class="friend-entry-today">${todayStr}</div>
        <button class="friend-remove-btn" onclick="event.stopPropagation(); confirmRemoveFriend('${f.id}', '${f.username}')" title="${de ? 'Entfernen' : 'Remove'}">✕</button>
      </div>`;
    }).join('');
  } catch(e) {
    console.error('loadFriendsList error:', e);
    list.innerHTML = `<div class="lb-empty">${de ? 'Fehler beim Laden.' : 'Error loading.'}</div>`;
  }
}

// ---- Anfragen laden ----
async function loadFriendRequests() {
  const list = document.getElementById('friends-requests-list');
  if (!list) return;
  list.innerHTML = '<div class="lb-empty">⏳</div>';
  const de = state.lang === 'de';
  const userId = state.currentUser.id;
  try {
    const reqs = await sbFetch(`friendships?receiver_id=eq.${userId}&status=eq.pending&select=id,requester_id`);
    if (!reqs || reqs.length === 0) {
      list.innerHTML = `<div class="lb-empty">${de ? 'Keine offenen Anfragen.' : 'No pending requests.'}</div>`;
      return;
    }
    const entries = await Promise.all(reqs.map(async r => {
      const uRows = await sbFetch(`users?id=eq.${r.requester_id}&select=username`);
      return { friendshipId: r.id, username: uRows?.[0]?.username || '?' };
    }));
    list.innerHTML = entries.map(e => `
      <div class="friend-req-entry">
        <div class="lb-avatar">${e.username[0].toUpperCase()}</div>
        <div class="friend-req-name">${e.username}</div>
        <div class="friend-req-actions">
          <button class="btn btn-primary" onclick="acceptFriendRequest(${e.friendshipId})">${de ? 'Annehmen' : 'Accept'}</button>
          <button class="btn btn-ghost"   onclick="declineFriendRequest(${e.friendshipId})">${de ? 'Ablehnen' : 'Decline'}</button>
        </div>
      </div>`).join('');
  } catch(e) { list.innerHTML = `<div class="lb-empty">${de ? 'Fehler.' : 'Error.'}</div>`; }
}

// ---- Suche ----
function friendsSearchDebounce() {
  clearTimeout(friendsSearchTimer);
  friendsSearchTimer = setTimeout(friendsSearch, 400);
}

async function friendsSearch() {
  const q = document.getElementById('friends-search-input').value.trim();
  const res = document.getElementById('friends-search-result');
  const de = state.lang === 'de';
  if (!res) return;
  if (q.length < 2) { res.innerHTML = ''; return; }
  try {
    const rows = await sbFetch(`users?username=ilike.${encodeURIComponent(q)}*&select=id,username&limit=5`);
    if (!rows || rows.length === 0) { res.innerHTML = `<div style="color:var(--text-muted); font-size:0.85rem; padding:8px 0">${de ? 'Niemanden gefunden.' : 'Nobody found.'}</div>`; return; }
    // Eigene ID rausfiltern
    const others = rows.filter(r => r.id !== state.currentUser.id);
    // Bestehende Freundschaften prüfen
    const userId = state.currentUser.id;
    const friendIds = await getFriendIds(userId);
    const pendingOut = await sbFetch(`friendships?requester_id=eq.${userId}&status=eq.pending&select=receiver_id`);
    const pendingIds = new Set((pendingOut || []).map(r => r.receiver_id));

    res.innerHTML = others.map(u => {
      const isFriend = friendIds.has(u.id);
      const isPending = pendingIds.has(u.id);
      const btn = isFriend
        ? `<span class="friend-icon">✓ ${de ? 'Freund' : 'Friend'}</span>`
        : isPending
        ? `<span style="color:var(--text-muted); font-size:0.78rem">${de ? 'Ausstehend' : 'Pending'}</span>`
        : `<button class="btn btn-primary" style="padding:6px 14px; font-size:0.78rem" onclick="openFriendReqPopup('${u.id}','${u.username}')">${de ? 'Hinzufügen' : 'Add'}</button>`;
      return `<div class="friends-search-result-item">
        <div style="display:flex; align-items:center; gap:10px;">
          <div class="lb-avatar">${u.username[0].toUpperCase()}</div>
          <span style="font-weight:600">${u.username}</span>
        </div>
        ${btn}
      </div>`;
    }).join('');
  } catch(e) { res.innerHTML = ''; }
}

async function getFriendIds(userId) {
  const sent = await sbFetch(`friendships?requester_id=eq.${userId}&status=eq.accepted&select=receiver_id`);
  const recv = await sbFetch(`friendships?receiver_id=eq.${userId}&status=eq.accepted&select=requester_id`);
  return new Set([
    ...(sent || []).map(r => r.receiver_id),
    ...(recv || []).map(r => r.requester_id)
  ]);
}

// ---- Anfrage senden ----
function openFriendReqPopup(targetId, targetUsername) {
  friendReqTarget = { id: targetId, username: targetUsername };
  const de = state.lang === 'de';
  setEl('friend-req-name', targetUsername);
  setEl('friend-req-desc', de ? 'Freundschaftsanfrage senden?' : 'Send friend request?');
  document.getElementById('friend-req-overlay').classList.add('open');
}

function closeFriendReqPopup() {
  document.getElementById('friend-req-overlay').classList.remove('open');
  friendReqTarget = null;
}

async function confirmFriendRequest() {
  if (!friendReqTarget) return;
  const de = state.lang === 'de';
  try {
    await sbFetch('friendships', {
      method: 'POST',
      body: JSON.stringify({ requester_id: state.currentUser.id, receiver_id: friendReqTarget.id }),
      prefer: 'return=minimal'
    });
    closeFriendReqPopup();
    showToast(de ? 'Anfrage gesendet ✓' : 'Request sent ✓', 'success');
    // Badge check
    checkAndAwardBadges({ mode: 'friend_added' });
  } catch(e) {
    closeFriendReqPopup();
    showToast(de ? 'Bereits eine Anfrage gesendet.' : 'Request already sent.', 'error');
  }
}

// ---- Anfrage annehmen/ablehnen ----
async function acceptFriendRequest(friendshipId) {
  const de = state.lang === 'de';
  try {
    await sbFetch(`friendships?id=eq.${friendshipId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'accepted' }),
      prefer: 'return=minimal'
    });
    showToast(de ? 'Freund hinzugefügt! 🎉' : 'Friend added! 🎉', 'success');
    checkAndAwardBadges({ mode: 'friend_added' });
    const req = await sbFetch(`friendships?id=eq.${friendshipId}&select=requester_id`);
if (req?.[0]) {
  const tmpUser = { id: req[0].requester_id };
  checkAndAwardBadgesForUser(tmpUser);
}
    loadFriendRequests();
  } catch(e) { showToast(de ? 'Fehler.' : 'Error.', 'error'); }
  updateFriendRequestBadge();
}

async function declineFriendRequest(friendshipId) {
  const de = state.lang === 'de';
  try {
    await sbFetch(`friendships?id=eq.${friendshipId}`, { method: 'DELETE', prefer: 'return=minimal' });
    showToast(de ? 'Anfrage abgelehnt.' : 'Request declined.', 'info');
    loadFriendRequests();
  } catch(e) { showToast(de ? 'Fehler.' : 'Error.', 'error'); }
  updateFriendRequestBadge();
}

//Freund entfernen
let removeFriendTarget = null;

function confirmRemoveFriend(friendId, friendUsername) {
  removeFriendTarget = { id: friendId, username: friendUsername };
  const de = state.lang === 'de';
  setEl('remove-friend-name', friendUsername);
  setEl('remove-friend-desc', de ? 'Als Freund entfernen?' : 'Remove as friend?');
  setEl('remove-friend-confirm', de ? 'Entfernen' : 'Remove');
  setEl('remove-friend-cancel', de ? 'Abbrechen' : 'Cancel');
  document.getElementById('remove-friend-overlay').classList.add('open');
}

function closeRemoveFriendPopup() {
  document.getElementById('remove-friend-overlay').classList.remove('open');
  removeFriendTarget = null;
}

async function executeRemoveFriend() {
  if (!removeFriendTarget) return;
  const de = state.lang === 'de';
  const userId = state.currentUser.id;
  const friendId = removeFriendTarget.id;
  closeRemoveFriendPopup();
  try {
    await sbFetch(`friendships?requester_id=eq.${userId}&receiver_id=eq.${friendId}`, { method: 'DELETE', prefer: 'return=minimal' });
    await sbFetch(`friendships?requester_id=eq.${friendId}&receiver_id=eq.${userId}`, { method: 'DELETE', prefer: 'return=minimal' });
    showToast(de ? 'Freund entfernt.' : 'Friend removed.', 'info');
    loadFriendsList();
  } catch(e) { showToast(de ? 'Fehler.' : 'Error.', 'error'); }
}

// ---- Freundesprofil ----
async function openFriendProfile(friendId, friendUsername) {
  currentFriendProfileId = friendId;
  currentFriendProfileName = friendUsername;
  const de = state.lang === 'de';
  setEl('friend-profile-avatar', friendUsername[0].toUpperCase());
  setEl('friend-profile-username', friendUsername);
  setEl('friend-profile-email', '…');
  document.getElementById('friend-stats-grid').innerHTML = '<div class="lb-empty">⏳</div>';
  document.getElementById('friend-badge-grid').innerHTML = '<div class="lb-empty">⏳</div>';
  navigate('friend-profile');

  try {
    // Email laden
    const uRows = await sbFetch(`users?id=eq.${friendId}&select=email`);
    setEl('friend-profile-email', uRows?.[0]?.email || '—');

    // Stats laden (beide Sprachen)
    const sRows = await sbFetch(`stats?user_id=eq.${friendId}&lang=eq.${state.lang}`);
const s = sRows?.[0];
const streak     = s?.streak || 0;
const bestStreak = s?.best_streak || 0;
const played     = s?.played || 0;
const won        = s?.won || 0;
const totalAtt   = s?.total_attempts || 0;
const avg        = played > 0 ? (totalAtt / played).toFixed(1) : '—';
const winrate    = played > 0 ? Math.round((won / played) * 100) + '%' : '0%';

    document.getElementById('friend-stats-grid').innerHTML = `
      <div class="stat-card streak-card"><span class="value">${streak}</span><span class="label">${de ? 'Aktuelle Serie 🔥' : 'Current Streak 🔥'}</span></div>
      <div class="stat-card streak-card"><span class="value">${bestStreak}</span><span class="label">${de ? 'Längste Serie 🏆' : 'Best Streak 🏆'}</span></div>
      <div class="stat-card"><span class="value">${played}</span><span class="label">${de ? 'Spiele gespielt' : 'Games Played'}</span></div>
      <div class="stat-card"><span class="value">${won}</span><span class="label">${de ? 'Gewonnen' : 'Won'}</span></div>
      <div class="stat-card"><span class="value">${avg}</span><span class="label">Ø ${de ? 'Versuche' : 'Attempts'}</span></div>
      <div class="stat-card"><span class="value">${winrate}</span><span class="label">${de ? 'Gewinnrate' : 'Win Rate'}</span></div>`;

    // Badges
    const earned = await loadEarnedBadges(friendId);
    const grid = document.getElementById('friend-badge-grid');
    // renderBadges nutzt state.lang, funktioniert direkt
    const lang = state.lang;
    const tierOrder = { gold: 0, silver: 1, bronze: 2 };
    const groups = {};
    BADGE_DEFS.forEach(b => {
      if (!groups[b.group]) groups[b.group] = { defs: [], earned: null };
      groups[b.group].defs.push(b);
      if (earned.has(b.id)) groups[b.group].earned = b;
    });
    const sortedGroups = Object.values(groups).sort((a, b) => {
      const aE = !!a.earned, bE = !!b.earned;
      if (aE !== bE) return bE - aE;
      if (aE && bE) return tierOrder[a.earned.tier] - tierOrder[b.earned.tier];
      return 0;
    });
    grid.innerHTML = sortedGroups.map(g => {
      const tiers = ['gold','silver','bronze'];
      let display = null;
      for (const t of tiers) { const f = g.defs.find(d => d.tier === t && earned.has(d.id)); if (f) { display = f; break; } }
      const locked = !display;
      const def = display || g.defs[g.defs.length - 1];
      const tierClass = locked ? 'tier-locked' : `tier-${def.tier}`;
      const tierLabel = locked ? '' : `<div class="badge-tier-dot">${def.tier === 'bronze' ? 'B' : def.tier === 'silver' ? 'S' : 'G'}</div>`;
      const tooltipBase = locked ? (g.defs.find(d => d.tier === 'bronze')?.desc[lang] || def.desc[lang]) : def.desc[lang];
      return `<div class="badge-item${locked ? '' : ' earned'}" onclick="toggleBadgeTooltip(this,'${def.name[lang]}','${tooltipBase}')">
        <div class="badge-icon-wrap ${tierClass}">${def.emoji}${tierLabel}</div>
        <div class="badge-label">${def.name[lang]}</div>
        <div class="badge-tooltip"></div>
      </div>`;
    }).join('');
  } catch(e) { console.error('Friend profile error:', e); }
}

// ---- Leaderboard Friend-Button ----
// Patch fetchAndRenderList um Friend-Buttons hinzuzufügen
const _origFetchAndRenderList = fetchAndRenderList;
fetchAndRenderList = async function() {
  await _origFetchAndRenderList();
};

document.addEventListener('click', async (e) => {
  const span = e.target.closest('.lb-name-click');
  if (!span || !state.currentUser) return;
  const uid = span.dataset.uid;
  const uname = span.dataset.name;
  if (uid === state.currentUser.id) { navigate('profile'); return; }
  try {
    const friendIds = await getFriendIds(state.currentUser.id);
    if (friendIds.has(uid)) openFriendProfile(uid, uname);
    else openFriendReqPopup(uid, uname);
  } catch(e) {}
});

async function checkAndAwardBadgesForUser(targetUser) {
  const userId = targetUser.id;
  const earned = await loadEarnedBadgesForUser(userId);
  if (earned.has('first_friend')) return;
  const friendIds = await getFriendIds(userId);
  if (friendIds.size >= 1) {
    await awardBadge(userId, 'first_friend');
  }
}

async function loadEarnedBadgesForUser(userId) {
  try {
    const rows = await sbFetch(`user_badges?user_id=eq.${userId}&select=badge_id`);
    return new Set((rows || []).map(r => r.badge_id));
  } catch { return new Set(); }
}

async function updateFriendRequestBadge() {
  if (!state.currentUser) return;
  try {
    const reqs = await sbFetch(`friendships?receiver_id=eq.${state.currentUser.id}&status=eq.pending&select=id`);
    const count = reqs?.length || 0;

    // Profil-Button im Header
    const btnProfile = document.getElementById('btn-profile');
    if (btnProfile) {
      const existing = btnProfile.querySelector('.notif-badge');
      if (existing) existing.remove();
      if (count > 0) btnProfile.insertAdjacentHTML('beforeend', `<span class="notif-badge">${count}</span>`);
    }

    // Freunde-Button im Profil
    const btnFriends = document.getElementById('btn-friends');
    if (btnFriends) {
      const existing = btnFriends.querySelector('.notif-badge');
      if (existing) existing.remove();
      if (count > 0) btnFriends.insertAdjacentHTML('beforeend', `<span class="notif-badge">${count}</span>`);
    }

    // "Hinzufügen" Tab auf der Freunde-Seite
    const tabAdd = document.getElementById('friends-tab-add');
    if (tabAdd) {
      const existing = tabAdd.querySelector('.notif-badge');
      if (existing) existing.remove();
      if (count > 0) tabAdd.insertAdjacentHTML('beforeend', `<span class="notif-badge">${count}</span>`);
    }
  } catch(e) {}
}

// ============================================================
//  PINNED BADGES
// ============================================================

async function loadPinnedBadges(userId) {
  try {
    const rows = await sbFetch(`users?id=eq.${userId}&select=pinned_badges`);
    return rows?.[0]?.pinned_badges || [];
  } catch { return []; }
}

async function savePinnedBadges(userId, pinned) {
  try {
    await sbFetch(`users?id=eq.${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ pinned_badges: pinned }),
      prefer: 'return=minimal'
    });
  } catch(e) { console.warn('pinned save error:', e); }
}

let _pinToggleLock = false;
async function togglePinBadge(badgeId) {
  if (!state.currentUser) return;
  if (_pinToggleLock) return;
  _pinToggleLock = true;
  setTimeout(() => { _pinToggleLock = false; }, 500);
  const userId = state.currentUser.id;
  const de = state.lang === 'de';
  let pinned = await loadPinnedBadges(userId);

  if (pinned.includes(badgeId)) {
    // Entpinnen
    pinned = pinned.filter(b => b !== badgeId);
    showToast(de ? 'Badge entfernt.' : 'Badge unpinned.', 'info', 1500);
  } else {
    if (pinned.length >= 3) {
      showToast(de ? 'Max. 3 Badges anheftbar.' : 'Max. 3 badges can be pinned.', 'error', 2000);
      return;
    }
    pinned.push(badgeId);
    showToast(de ? 'Badge angeheftet! 📌' : 'Badge pinned! 📌', 'success', 1500);
  }

  await savePinnedBadges(userId, pinned);
  // Profil neu rendern
  const earned = await loadEarnedBadges(userId);
  renderBadges(earned);
  renderProfilePinned(pinned);
}

function renderProfilePinned(pinned) {
  const container = document.getElementById('profile-pinned');
  if (!container) return;
  const de = state.lang === 'de';
  container.innerHTML = [0,1,2].map(i => {
    const badgeId = pinned[i];
    const def = badgeId ? getBadgeDef(badgeId) : null;
    if (!def) {
      return `<div class="pinned-badge-slot" title="${de ? 'Badge anheften' : 'Pin a badge'}">＋</div>`;
    }
    const tierClass = `tier-${def.tier}`;
    const dotLabel = def.tier === 'bronze' ? 'B' : def.tier === 'silver' ? 'S' : 'G';
    return `<div class="pinned-badge-slot filled badge-icon-wrap ${tierClass}" 
  title="${def.name[de ? 'de' : 'en']}"
  onclick="handleBadgeClick(this,'${def.id}','${def.name[de ? 'de' : 'en']}','${def.desc[de ? 'de' : 'en']}')"
  ondblclick="togglePinBadge('${def.id}')">
  ${def.emoji}
  <div class="badge-tier-dot">${dotLabel}</div>
  <div class="badge-tooltip"></div>
</div>`;
  }).join('');
}

// renderBadges patchen um Pin-Status + Klick hinzuzufügen
const _origRenderBadges = renderBadges;
renderBadges = async function(earnedSet) {
  await _origRenderBadges(earnedSet);
  if (!state.currentUser) return;
  const pinned = await loadPinnedBadges(state.currentUser.id);
  // Pin-Indikator auf geearnten Badges
  document.querySelectorAll('.badge-item.earned').forEach(el => {
    const onclick = el.getAttribute('onclick') || '';
    const match = onclick.match(/toggleBadgeTooltip\(this,'([^']+)','([^']+)'\)/);
    if (!match) return;
    // Badge-ID rausfinden über Name-Matching
    const def = BADGE_DEFS.find(b => b.name[state.lang] === match[1]);
    if (!def) return;
    if (pinned.includes(def.id)) el.classList.add('pinned');
    // Langer Klick oder Doppelklick zum Pinnen
    el.ondblclick = () => togglePinBadge(def.id);
    el.title = `${match[2]} · ${state.lang === 'de' ? 'Doppelklick zum Anheften' : 'Double-click to pin'}`;
  });
  renderProfilePinned(pinned);
};

function handleBadgeClick(el, badgeId, badgeName, badgeDesc) {
  // Kurz-Tap → Tooltip, Lang-Tap / zweiter Klick auf bereits getipptes → Pin
  if (el.dataset.tooltipOpen === '1') {
    // zweiter Klick → pinnen
    el.dataset.tooltipOpen = '0';
    el.classList.remove('tooltip-open');
    togglePinBadge(badgeId);
  } else {
    // erster Klick → Tooltip mit Pin-Hinweis
    document.querySelectorAll('.badge-item.tooltip-open').forEach(b => {
      b.classList.remove('tooltip-open');
      b.dataset.tooltipOpen = '0';
    });
    const tip = el.querySelector('.badge-tooltip');
    const de = state.lang === 'de';
    if (tip) tip.innerHTML = badgeDesc + `<br><span style="color:var(--primary); font-size:0.68rem;">${
  el.classList.contains('pinned')
    ? (de ? 'Nochmal klicken zum Entfernen' : 'Click again to unpin')
    : (de ? 'Nochmal klicken zum Anheften' : 'Click again to pin')
}</span>`;
    el.classList.add('tooltip-open');
    el.dataset.tooltipOpen = '1';
    setTimeout(() => {
      document.addEventListener('click', function close(e) {
        if (!el.contains(e.target)) {
          el.classList.remove('tooltip-open');
          el.dataset.tooltipOpen = '0';
          document.removeEventListener('click', close);
        }
      });
    }, 10);
  }
}

loadData();