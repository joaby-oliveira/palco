// Sons da festa tocando no telão. Os arquivos ficam em data/sounds.
// Cada pessoa tem o seu canal: um som novo dela corta o anterior dela,
// sem mexer no que os outros dispararam.

const Fx = (() => {
  let ctx = null;
  let vol = null;           // volume geral dos efeitos
  const channels = {};      // dono -> GainNode
  let sounds = {};          // id -> arquivo
  const buffers = {};
  let volume = 0.7;

  function init() {
    if (ctx) return;
    ctx = new AudioContext();
    vol = ctx.createGain();
    vol.gain.value = volume;
    // Um compressor evita que vários sons juntos estourem a caixa
    const comp = ctx.createDynamicsCompressor();
    vol.connect(comp);
    comp.connect(ctx.destination);
  }
  // O navegador só libera o som depois de um clique ou tecla na página
  const unlock = () => { init(); ctx.resume(); };
  document.addEventListener("pointerdown", unlock);
  document.addEventListener("keydown", unlock);

  // Desligar o canal cala tudo que estava tocando nele
  function freshChannel(owner) {
    if (channels[owner]) channels[owner].disconnect();
    const g = ctx.createGain();
    g.connect(vol);
    channels[owner] = g;
    return g;
  }

  async function load(file) {
    if (!buffers[file]) {
      const r = await fetch(`/media/sounds/${encodeURIComponent(file)}`);
      if (!r.ok) throw new Error(r.statusText);
      buffers[file] = await ctx.decodeAudioData(await r.arrayBuffer());
    }
    return buffers[file];
  }

  return {
    setSounds(list) { sounds = Object.fromEntries((list || []).map((s) => [s.id, s.file])); },
    setVolume(v) { volume = v; if (vol) vol.gain.value = v; },
    stopAll() {
      for (const owner of Object.keys(channels)) { channels[owner].disconnect(); delete channels[owner]; }
    },
    async play(name, owner = "local") {
      init();
      ctx.resume();
      if (name === "stop") { this.stopAll(); return; }
      if (!sounds[name]) return;
      const channel = freshChannel(owner);
      try {
        const src = ctx.createBufferSource();
        src.buffer = await load(sounds[name]);
        src.connect(channel);
        src.start();
      } catch (e) { console.warn("Falha ao tocar", name, e); }
    },
  };
})();
