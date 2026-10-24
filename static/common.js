// Funções usadas pelas três páginas (telão, celular e player).

function getClientId() {
  let id = null;
  try { id = localStorage.getItem("karaoke-client"); } catch (e) {}
  if (!id) {
    id = Math.random().toString(36).slice(2, 12);
    try { localStorage.setItem("karaoke-client", id); } catch (e) {}
  }
  return id;
}
const CLIENT = getClientId();

async function api(path, opts = {}) {
  const init = { method: opts.method || "GET", headers: { "X-Client": CLIENT } };
  if (opts.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const r = await fetch(path, init);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch (e) {}
    throw new Error(msg);
  }
  return r.json();
}

// Recebe o estado do servidor em tempo real e reconecta sozinho.
// Efeitos sonoros chegam pelo mesmo canal, em mensagens separadas.
function watchState(onState, onFx) {
  const connect = () => {
    const ws = new WebSocket(`ws://${location.host}/ws?client=${CLIENT}`);
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.fx_event) { if (onFx) onFx(data.fx_event); } else onState(data);
    };
    ws.onclose = () => setTimeout(connect, 1500);
  };
  api("/api/state").then(onState).catch(() => {});
  connect();
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Ícones de traço (no lugar dos emojis)
const ICONS = {
  play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  next: '<path d="M5 5v14l10-7z" fill="currentColor" stroke="none"/><rect x="17" y="5" width="2" height="14" fill="currentColor" stroke="none"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8"/>',
  pads: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  list: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  duel: '<path d="M8 3v8M16 3v8M5 11h6M13 11h6M8 11l-2 10M16 11l2 10"/>',
  dance: '<circle cx="12" cy="4" r="2"/><path d="M12 6v7M12 9l-5-3M12 9l5 2M12 13l-4 8M12 13l4 8"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  later: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  lyrics: '<path d="M4 6h16M4 10h12M4 14h16M4 18h9"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="M21 16l-5-5-9 9"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  wand: '<path d="M4 20L16 8M14 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 11l.7 1.3L21 13l-1.3.7L19 15l-.7-1.3L17 13l1.3-.7z"/>',
  headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="5" height="7" rx="2"/><rect x="16" y="14" width="5" height="7" rx="2"/>',
  starOn: '<path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.5 6.7 19.4l1.2-6L3.4 9.3l6-.7z" fill="currentColor"/>',
  star: '<path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.5 6.7 19.4l1.2-6L3.4 9.3l6-.7z"/>',
};


function icon(name, size = 20) {
  const s = document.createElement("span");
  s.style.cssText = "display:inline-grid;place-items:center;line-height:0";
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return s;
}

// Troca os <i data-icon="nome"> do HTML pelos ícones
function fillIcons(root = document) {
  root.querySelectorAll("i[data-icon]").forEach((i) => i.replaceWith(icon(i.dataset.icon, parseInt(i.dataset.size || "20", 10))));
}

// Leva a cor que veio do site do som para a cor mais parecida da paleta do Palco
function paletteFor(hex) {
  const n = parseInt((hex || "#3A2A5A").slice(1), 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (max > 0.85 && d < 0.3) return "white";
  if (max < 0.35 || d < 0.15) return "plum";
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue < 20 || hue >= 290) return "pink";
  if (hue < 45) return "orange";
  if (hue < 70) return "gold";
  if (hue < 170) return "green";
  return "blue";
}

function fireFx(name) {
  return api(`/api/fx/${encodeURIComponent(name)}`, { method: "POST" }).catch((e) => toast(e.message, true));
}

// Prévia no próprio aparelho (só o celular ouve; nada sai no telão)
let previewSound = null;
function previewFx(sound, btn) {
  const same = previewSound && previewSound.id === sound.id;
  if (previewSound) { previewSound.audio.pause(); previewSound.btn.replaceChildren(icon("headphones", 16)); previewSound = null; }
  if (same) return;
  const audio = new Audio(`/media/sounds/${encodeURIComponent(sound.file)}`);
  previewSound = { id: sound.id, audio, btn };
  btn.replaceChildren(icon("stop", 14));
  audio.onended = () => { if (previewSound && previewSound.audio === audio) { btn.replaceChildren(icon("headphones", 16)); previewSound = null; } };
  audio.play().catch(() => toast("Não consegui tocar a prévia.", true));
}

function setFavorite(id, fav) {
  return api(`/api/sounds/${encodeURIComponent(id)}/favorite`, { method: "POST", body: { fav } }).catch((e) => toast(e.message, true));
}

// Mesa de sons: a seção principal (favoritos) e "Seus sons" (o resto, com busca).
// opts.preview: botão de ouvir no aparelho; opts.keys: mostra as teclas 1 a 0.
// Só redesenha quando a lista muda, para não perder o que foi digitado na busca.
function renderSoundBoard(box, fx, opts = {}) {
  const sounds = fx.sounds || [];
  const favs = fx.favorites || [];
  const key = sounds.map((s) => s.id).join("|") + "#" + favs.join("|");
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  const byId = Object.fromEntries(sounds.map((s) => [s.id, s]));
  const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

  const pad = (s, fav, i) => {
    const tools = h("span", { class: "pad-tools" });
    if (opts.preview) {
      const b = h("button", { class: "tool", title: "Ouvir só aqui", "aria-label": `Ouvir ${s.name} só no celular` }, icon("headphones", 16));
      b.addEventListener("click", () => previewFx(s, b));
      tools.append(b);
    }
    tools.append(h("button", {
      class: "tool", title: fav ? "Tirar da seção principal" : "Pôr na seção principal",
      "aria-label": `${fav ? "Tirar" : "Pôr"} ${s.name} ${fav ? "da" : "na"} seção principal`,
      onclick: () => setFavorite(s.id, !fav),
    }, icon(fav ? "starOn" : "star", 16)));
    return h("div", { class: "pad-wrap" },
      h("button", { class: `pad snd ${paletteFor(s.color)}`, onclick: () => fireFx(s.id) },
        h("span", {}, s.name), opts.keys && fav && KEYS[i] ? h("span", { class: "key" }, KEYS[i]) : null),
      tools);
  };

  const main = favs.map((id, i) => pad(byId[id], true, i));
  const rest = sounds.filter((s) => !favs.includes(s.id));
  const input = h("input", { type: "search", class: "lib-filter", placeholder: `Procurar entre ${rest.length} sons`, "aria-label": "Procurar som" });
  const grid = h("div", { class: "pads sounds" });
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const list = rest.filter((s) => !q || s.name.toLowerCase().includes(q));
    grid.replaceChildren(...list.map((s) => pad(s, false)));
    if (!list.length) grid.append(h("p", { class: "empty" }, q ? "Nenhum som com esse nome." : "Todos os sons estão na seção principal."));
  };
  input.addEventListener("input", draw);
  draw();
  box.replaceChildren(
    h("div", { class: "sound-head" }, h("h3", { class: "h-section", style: "font-size:16px" }, "PRINCIPAIS"),
      h("button", { class: "btn sm danger", onclick: () => fireFx("stop") }, icon("stop", 14), "Parar sons")),
    main.length ? h("div", { class: "pads sounds" }, ...main) : h("p", { class: "empty" }, "Toque na estrela de um som para trazer ele pra cá."),
    h("div", { class: "sound-head", style: "margin-top:14px" }, h("h3", { class: "h-section", style: "font-size:16px" }, "SEUS SONS")),
    input, grid);
}

function avatar(singer, cls = "") {
  const name = (singer && singer.name) || "?";
  return h("span", { class: `avatar ${cls}`, style: `background:${(singer && singer.color) || "#FFC93C"}`, "aria-hidden": "true" }, name.trim()[0].toUpperCase());
}

// Um único status por música: pronta, preparando ou precisa de ajuste
function songStatus(s) {
  if (s.status === "error") return { tone: "err", label: "Deu ruim no preparo" };
  if (s.status !== "ready") return { tone: "warn", label: s.step || "Preparando…", busy: true };
  if (!s.has_lyrics) return { tone: "warn", label: "Sem letra", fix: true };
  if (!s.lyrics_synced) return { tone: "warn", label: "Letra sem sincronia", fix: true };
  return { tone: "ok", label: "Pronta" };
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function toast(msg, isErr = false) {
  const t = h("div", { class: "toast" + (isErr ? " err" : ""), role: "status" }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), isErr ? 6000 : 2500);
}

// Aviso grande no telão de qual efeito tocou
function fxToast(text) {
  document.querySelectorAll(".fx-toast").forEach((x) => x.remove());
  const t = h("div", { class: "fx-toast" }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 1600);
}

// Prévia de 5 segundos de um resultado da busca
let previewAudio = null;
function setPreviewIcon(btn, name) { btn.replaceChildren(icon(name, 16)); }
async function playPreview(videoId, btn) {
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }
  if (btn.dataset.playing) { delete btn.dataset.playing; setPreviewIcon(btn, "play"); return; }
  document.querySelectorAll("[data-playing]").forEach((b) => { delete b.dataset.playing; setPreviewIcon(b, "play"); });
  btn.textContent = "…";
  btn.dataset.playing = "1";
  const audio = new Audio(`/api/preview/${videoId}`);
  previewAudio = audio;
  audio.onplaying = () => setPreviewIcon(btn, "stop");
  audio.onended = audio.onerror = () => { delete btn.dataset.playing; setPreviewIcon(btn, "play"); };
  audio.play().catch(() => { setPreviewIcon(btn, "play"); delete btn.dataset.playing; toast("Não consegui tocar a prévia.", true); });
}

// Lista de resultados da busca do YouTube (telão e celular).
// "Pedir" já põe a música na fila da festa com o nome de quem pediu.
function renderResults(container, items, kind = "original", opts = {}) {
  container.replaceChildren();
  if (!items.length) { container.append(h("p", { class: "empty" }, "Nada encontrado. Tenta outro nome?")); return; }
  for (const v of items) {
    const buttons = [];
    const add = (queue, label, cls) => {
      const b = h("button", { class: cls }, label);
      b.onclick = async () => {
        buttons.forEach((x) => { x.disabled = true; });
        try {
          await api("/api/songs", { method: "POST", body: { ...v, kind, queue } });
          b.textContent = queue ? "Na fila!" : "Guardada";
          if (opts.onAdded) opts.onAdded(queue);
        } catch (e) { toast(e.message, true); buttons.forEach((x) => { x.disabled = false; }); }
      };
      buttons.push(b);
    };
    add(true, opts.queueLabel || "Pedir", "btn sm");
    if (opts.allowSave) add(false, "Só guardar", "btn sm ghost");
    const prev = h("button", { class: "icon-btn sm round", title: "Ouvir 5 segundos", "aria-label": "Ouvir prévia" }, icon("play", 16));
    prev.onclick = () => playPreview(v.id, prev);
    container.append(h("div", { class: "result" },
      h("img", { src: v.thumbnail, alt: "", loading: "lazy" }),
      h("div", { class: "meta" },
        h("div", { class: "t" }, v.title),
        h("div", { class: "sub" }, `${v.channel}${v.duration ? " · " + fmtTime(v.duration) : ""}`)),
      prev, h("div", { class: "add-btns" }, ...buttons)));
  }
}

// Busca do YouTube. O seletor [data-kind] escolhe entre a música original
// (que passa pela separação) e uma versão que já é karaokê (instrumental).
function setupSearch(form, input, results, opts = {}) {
  let kind = "original";
  const buttons = form.querySelectorAll("[data-kind]");
  const placeholder = input.placeholder;
  buttons.forEach((b) => b.addEventListener("click", () => {
    kind = b.dataset.kind;
    buttons.forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", x === b); });
    input.placeholder = kind === "karaoke" ? "Qual música? Vou buscar a versão karaokê" : placeholder;
    if (input.value.trim()) form.requestSubmit();
  }));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    let q = input.value.trim();
    if (!q) return;
    const isLink = /youtu\.?be/.test(q);
    if (kind === "karaoke" && !isLink && !/karaok/i.test(q)) q += " karaoke";
    if (opts.onOpen) opts.onOpen();
    results.replaceChildren(h("p", { class: "empty" }, "Procurando no YouTube…"));
    try { renderResults(results, await api(`/api/search?q=${encodeURIComponent(q)}`), kind, opts); }
    catch (err) { results.replaceChildren(h("p", { class: "empty" }, err.message)); }
  });
}

// Botão clicado perde o foco, para o espaço não "clicar" nele de novo
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest("button");
  if (b) b.blur();
});
