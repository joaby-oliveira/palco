// Palco: mistura as faixas separadas no navegador, mostra a letra sincronizada,
// toca os efeitos da festa e encerra com a nota da galera.

const $ = (id) => document.getElementById(id);
const SONG_ID = location.pathname.split("/").pop();
const ENTRY_ID = new URLSearchParams(location.search).get("entry");
const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
fillIcons();

let song = null;
let lines = [];
let synced = false;
let offset = 0;     // ajuste de sincronia desta música (s); positivo = letra mais tarde
let btDelay = 0;    // atraso da caixa Bluetooth (s), vale para todas as músicas
let STATE = null;

// ---------- Áudio ----------

const ctx = new AudioContext();
const master = ctx.createGain();
master.connect(ctx.destination);
const tracks = {}; // nome -> { buffer, gain, source }
let duration = 0;
let playing = false;
let startAt = 0;    // ctx.currentTime correspondente ao segundo 0 da música
let pausedAt = 0;
let voice = "none"; // full | guide | none

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

function setPlayIcon() { $("play").replaceChildren(icon(playing ? "pause" : "play", 22)); }

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
  setPlayIcon();
  wake();
}

function pause() {
  pausedAt = now();
  for (const t of Object.values(tracks)) { try { t.source && t.source.stop(); } catch (e) {} t.source = null; }
  playing = false;
  setPlayIcon();
  wake();
}

function seek(t) {
  const was = playing;
  if (playing) pause();
  pausedAt = Math.min(Math.max(0, t), duration);
  if (was) play(pausedAt);
}

// "Com voz" = todas as faixas juntas (a música original); "Voz guia" = a voz baixinha
function setVoice(v) {
  voice = v;
  if (v === "guide") $("vol-lead").value = 0.25;
  if (v === "none") $("vol-lead").value = 0;
  applyMix();
}

function applyMix() {
  const full = voice === "full";
  const lead = full ? 1 : parseFloat($("vol-lead").value);
  const backing = full ? 1 : parseFloat($("vol-backing").value);
  if (tracks.original) tracks.original.gain.gain.value = 1;
  if (tracks.instrumental) tracks.instrumental.gain.gain.value = 1;
  if (tracks.lead) tracks.lead.gain.gain.value = lead;
  if (tracks.backing) tracks.backing.gain.gain.value = backing;
  master.gain.value = parseFloat($("master").value);
  document.querySelectorAll("[data-voice]").forEach((b) => {
    const on = b.dataset.voice === voice;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on);
  });
}

// ---------- Letra ----------

function renderLyrics() {
  const box = $("lyrics-lines");
  box.replaceChildren();
  if (!lines.length) {
    box.append(h("div", { class: "ln on", style: "margin-top:20%" }, h("span", { class: "fill" }, "SEM LETRA… IMPROVISA!")));
    return;
  }
  $("lyrics-scroll").classList.toggle("free", !synced && !rec);
  lines.forEach((l, i) => {
    box.append(h("div", { class: "ln" + (l.text ? "" : " empty"), "data-i": i, onclick: () => syncToLine(i) }, h("span", { class: "fill" }, l.text || "♪")));
  });
}

let activeIdx = -2;

function lineStart(i) { return lines[i] && lines[i].t != null ? lines[i].t : null; }

// Tempo em que a linha é cantada: até a próxima, mas sem esticar demais nas pausas
function lineSpan(i) {
  const start = lineStart(i);
  let next = null;
  for (let j = i + 1; j < lines.length; j++) if (lineStart(j) != null) { next = lineStart(j); break; }
  const guess = Math.max(1.2, (lines[i].text || "").length * 0.075);
  return next == null ? guess : Math.min(next - start, guess + 0.6);
}

function updateLyrics() {
  if ((!synced && !rec) || !lines.length) { $("countdown").hidden = true; return; }
  const t = now() - offset - btDelay;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t == null) continue;
    if (lines[i].t <= t) idx = i; else break;
  }
  const els = $("lyrics-lines").children;
  // Preenchimento dourado avançando pela linha atual
  if (idx >= 0 && els[idx]) els[idx].style.setProperty("--p", Math.min(1, (t - lines[idx].t) / lineSpan(idx)).toFixed(3));
  updateCountdown(t, idx);

  const key = rec ? `${idx}/${rec.idx}` : idx;
  if (key === activeIdx) return;
  activeIdx = key;
  for (let i = 0; i < els.length; i++) {
    els[i].classList.toggle("on", i === idx);
    els[i].classList.toggle("past", i < idx);
    els[i].classList.toggle("next", Boolean(rec) && i === rec.idx);
    if (i !== idx) els[i].style.removeProperty("--p");
  }
  // Deixa a linha atual (ou a próxima a marcar) a ~40% da altura
  const target = els[Math.max(0, rec ? Math.min(rec.idx, els.length - 1) : idx)];
  const boxH = $("lyrics-box").clientHeight;
  requestAnimationFrame(() => {
    const y = target.offsetTop + target.offsetHeight / 2;
    $("lyrics-lines").style.transform = `translateY(${boxH * 0.4 - y}px)`;
  });
}

// Bolinhas de contagem antes da letra voltar depois de um trecho instrumental
function updateCountdown(t, idx) {
  let next = null;
  for (let i = idx + 1; i < lines.length; i++) if (lineStart(i) != null && lines[i].text) { next = lineStart(i); break; }
  const lastEnd = idx >= 0 ? lineStart(idx) + lineSpan(idx) : 0;
  const left = next == null ? Infinity : next - t;
  const show = playing && !rec && left > 0 && left <= 3 && next - lastEnd > 4;
  $("countdown").hidden = !show;
  if (show) [...$("countdown").children].forEach((d, i) => d.classList.toggle("on", i < Math.ceil(left)));
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
  if (!synced) { toast("Essa letra não tem tempos. Use Gravar sincronia.", true); return; }
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
  if (!lines.length) { toast("Escolha ou cole uma letra primeiro (na ficha da música).", true); return; }
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
document.querySelectorAll("[data-voice]").forEach((b) => b.addEventListener("click", () => setVoice(b.dataset.voice)));
for (const id of ["vol-lead", "vol-backing", "master"]) $(id).addEventListener("input", () => {
  if (id === "vol-lead") voice = parseFloat($("vol-lead").value) === 0 ? "none" : Math.abs(parseFloat($("vol-lead").value) - 0.25) < 0.02 ? "guide" : "custom";
  else if (id === "vol-backing" && voice === "full") voice = "none";
  applyMix();
});

let seeking = false;
$("seek").addEventListener("input", () => { seeking = true; $("time-now").textContent = fmtTime($("seek").value / 1000 * duration); });
$("seek").addEventListener("change", () => { seeking = false; seek($("seek").value / 1000 * duration); });

$("blur").addEventListener("input", () => { $("lyrics-bg").style.filter = `blur(${$("blur").value}px) brightness(.5) saturate(1.2)`; });
$("bright").addEventListener("input", () => { $("lyrics-box").style.setProperty("--dim", $("bright").value); });
$("fx-vol").addEventListener("input", () => Fx.setVolume(parseFloat($("fx-vol").value)));
$("fx-vol").addEventListener("change", () => api("/api/config", { method: "POST", body: { fx_volume: parseFloat($("fx-vol").value) } }).catch(() => {}));

$("key-note").replaceChildren(...NOTES.map((n) => h("option", {}, n)));
for (const id of ["key-note", "key-scale"]) $(id).addEventListener("change", () => {
  api(`/api/songs/${SONG_ID}`, { method: "PATCH", body: { key: { note: $("key-note").value, scale: $("key-scale").value } } }).catch(() => {});
});

// Gavetas "Letra fora do tempo?" e "Ajustes"
function toggleDrawer(id) {
  for (const d of ["sync-drawer", "adjust-drawer"]) $(d).hidden = d === id ? !$(d).hidden : true;
  wake();
}
$("open-sync").addEventListener("click", () => toggleDrawer("sync-drawer"));
$("open-adjust").addEventListener("click", () => toggleDrawer("adjust-drawer"));
document.querySelectorAll("[data-drawer-close]").forEach((b) => b.addEventListener("click", () => toggleDrawer(null)));

// Os controles somem com a música tocando e voltam ao mexer o mouse
const stage = $("stage");
let idleTimer = null;
function wake() {
  stage.classList.remove("idle");
  clearTimeout(idleTimer);
  const drawerOpen = !$("sync-drawer").hidden || !$("adjust-drawer").hidden;
  if (playing && !drawerOpen && !rec && !$("controls").matches(":hover")) idleTimer = setTimeout(() => stage.classList.add("idle"), 3000);
}
$("fullscreen").addEventListener("click", toggleFullscreen);
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen().catch(() => {});
}
document.addEventListener("fullscreenchange", () => { activeIdx = -2; wake(); });
document.addEventListener("mousemove", wake);
$("controls").addEventListener("mouseleave", wake);

// ---------- Efeitos sonoros ----------

const FX_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
$("fx-rail").replaceChildren(...FX_PADS.slice(0, 6).map(([name, label, color], i) => h("button", { class: `pad ${color}`, onclick: () => fireFx(name), title: `Tecla ${FX_KEYS[i]}` },
  h("span", {}, label.split(" ")[0]), h("span", { class: "key" }, FX_KEYS[i]))),
  h("button", { class: "pad plum more", onclick: () => { $("sounds-dlg").showModal(); wake(); }, title: "Todos os sons (S)" }, h("span", {}, "Mais sons"), h("span", { class: "key" }, "S")));
$("dlg-pads").replaceChildren(...FX_PADS.map(([name, label, color]) => h("button", { class: `pad ${color}`, onclick: () => fireFx(name) }, h("span", {}, label))));
document.querySelector("[data-dlg-close]").addEventListener("click", () => $("sounds-dlg").close());

// ---------- Teclado ----------

document.addEventListener("keydown", (e) => {
  if (e.target.matches && e.target.matches("input[type=number], input[type=text], select")) return;
  if (!$("final").hidden) {
    if (e.code === "Space" || e.code === "Enter") { e.preventDefault(); $("final-next").click(); }
    return;
  }
  if (rec) {
    if (e.code === "Space" || e.code === "Enter") { e.preventDefault(); markLine(); return; }
    if (e.code === "Backspace") { e.preventDefault(); undoMark(); return; }
    if (e.code === "Escape" && !document.fullscreenElement) { finishRec(true); return; }
  }
  if ($("sounds-dlg").open) return;
  if (e.key === "s" || e.key === "S") { $("sounds-dlg").showModal(); return; }
  const fxIdx = FX_KEYS.indexOf(e.key);
  if (fxIdx >= 0 && !e.ctrlKey && !e.altKey && !e.metaKey) { fireFx(FX_PADS[fxIdx][0]); return; }
  if (e.code === "Space") { e.preventDefault(); playing ? pause() : play(); }
  else if (e.key === "f" || e.key === "F") toggleFullscreen();
  else if (e.key === "ArrowRight") seek(now() + 5);
  else if (e.key === "ArrowLeft") seek(now() - 5);
});

// ---------- Festa: quem canta, quem vem, votos ----------

const BY_ID = () => Object.fromEntries(((STATE && STATE.songs) || []).map((s) => [s.id, s]));

function nextEntry() {
  if (!STATE) return null;
  const songs = BY_ID();
  return STATE.party.queue.find((e) => songs[e.song_id] && songs[e.song_id].status === "ready") || null;
}

function myEntry() {
  if (!STATE || !ENTRY_ID) return null;
  const p = STATE.party;
  return [p.current, p.last].find((e) => e && e.id === ENTRY_ID) || null;
}

function renderParty() {
  const e = myEntry();
  if (e) {
    $("singer-box").hidden = false;
    $("song-only").hidden = true;
    $("singer-who").replaceChildren(avatar(e.singer, "lg"), e.singer.name.toUpperCase());
  }
  const n = nextEntry();
  const songs = BY_ID();
  $("up-next-k").textContent = n ? "Depois vem" : "Pede a sua";
  $("up-next-v").textContent = n ? `${n.singer.name} · ${songs[n.song_id].title}` : "Escaneia o QR";
  if (!$("final").hidden) renderFinal();
}

watchState((s) => {
  STATE = s;
  Fx.setFiles(s.fx.files);
  Fx.setSounds(s.fx.sounds);
  renderSoundBoard($("dlg-sounds"), s.fx.sounds || []);
  renderParty();
}, (fx) => {
  Fx.play(fx.name);
  if (fx.name !== "stop") fxToast(`${fx.label || fx.name}${fx.by && fx.by !== "Alguém" ? " · " + fx.by : ""}`);
});

// ---------- Fim da música ----------

let finalTimer = null;
let finalCount = 0;

function verdict(score) {
  if (score == null) return "ARRASOU";
  if (score >= 85) return "ARRASOU";
  if (score >= 65) return "MANDOU BEM";
  if (score >= 40) return "VALEU A CORAGEM";
  return "O IMPORTANTE É PARTICIPAR";
}

function renderFinal() {
  const e = myEntry();
  const name = e ? e.singer.name.toUpperCase() : "";
  const score = e ? e.score : null;
  $("final-title").textContent = name ? `${verdict(score)}, ${name}!` : `${verdict(score)}!`;
  $("final-song").textContent = `${song.title} · ${song.artist}`;
  const votes = e ? e.vote_count || 0 : 0;
  $("final-votes").textContent = votes ? `${votes} ${votes === 1 ? "voto" : "votos"}` : "Vota pelo celular!";
  $("final-fill").style.width = score == null ? "0" : `${Math.max(8, score)}%`;
  $("final-score").textContent = score == null ? "" : score;
  const n = nextEntry();
  const songs = BY_ID();
  const btn = $("final-next");
  btn.replaceChildren(n ? `Agora é ${n.singer.name} · ${songs[n.song_id].title}` : "Voltar pro início");
  if (n && finalCount > 0) btn.append(h("span", { class: "count" }, finalCount));
  btn.onclick = async () => {
    clearInterval(finalTimer);
    if (!n) { location.href = "/"; return; }
    try {
      const entry = await api("/api/stage/start", { method: "POST", body: { entry_id: n.id } });
      location.href = `/play/${entry.song_id}?entry=${entry.id}`;
    } catch (err) { toast(err.message, true); location.href = "/"; }
  };
}

function confetti() {
  const box = $("confetti");
  const colors = ["#FFC93C", "#FF4FA3", "#7FB2FF", "#5BE3A1", "#FF8A5B"];
  box.replaceChildren(...Array.from({ length: 90 }, (_, i) => h("i", {
    style: `left:${Math.random() * 100}%;background:${colors[i % colors.length]};animation-duration:${2.5 + Math.random() * 3}s;animation-delay:${Math.random() * 1.5}s;width:${8 + Math.random() * 10}px`,
  })));
}

async function showFinal() {
  if (!$("final").hidden) return;
  if (ENTRY_ID) await api(`/api/stage/${ENTRY_ID}/finish`, { method: "POST" }).catch(() => {});
  if (document.fullscreenElement) { /* fica em tela cheia: a próxima música abre na mesma aba */ }
  $("final").hidden = false;
  stage.classList.remove("idle");
  confetti();
  Fx.play("aplausos");
  // Contagem para chamar o próximo sozinho
  finalCount = 15;
  renderFinal();
  clearInterval(finalTimer);
  finalTimer = setInterval(() => {
    finalCount -= 1;
    if (finalCount <= 0) {
      clearInterval(finalTimer);
      if (nextEntry()) $("final-next").click();
      else finalCount = 0;
    }
    renderFinal();
  }, 1000);
}

$("finish").addEventListener("click", () => { if (playing) pause(); showFinal(); });
$("final-bis").addEventListener("click", async () => {
  clearInterval(finalTimer);
  // Bis: a mesma pessoa canta de novo
  const e = myEntry();
  try {
    const entry = await api("/api/stage/start", { method: "POST", body: { song_id: SONG_ID, client: e ? e.client : undefined } });
    history.replaceState(null, "", `/play/${SONG_ID}?entry=${entry.id}`);
    location.reload();
  } catch (err) { toast(err.message, true); }
});

// ---------- Loop de tela ----------

function tick() {
  const t = now();
  if (playing && t >= duration - 0.01) { pause(); pausedAt = 0; showFinal(); }
  if (!seeking) {
    $("seek").value = duration ? Math.round((t / duration) * 1000) : 0;
    $("time-now").textContent = fmtTime(t);
  }
  updateLyrics();
  requestAnimationFrame(tick);
}

// ---------- Início ----------

async function init() {
  const state = await api("/api/state");
  STATE = state;
  song = state.songs.find((s) => s.id === SONG_ID);
  if (!song) { $("loading").textContent = "Música não encontrada."; return; }
  document.title = `${song.title} · Palco`;
  $("song-title").textContent = `${song.title} · ${song.artist}`;
  $("song-title-2").textContent = `${song.title} · ${song.artist}`;
  $("song-only").hidden = Boolean(ENTRY_ID);
  $("lyrics-bg").style.backgroundImage = `url("${song.cover}")`;
  if (song.key) { $("key-note").value = song.key.note; $("key-scale").value = song.key.scale; }
  btDelay = (state.config && state.config.bt_delay) || 0;
  $("bt").value = btDelay;
  $("fx-vol").value = (state.config && state.config.fx_volume) ?? 0.7;
  Fx.setVolume(parseFloat($("fx-vol").value));
  setOffset(song.offset || 0, false);
  renderParty();

  const lyr = await api(`/api/songs/${SONG_ID}/lyrics`);
  lines = lyr.lines || [];
  synced = Boolean(lyr.synced);
  renderLyrics();

  const names = song.separated ? ["instrumental", "lead"].concat(song.has_backing ? ["backing"] : []) : ["original"];
  try { await Promise.all(names.map(loadTrack)); }
  catch (e) { $("loading").textContent = "Falha ao carregar o áudio."; return; }
  $("time-total").textContent = fmtTime(duration);
  if (!song.separated) {
    // Versão karaokê (já instrumental) ou música sem separação: uma faixa só
    document.querySelectorAll("[data-separated]").forEach((el) => { el.hidden = true; });
    $("mix-info").hidden = false;
    $("mix-info").textContent = song.kind === "karaoke" ? "Versão karaokê" : "Música original, com a voz";
    if (song.warning) $("mix-info").title = song.warning;
  } else if (!song.has_backing) {
    // Backing vocals ainda juntos da voz: o controle não faz sentido
    $("backing-pill").classList.add("disabled");
    $("vol-backing").disabled = true;
    $("backing-pill").title = "Os backing vocals estão junto com a voz original. Dá para separar na ficha da música.";
  }
  $("loading").remove();
  setVoice("none");
  requestAnimationFrame(tick);
  wake();
}

init().catch((e) => {
  console.error(e);
  if ($("loading")) $("loading").textContent = e.message;
  else toast(`Erro no palco: ${e.message}`, true);
});
