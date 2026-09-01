// A PDF is typeset for eyes, not for a voice. Read one out verbatim and it
// sounds like a machine, because it is full of things nobody says aloud:
// ligatures, hyphens left over from line breaks, bracketed citations, bare page
// numbers, URLs, and abbreviations that are read as letters. This turns a run of
// extracted text into the words a person would actually say.

const LIGATURES = {
  "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl",
  "ﬅ": "st", "ﬆ": "st", "œ": "oe", "æ": "ae"
};

// Read as words, not letters. Kept short on purpose: every expansion is a
// chance to mangle a sentence that was fine to begin with.
const SPOKEN = [
  [/\bFigs\./gi, "Figures"],
  [/\bFig\./gi, "Figure"],
  [/\bEqs\./gi, "Equations"],
  [/\bEq\./gi, "Equation"],
  [/\bRefs\./gi, "References"],
  [/\bRef\./gi, "Reference"],
  [/\be\.\s?g\./gi, "for example"],
  [/\bi\.\s?e\./gi, "that is"],
  [/\bet al\./gi, "and others"],
  [/\bcf\./gi, "compare"],
  [/\betc\./gi, "et cetera"],
  [/\bvs\.?/gi, "versus"],
  [/\bapprox\./gi, "approximately"],
  [/\bDept\./gi, "Department"],
  [/\bUniv\./gi, "University"],
  [/\bvol\.\s*(\d)/gi, "volume $1"],
  [/\bpp\.\s*(\d)/gi, "pages $1"],
  [/\bp\.\s*(\d)/gi, "page $1"],
  [/\bNo\.\s*(\d)/g, "number $1"],
  [/\bSec\.\s*(\d)/gi, "section $1"],
  [/§\s*/g, "section "],
  [/\s&\s/g, " and "],
  [/(\d)\s*%/g, "$1 percent"],
  [/(\d)\s*°C/g, "$1 degrees celsius"],
  [/±/g, " plus or minus "],
  [/(\d)\s*×\s*(\d)/g, "$1 by $2"],
  [/→/g, " to "]
];

/** The words to speak for a run of extracted PDF text. */
export function forSpeech(raw) {
  let text = raw;

  for (const [glyph, plain] of Object.entries(LIGATURES)) {
    text = text.split(glyph).join(plain);
  }

  text = text
    .replace(/-\s*\n\s*/g, "")                  // a word broken across two lines
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1 to $2")   // a range of numbers
    .replace(/\s*[—–]\s*/g, ", ")     // a dash is a breath, not a word
    .replace(/https?:\/\/\S+|www\.\S+/gi, "a link")
    .replace(/\S+@\S+\.\S+/g, "an email address")
    .replace(/\[\s*\d+(?:\s*[,–-]\s*\d+)*\s*\]/g, "")  // [12], [3-5]
    .replace(/\.{3,}|…/g, ", ")            // leader dots in a contents list
    .replace(/_{2,}|-{3,}/g, " ");

  for (const [pattern, said] of SPOKEN) text = text.replace(pattern, said);

  return text.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
}

/** Whether a run is worth speaking at all. */
export function worthSaying(text) {
  if (!/[A-Za-z]/.test(text)) return false;         // page numbers, rules, glyphs
  if (/^\d+\s*$/.test(text)) return false;
  if (/^page\s+\d+(\s+of\s+\d+)?$/i.test(text)) return false;
  return text.replace(/[^A-Za-z]/g, "").length > 1;
}

/**
 * Pick the most human voice available. Browsers hand back everything from
 * 1990s formant synthesis to neural voices, and the default is rarely the best
 * of them, so choose rather than accept.
 */
export function bestVoice(voices, language = navigator.language || "en-US") {
  if (!voices.length) return null;
  const want = language.toLowerCase();
  const family = want.slice(0, 2);

  const score = voice => {
    const name = voice.name.toLowerCase();
    const lang = (voice.lang || "").toLowerCase().replace("_", "-");
    let points = 0;

    if (/natural|neural|premium|enhanced/.test(name)) points += 8;
    if (/online/.test(name)) points += 4;              // Microsoft's cloud voices
    if (/google/.test(name)) points += 5;
    if (/siri|samantha|serena|daniel|karen|moira/.test(name)) points += 4;  // Apple
    if (voice.localService === false) points += 1;

    if (lang === want) points += 6;
    else if (lang.slice(0, 2) === family) points += 4;
    else points -= 6;                                   // wrong language is fatal

    if (voice.default) points += 1;
    // The old Windows SAPI set: intelligible, unmistakably a robot.
    if (/david|zira|mark|hazel|sam\b/.test(name)) points -= 5;
    if (/espeak|festival|pico/.test(name)) points -= 6;

    return points;
  };

  return [...voices].sort((a, b) => score(b) - score(a))[0] || null;
}
