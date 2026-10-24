// Player: mistura as faixas separadas no navegador e mostra a letra sincronizada.

const $ = (id) => document.getElementById(id);
const SONG_ID = location.pathname.split("/").pop();
const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

let song = null;
let lines = [];
let synced = false;
let offset = 0;     // ajuste de sincronia desta música (s); positivo = letra mais tarde
let btDelay = 0;    // atraso da caixa Bluetooth (s), vale para todas as músicas

// ---------- Áudio ----------

const ctx = new AudioContext();
const master = ctx.createGain();
master.connect(ctx.destination);
const tracks = {}; // nome -> { buffer, gain, source }
let duration = 0;
let playing = false;
let startAt = 0;    // ctx.currentTime correspondente ao segundo 0 da música
let pausedAt = 0;
let mode = "instrumental";

async function loadTrack(name) {
  const r = await fetch(`/media/${SONG_ID}/${name}.mp3`);
  if (!r.ok) return;
  const buffer = await ctx.decodeAudioData(await r.arrayBuffer());
  const gain = ctx.createGain();
  gain.connect(master);
  tracks[name] = { buffer, gain, source: null };
  duration = Math.max(duration, buffer.duration);
}

function now() {
  const t = playing ? ctx.currentTime - startAt : pausedAt;
  return Math.min(Math.max(0, t), duration);
}

function play(from = now()) {
  if (from >= duration - 0.05) from = 0;
  ctx.resume();
  const when = ctx.currentTime + 0.05;
  for (const t of Object.values(tracks)) {
    const src = ctx.createBufferSource();
    src.buffer = t.buffer;
    src.connect(t.gain);
    src.start(when, from);
    t.source = src;
  }
  startAt = when - from;
  playing = true;
  $("play").textContent = "❚❚";
}

function pause() {
  pausedAt = now();
  for (const t of Object.values(tracks)) { try { t.source && t.source.stop(); } catch (e) {} t.source = null; }
  playing = false;
  $("play").textContent = "▶";
}

function seek(t) {
  const was = playing;
  if (playing) pause();
  pausedAt = Math.min(Math.max(0, t), duration);
  if (was) play(pausedAt);
}

function applyMix() {
  // "Original" = todas as faixas juntas, que somam a música original
  const lead = mode === "original" ? 1 : parseFloat($("vol-lead").value);
  const backing = mode === "original" ? 1 : parseFloat($("vol-backing").value);
  if (tracks.original) tracks.original.gain.gain.value = 1;
  if (tracks.instrumental) tracks.instrumental.gain.gain.value = 1;
  if (tracks.lead) tracks.lead.gain.gain.value = lead;
  if (tracks.backing) tracks.backing.gain.gain.value = backing;
  master.gain.value = parseFloat($("master").value);
  $("mode-original").classList.toggle("on", mode === "original");
  $("mode-instrumental").classList.toggle("on", mode === "instrumental");
}

// ---------- Letra ----------

function renderLyrics() {
  const box = $("lyrics-lines");
  box.replaceChildren();
  if (!lines.length) {
    box.append(h("div", { class: "ln on", style: "margin-top:40%" }, "Sem letra. Escolha uma na biblioteca (🎤)."));
    return;
  }
  $("lyrics-scroll").classList.toggle("free", !synced && !rec);
  lines.forEach((l, i) => {
    box.append(h("div", { class: "ln" + (l.text ? "" : " empty"), "data-i": i, onclick: () => syncToLine(i) }, l.text || "♪"));
  });
}

let activeIdx = -2;

function updateLyrics() {
  if ((!synced && !rec) || !lines.length) return;
  const t = now() - offset - btDelay;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t == null) continue;
    if (lines[i].t <= t) idx = i; else break;
  }
  const key = rec ? `${idx}/${rec.idx}` : idx;
  if (key === activeIdx) return;
  activeIdx = key;
  const els = $("lyrics-lines").children;
  for (let i = 0; i < els.length; i++) {
    els[i].classList.toggle("on", i === idx);
    els[i].classList.toggle("past", i < idx);
    els[i].classList.toggle("next", Boolean(rec) && i === rec.idx);
  }
  // Deixa a linha atual (ou a próxima a marcar) a ~40% da altura, longe dos controles da tela cheia
  const target = els[Math.max(0, rec ? Math.min(rec.idx, els.length - 1) : idx)];
  const boxH = $("lyrics-box").clientHeight;
  requestAnimationFrame(() => {
    const y = target.offsetTop + target.offsetHeight / 2;
    $("lyrics-lines").style.transform = `translateY(${boxH * 0.4 - y}px)`;
  });
}

// ---------- Sincronia ----------

let syncMode = false;

function setOffset(v, save = true) {
  offset = Math.round(v * 100) / 100;
  $("offset").textContent = `${offset > 0 ? "+" : ""}${offset.toFixed(1)}s`;
  activeIdx = -2;
  if (save) saveOffset();
}

let saveTimer = null;
function saveOffset() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api(`/api/songs/${SONG_ID}`, { method: "PATCH", body: { offset } }).catch(() => {}), 500);
}

function syncToLine(i) {
  if (rec) { rec.idx = i; activeIdx = -2; return; }
  if (!syncMode || !synced || lines[i].t == null) return;
  // A linha clicada passa a começar agora
  setOffset(now() - btDelay - lines[i].t);
  syncMode = false;
  $("sync-mouse").classList.remove("on");
  $("lyrics-box").classList.remove("syncing");
  toast("Letra sincronizada.");
}

$("sync-mouse").addEventListener("click", () => {
  if (!synced) { toast("Essa letra não tem tempos para sincronizar.", true); return; }
  syncMode = !syncMode;
  $("sync-mouse").classList.toggle("on", syncMode);
  $("lyrics-box").classList.toggle("syncing", syncMode);
  if (syncMode) toast("Clique na linha da letra no momento em que ela começa.");
});
document.querySelectorAll("[data-shift]").forEach((b) => b.addEventListener("click", () => setOffset(offset + parseFloat(b.dataset.shift))));

$("bt").addEventListener("change", () => {
  btDelay = Math.max(0, parseFloat($("bt").value) || 0);
  activeIdx = -2;
  api("/api/config", { method: "POST", body: { bt_delay: btDelay } }).catch(() => toast("O atraso do Bluetooth só pode ser salvo no notebook.", true));
});

// ---------- Gravar sincronia em tempo real ----------
// Toque a música e aperte espaço no começo de cada linha. Cada marca também
// empurra as linhas seguintes pela mesma diferença, então marcar só a primeira
// linha já corrige uma letra inteira atrasada ou adiantada (ex.: versão karaokê).

let rec = null; // { idx, history, backup, backupOffset }

function startRec() {
  if (!lines.length) { toast("Escolha ou cole uma letra primeiro (🎤 na biblioteca).", true); return; }
  if (syncMode) $("sync-mouse").click();
  rec = { idx: 0, history: [], backup: lines.map((l) => l.t), backupOffset: offset };
  // O ajuste atual passa para os tempos das linhas
  for (const l of lines) if (l.t != null) l.t = Math.round((l.t + offset) * 100) / 100;
  setOffset(0, false);
  // Começa pela primeira linha que ainda não passou
  const t = now() - btDelay;
  const next = lines.findIndex((l) => l.t == null || l.t > t);
  rec.idx = next < 0 ? 0 : next;
  $("rec-bar").hidden = false;
  $("rec-start").hidden = true;
  $("lyrics-box").classList.add("recording");
  renderLyrics();
  activeIdx = -2;
  if (!playing) play();
}

function markLine() {
  if (!rec || rec.idx >= lines.length) return;
  const i = rec.idx;
  const T = Math.round((now() - btDelay) * 100) / 100;
  rec.history.push({ i, times: lines.map((l) => l.t) });
  const old = lines[i].t;
  lines[i].t = T;
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].t == null) continue;
    if (old != null) lines[j].t = Math.round((lines[j].t + T - old) * 100) / 100;
    if (lines[j].t <= lines[j - 1].t) lines[j].t = Math.round((lines[j - 1].t + 0.3) * 100) / 100;
  }
  rec.idx = i + 1;
  activeIdx = -2;
  if (rec.idx >= lines.length) finishRec(true);
}

function undoMark() {
  if (!rec || !rec.history.length) return;
  const last = rec.history.pop();
  lines.forEach((l, k) => { l.t = last.times[k]; });
  rec.idx = last.i;
  const back = last.times[last.i] != null ? last.times[last.i] : now();
  seek(Math.max(0, Math.min(back, now()) - 3));
  activeIdx = -2;
}

async function finishRec(save) {
  if (!rec) return;
  if (save) {
    // Linhas que ficaram sem tempo (letra colada, gravação parada no meio) seguem a última marcada
    let last = 0;
    for (const l of lines) { if (l.t == null) l.t = Math.round((last + 3) * 100) / 100; last = l.t; }
    try {
      await api(`/api/songs/${SONG_ID}/lyrics/times`, { method: "PUT", body: { times: lines.map((l) => l.t) } });
      synced = true;
      setOffset(0, false);
      toast("Sincronia salva.");
    } catch (e) { toast(e.message, true); }
  } else {
    lines.forEach((l, k) => { l.t = rec.backup[k]; });
    setOffset(rec.backupOffset, false);
  }
  rec = null;
  $("rec-bar").hidden = true;
  $("rec-start").hidden = false;
  $("lyrics-box").classList.remove("recording");
  renderLyrics();
  activeIdx = -2;
}

$("rec-start").addEventListener("click", startRec);
$("rec-mark").addEventListener("click", markLine);
$("rec-undo").addEventListener("click", undoMark);
$("rec-done").addEventListener("click", () => finishRec(true));
$("rec-cancel").addEventListener("click", () => finishRec(false));

// ---------- Controles ----------

$("play").addEventListener("click", () => (playing ? pause() : play()));
$("mode-original").addEventListener("click", () => { mode = "original"; applyMix(); });
$("mode-instrumental").addEventListener("click", () => { mode = "instrumental"; applyMix(); });
for (const id of ["vol-lead", "vol-backing", "master"]) $(id).addEventListener("input", () => {
  if (id !== "master" && mode === "original") mode = "instrumental";
  applyMix();
});

let seeking = false;
$("seek").addEventListener("input", () => { seeking = true; $("time").textContent = `${fmtTime($("seek").value / 1000 * duration)} / ${fmtTime(duration)}`; });
$("seek").addEventListener("change", () => { seeking = false; seek($("seek").value / 1000 * duration); });

$("blur").addEventListener("input", () => { $("lyrics-bg").style.filter = `blur(${$("blur").value}px) brightness(.55)`; });
$("bright").addEventListener("input", () => { $("lyrics-box").style.setProperty("--dim", $("bright").value); });

$("key-note").replaceChildren(...NOTES.map((n) => h("option", {}, n)));
for (const id of ["key-note", "key-scale"]) $(id).addEventListener("change", () => {
  api(`/api/songs/${SONG_ID}`, { method: "PATCH", body: { key: { note: $("key-note").value, scale: $("key-scale").value } } }).catch(() => {});
});

// Tela cheia: os controles somem parados e voltam ao mexer o mouse
const stage = $("stage");
let idleTimer = null;
function wake() {
  stage.classList.remove("idle");
  clearTimeout(idleTimer);
  if (document.fullscreenElement && !$("controls").matches(":hover")) idleTimer = setTimeout(() => stage.classList.add("idle"), 2500);
}
$("fullscreen").addEventListener("click", toggleFullscreen);
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen().catch(() => {});
}
document.addEventListener("fullscreenchange", () => { activeIdx = -2; wake(); });
document.addEventListener("mousemove", wake);
$("controls").addEventListener("mouseleave", wake);

document.addEventListener("keydown", (e) => {
  if (e.target.matches && e.target.matches("input[type=number], input[type=text], select")) return;
  if (rec) {
    if (e.code === "Space" || e.code === "Enter") { e.preventDefault(); markLine(); return; }
    if (e.code === "Backspace") { e.preventDefault(); undoMark(); return; }
    if (e.code === "Escape" && !document.fullscreenElement) { finishRec(true); return; }
  }
  if (e.code === "Space") { e.preventDefault(); playing ? pause() : play(); }
  else if (e.key === "f" || e.key === "F") toggleFullscreen();
  else if (e.key === "ArrowRight") seek(now() + 5);
  else if (e.key === "ArrowLeft") seek(now() - 5);
});

// ---------- Loop de tela ----------

function tick() {
  const t = now();
  if (playing && t >= duration - 0.01) { pause(); pausedAt = 0; }
  if (!seeking) {
    $("seek").value = duration ? Math.round((t / duration) * 1000) : 0;
    $("time").textContent = `${fmtTime(t)} / ${fmtTime(duration)}`;
  }
  updateLyrics();
  requestAnimationFrame(tick);
}

// ---------- Início ----------

async function init() {
  const state = await api("/api/state");
  song = state.songs.find((s) => s.id === SONG_ID);
  if (!song) { $("loading").textContent = "Música não encontrada."; return; }
  document.title = `${song.title} · Karaoke`;
  $("song-title").textContent = song.title;
  $("lyrics-bg").style.backgroundImage = `url("${song.cover}")`;
  if (song.key) { $("key-note").value = song.key.note; $("key-scale").value = song.key.scale; }
  btDelay = (state.config && state.config.bt_delay) || 0;
  $("bt").value = btDelay;
  setOffset(song.offset || 0, false);

  const lyr = await api(`/api/songs/${SONG_ID}/lyrics`);
  lines = lyr.lines || [];
  synced = Boolean(lyr.synced);
  renderLyrics();

  const names = song.separated ? ["instrumental", "lead"].concat(song.has_backing ? ["backing"] : []) : ["original"];
  try { await Promise.all(names.map(loadTrack)); }
  catch (e) { $("loading").textContent = "Falha ao carregar o áudio."; return; }
  if (!song.separated) {
    // Versão karaokê (já instrumental) ou música sem separação: uma faixa só
    document.querySelectorAll("[data-separated]").forEach((el) => { el.hidden = true; });
    $("mix-info").hidden = false;
    $("mix-info").textContent = song.kind === "karaoke" ? "🎵 Versão karaokê (instrumental)" : "🎵 Música original (sem separação)";
    if (song.warning) $("mix-info").title = song.warning;
  } else if (!song.has_backing) {
    // Backing vocals ainda juntos da voz: oferece separar (gasta mais 1 separação)
    const btn = h("button", { class: "btn sm ghost", title: "Separa a voz principal dos backing vocals (gasta mais 1 separação)" }, "Separar backing vocals");
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api(`/api/songs/${SONG_ID}/backing`, { method: "POST" });
        btn.textContent = "Na fila… volte à biblioteca";
        toast("Separando os backing vocals. Quando terminar, abra a música de novo.");
      } catch (e) { toast(e.message, true); btn.disabled = false; }
    };
    // O controle de volume continua na página (escondido), a mistura depende dele
    $("vol-backing").hidden = true;
    $("backing-pill").append(btn);
    $("backing-pill").title = "A voz original ainda está inteira em \"Vocais originais\".";
  }
  $("loading").remove();
  applyMix();
  requestAnimationFrame(tick);
}

init().catch((e) => {
  console.error(e);
  if ($("loading")) $("loading").textContent = e.message;
  else toast(`Erro no player: ${e.message}`, true);
});
