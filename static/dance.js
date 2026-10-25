// Palco de dança: toca o vídeo da coreografia, acompanha quem dança pela webcam
// (MediaPipe Pose, no próprio navegador) ou por um celular que manda os pontos
// do corpo, e dá nota a cada movimento.

import { Judge, Scoreboard, STARS, SKELETON, flatten } from "/static/dance-score.js?v=3";

const $ = (id) => document.getElementById(id);
const SONG_ID = location.pathname.split("/").pop();
const ENTRY_ID = new URLSearchParams(location.search).get("entry");
const MEDIAPIPE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1";
const MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";
const COLORS = ["#FFC93C", "#FF4FA3"];
fillIcons();

let song = null;
let STATE = null;
let judge = null;
let boards = [];          // placar de cada jogador (1 ou 2)
let started = false;      // passou da tela de "Prepare-se"
let scoring = true;       // false = dançar sem nota (sem câmera)
// Gravação da dança para a tela de análise: pontos de cada quadro e nota de cada movimento
const rec = { frames: [], moves: [], sources: new Set(), saved: null };
const round3 = (v) => Math.round(v * 1000) / 1000;
const clip = $("clip");
const cam = $("cam");

// ---------- Vídeo ----------

const playing = () => !clip.paused && !clip.ended;
function setPlayIcon() { $("play").replaceChildren(icon(playing() ? "pause" : "play", 22)); }
function play() { clip.play().catch((e) => toast(`Não consegui tocar: ${e.message}`, true)); }
function pause() { clip.pause(); }
function seek(t) { clip.currentTime = Math.max(0, Math.min(t, clip.duration || 0)); }

clip.addEventListener("play", () => { setPlayIcon(); wake(); });
clip.addEventListener("pause", () => { setPlayIcon(); wake(); });
// Pular na música: os movimentos pulados não contam nem a favor nem contra
clip.addEventListener("seeked", () => {
  if (!judge) return;
  judge.reset(clip.currentTime);
  if (started && scoring) rec.frames.push([round3(clip.currentTime), null]);
});
clip.addEventListener("ended", () => { closeMoves(Infinity); showFinal(null); });

// ---------- Câmeras: a webcam do notebook ou um celular ----------
// As duas entregam a mesma coisa: os 12 pontos de cada pessoa, achatados.
// O celular já manda os pontos prontos; com ele ligado, a webcam descansa.

let landmarker = null;
let notebookCam = false;  // webcam do notebook ligada e detector carregado
let lastCamTime = -1;
let lastStamp = 0;
let phone = null;         // { id, last } do celular que está mandando os pontos
let source = null;        // "phone" | "notebook" | null
const PHONE_TIMEOUT = 1500;
const phoneActive = () => Boolean(phone) && performance.now() - phone.last < PHONE_TIMEOUT;

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }, audio: false,
  });
  cam.srcObject = stream;
  await cam.play();
}

async function loadDetector() {
  const { FilesetResolver, PoseLandmarker } = await import(`${MEDIAPIPE}/vision_bundle.mjs`);
  const files = await FilesetResolver.forVisionTasks(`${MEDIAPIPE}/wasm`);
  let lastError = null;
  // Placa de vídeo quando der; senão processador (mais lento, mas funciona)
  for (const delegate of ["GPU", "CPU"]) {
    try {
      return await PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: "VIDEO", numPoses: 2,
        minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      });
    } catch (e) { lastError = e; }
  }
  throw lastError;
}

// Escolhe de onde vêm os pontos: celular quando ele está mandando, senão o notebook
function setSource() {
  const next = phoneActive() ? "phone" : notebookCam ? "notebook" : null;
  if (next === source) return;
  const before = source;
  source = next;
  $("cam-box").classList.toggle("phone", source === "phone");
  $("cam-msg").hidden = Boolean(source);
  $("cam-msg").textContent = "Sem câmera";
  $("cam-src").textContent = source === "phone" ? "Celular" : "Notebook";
  $("start").disabled = !source;
  if (source && !started && (document.activeElement === document.body || document.activeElement === $("play"))) $("start").focus();
  if (source === "phone") toast("Câmera do celular conectada!");
  else if (before === "phone") toast(source ? "O celular parou de mandar. Voltei para a câmera do notebook." : "O celular parou de mandar os movimentos.", !source);
  if (!source) {
    tracks.forEach((t) => { t.seen = 0; });
    drawSkeleton([], 4, 3);
  }
}

function listenPhones() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/stage-cam`);
  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === "pose") {
      // Um celular por vez: o primeiro fica até parar de mandar
      if (phoneActive() && phone.id !== data.id) return;
      if (!phoneActive()) phone = { id: data.id, last: 0 };
      phone.last = performance.now();
      setSource();
      onPoses(data.poses || [], data.w, data.h);
    } else if (data.type === "cam" && !data.on && phone && phone.id === data.id) {
      phone.last = 0;
      setSource();
    }
  };
  ws.onclose = () => setTimeout(listenPhones, 1500);
}

// Quem é quem: jogador 1 à esquerda da tela, jogador 2 à direita.
// A imagem aparece espelhada, então a esquerda da tela é o x maior da câmera.
const tracks = [{ x: 0.5, seen: 0 }];
let pairFrames = 0;

const screenX = (p) => 1 - (p[0] + p[3]) / 2; // meio dos ombros

function assign(poses) {
  const slots = tracks.map(() => null);
  if (poses.length >= 2) {
    pairFrames++;
    // Duas pessoas por um tempinho: entra o jogador 2
    if (tracks.length === 1 && pairFrames > 20) addPlayer();
    const sorted = [...poses].sort((a, b) => screenX(a) - screenX(b)).slice(0, tracks.length);
    if (tracks.length === 1) {
      // Ainda só um jogador: fica com quem está mais perto de onde ele estava
      sorted.sort((a, b) => Math.abs(screenX(a) - tracks[0].x) - Math.abs(screenX(b) - tracks[0].x));
      slots[0] = sorted[0];
    } else sorted.forEach((p, i) => { slots[i] = p; });
  } else if (poses.length === 1) {
    pairFrames = Math.max(0, pairFrames - 1);
    const x = screenX(poses[0]);
    let best = 0;
    tracks.forEach((t, i) => { if (Math.abs(x - t.x) < Math.abs(x - tracks[best].x)) best = i; });
    slots[best] = poses[0];
  }
  slots.forEach((p, i) => { if (p) { tracks[i].x = screenX(p); tracks[i].seen = performance.now(); } });
  return slots;
}

function addPlayer() {
  tracks.push({ x: 0.75, seen: 0 });
  tracks[0].x = Math.min(tracks[0].x, 0.4);
  // O jogador 2 só disputa os movimentos que ainda faltam
  const since = judge ? judge.idx : 0;
  boards.push(Object.assign(new Scoreboard(judge ? (judge.moves.length - since) * 100 : 1, judge && judge.p.thresholds), { since }));
  renderDancers();
  if (started) toast("Jogador 2 entrou na pista!");
}

// Roda num timer, não no ritmo da tela: com a janela coberta por outra o Chrome
// derruba a tela para 1 quadro por segundo, mas a câmera continua a 30.
function detect() {
  if (source !== "notebook" || cam.readyState < 2 || cam.currentTime === lastCamTime) return;
  lastCamTime = cam.currentTime;
  // O detector exige tempos sempre crescentes
  const stamp = Math.max(performance.now(), lastStamp + 1);
  lastStamp = stamp;
  landmarker.detectForVideo(cam, stamp, (res) => onPoses((res.landmarks || []).map(flatten), cam.videoWidth, cam.videoHeight));
}

// Pontos de um quadro (de qualquer câmera), com a largura e altura da imagem
function onPoses(poses, w, hgt) {
  const slots = assign(poses);
  drawSkeleton(slots, w, hgt);
  updateReady(slots);
  if (!(started && scoring && playing() && judge)) return;
  // Com os números arredondados de uma vez, a análise recalcula exatamente a mesma nota
  const t = round3(clip.currentTime), aspect = Math.round((w / hgt || 4 / 3) * 10000) / 10000;
  const points = slots.map((p) => (p ? p.map(round3) : null));
  rec.frames.push([t, aspect, ...points]);
  rec.sources.add(source);
  handleMoves(judge.frame(t, points, aspect));
}

// ---------- Esqueleto na câmera ----------

function drawSkeleton(slots, w, hgt) {
  const canvas = $("skeleton");
  if (!w || !hgt) return;
  if (canvas.width !== w || canvas.height !== hgt) {
    canvas.width = w;
    canvas.height = hgt;
    $("cam-box").style.aspectRatio = `${w} / ${hgt}`;
  }
  const g = canvas.getContext("2d");
  g.clearRect(0, 0, w, hgt);
  g.lineCap = "round";
  g.lineWidth = Math.max(4, w / 110);
  slots.forEach((p, i) => {
    if (!p) return;
    g.strokeStyle = COLORS[i];
    for (const [a, b] of SKELETON) {
      if (p[a * 3 + 2] < 0.5 || p[b * 3 + 2] < 0.5) continue;
      g.beginPath();
      g.moveTo(p[a * 3] * w, p[a * 3 + 1] * hgt);
      g.lineTo(p[b * 3] * w, p[b * 3 + 1] * hgt);
      g.stroke();
    }
  });
}

// ---------- Nota ----------

function handleMoves(done) {
  for (const d of done) {
    const entry = { move: d.move, start: d.start, end: d.end, players: [] };
    boards.forEach((b, i) => {
      // Jogador 2 que entrou depois não leva nota dos movimentos de antes
      if (d.move < (b.since || 0)) return;
      const r = b.add(d.results[i]);
      entry.players[i] = { label: r.label, value: round3(r.value), mode: r.mode };
      updateDancer(i);
      showRating(i, r);
    });
    rec.moves.push(entry);
  }
}

function closeMoves(t) {
  if (judge && started && scoring) handleMoves(judge.frame(t, [], 4 / 3));
}

function showRating(i, r) {
  const box = document.querySelector(`[data-dancer="${i}"] .rating`);
  if (!box) return;
  box.className = `rating ${r.tone}`;
  box.textContent = r.label;
  void box.offsetWidth; // reinicia a animação
  box.classList.add("pop");
}

function renderDancers() {
  const box = $("dancers");
  if (!scoring) { box.replaceChildren(); return; }
  box.replaceChildren(...boards.map((b, i) => h("div", { class: "dancer", "data-dancer": i, style: `--c:${COLORS[i]}` },
    h("div", { class: "dancer-head" },
      h("span", { class: "who" }, dancerName(i)),
      h("span", { class: "score" }, b.score.toLocaleString("pt-BR"))),
    h("div", { class: "meter" },
      h("div", { class: "fill", style: `width:${Math.min(100, b.score / 100)}%` }),
      ...STARS.map((s) => h("span", { class: "star" + (b.score >= s ? " on" : ""), style: `left:${s / 100}%` }, icon("star", 14)))),
    h("div", { class: "rating" }))));
}

// Atualiza o placar no lugar (redesenhar cortaria a animação da nota)
function updateDancer(i) {
  const el = document.querySelector(`[data-dancer="${i}"]`);
  const b = boards[i];
  if (!el || !b) return;
  el.querySelector(".score").textContent = b.score.toLocaleString("pt-BR");
  el.querySelector(".fill").style.width = `${Math.min(100, b.score / 100)}%`;
  el.querySelectorAll(".star").forEach((star, k) => star.classList.toggle("on", b.score >= STARS[k]));
}

function dancerName(i) {
  const e = myEntry();
  if (i === 0 && e) return e.singer.name.toUpperCase();
  return `JOGADOR ${i + 1}`;
}

// ---------- Antes de começar ----------

let seenFrames = 0;

function updateReady(slots) {
  if (started) return;
  const p = slots[0];
  // Ombros e punhos à vista: dá para dar nota
  const ok = p && [0, 1, 4, 5].every((k) => p[k * 3 + 2] > 0.5);
  seenFrames = ok ? seenFrames + 1 : 0;
  const status = $("ready-status");
  if (seenFrames > 10) {
    status.textContent = slots[1] ? "Vi vocês dois! Bora?" : "Te vi! Quando quiser, aperta COMEÇAR.";
    status.className = "ready-status ok";
  } else {
    status.textContent = p ? "Afasta um pouco: preciso ver os dois braços inteiros." : "Não estou te vendo. Fica na frente da câmera.";
    status.className = "ready-status";
  }
}

async function begin(withScore) {
  if (started) return;
  started = true;
  scoring = withScore;
  $("ready").hidden = true;
  stage.classList.remove("prep");
  $("mode-info").textContent = scoring ? `${judge.moves.length} movimentos · imita como espelho` : "Sem nota (sem câmera)";
  renderDancers();
  // Contagem 3, 2, 1 antes de soltar o vídeo
  const go = $("go");
  go.hidden = false;
  for (const n of ["3", "2", "1"]) {
    go.textContent = n;
    go.classList.remove("pop"); void go.offsetWidth; go.classList.add("pop");
    await new Promise((r) => setTimeout(r, 800));
  }
  go.hidden = true;
  seek(0);
  if (judge) judge.reset(0);
  play();
}

$("start").addEventListener("click", () => begin(true));
$("start-free").addEventListener("click", () => begin(false));

// ---------- Controles ----------

$("play").addEventListener("click", () => {
  if (!started) { begin(Boolean(source)); return; }
  playing() ? pause() : play();
});

let seeking = false;
$("seek").addEventListener("input", () => { seeking = true; $("time-now").textContent = fmtTime($("seek").value / 1000 * clip.duration); });
$("seek").addEventListener("change", () => { seeking = false; seek($("seek").value / 1000 * clip.duration); });
$("master").addEventListener("input", () => { clip.volume = parseFloat($("master").value); });
$("fx-vol").addEventListener("input", () => Fx.setVolume(parseFloat($("fx-vol").value)));
$("fx-vol").addEventListener("change", () => deviceSet({ fx_volume: parseFloat($("fx-vol").value) }));

const CAM_SIZES = ["sm", "md", "lg", "off"];
function setCamSize(size) {
  $("cam-size").value = size;
  $("cam-box").dataset.size = size;
  try { localStorage.setItem("dance-cam-size", size); } catch (e) {}
}
$("cam-size").addEventListener("change", () => setCamSize($("cam-size").value));

function toggleDrawer() {
  $("adjust-drawer").hidden = !$("adjust-drawer").hidden;
  // Pelo controle remoto, o foco entra na gaveta e volta para o botão de Ajustes ao fechar
  if (document.documentElement.classList.contains("kbd-nav")) {
    if (!$("adjust-drawer").hidden) TvNav.focusFirst($("adjust-drawer").querySelector(".adjust-grid"));
    else if ($("adjust-drawer").contains(document.activeElement) || document.activeElement === document.body) $("open-adjust").focus();
  }
  wake();
}
$("open-adjust").addEventListener("click", toggleDrawer);
document.querySelector("[data-drawer-close]").addEventListener("click", toggleDrawer);

// Os controles somem com a música tocando e voltam ao mexer o mouse
const stage = $("stage");
let idleTimer = null;
function wake() {
  stage.classList.remove("idle");
  clearTimeout(idleTimer);
  if (playing() && $("adjust-drawer").hidden && !$("controls").matches(":hover")) idleTimer = setTimeout(goIdle, 3000);
}
// Controles escondidos: o foco sai deles, para as setas voltarem a avançar/voltar o vídeo
function goIdle() {
  stage.classList.add("idle");
  if ($("controls").contains(document.activeElement)) document.activeElement.blur();
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen().catch(() => {});
}
$("fullscreen").addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", wake);
document.addEventListener("mousemove", wake);
$("controls").addEventListener("mouseleave", wake);

// Controle remoto: igual ao palco do karaokê. Controles escondidos: ← → pulam 5 s,
// as outras setas ou o OK mostram os controles. Com eles na tela, as setas andam entre os botões.
const togglePlay = () => {
  if (!started) { if (!$("start").disabled) begin(true); else if (!$("start-free").hidden) begin(false); }
  else playing() ? pause() : play();
};
const MEDIA = {
  MediaPlayPause: togglePlay, MediaPlay: () => (playing() ? null : togglePlay()), MediaPause: pause,
  MediaFastForward: () => started && seek(clip.currentTime + 10), MediaRewind: () => started && seek(clip.currentTime - 10),
  MediaTrackNext: () => $("finish").click(), MediaStop: () => $("finish").click(),
};
const onButton = (t) => t.matches && t.matches("button, a[href], input, select, [role=button]");

document.addEventListener("keydown", (e) => {
  if (e.target.matches && e.target.matches("input[type=number], input[type=text], select")) return;
  const wasIdle = stage.classList.contains("idle");
  wake();
  if (!$("final").hidden) {
    if (e.code === "Space" || (e.key === "Enter" && !onButton(e.target))) { e.preventDefault(); $("final-next").click(); }
    return;
  }
  if (MEDIA[e.key]) { e.preventDefault(); MEDIA[e.key](); return; }
  const inUi = !wasIdle && e.target !== document.body;
  const arrow = e.key === "ArrowRight" ? 5 : e.key === "ArrowLeft" ? -5 : 0;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  else if (e.key === "f" || e.key === "F") toggleFullscreen();
  else if (e.key === "c" || e.key === "C") setCamSize(CAM_SIZES[(CAM_SIZES.indexOf($("cam-size").value) + 1) % CAM_SIZES.length]);
  else if (started && arrow && (!inUi || e.target === $("seek"))) { e.preventDefault(); seek(clip.currentTime + arrow); }
  else if (wasIdle && (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Enter") && !onButton(e.target)) {
    e.preventDefault();
    TvNav.focus($("play"));
  }
});

// Voltar do controle remoto: fecha os ajustes; sem eles, o navegador volta para o telão
TvNav.onBack = () => {
  if ($("adjust-drawer").hidden) return false;
  toggleDrawer();
  return true;
};

// ---------- Festa: quem dança, quem vem, efeitos ----------

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
  Fx.setSounds(s.fx.sounds);
  renderParty();
}, (fx) => {
  Fx.play(fx.name, fx.client);
  if (fx.name !== "stop") fxToast(`${fx.label || fx.name}${fx.by && fx.by !== "Alguém" ? " · " + fx.by : ""}`);
});

// ---------- Fim da música ----------

let finalTimer = null;
let finalCount = 0;

function verdict(stars) {
  if (!scoring) return "QUE SHOW";
  return ["BORA TREINAR", "TÁ AQUECENDO", "MANDOU BEM", "ARRASOU", "ARRASOU MUITO", "LENDÁRIO"][stars];
}

function renderFinal() {
  const best = boards.reduce((a, b) => (b.score > a.score ? b : a), boards[0]);
  const e = myEntry();
  const name = boards.length === 1 && e ? `, ${e.singer.name.toUpperCase()}` : "";
  $("final-title").textContent = `${verdict(best ? best.stars : 0)}${name}!`;
  $("final-song").textContent = `${song.title} · ${song.artist}`;
  $("final-dancers").replaceChildren(...(scoring ? boards : []).map((b, i) => h("div", { class: "final-dancer", style: `--c:${COLORS[i]}` },
    h("span", { class: "who" }, dancerName(i)),
    h("span", { class: "stars" }, ...STARS.map((s) => h("span", { class: b.score >= s ? "on" : "" }, icon("star", 34)))),
    h("span", { class: "score" }, b.score.toLocaleString("pt-BR")),
    h("span", { class: "counts" }, ["PERFEITO", "SUPER", "BOM", "OK", "ERROU"].map((k) => `${b.counts[k]} ${k.toLowerCase()}`).join(" · ")))));
  $("final-review").hidden = !rec.saved && !rec.error;
  $("final-review").textContent = rec.saved ? "Ver análise" : "Tentar guardar a análise";
  $("final-review").onclick = () => {
    clearInterval(finalTimer);
    if (rec.saved) location.href = `/review/${SONG_ID}?s=${rec.saved}`;
    else saveSession(rec.end);
  };
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

// Guarda a dança para a tela de análise (data/songs/<id>/sessions)
async function saveSession(end) {
  if (!scoring || !judge || !rec.frames.some((f) => f[1] !== null)) return;
  rec.end = end;
  rec.error = null;
  const body = {
    title: song.title, artist: song.artist, entry: ENTRY_ID,
    end: end == null ? null : round3(end), duration: clip.duration,
    params: judge.p, sources: [...rec.sources],
    players: boards.map((b, i) => ({
      name: dancerName(i), score: b.score, stars: b.stars, counts: b.counts,
      mode: b.modeTotals.mirror >= b.modeTotals.same ? "mirror" : "same", since: b.since || 0, maxPoints: b.maxPoints,
    })),
    moves: rec.moves, frames: rec.frames,
  };
  try {
    rec.saved = (await api(`/api/songs/${SONG_ID}/dance-sessions`, { method: "POST", body })).id;
  } catch (e) {
    // A dança continua na memória: dá para tentar de novo (ex.: depois de reiniciar o servidor)
    rec.error = e.message;
    clearInterval(finalTimer);
    finalCount = 0;
    toast(`Não consegui guardar a análise: ${e.message}`, true);
  }
  renderFinal();
}

// end: onde a dança parou (null = foi até o fim da música)
async function showFinal(end) {
  if (!$("final").hidden) return;
  saveSession(end);
  if (ENTRY_ID) await api(`/api/stage/${ENTRY_ID}/finish`, { method: "POST" }).catch(() => {});
  $("final").hidden = false;
  stage.classList.remove("idle");
  $("final-next").focus();
  confetti();
  const claps = ["claps-with-cheers-audience", "applause_2"].find((id) => STATE && STATE.fx.sounds.some((s) => s.id === id));
  if (claps) Fx.play(claps, "palco");
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

$("finish").addEventListener("click", () => { if (playing()) pause(); closeMoves(clip.currentTime); showFinal(clip.currentTime); });
$("final-bis").addEventListener("click", async () => {
  clearInterval(finalTimer);
  // Bis: a mesma pessoa dança de novo
  const e = myEntry();
  try {
    const entry = await api("/api/stage/start", { method: "POST", body: { song_id: SONG_ID, client: e ? e.client : undefined } });
    history.replaceState(null, "", `/play/${SONG_ID}?entry=${entry.id}`);
    location.reload();
  } catch (err) { toast(err.message, true); }
});

// ---------- Loop de tela ----------

function tick() {
  if (!seeking && clip.duration) {
    $("seek").value = Math.round((clip.currentTime / clip.duration) * 1000);
    $("time-now").textContent = fmtTime(clip.currentTime);
  }
  // Celular parou de mandar: volta para a webcam (ou fica sem câmera)
  if (source === "phone" && !phoneActive()) setSource();
  // Sem ninguém na câmera, os movimentos continuam fechando (e contando como erro)
  if (started && scoring && playing() && judge && performance.now() - Math.max(...tracks.map((t) => t.seen)) > 500) {
    handleMoves(judge.frame(clip.currentTime, tracks.map(() => null), 4 / 3));
  }
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
  $("ready-title").textContent = song.title.toUpperCase();
  $("fx-vol").value = deviceGet("fx_volume");
  Fx.setVolume(parseFloat($("fx-vol").value));
  let size = "md";
  try { size = localStorage.getItem("dance-cam-size") || size; } catch (e) {}
  setCamSize(size);
  renderParty();

  const pose = await fetch(`/media/${SONG_ID}/pose.json`).then((r) => (r.ok ? r.json() : null));
  if (!pose) { $("loading").textContent = "Essa música ainda não foi preparada para dança."; return; }
  // Parâmetros da nota calibrados na tela de análise (⚙), ou os padrões
  judge = new Judge(pose, state.config && state.config.dance_params);
  boards = [new Scoreboard(judge.maxPoints, judge.p.thresholds)];

  clip.src = `/media/${SONG_ID}/video.mp4`;
  clip.addEventListener("loadedmetadata", () => { $("time-total").textContent = fmtTime(clip.duration); $("loading").remove(); }, { once: true });
  clip.addEventListener("error", () => { $("loading").textContent = "Falha ao carregar o vídeo."; }, { once: true });
  requestAnimationFrame(tick);
  wake();

  // Um celular pode virar a câmera a qualquer momento (QR na tela de preparação)
  listenPhones();
  setInterval(detect, 15);

  // Câmera e detector do notebook em paralelo; sem eles, só pelo celular ou sem nota
  const status = $("ready-status");
  try {
    await Promise.all([
      startCamera().catch((e) => { throw new Error(e.name === "NotAllowedError" ? "O navegador bloqueou a câmera. Libera no cadeado da barra de endereço e recarrega a página." : `Não achei a câmera (${e.message}).`); }),
      loadDetector().then((l) => { landmarker = l; }).catch((e) => { throw new Error(`Não consegui carregar o detector de movimentos (${e.message}). Precisa de internet na primeira vez.`); }),
    ]);
    notebookCam = true;
    setSource();
    if (source === "notebook") status.textContent = "Não estou te vendo. Fica na frente da câmera.";
  } catch (e) {
    console.error(e);
    if (source) return; // o celular já está mandando
    status.textContent = `${e.message} Dá para usar o celular como câmera (QR abaixo).`;
    status.className = "ready-status err";
    $("cam-msg").textContent = "Sem câmera";
    $("start-free").hidden = false;
    if (document.activeElement === document.body) $("start-free").focus();
  }
}

init().catch((e) => {
  console.error(e);
  if ($("loading")) $("loading").textContent = e.message;
  else toast(`Erro no palco: ${e.message}`, true);
});
