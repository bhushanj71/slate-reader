import * as pdfjs from "/vendor/pdfjs/pdf.mjs";
import { keepDrawingWhenHidden } from "/js/keep-drawing.js";
import { splitSentences, Speaker } from "/js/tts.js";
import {
  fingerprint, putDoc, getDoc, allDocs, removeDoc,
  getMarks, putMarks, saveCheckpoint, loadCheckpoint, savePrefs, loadPrefs
} from "/js/store.js";

pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
keepDrawingWhenHidden();

const PDF_OPTS = {
  cMapUrl: "/vendor/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/vendor/standard_fonts/"
};

const $ = id => document.getElementById(id);
const el = {
  device: $("device"), flash: $("flash"), toast: $("toast"),
  statusDoc: $("statusDoc"), statusPage: $("statusPage"), statusListening: $("statusListening"),
  shelf: $("shelfView"), reader: $("readerView"), rail: $("rail"),
  drop: $("drop"), openBtn: $("openBtn"), fileInput: $("fileInput"),
  contents: $("contents"), tocList: $("tocList"),
  stage: $("stage"), spread: $("spread"), spinner: $("spinner"),
  tapPrev: $("tapPrev"), tapMid: $("tapMid"), tapNext: $("tapNext"),
  progressLabel: $("progressLabel"), progressFill: $("progressFill"), progressPct: $("progressPct"),
  backBtn: $("backBtn"), prevBtn: $("prevBtn"), nextBtn: $("nextBtn"),
  pageInput: $("pageInput"), pageTotal: $("pageTotal"),
  playBtn: $("playBtn"), stopBtn: $("stopBtn"),
  markBtn: $("markBtn"), marksBtn: $("marksBtn"), settingsBtn: $("settingsBtn"),
  drawer: $("drawer"), drawerTitle: $("drawerTitle"), drawerBody: $("drawerBody"), drawerClose: $("drawerClose")
};

const prefs = Object.assign(
  { tone: "paper", sharpen: 1, fit: "page", size: 1, spread: "auto", ghost: true, rate: 1, voiceURI: null },
  loadPrefs()
);

const speaker = Speaker.supported ? new Speaker() : null;

const state = {
  id: null,
  title: "",
  pdf: null,
  page: 1,            // the left-hand leaf when two are open
  showing: [],        // page numbers currently on the panel
  pages: 0,
  twoUp: false,
  marks: [],
  listening: false,
  tasks: [],
  renderToken: 0,
  spans: [],          // per leaf: { node, start, end }
  sentences: [],      // per leaf-tagged sentence: { start, end, text, leaf }
  cache: new Map(),
  lit: []
};

/* ── Shelf ────────────────────────────────────────────────────────── */

async function refreshShelf() {
  const docs = await allDocs();
  el.contents.hidden = docs.length === 0;
  el.tocList.replaceChildren(...docs.map(row => {
    const at = loadCheckpoint(row.id) || { page: 1 };
    const li = document.createElement("li");

    const open = document.createElement("button");
    open.type = "button";
    open.className = "toc__row";
    open.innerHTML =
      `<span class="toc__title"></span><span class="toc__leader"></span><span class="toc__meta"></span>`;
    open.querySelector(".toc__title").textContent = row.title;
    open.querySelector(".toc__meta").textContent = row.pages
      ? `p. ${at.page} / ${row.pages}`
      : "unread";
    open.addEventListener("click", () => openStored(row.id));

    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "toc__drop";
    drop.textContent = "Remove";
    drop.setAttribute("aria-label", `Remove ${row.title} from the shelf`);
    drop.addEventListener("click", async () => {
      await removeDoc(row.id);
      localStorage.removeItem(`slate:at:${row.id}`);
      refreshShelf();
    });

    li.append(open, drop);
    return li;
  }));
}

async function openStored(id) {
  const row = await getDoc(id);
  if (!row) return note("That file is no longer on the shelf.");
  await load(await row.blob.arrayBuffer(), id, row.title);
}

async function takeFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
    return note("Slate reads PDFs only.");
  }

  note("Reading the file…");
  const title = file.name.replace(/\.pdf$/i, "");

  let id, buf;
  try {
    ({ id, buf } = await fingerprint(file));
  } catch (err) {
    console.error(err);
    return note("That file could not be read from disk.");
  }

  // Shelving is a convenience; a document that will not fit in storage should
  // still open for reading right now.
  try {
    await putDoc({ id, title, size: file.size, blob: file, openedAt: Date.now(), pages: 0 });
  } catch (err) {
    console.error(err);
    note("Opened, but there was no room to keep it on the shelf.");
  }

  await load(buf, id, title);
}

/* ── Opening a document ───────────────────────────────────────────── */

async function load(buffer, id, title) {
  stopListening();
  state.cache.clear();

  try {
    // pdf.js takes ownership of the buffer, so hand it a copy we can discard.
    state.pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer), ...PDF_OPTS }).promise;
  } catch (err) {
    console.error(err);
    return note("That PDF could not be opened. It may be damaged or password-protected.");
  }

  state.id = id;
  state.title = title;
  state.pages = state.pdf.numPages;
  state.marks = await getMarks(id);

  const stored = await getDoc(id);
  if (stored) putDoc({ ...stored, pages: state.pages, openedAt: Date.now() });

  el.shelf.hidden = true;
  el.reader.hidden = false;
  el.rail.hidden = false;
  el.statusDoc.textContent = title;
  el.pageTotal.textContent = `/ ${state.pages}`;

  const at = loadCheckpoint(id);
  const resumeTo = at && at.page > 1 ? at.page : 1;
  await go(resumeTo, { flash: false, ghost: false, scrollTop: at?.scrollTop });

  if (resumeTo > 1) note(`Picked up at page ${resumeTo}.`, "Start over", () => go(1));
}

function toShelf() {
  stopListening();
  state.renderToken++;
  cancelRenders();
  el.device.classList.remove("is-bare");
  el.reader.hidden = true;
  el.rail.hidden = true;
  el.shelf.hidden = false;
  el.statusDoc.textContent = "Library";
  el.statusPage.hidden = true;
  closeDrawer();
  refreshShelf();
}

/* ── Turning pages ────────────────────────────────────────────────── */

/** Facing pages are paired the way a book is bound: the cover stands alone,
 *  then 2–3, 4–5, and so on, so an even page is always on the left. */
function leftLeafFor(n) {
  if (!state.twoUp || n <= 1) return Math.max(n, 1);
  return n % 2 === 0 ? n : n - 1;
}

function leavesOpenAt(left) {
  if (!state.twoUp || left === 1) return [left];
  return left + 1 <= state.pages ? [left, left + 1] : [left];
}

function twoUpWanted() {
  if (prefs.spread === "single") return false;
  if (prefs.spread === "double") return true;
  return el.stage.clientWidth > 780 && el.stage.clientWidth > el.stage.clientHeight;
}

function cancelRenders() {
  state.tasks.forEach(t => { try { t.cancel(); } catch { /* already settled */ } });
  state.tasks = [];
}

async function go(n, { flash = true, ghost = true, scrollTop = 0 } = {}) {
  if (!state.pdf) return;

  state.twoUp = twoUpWanted();
  const left = leftLeafFor(Math.min(Math.max(Math.round(n) || 1, 1), state.pages));
  const numbers = leavesOpenAt(left);
  state.page = left;
  state.showing = numbers;

  const token = ++state.renderToken;
  cancelRenders();
  el.spinner.hidden = false;
  updateChrome();

  const pages = await Promise.all(numbers.map(p => state.pdf.getPage(p)));
  if (token !== state.renderToken) return;

  const scale = scaleFor(pages);
  const residue = ghost && prefs.ghost ? captureLeaves() : [];

  const leaves = pages.map(page => {
    const viewport = page.getViewport({ scale });
    const leaf = document.createElement("div");
    leaf.className = "leaf";
    const canvas = document.createElement("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Page of the document");
    const text = document.createElement("div");
    text.className = "textlayer";
    leaf.append(canvas, text);
    return { page, viewport, leaf, canvas, text };
  });

  el.spread.replaceChildren(...leaves.map(l => l.leaf));

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (const l of leaves) {
    l.canvas.width = Math.floor(l.viewport.width * dpr);
    l.canvas.height = Math.floor(l.viewport.height * dpr);
    l.canvas.style.width = `${Math.floor(l.viewport.width)}px`;
    l.canvas.style.height = `${Math.floor(l.viewport.height)}px`;
    const task = l.page.render({
      canvasContext: l.canvas.getContext("2d", { alpha: false }),
      viewport: l.viewport,
      transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0]
    });
    state.tasks.push(task);
    try {
      await task.promise;
    } catch (err) {
      if (err?.name !== "RenderingCancelledException") console.error(err);
      return;
    }
    if (token !== state.renderToken) return;
  }

  state.spans = [];
  state.sentences = [];
  for (let i = 0; i < leaves.length; i++) {
    const { spans, sentences } = await buildLeafText(leaves[i], numbers[i], token);
    if (token !== state.renderToken) return;
    state.spans.push(spans);
    sentences.forEach(s => state.sentences.push({ ...s, leaf: i }));
  }

  el.spinner.hidden = true;
  el.stage.scrollTop = scrollTop || 0;
  if (residue.length) layGhosts(leaves, residue);
  if (flash) refreshFlash();
  checkpoint();
}

function scaleFor(pages) {
  const unit = pages[0].getViewport({ scale: 1 });
  const style = getComputedStyle(el.stage);
  const gutter = pages.length - 1 + 2;      // hairline gutter plus the border
  const room = el.stage.clientWidth - parseFloat(style.paddingLeft) * 2 - gutter;
  const height = el.stage.clientHeight - parseFloat(style.paddingTop) * 2 - 2;
  const perLeaf = room / pages.length;
  const base = prefs.fit === "width"
    ? perLeaf / unit.width
    : Math.min(perLeaf / unit.width, height / unit.height);
  return Math.max(base * prefs.size, 0.12);
}

async function buildLeafText(leaf, pageNo, token) {
  const content = await leaf.page.getTextContent();
  if (token !== state.renderToken) return { spans: [], sentences: [] };

  leaf.text.style.width = `${Math.floor(leaf.viewport.width)}px`;
  leaf.text.style.height = `${Math.floor(leaf.viewport.height)}px`;

  const spans = [];
  const frag = document.createDocumentFragment();
  let text = "";

  for (const item of content.items) {
    if (typeof item.str !== "string" || !item.str.length) {
      if (item.hasEOL) text += "\n";
      continue;
    }

    const tx = pdfjs.Util.transform(leaf.viewport.transform, item.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    const span = document.createElement("span");
    span.textContent = item.str;
    span.style.left = `${tx[4]}px`;
    span.style.top = `${tx[5] - fontHeight}px`;
    span.style.fontSize = `${fontHeight}px`;
    span.style.fontFamily = content.styles?.[item.fontName]?.fontFamily || "sans-serif";

    spans.push({
      node: span,
      start: text.length,
      end: text.length + item.str.length,
      target: item.width * leaf.viewport.scale
    });
    text += item.str + (item.hasEOL ? "\n" : " ");
    frag.append(span);
  }

  leaf.text.replaceChildren(frag);

  // One measuring pass for the whole leaf, then one writing pass: the glyphs
  // the browser has are never the glyphs the PDF used, so each run is
  // stretched to the width pdf.js reports for it.
  const widths = spans.map(s => s.node.getBoundingClientRect().width);
  spans.forEach((s, i) => {
    if (widths[i] > 0 && s.target > 0) s.node.style.transform = `scaleX(${s.target / widths[i]})`;
  });

  return { spans, sentences: sentencesFor(pageNo, text) };
}

function sentencesFor(pageNo, text) {
  const hit = state.cache.get(pageNo);
  if (hit) return hit;
  const sentences = splitSentences(text);
  state.cache.set(pageNo, sentences);
  return sentences;
}

/* ── Panel artifacts: the refresh flash and its ghost ─────────────── */

function refreshFlash() {
  el.flash.classList.remove("is-on");
  void el.flash.offsetWidth;
  el.flash.classList.add("is-on");
}

function captureLeaves() {
  return [...el.spread.querySelectorAll("canvas:not(.ghost)")].map(source => {
    const copy = document.createElement("canvas");
    copy.width = source.width;
    copy.height = source.height;
    copy.getContext("2d").drawImage(source, 0, 0);
    return copy;
  });
}

function layGhosts(leaves, residue) {
  leaves.forEach((l, i) => {
    const old = residue[i] || residue[0];
    if (!old) return;
    const ghost = document.createElement("canvas");
    ghost.className = "ghost";
    ghost.width = l.canvas.width;
    ghost.height = l.canvas.height;
    ghost.style.width = l.canvas.style.width;
    ghost.style.height = l.canvas.style.height;
    ghost.getContext("2d").drawImage(old, 0, 0, ghost.width, ghost.height);
    l.leaf.append(ghost);
    setTimeout(() => ghost.remove(), 500);
  });
}

/* ── Chrome ───────────────────────────────────────────────────────── */

function updateChrome() {
  const [first, last] = [state.showing[0], state.showing[state.showing.length - 1]];
  const label = state.showing.length > 1
    ? `Pages ${first}–${last} of ${state.pages}`
    : `Page ${first} of ${state.pages}`;

  el.progressLabel.textContent = label;
  el.progressPct.textContent = `${Math.round((last / state.pages) * 100)}%`;
  el.progressFill.style.width = `${(last / state.pages) * 100}%`;

  el.pageInput.value = first;
  el.statusPage.hidden = false;
  el.statusPage.textContent = `p. ${first} / ${state.pages}`;
  el.prevBtn.disabled = first <= 1;
  el.nextBtn.disabled = last >= state.pages;
}

/* ── Reading aloud ────────────────────────────────────────────────── */

async function startListening(fromSentence) {
  if (!speaker) return note("This browser has no speech voices.");
  if (!state.sentences.length) return note("There is no readable text on this page.");

  await speaker.ready();
  speaker.rate = prefs.rate;
  speaker.voice = speaker.voices().find(v => v.voiceURI === prefs.voiceURI) || null;

  state.listening = true;
  el.playBtn.textContent = "Pause";
  el.playBtn.classList.add("is-on");
  el.stopBtn.hidden = false;
  el.statusListening.hidden = false;

  speaker.onSentence = i => {
    highlight(state.sentences[i]);
    checkpoint(i);
  };
  speaker.onFinished = async () => {
    if (!state.listening) return;
    const last = state.showing[state.showing.length - 1];
    if (last >= state.pages) return stopListening("You have reached the end.");
    await go(last + 1);
    if (!state.listening) return;
    if (state.sentences.length) {
      speaker.load(state.sentences, 0);
      speaker.start(0);
    } else {
      speaker.onFinished();   // a plate or a blank leaf: keep going
    }
  };

  const at = loadCheckpoint(state.id);
  const resume = fromSentence ?? (at && at.page === state.page ? at.sentence || 0 : 0);
  speaker.load(state.sentences, resume);
  speaker.start(resume);
}

function pauseListening() {
  if (!speaker) return;
  speaker.pause();
  state.listening = false;
  el.playBtn.textContent = "Resume";
  el.playBtn.classList.remove("is-on");
  el.statusListening.hidden = true;
}

function stopListening(message) {
  if (speaker) speaker.stop();
  state.listening = false;
  el.playBtn.textContent = "Read aloud";
  el.playBtn.classList.remove("is-on");
  el.stopBtn.hidden = true;
  el.statusListening.hidden = true;
  clearHighlight();
  if (message) note(message);
}

function highlight(sentence) {
  clearHighlight();
  if (!sentence) return;
  const spans = state.spans[sentence.leaf] || [];
  const hits = spans.filter(s => s.start < sentence.end && s.end > sentence.start);
  hits.forEach(s => s.node.classList.add("lit"));
  state.lit = hits;
  if (hits.length) keepInView(hits[0].node);
}

function clearHighlight() {
  state.lit.forEach(s => s.node.classList.remove("lit"));
  state.lit = [];
}

function keepInView(node) {
  if (el.stage.scrollHeight <= el.stage.clientHeight) return;   // the whole leaf is on screen
  const top = node.getBoundingClientRect().top - el.stage.getBoundingClientRect().top + el.stage.scrollTop;
  const height = el.stage.clientHeight;
  if (top < el.stage.scrollTop + height * 0.12 || top > el.stage.scrollTop + height * 0.8) {
    el.stage.scrollTop = Math.max(top - height * 0.35, 0);
  }
}

/* ── Bookmarks and the checkpoint ─────────────────────────────────── */

function checkpoint(sentence) {
  if (!state.id) return;
  const previous = loadCheckpoint(state.id) || {};
  saveCheckpoint(state.id, {
    page: state.page,
    scrollTop: el.stage.scrollTop,
    sentence: sentence ?? (previous.page === state.page ? previous.sentence || 0 : 0)
  });
}

async function addMark() {
  if (!state.id) return;
  if (state.marks.some(m => m.page === state.page)) {
    return note(`Page ${state.page} is already bookmarked.`);
  }
  const snip = (state.sentences[0]?.text || "").slice(0, 90);
  state.marks = [...state.marks, { page: state.page, snip, at: Date.now() }]
    .sort((a, b) => a.page - b.page);
  await putMarks(state.id, state.marks);
  note(`Bookmarked page ${state.page}.`, "See marks", openMarks);
}

function openMarks() {
  openDrawer("Bookmarks");
  if (!state.marks.length) {
    el.drawerBody.innerHTML =
      `<p class="empty">No bookmarks yet. Slate still remembers where you stopped.</p>`;
    return;
  }
  const list = document.createElement("ul");
  list.className = "marklist";
  state.marks.forEach(mark => {
    const li = document.createElement("li");

    const open = document.createElement("button");
    open.type = "button";
    open.className = "mark-open";
    open.innerHTML = `<span></span><span class="mark-snip"></span>`;
    open.children[0].textContent = `Page ${mark.page}`;
    open.children[1].textContent = mark.snip || "";
    open.addEventListener("click", () => { closeDrawer(); go(mark.page); });

    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "toc__drop";
    drop.textContent = "Remove";
    drop.addEventListener("click", async () => {
      state.marks = state.marks.filter(m => m !== mark);
      await putMarks(state.id, state.marks);
      openMarks();
    });

    li.append(open, drop);
    list.append(li);
  });
  el.drawerBody.replaceChildren(list);
}

/* ── Panel settings ───────────────────────────────────────────────── */

function openSettings() {
  openDrawer("Panel");
  const body = document.createElement("div");

  body.append(
    segmented("Tone", [["paper", "Paper"], ["bleached", "Bleached"], ["night", "Night ink"]],
      prefs.tone, v => { prefs.tone = v; applyPrefs(); openSettings(); }),
    segmented("Leaves", [["auto", "Auto"], ["single", "One up"], ["double", "Spread"]],
      prefs.spread, v => { prefs.spread = v; applyPrefs(); openSettings(); reflow(); }),
    segmented("Fit", [["page", "Whole page"], ["width", "Width"]],
      prefs.fit, v => { prefs.fit = v; applyPrefs(); openSettings(); reflow(); }),
    segmented("Ghosting", [[true, "On"], [false, "Off"]],
      prefs.ghost, v => { prefs.ghost = v; applyPrefs(); openSettings(); }),
    slider("Sharpen", 0.85, 1.6, 0.05, prefs.sharpen, v => { prefs.sharpen = v; applyPrefs(); }),
    slider("Size", 0.6, 2, 0.1, prefs.size, v => { prefs.size = v; applyPrefs(); reflow(); })
  );

  if (speaker) {
    const pick = document.createElement("select");
    pick.append(new Option("Browser default", ""));
    speaker.voices().forEach(v => {
      const opt = new Option(`${v.name} — ${v.lang}`, v.voiceURI);
      opt.selected = v.voiceURI === prefs.voiceURI;
      pick.append(opt);
    });
    pick.addEventListener("change", () => {
      prefs.voiceURI = pick.value || null;
      applyPrefs();
      if (state.listening) startListening(speaker.index);
    });
    body.append(
      field("Voice", pick),
      slider("Speed", 0.6, 1.8, 0.1, prefs.rate, v => {
        prefs.rate = v;
        applyPrefs();
        if (state.listening) startListening(speaker.index);
      })
    );
  } else {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "This browser has no speech voices, so reading aloud is off.";
    body.append(p);
  }

  el.drawerBody.replaceChildren(body);
}

function reflow() {
  if (state.pdf && !el.reader.hidden) go(state.page, { flash: false, ghost: false });
}

function field(label, control) {
  const row = document.createElement("label");
  row.className = "field";
  const name = document.createElement("span");
  name.textContent = label;
  row.append(name, control);
  return row;
}

function slider(label, min, max, step, value, onInput) {
  const input = document.createElement("input");
  Object.assign(input, { type: "range", min, max, step, value });
  input.addEventListener("change", () => onInput(parseFloat(input.value)));
  input.addEventListener("input", () => onInput(parseFloat(input.value)));
  return field(label, input);
}

function segmented(label, options, current, onPick) {
  const wrap = document.createElement("div");
  wrap.className = "segmented";
  options.forEach(([value, text]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn" + (value === current ? " is-on" : "");
    btn.textContent = text;
    btn.addEventListener("click", () => onPick(value));
    wrap.append(btn);
  });
  return field(label, wrap);
}

function applyPrefs() {
  el.device.dataset.tone = prefs.tone;
  el.device.style.setProperty("--sharpen", prefs.sharpen);
  if (speaker) {
    speaker.rate = prefs.rate;
    speaker.voice = speaker.voices().find(v => v.voiceURI === prefs.voiceURI) || null;
  }
  savePrefs(prefs);
}

/* ── Drawer, toast ────────────────────────────────────────────────── */

function openDrawer(title) {
  el.drawerTitle.textContent = title;
  el.drawer.hidden = false;
}

function closeDrawer() { el.drawer.hidden = true; }

function drawerIs(title) { return !el.drawer.hidden && el.drawerTitle.textContent === title; }

let toastTimer;
function note(text, actionLabel, action) {
  clearTimeout(toastTimer);
  el.toast.replaceChildren(document.createTextNode(text));
  if (actionLabel) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = actionLabel;
    btn.addEventListener("click", () => { el.toast.hidden = true; action(); });
    el.toast.append(btn);
  }
  el.toast.hidden = false;
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, actionLabel ? 9000 : 4000);
}

/* ── Wiring ───────────────────────────────────────────────────────── */

function wireUp() {
  el.openBtn.addEventListener("click", () => el.fileInput.click());
  // The whole dashed panel is a target, not just the button inside it.
  el.drop.addEventListener("click", e => {
    if (e.target !== el.openBtn) el.fileInput.click();
  });
  el.fileInput.addEventListener("change", () => {
    const [file] = el.fileInput.files;
    el.fileInput.value = "";        // so choosing the same file twice still fires
    takeFile(file);
  });

  ["dragenter", "dragover"].forEach(type =>
    el.device.addEventListener(type, e => { e.preventDefault(); el.drop.classList.add("is-over"); }));
  ["dragleave", "drop"].forEach(type =>
    el.device.addEventListener(type, () => el.drop.classList.remove("is-over")));
  el.device.addEventListener("drop", e => {
    e.preventDefault();
    takeFile(e.dataTransfer?.files?.[0]);
  });

  el.backBtn.addEventListener("click", toShelf);
  el.prevBtn.addEventListener("click", () => turn(-1));
  el.nextBtn.addEventListener("click", () => turn(1));
  el.tapPrev.addEventListener("click", () => turn(-1));
  el.tapNext.addEventListener("click", () => turn(1));
  el.tapMid.addEventListener("click", () => el.device.classList.toggle("is-bare"));

  el.pageInput.addEventListener("change", () => {
    const n = parseInt(el.pageInput.value, 10);
    if (Number.isFinite(n)) turnTo(n);
    else el.pageInput.value = state.page;
  });

  el.playBtn.addEventListener("click", () => {
    if (state.listening) pauseListening();
    else startListening(speaker && speaker.queue === state.sentences ? speaker.index : undefined);
  });
  el.stopBtn.addEventListener("click", () => stopListening());

  el.markBtn.addEventListener("click", addMark);
  el.marksBtn.addEventListener("click", () => (drawerIs("Bookmarks") ? closeDrawer() : openMarks()));
  el.settingsBtn.addEventListener("click", () => (drawerIs("Panel") ? closeDrawer() : openSettings()));
  el.drawerClose.addEventListener("click", closeDrawer);

  let scrollTimer;
  el.stage.addEventListener("scroll", () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(checkpoint, 400);
  });

  window.addEventListener("resize", debounce(reflow, 250));
  window.addEventListener("pagehide", () => { checkpoint(); if (speaker) speaker.stop(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) checkpoint(); });

  document.addEventListener("keydown", e => {
    if (e.target.matches("input, select, textarea")) return;
    if (el.reader.hidden) return;
    const keys = {
      ArrowRight: () => turn(1), ArrowDown: () => turn(1), PageDown: () => turn(1), j: () => turn(1),
      ArrowLeft: () => turn(-1), ArrowUp: () => turn(-1), PageUp: () => turn(-1), k: () => turn(-1),
      b: addMark, B: addMark,
      h: () => el.device.classList.toggle("is-bare"),
      Escape: closeDrawer,
      " ": () => (state.listening ? pauseListening() : startListening())
    };
    const run = keys[e.key];
    if (!run) return;
    e.preventDefault();
    run();
  });
}

function turn(delta) { turnTo(state.page + delta * (state.twoUp ? 2 : 1)); }

async function turnTo(n) {
  if (!state.pdf) return;
  const target = Math.min(Math.max(n, 1), state.pages);
  if (leftLeafFor(target) === state.page) return;

  const wasListening = state.listening;
  if (wasListening && speaker) speaker.pause();

  await go(target);

  if (wasListening) {
    state.listening = true;
    if (state.sentences.length) {
      speaker.load(state.sentences, 0);
      speaker.start(0);
    }
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ── Boot ─────────────────────────────────────────────────────────── */

applyPrefs();
wireUp();
refreshShelf();
if (speaker) speaker.ready();

// Proof of life for the fallback in index.html. If an import above fails — most
// likely the pdf.js files under /vendor — none of this module runs, every
// control is inert, and the page gives no sign of it. This flag is how the page
// knows the difference between "working" and "never started".
document.documentElement.dataset.slateReady = "1";

// A slow network can trip that fallback before this module arrives. Arriving
// late is not the same as failing, so put the page back.
$("fault").hidden = true;
$("drop").hidden = false;
