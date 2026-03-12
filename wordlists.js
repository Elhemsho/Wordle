// Word validation - loads from txt files, handles both plain and "word frequency" formats
let VALID_WORDS_DE = new Set();
let VALID_WORDS_EN = new Set();
let wordlistsReady = false;

async function loadWordlists() {
  try {
    const [deRes, enRes] = await Promise.all([
      fetch('words_de.txt'),
      fetch('words_en.txt')
    ]);
    const [deText, enText] = await Promise.all([deRes.text(), enRes.text()]);

    // Handles both formats:
    // "WORT" (plain) and "wort 12345" (frequency list)
    const parseWords = (text, allowUmlauts = false) => {
      const allowed = allowUmlauts
        ? /^[A-ZÄÖÜ]+$/
        : /^[A-Z]+$/;
      return new Set(
        text.split('\n')
          .map(line => line.trim().split(/\s+/)[0].toUpperCase())
          .filter(w => w.length === 5 && allowed.test(w))
      );
    };

    VALID_WORDS_DE = parseWords(deText, true);   // DE: allow Ä Ö Ü
    VALID_WORDS_EN = parseWords(enText, false);  // EN: only A-Z

    wordlistsReady = true;
    console.log(`Wordlists loaded: DE=${VALID_WORDS_DE.size}, EN=${VALID_WORDS_EN.size}`);
  } catch (e) {
    console.warn('Wordlists could not be loaded, validation disabled:', e);
    wordlistsReady = false;
  }
}
