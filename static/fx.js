// Efeitos sonoros da festa, sintetizados no navegador (sem arquivos de áudio).
// Um arquivo em data/fx/<nome>.mp3 (ou .wav/.ogg) substitui o som sintetizado.

const Fx = (() => {
  let ctx = null;
  let out = null;
  let noise = null;
  let files = {};
  const buffers = {};
  let volume = 0.7;

  function init() {
    if (ctx) return;
    ctx = new AudioContext();
    out = ctx.createGain();
    out.gain.value = volume;
    // Um compressor evita que vários efeitos juntos estourem a caixa
    const comp = ctx.createDynamicsCompressor();
    out.connect(comp);
    comp.connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  // O navegador só libera o som depois de um clique ou tecla na página
  const unlock = () => { init(); ctx.resume(); };
  document.addEventListener("pointerdown", unlock);
  document.addEventListener("keydown", unlock);

  const rnd = (a, b) => a + Math.random() * (b - a);

  // Envelope: sobe em `a` segundos até `peak`, segura `hold` e cai em `rel`
  function env(node, t, a, hold, rel, peak = 1) {
    const g = node.gain;
    g.setValueAtTime(0.0001, t);
    g.linearRampToValueAtTime(peak, t + a);
    g.setValueAtTime(peak, t + a + hold);
    g.exponentialRampToValueAtTime(0.0001, t + a + hold + rel);
    return t + a + hold + rel;
  }

  function gain(dest = out) { const g = ctx.createGain(); g.connect(dest); return g; }

  function filter(type, freq, q = 1, dest = out) {
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    f.connect(dest);
    return f;
  }

  function noiseBurst(t, dur, dest, offset = Math.random()) {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    s.connect(dest);
    s.start(t, offset, dur + 0.05);
  }

  function osc(type, freq, t, end, dest) {
    const o = ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    o.connect(dest);
    o.start(t); o.stop(end + 0.05);
    return o;
  }

  // Voz "cantada": dente de serra passando por dois formantes de vogal
  function voice(t, dur, freq, vowel, level = 0.3, glide = 0, dest = out) {
    const F = { a: [800, 1200], o: [500, 900], u: [330, 700], e: [500, 1800] }[vowel];
    const g = gain(dest);
    const f1 = filter("bandpass", F[0], 6, g);
    const f2 = filter("bandpass", F[1], 8, g);
    const o = osc("sawtooth", freq, t, t + dur, f1);
    o.connect(f2);
    if (glide) o.frequency.linearRampToValueAtTime(freq + glide, t + dur);
    const lfo = osc("sine", rnd(4.5, 6), t, t + dur, gain());
    const depth = ctx.createGain(); depth.gain.value = freq * 0.015;
    lfo.disconnect(); lfo.connect(depth); depth.connect(o.frequency);
    env(g, t, 0.06, Math.max(0, dur - 0.2), 0.14, level * 3);
  }

  const SYNTH = {
    aplausos(t) {
      const dur = 3.2;
      for (let i = 0; i < 260; i++) {
        const at = t + Math.pow(Math.random(), 0.8) * dur;
        const level = Math.sin(Math.PI * Math.min(1, (at - t) / dur * 1.15)) * 0.9 + 0.1;
        const g = gain();
        noiseBurst(at, 0.04, filter("bandpass", rnd(900, 2600), 1.2, g));
        env(g, at, 0.002, 0.004, rnd(0.03, 0.07), level * 0.9);
      }
    },
    uhuu(t) {
      for (let i = 0; i < 7; i++) {
        const s = t + rnd(0, 0.35);
        voice(s, rnd(1.3, 1.9), rnd(260, 420), "u", 0.22, rnd(250, 420));
      }
      const g = gain();
      noiseBurst(t, 1.8, filter("bandpass", 1200, 0.8, g));
      env(g, t, 0.3, 0.8, 0.7, 0.15);
    },
    risada(t) {
      for (let v = 0; v < 4; v++) {
        let at = t + rnd(0, 0.3);
        const base = rnd(170, 300);
        for (let i = 0; i < 7; i++) {
          voice(at, 0.13, base * (1 - i * 0.03), "a", 0.18);
          at += rnd(0.17, 0.22);
        }
      }
    },
    buzina(t) {
      [[0, 0.22], [0.32, 0.22], [0.64, 0.9]].forEach(([d, len]) => {
        const g = gain();
        const f = filter("lowpass", 2200, 1, g);
        for (const fr of [370, 466]) osc("sawtooth", fr, t + d, t + d + len, f);
        env(g, t + d, 0.01, len - 0.06, 0.05, 0.35);
      });
    },
    rufar(t) {
      const roll = 2.2;
      for (let at = t; at < t + roll; at += 0.034) {
        const g = gain();
        noiseBurst(at, 0.05, filter("bandpass", 2500, 0.7, g));
        env(g, at, 0.001, 0.005, 0.04, 0.12 + 0.5 * ((at - t) / roll));
      }
      const end = t + roll;
      const crash = gain();
      noiseBurst(end, 2.2, filter("highpass", 4000, 0.5, crash));
      env(crash, end, 0.002, 0.05, 2, 0.6);
      const kick = gain();
      const k = osc("sine", 140, end, end + 0.5, kick);
      k.frequency.exponentialRampToValueAtTime(45, end + 0.4);
      env(kick, end, 0.002, 0.05, 0.4, 1);
    },
    errou(t) {
      // Trombone triste: "uó, uó, uó, uóóóó"
      [[293.7, 0.45], [277.2, 0.45], [261.6, 0.45], [246.9, 1.4]].forEach(([fr, len], i) => {
        const at = t + i * 0.5;
        const g = gain();
        const f = filter("lowpass", 600, 4, g);
        f.frequency.setValueAtTime(400, at);
        f.frequency.linearRampToValueAtTime(1600, at + 0.15);
        f.frequency.linearRampToValueAtTime(700, at + len);
        const o = osc("sawtooth", fr, at, at + len, f);
        if (i === 3) {
          const lfo = osc("sine", 6, at, at + len, gain());
          const depth = ctx.createGain(); depth.gain.value = 6;
          lfo.disconnect(); lfo.connect(depth); depth.connect(o.frequency);
        }
        env(g, at, 0.03, len - 0.15, 0.12, 0.4);
      });
    },
    ooo(t) {
      // Plateia cantando "ô-ô-ô-ôôô"
      const notes = [[0, 0.35, 0], [0.4, 0.35, 0], [0.8, 0.35, 2], [1.2, 1.1, -3]];
      for (let v = 0; v < 6; v++) {
        const base = rnd(190, 215) * (v % 2 ? 2 : 1) * (v % 3 === 0 ? 0.75 : 1);
        for (const [d, len, semi] of notes) voice(t + d + rnd(0, 0.04), len, base * Math.pow(2, semi / 12), "o", 0.13);
      }
    },
    sirene(t) {
      const g = gain();
      const o = osc("square", 650, t, t + 3, filter("lowpass", 2500, 1, g));
      for (let i = 0; i < 3; i++) {
        o.frequency.linearRampToValueAtTime(1250, t + i + 0.5);
        o.frequency.linearRampToValueAtTime(650, t + i + 1);
      }
      env(g, t, 0.05, 2.8, 0.15, 0.18);
    },
    grilo(t) {
      // Silêncio constrangedor
      for (let c = 0; c < 4; c++) {
        const at0 = t + c * 0.75;
        for (let i = 0; i < 3; i++) {
          const at = at0 + i * 0.06;
          const g = gain();
          osc("sine", 4600, at, at + 0.05, g);
          env(g, at, 0.005, 0.02, 0.02, 0.2);
        }
      }
    },
    tchan(t) {
      // "Tchan, tchan, tchaaaan!"
      [[0, 0.22, [146.8, 174.6, 220]], [0.3, 0.22, [146.8, 174.6, 220]], [0.62, 1.6, [138.6, 164.8, 207.7]]].forEach(([d, len, chord]) => {
        const at = t + d;
        const g = gain();
        const f = filter("lowpass", 1800, 2, g);
        for (const fr of chord) { osc("sawtooth", fr, at, at + len, f); osc("sawtooth", fr * 1.004, at, at + len, f); }
        env(g, at, 0.01, len - 0.1, 0.2, 0.22);
        if (len > 1) {
          const tr = ctx.createOscillator(); tr.frequency.value = 9;
          const depth = ctx.createGain(); depth.gain.value = 0.08;
          tr.connect(depth); depth.connect(g.gain); tr.start(at + 0.2); tr.stop(at + len);
        }
      });
    },
    vaia(t) {
      for (let i = 0; i < 9; i++) voice(t + rnd(0, 0.3), rnd(1.6, 2.1), rnd(110, 170), "u", 0.14, -rnd(10, 30));
      const g = gain();
      noiseBurst(t, 2, filter("lowpass", 500, 0.7, g));
      env(g, t, 0.2, 1.4, 0.4, 0.25);
    },
    fogos(t) {
      for (let k = 0; k < 3; k++) {
        const at = t + k * 0.55;
        const g = gain();
        const o = osc("sine", 900, at, at + 0.7, g);
        o.frequency.exponentialRampToValueAtTime(2800, at + 0.7);
        env(g, at, 0.02, 0.6, 0.05, 0.08);
        const boom = at + 0.75;
        const b = gain();
        noiseBurst(boom, 1, filter("lowpass", 900, 0.7, b));
        env(b, boom, 0.002, 0.03, 0.9, 1);
        for (let i = 0; i < 30; i++) {
          const c = boom + 0.1 + Math.random() * 0.9;
          const cg = gain();
          noiseBurst(c, 0.02, filter("highpass", 3000, 1, cg));
          env(cg, c, 0.001, 0.002, 0.02, 0.4);
        }
      }
    },
  };

  async function playFile(name) {
    if (!buffers[name]) {
      const r = await fetch(`/media/fx/${encodeURIComponent(files[name])}`);
      buffers[name] = await ctx.decodeAudioData(await r.arrayBuffer());
    }
    const s = ctx.createBufferSource();
    s.buffer = buffers[name];
    s.connect(out);
    s.start();
  }

  return {
    names: Object.keys(SYNTH),
    setFiles(f) { files = f || {}; },
    setVolume(v) { volume = v; if (out) out.gain.value = v; },
    play(name) {
      init();
      ctx.resume();
      if (files[name]) { playFile(name).catch(() => SYNTH[name] && SYNTH[name](ctx.currentTime + 0.02)); return; }
      if (SYNTH[name]) SYNTH[name](ctx.currentTime + 0.02);
    },
  };
})();

