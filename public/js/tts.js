// Reading aloud. The browser supplies the voice; this file supplies the
// sentences, the breathing room between them, and a queue that survives a page
// turn.

import { forSpeech, worthSaying } from "/js/speech-text.js";

const ABBREV = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "fig", "eq", "no", "vol",
  "ch", "sec", "pp", "ed", "eds", "al", "etc", "approx", "dept", "univ", "inc",
  "ltd", "co", "cf", "vs", "e.g", "i.e", "viz", "ibid"
]);

const HARD_CAP = 420; // Chrome drops utterances that run much past this.

// How long to rest after a sentence, in milliseconds, before the next one.
const REST = { sentence: 170, heading: 420, paragraph: 520 };

/**
 * Split a page into sentences, keeping each one's character range so the reader
 * can light up the matching text on the page, the words to say for it, and how
 * long to rest afterwards.
 * @returns {{start:number, end:number, text:string, speech:string, rest:number}[]}
 */
export function splitSentences(raw) {
  const out = [];
  let start = 0;

  const push = (from, to) => {
    const text = clean(raw.slice(from, to));
    const speech = forSpeech(raw.slice(from, to));
    if (worthSaying(speech)) out.push({ start: from, end: to, text, speech, rest: REST.sentence });
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const isStop = ch === "." || ch === "!" || ch === "?";
    const isBreak = ch === "\n" && raw[i + 1] === "\n";

    if (!isStop && !isBreak) {
      // Runaway sentence (tables, references, PDFs with no punctuation).
      if (i - start > HARD_CAP && /\s/.test(ch)) {
        push(start, i);
        start = i + 1;
      }
      continue;
    }

    if (isStop) {
      let j = i + 1;
      while (j < raw.length && /["'”’)\]]/.test(raw[j])) j++;
      const next = raw[j];
      if (next && !/\s/.test(next)) continue;          // 3.14, foo.bar
      if (ch === "." && isAbbreviation(raw, i)) continue;
      push(start, j);
      start = j;
    } else {
      push(start, i);
      start = i + 1;
    }
  }

  push(start, raw.length);

  // A reader rests longer between paragraphs than between sentences, and longer
  // still after a heading, which is what tells you a heading was one.
  for (const sentence of out) {
    const breaks = blankLinesAfter(raw, sentence.end);
    const unpunctuated = !/[.!?:;]$/.test(sentence.text);
    if (breaks >= 2) sentence.rest = REST.paragraph;
    else if (breaks === 1 && unpunctuated && sentence.text.length < 70) sentence.rest = REST.heading;
  }

  return out;
}

function blankLinesAfter(raw, end) {
  let newlines = 0;
  for (let i = end; i < raw.length && /\s/.test(raw[i]); i++) {
    if (raw[i] === "\n") newlines++;
  }
  return newlines;
}

function isAbbreviation(raw, dot) {
  let k = dot - 1;
  while (k >= 0 && /[^\s]/.test(raw[k])) k--;
  const word = raw.slice(k + 1, dot).toLowerCase().replace(/^[^a-z.]+/, "");
  if (ABBREV.has(word)) return true;
  return word.length === 1 && /[a-z]/.test(word); // an initial: "J. Smith"
}

function clean(text) {
  return text
    .replace(/-\s*\n\s*/g, "")   // rejoin words broken across lines
    .replace(/\s+/g, " ")
    .trim();
}


/** A queue of sentences read one at a time, so a page turn can interrupt it. */
export class Speaker {
  constructor() {
    this.synth = window.speechSynthesis;
    this.queue = [];
    this.index = 0;
    this.playing = false;
    this.rate = 1;
    this.voice = null;
    this.onSentence = () => {};
    this.onFinished = () => {};
    this.keepalive = null;
    this.resting = null;
  }

  static get supported() {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  voices() {
    return this.synth ? this.synth.getVoices() : [];
  }

  /** Voices arrive asynchronously in Chrome; resolve once they exist. */
  ready() {
    return new Promise(resolve => {
      if (!this.synth) return resolve([]);
      const have = this.synth.getVoices();
      if (have.length) return resolve(have);
      const done = () => {
        this.synth.removeEventListener("voiceschanged", done);
        resolve(this.synth.getVoices());
      };
      this.synth.addEventListener("voiceschanged", done);
      setTimeout(() => resolve(this.synth.getVoices()), 1200);
    });
  }

  load(sentences, from = 0) {
    this.queue = sentences;
    this.index = Math.min(Math.max(from, 0), Math.max(sentences.length - 1, 0));
  }

  start(from = this.index) {
    if (!this.queue.length) { this.onFinished(); return; }
    this.index = from;
    this.playing = true;
    this.synth.cancel();
    this.#tick();
    this.#guard();
  }

  #tick() {
    if (!this.playing) return;
    if (this.index >= this.queue.length) {
      this.playing = false;
      this.#unguard();
      this.onFinished();
      return;
    }

    const at = this.index;
    const sentence = this.queue[at];
    const utter = new SpeechSynthesisUtterance(sentence.speech || sentence.text);
    utter.rate = this.rate;
    utter.pitch = 1;
    if (this.voice) utter.voice = this.voice;

    // Rest before the next sentence rather than running them together. Faster
    // reading shortens the rests too, the way it does for a person.
    const advance = () => {
      if (!this.playing || this.index !== at) return;
      this.index = at + 1;
      const rest = (sentence.rest || 0) / Math.max(this.rate, 0.5);
      this.resting = setTimeout(() => this.#tick(), rest);
    };

    utter.onstart = () => this.onSentence(at);
    utter.onend = advance;
    utter.onerror = event => {
      if (event.error === "interrupted" || event.error === "canceled") return;
      advance();
    };

    this.current = utter;
    this.synth.speak(utter);
  }

  pause() {
    this.playing = false;
    this.#unguard();
    this.synth.cancel(); // pause() is unreliable on mobile; restart the sentence
  }

  stop() {
    this.playing = false;
    this.index = 0;
    this.#unguard();
    this.synth.cancel();
  }

  // Chrome silently suspends synthesis after ~15s; nudging it keeps it awake.
  #guard() {
    this.#unguard();
    this.keepalive = setInterval(() => {
      if (!this.playing) return this.#unguard();
      if (this.synth.speaking) { this.synth.pause(); this.synth.resume(); }
    }, 8000);
  }

  #unguard() {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    if (this.resting) clearTimeout(this.resting);
    this.resting = null;
  }
}
