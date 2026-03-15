let VALID_WORDS_DE = new Set();
let VALID_WORDS_EN = new Set();
let DAILY_WORDS_DE = [];
let DAILY_WORDS_EN = [];
let wordlistsReady = false;

async function loadWordlists() {
  try {
    const [deRes, enRes, dailyDeRes, dailyEnRes] = await Promise.all([
      fetch('words_de.txt'),
      fetch('words_en.txt'),
      fetch('daily_de.txt'),
      fetch('daily_en.txt')
    ]);
    const [deText, enText, dailyDeText, dailyEnText] = await Promise.all([
      deRes.text(), enRes.text(), dailyDeRes.text(), dailyEnRes.text()
    ]);

    const parseWords = (text, allowUmlauts = false) => {
      const allowed = allowUmlauts ? /^[A-ZÄÖÜ]+$/ : /^[A-Z]+$/;
      return new Set(
        text.split('\n')
          .map(line => line.trim().split(/\s+/)[0].toUpperCase())
          .filter(w => w.length === 5 && allowed.test(w))
      );
    };

    const parseList = (text, allowUmlauts = false) => {
      const allowed = allowUmlauts ? /^[A-ZÄÖÜ]+$/ : /^[A-Z]+$/;
      return text.split('\n')
        .map(line => line.trim().split(/\s+/)[0].toUpperCase())
        .filter(w => w.length === 5 && allowed.test(w));
    };

    VALID_WORDS_DE = parseWords(deText, true);
    VALID_WORDS_EN = parseWords(enText, false);
    DAILY_WORDS_DE = parseList(dailyDeText, true);
    DAILY_WORDS_EN = parseList(dailyEnText, false);

    wordlistsReady = true;
    console.log(`Wordlists loaded: DE=${VALID_WORDS_DE.size}, EN=${VALID_WORDS_EN.size}, Daily DE=${DAILY_WORDS_DE.length}, Daily EN=${DAILY_WORDS_EN.length}`);
  } catch (e) {
    console.warn('Wordlists could not be loaded, validation disabled:', e);
    wordlistsReady = false;
  }
}