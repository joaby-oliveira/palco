// Funções usadas pelas três páginas (notebook, celular e player).

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
function watchState(onState) {
  let ws;
  const connect = () => {
    ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onmessage = (e) => onState(JSON.parse(e.data));
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

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function toast(msg, isErr = false) {
  const t = h("div", { class: "toast" + (isErr ? " err" : "") }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), isErr ? 6000 : 2500);
}

// Prévia de 5 segundos de um resultado da busca
let previewAudio = null;
async function playPreview(videoId, btn) {
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }
  if (btn.dataset.playing) { delete btn.dataset.playing; btn.textContent = "▶"; return; }
  document.querySelectorAll("[data-playing]").forEach((b) => { delete b.dataset.playing; b.textContent = "▶"; });
  btn.textContent = "…";
  btn.dataset.playing = "1";
  const audio = new Audio(`/api/preview/${videoId}`);
  previewAudio = audio;
  audio.onplaying = () => { btn.textContent = "■"; };
  audio.onended = audio.onerror = () => { delete btn.dataset.playing; btn.textContent = "▶"; };
  audio.play().catch(() => { btn.textContent = "▶"; delete btn.dataset.playing; toast("Não consegui tocar a prévia.", true); });
}

// Lista de resultados da busca do YouTube (notebook e celular)
function renderResults(container, items, kind = "original") {
  container.replaceChildren();
  if (!items.length) { container.append(h("p", { class: "empty" }, "Nada encontrado.")); return; }
  for (const v of items) {
    // Música original: escolhe na hora se separa também os backing vocals
    // (gasta 2 separações em vez de 1). Versão karaokê não passa por separação.
    const buttons = [];
    const addWith = (backing, label, title, cls) => {
      const b = h("button", { class: cls, title }, label);
      b.onclick = async () => {
        buttons.forEach((x) => { x.disabled = true; });
        try {
          await api("/api/songs", { method: "POST", body: { ...v, kind, backing } });
          b.textContent = "Adicionada";
        } catch (e) { toast(e.message, true); buttons.forEach((x) => { x.disabled = false; }); }
      };
      buttons.push(b);
    };
    if (kind === "karaoke") {
      addWith(false, "Adicionar", "Versão karaokê: entra sem separação", "btn sm");
    } else {
      addWith(false, "Sem backing", "Tira só a voz (1 separação). Os backing vocals saem junto com a voz.", "btn sm");
      addWith(true, "Com backing", "Tira a voz e separa os backing vocals, para você controlar o volume deles (2 separações).", "btn sm ghost");
    }
    const prev = h("button", { class: "icon-btn", title: "Prévia de 5 segundos" }, "▶");
    prev.onclick = () => playPreview(v.id, prev);
    container.append(h("div", { class: "result" },
      h("img", { src: v.thumbnail, alt: "", loading: "lazy" }),
      h("div", { class: "meta" },
        h("div", { class: "title" }, v.title),
        h("div", { class: "sub" }, `${v.channel}${v.duration ? " · " + fmtTime(v.duration) : ""}`)),
      prev, h("div", { class: "add-btns" }, ...buttons)));
  }
}

// Busca do YouTube. O seletor [data-kind] escolhe entre a música original
// (que passa pela separação) e uma versão karaokê (que já é instrumental).
function setupSearch(form, input, results) {
  let kind = "original";
  const buttons = form.querySelectorAll("[data-kind]");
  buttons.forEach((b) => b.addEventListener("click", () => {
    kind = b.dataset.kind;
    buttons.forEach((x) => x.classList.toggle("on", x === b));
    input.placeholder = kind === "karaoke" ? "Música para buscar a versão karaokê..." : "Digite o nome do artista ou música...";
    if (input.value.trim()) form.requestSubmit();
  }));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    let q = input.value.trim();
    if (!q) return;
    const isLink = /youtu\.?be/.test(q);
    if (kind === "karaoke" && !isLink && !/karaok/i.test(q)) q += " karaoke";
    results.replaceChildren(h("p", { class: "empty" }, "Buscando no YouTube..."));
    try { renderResults(results, await api(`/api/search?q=${encodeURIComponent(q)}`), kind); }
    catch (err) { results.replaceChildren(h("p", { class: "empty" }, err.message)); }
  });
}

// Itens da fila "Músicas a processar"
function renderQueue(container, songs, canDelete, onRetry) {
  container.replaceChildren();
  for (const s of songs) {
    const isErr = s.status === "error";
    const body = h("div", { class: "body" },
      h("img", { src: s.thumbnail, alt: "" }),
      h("div", { class: "meta" },
        h("div", { class: "title" }, s.title),
        h("div", { class: "sub" }, s.artist),
        h("div", { class: "step" + (isErr ? " err" : "") }, isErr ? `Erro: ${s.error}` : s.step),
        isErr ? null : h("div", { class: "bar" }, h("div", { style: `width:${Math.round(s.progress * 100)}%` }))),
      isErr && onRetry ? h("button", { class: "btn sm ghost", onclick: () => onRetry(s) }, "Tentar de novo") : null);
    const item = h("div", { class: "queue-item" }, body);
    if (canDelete(s)) {
      item.append(h("button", { class: "icon-btn x", title: "Remover", onclick: async () => {
        try { await api(`/api/songs/${s.id}`, { method: "DELETE" }); } catch (e) { toast(e.message, true); }
      } }, "✕"));
    }
    container.append(item);
  }
}

// Botão clicado perde o foco, para o espaço não "clicar" nele de novo
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest("button");
  if (b) b.blur();
});
