// Análise de uma dança gravada: coach × quem dançou quadro a quadro, nota de
// cada movimento, atraso medido e calibragem da nota (a dança é recalculada na
// hora com os valores escolhidos, e dá para salvar para as próximas danças).

import { replay, params, DEFAULT_PARAMS, RATINGS, BONE_NAMES, SKELETON, SWAP, bones, boneErrors } from "/static/dance-score.js?v=3";

const $ = (id) => document.getElementById(id);
const SONG_ID = location.pathname.split("/").pop();
const WIDE = { lagMin: -1.2, lagMax: 0.4 }; // janela larga para medir o atraso de verdade
const TONE_VAR = { PERFEITO: "--perfect", SUPER: "--super", BOM: "--good", OK: "--ok", ERROU: "--miss" };
const color = (name) => getComputedStyle(document.querySelector(".review")).getPropertyValue(name).trim();
const toneColor = (label) => color(TONE_VAR[label] || "--miss");
const dpr = () => window.devicePixelRatio || 1;
const fmt = (v, d = 2) => v.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
fillIcons();

let song = null, pose = null, session = null;
let P = params();      // valores da calibragem
let saved = null;      // valores em uso nas próximas danças (⚙)
let result = null;     // dança recalculada com P
let wide = null;       // dança recalculada com a janela larga (só para medir o atraso)
let camFrames = [];    // quadros da câmera (sem as marcas de pulo)
let traces = {};       // "jogador/modo" -> quadros comparados, em ordem de tempo
let wideTraces = {};
let playerIdx = 0;
let selected = null;   // movimento escolhido na linha do tempo
const video = $("video");
const timelineImage = document.createElement("canvas"); // linha do tempo desenhada uma vez por cálculo

// ---------- Busca no tempo ----------

function nearest(list, t, key = (x) => x[0]) {
  let lo = 0, hi = list.length - 1;
  if (hi < 0) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(list[mid]) < t) lo = mid + 1; else hi = mid;
  }
  const a = list[lo], b = list[lo - 1];
  return b && Math.abs(key(b) - t) < Math.abs(key(a) - t) ? b : a;
}

const modeOf = (i, r = result) => {
  const b = r.boards[i];
  return b && b.modeTotals.same > b.modeTotals.mirror ? "same" : "mirror";
};

function indexTraces(trace) {
  const out = {};
  for (const e of trace) (out[`${e.i}/${e.mode}`] ||= []).push(e);
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.t - b.t);
  return out;
}

function moveAt(t) {
  return result.moves.find((m) => t >= m.start && t <= m.end) || null;
}

const inMoves = (t) => pose.moves.some(([s, e]) => t >= s && t <= e);

const duration = () => video.duration || session.duration || pose.frames.length / pose.fps;

// ---------- Recalcular ----------

function recompute() {
  result = replay(pose, session, P);
  wide = replay(pose, session, { ...P, ...WIDE });
  traces = indexTraces(result.trace);
  wideTraces = indexTraces(wide.trace);
  if (selected) selected = result.moves.find((m) => m.move === selected.move) || null;
  renderCards();
  renderCalResult();
  drawTimeline();
  drawLag();
  renderMove();
  renderFrame(true);
}

// ---------- Resumo ----------

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
}

function quantile(values, q) {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
}

function renderCards() {
  const i = playerIdx, b = result.boards[i], orig = session.players[i];
  const mode = modeOf(i);
  // Cobertura: quadros dentro dos movimentos em que os dois braços aparecem inteiros
  let total = 0, seen = 0;
  for (const f of camFrames) {
    if (!inMoves(f[0])) continue;
    total++;
    const p = f[2 + i];
    if (p && [0, 1, 2, 3, 4, 5].every((k) => p[k * 3 + 2] >= 0.5)) seen++;
  }
  const coverage = total ? seen / total : 0;
  const span = camFrames.length > 1 ? camFrames[camFrames.length - 1][0] - camFrames[0][0] : 0;
  const fps = span > 0 ? camFrames.length / span : 0;
  const lags = (wideTraces[`${i}/${mode}`] || []).map((e) => e.lag);
  const lag = median(lags);
  const values = result.moves.map((m) => m.players[i]).filter(Boolean).map((p) => Math.max(0, p.value));
  const mean = values.length ? values.reduce((x, y) => x + y, 0) / values.length : 0;
  const card = (k, v, d, tone = "") => h("div", { class: `rv-card ${tone}` }, h("span", { class: "k" }, k), h("span", { class: "v" }, v), d ? h("span", { class: "d" }, d) : null);
  const stars = (n) => h("span", { class: "stars" }, "★".repeat(n) + "☆".repeat(5 - n));
  $("cards").replaceChildren(
    card("Nota na hora", orig.score.toLocaleString("pt-BR"), stars(orig.stars)),
    card("Recalculada", b.score.toLocaleString("pt-BR"), h("span", {}, stars(b.stars), " com os valores da calibragem")),
    card("Câmera viu os braços", `${Math.round(coverage * 100)}%`, `dos quadros durante os movimentos (${seen} de ${total})`, coverage < 0.6 ? "bad" : coverage < 0.85 ? "warn" : ""),
    card("Quadros da câmera", `${fmt(fps, 0)}/s`,
      `${(session.sources || []).map((s) => (s === "phone" ? "celular" : "notebook")).join(" + ") || "?"}${fps && fps < 12 ? " · poucos: a nota fica menos confiável (computador lento ou palco escondido atrás de outra janela)" : ""}`,
      fps && fps < 5 ? "bad" : fps && fps < 12 ? "warn" : ""),
    card("Atraso típico", lag == null ? "—" : `${fmt(Math.abs(lag), 2)} s`, lag == null ? "sem dados" : lag <= 0 ? "você vem depois do coach" : "você veio antes do coach"),
    card("Jeito de imitar", mode === "mirror" ? "Espelho" : "Mesmo lado", `soma espelho ${fmt(b.modeTotals.mirror, 1)} × mesmo lado ${fmt(b.modeTotals.same, 1)}`),
    card("Média por movimento", fmt(mean, 2), `${values.length} movimentos com nota`),
  );
}

// ---------- Coach × você (quadro a quadro) ----------

// Pontos em "unidades de tronco", centrados no meio dos ombros
function normalize(p, aspect, mirror) {
  const pts = [];
  for (let j = 0; j < 12; j++) {
    const s = mirror ? SWAP[j] : j;
    pts.push([(mirror ? -1 : 1) * p[s * 3] * aspect, p[s * 3 + 1], p[s * 3 + 2]]);
  }
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const shoulders = mid(pts[0], pts[1]), hips = mid(pts[6], pts[7]);
  const hipsOk = pts[6][2] >= 0.5 && pts[7][2] >= 0.5;
  const scale = (hipsOk ? Math.hypot(hips[0] - shoulders[0], hips[1] - shoulders[1]) : Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) * 1.4) || 1;
  return pts.map(([x, y, v]) => [(x - shoulders[0]) / scale, (y - shoulders[1]) / scale, v]);
}

function drawBody(g, pts, ox, oy, unit, stroke, width) {
  g.strokeStyle = stroke;
  g.lineWidth = width;
  g.lineCap = "round";
  for (const [a, b] of SKELETON) {
    if (pts[a][2] < 0.5 || pts[b][2] < 0.5) continue;
    g.beginPath();
    g.moveTo(ox + pts[a][0] * unit, oy + pts[a][1] * unit);
    g.lineTo(ox + pts[b][0] * unit, oy + pts[b][1] * unit);
    g.stroke();
  }
}

function fitCanvas(c) {
  const w = Math.round(c.clientWidth * dpr()), hgt = Math.round(c.clientHeight * dpr());
  if (c.width !== w || c.height !== hgt) { c.width = w; c.height = hgt; }
  return [w, hgt];
}

let lastRendered = -1;

function renderFrame(force = false) {
  const t = video.currentTime;
  if (!force && t === lastRendered) return;
  lastRendered = t;
  $("time").textContent = fmtTime(t);
  if (!seeking) $("seek").value = Math.round((t / duration()) * 1000);

  const i = playerIdx, mode = modeOf(i);
  const camFrame = nearest(camFrames, t);
  const player = camFrame && Math.abs(camFrame[0] - t) < 0.25 ? camFrame[2 + i] : null;
  // Quadro do coach: o mesmo instante, ou o que a nota usou (melhor encaixe na janela)
  let k = Math.round(t * pose.fps), used = null;
  if ($("compensate").checked && player) {
    const e = nearest(traces[`${i}/${mode}`] || [], t, (x) => x.t);
    if (e && Math.abs(e.t - t) < 0.25) { used = e; k = Math.round((e.t + e.lag) * pose.fps); }
  }
  const coach = pose.frames[Math.max(0, Math.min(pose.frames.length - 1, k))];

  // Vídeo do coach com o esqueleto que o app marcou
  const cc = $("coach-canvas");
  const [cw, ch] = fitCanvas(cc);
  const cg = cc.getContext("2d");
  cg.clearRect(0, 0, cw, ch);
  const live = pose.frames[Math.round(t * pose.fps)];
  if (live) {
    const pts = Array.from({ length: 12 }, (_, j) => [live[j * 3] * cw, live[j * 3 + 1] * ch, live[j * 3 + 2]]);
    drawBody(cg, pts, 0, 0, 1, color("--gold"), 4 * dpr());
  }

  // Os dois esqueletos um em cima do outro
  const oc = $("overlay");
  const [ow, oh] = fitCanvas(oc);
  const og = oc.getContext("2d");
  og.clearRect(0, 0, ow, oh);
  const unit = oh * 0.2;
  if (coach) drawBody(og, normalize(coach, pose.aspect, false), ow / 2, oh * 0.3, unit, color("--gold") + "D0", 12 * dpr());
  if (player) drawBody(og, normalize(player, camFrame[1], mode === "mirror"), ow / 2, oh * 0.3, unit, color("--pink"), 6 * dpr());
  const lagText = used ? ` · coach ${fmt(Math.abs(used.lag), 2)} s ${used.lag <= 0 ? "antes" : "depois"}` : "";
  $("frame-info").textContent = !player ? "câmera não te viu aqui" : !coach ? "coach fora de cena" : `nota do quadro ${used ? fmt(used.s) : "—"}${lagText}`;

  // Diferença de cada osso
  if (!coach || !player) { $("bones").replaceChildren(h("p", { class: "sub", style: "margin:0" }, !player ? "Sem você neste instante." : "Sem coach neste instante.")); return; }
  const ref = bones(coach, pose.aspect), mine = bones(player, camFrame[1], mode === "mirror");
  const errors = boneErrors(ref, mine);
  const rows = errors.map((deg, j) => {
    const weight = j < 4 ? 1 : P.legWeight;
    const off = deg == null || !weight;
    const tone = deg == null ? "--miss" : deg < P.tolerance / 2 ? "--good" : deg < P.tolerance ? "--perfect" : "--danger";
    return h("div", { class: "row" + (off ? " off" : "") },
      h("span", {}, BONE_NAMES[j], j >= 4 ? h("span", { class: "sub" }, ` ×${fmt(weight, 2)}`) : null),
      h("span", { class: "deg" }, deg == null ? "—" : `${Math.round(deg)}°`),
      h("div", { class: "bar" }, h("div", { style: `width:${deg == null ? 0 : Math.min(100, deg / 90 * 100)}%;background:var(${tone})` })));
  });
  const s = result.judge.similarity(ref, mine);
  rows.push(h("div", { class: "total" }, h("span", {}, "Nota deste quadro"), h("span", {}, s == null ? "—" : fmt(s))));
  $("bones").replaceChildren(...rows);
}

// ---------- Linha do tempo ----------

function drawTimeline() {
  const c = $("timeline");
  const [w, hgt] = fitCanvas(c);
  timelineImage.width = w;
  timelineImage.height = hgt;
  const g = timelineImage.getContext("2d");
  const r = dpr(), i = playerIdx, mode = modeOf(i);
  const top = 18 * r, base = hgt - 20 * r, plot = base - top - 8 * r;
  const x = (t) => (t / duration()) * w;
  const y = (v) => base - Math.max(0, v) * plot;
  g.clearRect(0, 0, w, hgt);
  g.font = `${11 * r}px Outfit, sans-serif`;

  // Limites de cada nota
  g.setLineDash([4 * r, 4 * r]);
  P.thresholds.forEach((th, k) => {
    g.strokeStyle = toneColor(RATINGS[k].label) + "80";
    g.beginPath(); g.moveTo(0, y(th)); g.lineTo(w, y(th)); g.stroke();
    g.fillStyle = toneColor(RATINGS[k].label);
    g.fillText(RATINGS[k].label, 4 * r, y(th) - 3 * r);
  });
  g.setLineDash([]);

  // Nota recalculada de cada movimento (barras) e a que saiu na hora (faixa de cima)
  for (const m of result.moves) {
    const p = m.players[i];
    if (!p) continue;
    const x0 = x(m.start) + r, wd = Math.max(r, x(m.end) - x(m.start) - 2 * r);
    g.fillStyle = toneColor(p.label);
    const hh = Math.max(3 * r, Math.max(0, p.value) * plot);
    g.fillRect(x0, base - hh, wd, hh);
    if (selected && selected.move === m.move) { g.strokeStyle = "#fff"; g.lineWidth = 2 * r; g.strokeRect(x0, base - hh, wd, hh); }
  }
  for (const m of session.moves) {
    const p = m.players[i];
    if (!p) continue;
    g.fillStyle = toneColor(p.label);
    g.fillRect(x(m.start) + r, 2 * r, Math.max(r, x(m.end) - x(m.start) - 2 * r), top - 8 * r);
  }

  // Nota de cada quadro da câmera
  g.fillStyle = "rgba(255,255,255,.35)";
  for (const e of traces[`${i}/${mode}`] || []) g.fillRect(x(e.t) - r / 2, y(e.s) - r / 2, r * 1.4, r * 1.4);

  // Minutos
  g.fillStyle = color("--muted");
  for (let t = 0; t < duration(); t += 30) g.fillText(fmtTime(t), x(t) + 2 * r, hgt - 5 * r);
  paintTimeline();
}

function paintTimeline() {
  const c = $("timeline");
  const g = c.getContext("2d");
  g.clearRect(0, 0, c.width, c.height);
  g.drawImage(timelineImage, 0, 0);
  const px = (video.currentTime / duration()) * c.width;
  g.fillStyle = "#fff";
  g.fillRect(px - dpr(), 0, 2 * dpr(), c.height);
}

$("timeline").addEventListener("click", (e) => {
  const rect = $("timeline").getBoundingClientRect();
  const t = ((e.clientX - rect.left) / rect.width) * duration();
  selected = moveAt(t);
  video.currentTime = selected ? selected.start : t;
  drawTimeline();
  renderMove();
});

function renderMove() {
  const box = $("move-detail");
  const i = playerIdx;
  if (!selected || !selected.players[i]) { box.textContent = "Clique num movimento para ver os detalhes."; return; }
  const p = selected.players[i];
  const orig = (session.moves.find((m) => m.move === selected.move) || { players: [] }).players[i];
  const res = p.result || {};
  const d = (res.detail || {})[p.mode];
  const other = p.mode === "mirror" ? "same" : "mirror";
  const parts = [
    h("span", { class: "tag", style: `background:${toneColor(p.label)}` }, p.label),
    h("b", {}, `Movimento ${selected.move + 1}`), ` (${fmtTime(selected.start)}–${fmtTime(selected.end)}) · nota ${p.value < 0 ? "—" : fmt(p.value)}`,
    orig ? ` · na hora: ${orig.label}` : "",
  ];
  if (d) parts.push(h("br"), `Pose média ${fmt(d.mean)} · movimentou ${Math.round(d.ratio * 100)}% do que o coach pedia · ${d.frames} quadros da câmera · `,
    `${other === "same" ? "mesmo lado" : "espelho"} daria ${res[other] == null ? "—" : fmt(res[other])}`);
  else parts.push(h("br"), "A câmera não te viu (ou não viu os braços) neste movimento.");
  box.replaceChildren(...parts);
}

// ---------- Atraso ----------

function drawLag() {
  const c = $("lag");
  const [w, hgt] = fitCanvas(c);
  const g = c.getContext("2d");
  const r = dpr(), i = playerIdx, mode = modeOf(i);
  const lags = (wideTraces[`${i}/${mode}`] || []).map((e) => e.lag);
  const step = 1 / pose.fps, from = WIDE.lagMin, to = WIDE.lagMax;
  const bins = new Array(Math.round((to - from) / step) + 1).fill(0);
  for (const v of lags) bins[Math.max(0, Math.min(bins.length - 1, Math.round((v - from) / step)))]++;
  const max = Math.max(1, ...bins);
  const x = (v) => ((v - from) / (to - from)) * w;
  const base = hgt - 18 * r;
  g.clearRect(0, 0, w, hgt);
  g.fillStyle = "rgba(255,255,255,.06)";
  g.fillRect(x(P.lagMin), 0, x(P.lagMax) - x(P.lagMin), base);
  bins.forEach((n, k) => {
    const v = from + k * step;
    g.fillStyle = v >= P.lagMin && v <= P.lagMax ? color("--pink") : color("--miss");
    const hh = (n / max) * (base - 8 * r);
    g.fillRect(x(v) - (w / bins.length) / 2 + r, base - hh, w / bins.length - 2 * r, hh);
  });
  g.fillStyle = color("--muted");
  g.font = `${11 * r}px Outfit, sans-serif`;
  for (let v = -1.2; v <= 0.41; v += 0.2) g.fillText(`${fmt(v, 1)}s`, Math.min(w - 28 * r, Math.max(2 * r, x(v) - 10 * r)), hgt - 4 * r);
  g.fillStyle = "#fff";
  g.fillRect(x(0) - r / 2, 0, r, base);

  const note = $("lag-note");
  if (!lags.length) { note.textContent = "Sem quadros suficientes para medir."; return; }
  const inside = lags.filter((v) => v >= P.lagMin && v <= P.lagMax).length / lags.length;
  const lo = Math.round(quantile(lags, 0.1) * 20) / 20, hi = Math.round(quantile(lags, 0.9) * 20) / 20;
  const sugMin = Math.min(-0.1, lo - 0.05), sugMax = Math.max(0.05, hi + 0.05);
  const apply = h("button", { class: "btn ghost sm", style: "margin-left:8px", onclick: () => { P.lagMin = Math.max(-1.2, sugMin); P.lagMax = Math.min(0.5, sugMax); renderCal(); recompute(); } }, "Usar a janela sugerida");
  note.replaceChildren(
    `O melhor encaixe ficou em ${fmt(median(lags), 2)} s (mediana); 80% entre ${fmt(lo, 2)} e ${fmt(hi, 2)} s. `,
    h("b", {}, `${Math.round(inside * 100)}%`), ` caem dentro da janela atual (${fmt(P.lagMin, 2)} a ${fmt(P.lagMax, 2)} s). `,
    "Picos longe do principal costumam ser passos repetidos do coach.",
    inside < 0.8 ? apply : "");
}

// ---------- Calibragem ----------

const SLIDERS = [
  ["tolerance", "Tolerância por osso", 15, 90, 1, (v) => `${v}°`, "Diferença de ângulo em que o osso zera. Maior = mais fácil."],
  ["stillPenalty", "Castigo por ficar parado", 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`, "Quanto da nota some se você não se mexe quando o coach se mexe."],
  ["lagMin", "Janela: coach até quanto antes", -1.2, 0, 0.05, (v) => `${fmt(v, 2)} s`, "Atraso máximo aceito de quem dança."],
  ["lagMax", "Janela: coach até quanto depois", 0, 0.5, 0.05, (v) => `${fmt(v, 2)} s`, "Para quem antecipa o passo."],
  ["legWeight", "Peso das pernas", 0, 1, 0.05, (v) => `${fmt(v, 2)}`, "Cada osso do braço vale 1. Zero ignora as pernas."],
  ...RATINGS.slice(0, 4).map((r, k) => [`th${k}`, `${r.label} a partir de`, 0, 1, 0.01, (v) => fmt(v, 2), null]),
];

const getParam = (key) => (key.startsWith("th") ? P.thresholds[+key[2]] : P[key]);
function setParam(key, v) {
  if (key.startsWith("th")) { P.thresholds = [...P.thresholds]; P.thresholds[+key[2]] = v; } else P[key] = v;
}

let calTimer = null;
function renderCal() {
  $("cal").replaceChildren(...SLIDERS.map(([key, label, min, max, step, show, hint]) => {
    const input = h("input", { type: "range", min, max, step, value: getParam(key) });
    const value = h("b", {}, show(getParam(key)));
    input.addEventListener("input", () => {
      setParam(key, parseFloat(input.value));
      value.textContent = show(getParam(key));
      clearTimeout(calTimer);
      calTimer = setTimeout(recompute, 120);
    });
    return h("label", {}, h("span", {}, label, value), input, hint ? h("span", { class: "hint" }, hint) : null);
  }));
  calStatus();
}

const same = (a, b) => JSON.stringify(params(a)) === JSON.stringify(params(b));

function calStatus() {
  const order = P.thresholds.every((v, k) => k === 0 || v <= P.thresholds[k - 1]);
  $("cal-status").textContent = !order ? "Atenção: os limites das notas precisam ir do maior (PERFEITO) para o menor (OK)."
    : same(P, saved) ? "Estes são os valores em uso nas próximas danças."
    : same(P, session.params) ? "Estes são os valores com que esta dança foi avaliada (diferentes dos em uso agora)."
    : "Valores novos: ainda não estão em uso.";
}

function renderCalResult() {
  $("cal-result").replaceChildren(...result.boards.map((b, i) => {
    const orig = session.players[i].score;
    const diff = b.score - orig;
    const total = Object.values(b.counts).reduce((x, y) => x + y, 0) || 1;
    return h("div", {},
      h("div", { class: "who" }, h("span", {}, session.players[i].name),
        h("span", {}, h("span", { class: "score" }, b.score.toLocaleString("pt-BR")), " ", "★".repeat(b.stars),
          diff ? h("span", { class: diff > 0 ? "up" : "down" }, ` (${diff > 0 ? "+" : ""}${diff.toLocaleString("pt-BR")})`) : null)),
      h("div", { class: "dist", title: RATINGS.map((r) => `${r.label}: ${b.counts[r.label]}`).join(" · ") },
        ...RATINGS.map((r) => h("span", { style: `width:${(b.counts[r.label] / total) * 100}%;background:${toneColor(r.label)}` }))),
      h("span", { class: "sub" }, RATINGS.map((r) => `${b.counts[r.label]} ${r.label.toLowerCase()}`).join(" · ")));
  }));
  calStatus();
}

$("cal-session").addEventListener("click", () => { P = params(session.params); renderCal(); recompute(); });
$("cal-default").addEventListener("click", () => { P = params(DEFAULT_PARAMS); renderCal(); recompute(); });
$("cal-save").addEventListener("click", async () => {
  try {
    await api("/api/config", { method: "POST", body: { dance_params: P } });
    saved = params(P);
    calStatus();
    toast("Pronto: as próximas danças usam estes valores.");
  } catch (e) { toast(e.message, true); }
});

// ---------- Vídeo ----------

let seeking = false;
$("play").addEventListener("click", () => (video.paused ? video.play() : video.pause()));
video.addEventListener("play", () => $("play").replaceChildren(icon("pause", 20)));
video.addEventListener("pause", () => $("play").replaceChildren(icon("play", 20)));
$("seek").addEventListener("input", () => { seeking = true; video.currentTime = ($("seek").value / 1000) * duration(); });
$("seek").addEventListener("change", () => { seeking = false; });
$("speed").addEventListener("change", () => { video.playbackRate = parseFloat($("speed").value); });
$("compensate").addEventListener("change", () => renderFrame(true));

function jumpMiss(dir) {
  const i = playerIdx, t = video.currentTime;
  const low = result.moves.filter((m) => m.players[i] && (m.players[i].label === "ERROU" || m.players[i].label === "OK"));
  const target = dir > 0 ? low.find((m) => m.start > t + 0.05) : [...low].reverse().find((m) => m.start < t - 0.5);
  if (!target) { toast(dir > 0 ? "Nenhum movimento com nota baixa depois daqui." : "Nenhum antes daqui."); return; }
  selected = target;
  video.currentTime = Math.max(0, target.start - 0.3);
  drawTimeline();
  renderMove();
}
$("next-miss").addEventListener("click", () => jumpMiss(1));
$("prev-miss").addEventListener("click", () => jumpMiss(-1));

document.addEventListener("keydown", (e) => {
  if (e.target.matches && e.target.matches("input, select, textarea")) return;
  if (e.code === "Space") { e.preventDefault(); $("play").click(); }
  // Com um botão focado, as setas andam entre os botões (controle remoto, tvnav.js)
  else if (e.target !== document.body && e.key.startsWith("Arrow")) return;
  else if (e.key === "ArrowRight") { e.preventDefault(); video.currentTime += 1 / pose.fps; }
  else if (e.key === "ArrowLeft") { e.preventDefault(); video.currentTime -= 1 / pose.fps; }
});

function loop() {
  renderFrame();
  paintTimeline();
  requestAnimationFrame(loop);
}
window.addEventListener("resize", () => { drawTimeline(); drawLag(); renderFrame(true); });

// ---------- Sessões ----------

async function loadSession(id) {
  session = await api(`/api/songs/${SONG_ID}/dance-sessions/${id}`);
  camFrames = session.frames.filter((f) => f[1] !== null);
  P = params(session.params);
  playerIdx = 0;
  selected = null;
  $("player").replaceChildren(...session.players.map((p, i) => h("option", { value: i }, p.name)));
  $("download").href = `/api/songs/${SONG_ID}/dance-sessions/${id}`;
  $("download").setAttribute("download", `danca-${SONG_ID}-${id}.json`);
  history.replaceState(null, "", `/review/${SONG_ID}?s=${id}`);
  renderCal();
  recompute();
}

$("player").addEventListener("change", () => { playerIdx = parseInt($("player").value, 10); selected = null; recompute(); });
$("session").addEventListener("change", () => loadSession($("session").value));

let deleteArmed = false;
$("delete").addEventListener("click", async () => {
  if (!deleteArmed) {
    deleteArmed = true;
    $("delete").textContent = "Apagar mesmo?";
    setTimeout(() => { deleteArmed = false; $("delete").textContent = "Apagar"; }, 4000);
    return;
  }
  try {
    await api(`/api/songs/${SONG_ID}/dance-sessions/${session.id}`, { method: "DELETE" });
    location.href = `/review/${SONG_ID}`;
  } catch (e) { toast(e.message, true); }
});

async function init() {
  const state = await api("/api/state");
  song = state.songs.find((s) => s.id === SONG_ID);
  if (!song) { $("song-title").textContent = "Música não encontrada"; return; }
  document.title = `Análise · ${song.title} · Palco`;
  $("song-title").textContent = `${song.title} · ${song.artist}`;
  $("dance-again").href = `/play/${SONG_ID}`;
  saved = params(state.config && state.config.dance_params);

  const list = await api(`/api/songs/${SONG_ID}/dance-sessions`);
  if (!list.length) { $("empty").hidden = false; $("delete").hidden = true; $("download").hidden = true; return; }
  const when = (s) => new Date(s.created * 1000).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  $("session").replaceChildren(...list.map((s) => h("option", { value: s.id },
    `${when(s)} · ${s.players.map((p) => `${p.name} ${p.score.toLocaleString("pt-BR")}`).join(" × ")}`)));
  const wanted = new URLSearchParams(location.search).get("s");
  const id = list.some((s) => s.id === wanted) ? wanted : list[0].id;
  $("session").value = id;

  pose = await fetch(`/media/${SONG_ID}/pose.json`).then((r) => r.json());
  $("coach-view").style.aspectRatio = String(pose.aspect);
  video.src = `/media/${SONG_ID}/video.mp4`;
  $("content").hidden = false;
  await loadSession(id);
  video.addEventListener("loadedmetadata", () => { drawTimeline(); drawLag(); renderFrame(true); }, { once: true });
  requestAnimationFrame(loop);
}

init().catch((e) => { console.error(e); toast(`Erro na análise: ${e.message}`, true); });
