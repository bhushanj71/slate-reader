// Reading aloud in a studio voice. The audio is synthesised by the server,
// which holds the API key; this file only asks for a sentence and plays it.
//
// It presents the same shape as the device Speaker in tts.js — load, start,
// pause, stop, onSentence, onFinished — so the reader can hold either one
// without knowing which.

const CACHE_LIMIT = 120;   // sentences of audio kept for this session

export class CloudSpeaker {
  constructor() {
    this.queue = [];
    this.index = 0;
    this.playing = false;
    this.rate = 1;
    this.voiceId = null;
    this.onSentence = () => {};
    this.onFinished = () => {};
    this.onTrouble = () => {};
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.clips = new Map();      // sentence text -> object URL
    this.resting = null;
    this.token = 0;
  }

  /** What the server can offer, if anything. */
  static async probe() {
    try {
      const res = await fetch("/api/voice");
      if (!res.ok) return { available: false, voices: [] };
      const info = await res.json();
      return { available: Boolean(info.available), voices: info.voices || [] };
    } catch {
      return { available: false, voices: [] };
    }
  }

  ready() { return Promise.resolve([]); }
  voices() { return []; }

  load(sentences, from = 0) {
    this.queue = sentences;
    this.index = Math.min(Math.max(from, 0), Math.max(sentences.length - 1, 0));
  }

  start(from = this.index) {
    if (!this.queue.length) { this.onFinished(); return; }
    this.index = from;
    this.playing = true;
    this.token++;
    this.#play();
  }

  pause() {
    this.playing = false;
    this.#clearRest();
    this.audio.pause();
  }

  stop() {
    this.playing = false;
    this.index = 0;
    this.token++;
    this.#clearRest();
    this.audio.pause();
    this.audio.removeAttribute("src");
  }

  async #play() {
    if (!this.playing) return;
    if (this.index >= this.queue.length) {
      this.playing = false;
      this.onFinished();
      return;
    }

    const at = this.index;
    const token = this.token;
    const sentence = this.queue[at];

    let url;
    try {
      url = await this.#clip(sentence.speech || sentence.text);
    } catch (err) {
      // One failure is enough: fall back rather than stuttering through a page.
      this.playing = false;
      this.onTrouble(err);
      return;
    }
    if (!this.playing || token !== this.token || this.index !== at) return;

    this.audio.src = url;
    this.audio.playbackRate = this.rate;
    this.audio.onended = () => {
      if (!this.playing || token !== this.token || this.index !== at) return;
      this.index = at + 1;
      const rest = (sentence.rest || 0) / Math.max(this.rate, 0.5);
      this.resting = setTimeout(() => this.#play(), rest);
    };
    this.audio.onerror = () => {
      if (!this.playing || token !== this.token) return;
      this.playing = false;
      this.onTrouble(new Error("The audio could not be played."));
    };

    try {
      await this.audio.play();
    } catch (err) {
      // Autoplay was refused, which only happens without a gesture behind it.
      this.playing = false;
      this.onTrouble(err);
      return;
    }

    this.onSentence(at);
    this.#prefetch(at + 1);        // fetch the next while this one is speaking
  }

  #prefetch(at) {
    const next = this.queue[at];
    if (!next) return;
    this.#clip(next.speech || next.text).catch(() => { /* it will be retried in turn */ });
  }

  async #clip(text) {
    const held = this.clips.get(text);
    if (held) return held;

    const res = await fetch("/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voiceId: this.voiceId })
    });

    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.error || `The voice service returned ${res.status}.`);
    }

    const url = URL.createObjectURL(await res.blob());
    this.clips.set(text, url);
    if (this.clips.size > CACHE_LIMIT) {
      const oldest = this.clips.keys().next().value;
      URL.revokeObjectURL(this.clips.get(oldest));
      this.clips.delete(oldest);
    }
    return url;
  }

  #clearRest() {
    if (this.resting) clearTimeout(this.resting);
    this.resting = null;
  }
}
