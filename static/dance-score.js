// Nota da dança: compara a pose de quem dança (webcam) com a do coach (pose.json).
// Sem dependência da página, para dar para testar com node.
//
// A comparação é pela direção de cada osso (braço, antebraço, coxa, canela),
// que não muda com a altura da pessoa nem com a distância da câmera. Cada
// quadro da webcam é comparado com um trecho do gabarito um pouco para trás
// (quem imita vem sempre atrasado), e cada movimento ganha a média dos quadros,
// reduzida se a pessoa ficou parada enquanto o coach se mexia.

// Pontos (na ordem do pose.json): 0 ombro E, 1 ombro D, 2 cotovelo E, 3 cotovelo D,
// 4 punho E, 5 punho D, 6 quadril E, 7 quadril D, 8 joelho E, 9 joelho D, 10 tornozelo E, 11 tornozelo D
export const KEYPOINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
// Linhas do desenho do corpo, nos mesmos 12 pontos
export const SKELETON = [[0, 1], [0, 2], [2, 4], [1, 3], [3, 5], [0, 6], [1, 7], [6, 7], [6, 8], [8, 10], [7, 9], [9, 11]];
// Ossos comparados; os 4 primeiros são dos braços, os outros das pernas
export const BONES = [[0, 2], [2, 4], [1, 3], [3, 5], [6, 8], [8, 10], [7, 9], [9, 11]];
export const BONE_NAMES = ["Braço esq.", "Antebraço esq.", "Braço dir.", "Antebraço dir.", "Coxa esq.", "Canela esq.", "Coxa dir.", "Canela dir."];
const ARMS = 4;
export const SWAP = [1, 0, 3, 2, 5, 4, 7, 6, 9, 8, 11, 10];
const GRACE = 0.25; // quadros até um pouco depois do fim ainda contam para o movimento

// Parâmetros da nota (dá para calibrar na tela de análise e salvar no ⚙)
export const DEFAULT_PARAMS = {
  tolerance: 40,       // graus de diferença em que o osso zera
  lagMin: -0.45,       // trecho do gabarito comparado com cada quadro (s, negativo = coach antes)
  lagMax: 0.1,
  legWeight: 0.3,      // peso das pernas (cada osso do braço vale 1)
  stillPenalty: 0.7,   // quanto da nota some se a pessoa fica parada enquanto o coach se mexe
  thresholds: [0.75, 0.62, 0.5, 0.38], // mínimo para PERFEITO, SUPER, BOM e OK
};

export function params(custom) {
  const p = { ...DEFAULT_PARAMS, ...(custom || {}) };
  p.thresholds = Array.isArray(p.thresholds) && p.thresholds.length === 4 ? p.thresholds : DEFAULT_PARAMS.thresholds;
  return p;
}

export const RATINGS = [
  { label: "PERFEITO", points: 100, tone: "perfect" },
  { label: "SUPER", points: 75, tone: "super" },
  { label: "BOM", points: 50, tone: "good" },
  { label: "OK", points: 25, tone: "ok" },
  { label: "ERROU", points: 0, tone: "miss" },
];
export const STARS = [2000, 4000, 5500, 7000, 8500]; // pontos (de 10.000) para cada estrela

export function rate(value, thresholds = DEFAULT_PARAMS.thresholds) {
  const i = thresholds.findIndex((min) => value >= min);
  return RATINGS[i < 0 ? RATINGS.length - 1 : i];
}

// Pontos [x, y, visibilidade] -> direção de cada osso, com x na mesma escala de y.
// mirror: a pessoa imita como num espelho (troca esquerda/direita e inverte x).
export function bones(points, aspect, mirror = false) {
  return BONES.map(([a, b]) => {
    if (mirror) { a = SWAP[a]; b = SWAP[b]; }
    let dx = (points[b * 3] - points[a * 3]) * aspect;
    const dy = points[b * 3 + 1] - points[a * 3 + 1];
    if (mirror) dx = -dx;
    const n = Math.hypot(dx, dy) || 1;
    return [dx / n, dy / n, Math.min(points[a * 3 + 2], points[b * 3 + 2])];
  });
}

// Landmarks do MediaPipe (33 pontos {x, y, visibility}) -> 12 pontos achatados
export function flatten(landmarks) {
  const out = [];
  for (const k of KEYPOINTS) { const p = landmarks[k]; out.push(p.x, p.y, p.visibility ?? 1); }
  return out;
}

// Diferença de cada osso em graus (null = osso fora de vista em um dos dois)
export function boneErrors(ref, player) {
  return ref.map((r, i) => {
    const p = player[i];
    if (r[2] < 0.5 || p[2] < 0.5) return null;
    return Math.acos(Math.max(-1, Math.min(1, r[0] * p[0] + r[1] * p[1]))) * 180 / Math.PI;
  });
}

// Quanto os braços variaram num trecho (0 = parado)
function spread(list) {
  let total = 0, n = 0;
  for (let j = 0; j < ARMS; j++) {
    let x = 0, y = 0, c = 0;
    for (const b of list) if (b[j][2] >= 0.5) { x += b[j][0]; y += b[j][1]; c++; }
    if (c < 3) continue;
    total += 1 - Math.hypot(x / c, y / c);
    n++;
  }
  return n ? total / n : 0;
}

export class Judge {
  constructor(pose, custom) {
    this.p = params(custom);
    this.fps = pose.fps;
    this.moves = pose.moves;
    this.ref = pose.frames.map((f) => (f ? bones(f, pose.aspect) : null));
    this.weights = BONES.map((_, i) => (i < ARMS ? 1 : this.p.legWeight));
    this.maxPoints = this.moves.length * 100;
    this.trace = null; // lista: cada quadro comparado (tempo, jogador, modo, nota, atraso) — para a análise
    this.reset(0);
  }

  // Volta a contar do ponto t (início, ou depois de pular na música)
  reset(t) {
    this.idx = this.moves.findIndex((m) => m[1] + GRACE > t);
    if (this.idx < 0) this.idx = this.moves.length;
    this.acc = null;
  }

  // Coach está dançando agora? (só há nota dentro dos movimentos)
  active(t) { const m = this.moves[this.idx]; return Boolean(m) && t >= m[0]; }

  similarity(ref, player) {
    let total = 0, weight = 0;
    for (let i = 0; i < BONES.length; i++) {
      const r = ref[i], p = player[i];
      if (r[2] < 0.5 || p[2] < 0.5 || !this.weights[i]) continue;
      const cos = Math.max(-1, Math.min(1, r[0] * p[0] + r[1] * p[1]));
      const deg = Math.acos(cos) * 180 / Math.PI;
      total += this.weights[i] * Math.max(0, 1 - deg / this.p.tolerance);
      weight += this.weights[i];
    }
    return weight >= 2 ? total / weight : null; // precisa ver pelo menos os dois braços
  }

  // Melhor quadro do gabarito dentro da janela de atraso: { s: nota, k: índice }
  best(t, player) {
    let best = null;
    const from = Math.max(0, Math.floor((t + this.p.lagMin) * this.fps));
    const to = Math.min(this.ref.length - 1, Math.ceil((t + this.p.lagMax) * this.fps));
    for (let k = from; k <= to; k++) {
      if (!this.ref[k]) continue;
      const s = this.similarity(this.ref[k], player);
      if (s != null && (best == null || s > best.s)) best = { s, k };
    }
    return best;
  }

  // Um quadro da webcam no tempo t da música. players: lista de pontos achatados
  // (um por pessoa, já na ordem dos jogadores), ou null para quem não apareceu.
  // aspect: largura/altura da imagem da câmera. Devolve os movimentos fechados.
  frame(t, players, aspect) {
    const done = [];
    while (this.idx < this.moves.length && t > this.moves[this.idx][1] + GRACE) {
      done.push(this._close());
      this.idx++;
    }
    const m = this.moves[this.idx];
    if (!m || t < m[0]) return done;
    if (!this.acc) this.acc = { players: [] };
    players.forEach((points, i) => {
      const a = this.acc.players[i] || (this.acc.players[i] = { mirror: [], same: [], bonesMirror: [], bonesSame: [] });
      if (!points) return;
      for (const mode of ["mirror", "same"]) {
        const b = bones(points, aspect, mode === "mirror");
        (mode === "mirror" ? a.bonesMirror : a.bonesSame).push(b);
        const r = this.best(t, b);
        if (!r) continue;
        a[mode].push(r.s);
        if (this.trace) this.trace.push({ t, i, mode, s: r.s, lag: r.k / this.fps - t });
      }
    });
    return done;
  }

  _close() {
    const [start, end] = this.moves[this.idx];
    const coach = this.ref.slice(Math.floor(start * this.fps), Math.ceil(end * this.fps)).filter(Boolean);
    const want = spread(coach);
    const results = ((this.acc && this.acc.players) || []).map((a) => {
      const score = { detail: {} };
      for (const mode of ["mirror", "same"]) {
        const vals = a[mode];
        if (!vals.length) { score[mode] = null; continue; }
        const mean = vals.reduce((x, y) => x + y, 0) / vals.length;
        const moved = spread(mode === "mirror" ? a.bonesMirror : a.bonesSame);
        // Ficar parado enquanto o coach se mexe tira parte da nota
        const ratio = Math.min(1, (moved + 0.01) / (0.6 * want + 0.01));
        score[mode] = mean * (1 - this.p.stillPenalty + this.p.stillPenalty * ratio);
        score.detail[mode] = { mean, ratio, frames: vals.length };
      }
      return score;
    });
    this.acc = null;
    return { move: this.idx, start, end, results };
  }
}

// Placar de uma pessoa. A pessoa pode imitar como espelho (o normal no Just
// Dance) ou do mesmo lado; vale o jeito que deu mais nota até agora.
export class Scoreboard {
  constructor(maxPoints, thresholds = DEFAULT_PARAMS.thresholds) {
    this.maxPoints = maxPoints || 1;
    this.thresholds = thresholds;
    this.points = 0;
    this.modeTotals = { mirror: 0.001, same: 0 };
    this.counts = Object.fromEntries(RATINGS.map((r) => [r.label, 0]));
    this.streak = 0;
    this.bestStreak = 0;
  }

  add(result) {
    if (result) for (const mode of ["mirror", "same"]) if (result[mode] != null) this.modeTotals[mode] += result[mode];
    const mode = this.modeTotals.mirror >= this.modeTotals.same ? "mirror" : "same";
    const value = result && result[mode] != null ? result[mode] : -1;
    const r = rate(value, this.thresholds);
    this.points += r.points;
    this.counts[r.label]++;
    this.streak = r.points >= 75 ? this.streak + 1 : 0;
    this.bestStreak = Math.max(this.bestStreak, this.streak);
    return { ...r, value, mode };
  }

  get score() { return Math.round(this.points / this.maxPoints * 10000); }
  get stars() { return STARS.filter((s) => this.score >= s).length; }
}

// Recalcula uma dança gravada com outros parâmetros (tela de análise).
// session: { frames: [[t, aspecto, pontos1|null, pontos2|null], ...], players: [{ since, maxPoints }], end }
// Um quadro [t, null] marca um pulo na música (os movimentos pulados não contam).
// end: onde a dança parou (null = foi até o fim).
export function replay(pose, session, custom) {
  const judge = new Judge(pose, custom);
  judge.trace = [];
  const boards = session.players.map((p) => new Scoreboard(p.maxPoints || judge.maxPoints, judge.p.thresholds));
  const moves = [];
  const collect = (done) => {
    for (const d of done) {
      const entry = { move: d.move, start: d.start, end: d.end, players: [] };
      boards.forEach((b, i) => {
        if (d.move < (session.players[i].since || 0)) return;
        const r = b.add(d.results[i]);
        entry.players[i] = { label: r.label, tone: r.tone, value: r.value, mode: r.mode, result: d.results[i] || null };
      });
      moves.push(entry);
    }
  };
  for (const [t, aspect, ...players] of session.frames) {
    if (aspect === null) judge.reset(t);
    else collect(judge.frame(t, players, aspect));
  }
  collect(judge.frame(session.end == null ? Infinity : session.end, [], 4 / 3));
  return { judge, boards, moves, trace: judge.trace };
}
