// Telão (notebook): próximo no palco, fila da festa, repertório, letra, capa, efeitos e ajustes.

let STATE = { songs: [], config: {}, providers: [], party: { queue: [] } };
let BY_ID = {};
const $ = (id) => document.getElementById(id);
fillIcons();

// ---------- Navegação entre telas ----------

function show(view) {
  for (const v of ["home", "lyrics", "cover"]) $(`view-${v}`).hidden = v !== view;
  window.scrollTo(0, 0);
}
document.querySelectorAll("[data-back]").forEach((a) => a.addEventListener("click", () => show("home")));
document.querySelectorAll("dialog [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

// ---------- Uso do serviço (limite diário do MVSEP grátis) ----------

let USAGE = null;
let lastStatuses = "";

async function loadUsage(force = false) {
  try { USAGE = await api(`/api/usage${force ? "?force=true" : ""}`); } catch (e) { USAGE = null; }
  renderAlert();
}

function usageLevel(u) {
  if (u.remaining < u.per_song) return "out";
  if (u.remaining <= 10) return "warn";
  return "";
}

function resetTime(u) {
  return new Date(u.resets_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

// O telão só mostra o lado técnico quando algo precisa de atenção
function renderAlert() {
  const chip = $("alert-chip");
  const p = STATE.providers.find((x) => x.name === STATE.config.provider);
  const u = USAGE;
  chip.className = "alert-chip";
  if (p && p.problem && p.name !== "none") {
    chip.textContent = `Separação de voz: configurar ${p.label}`;
    chip.title = p.problem;
  } else if (u && u.supported && !u.error && u.plan !== "premium" && usageLevel(u)) {
    const out = usageLevel(u) === "out";
    chip.classList.toggle("out", out);
    chip.textContent = out ? `${p ? p.label : "Separação"}: acabou por hoje` : `${p ? p.label : "Separação"}: sobram ~${u.songs_left} músicas`;
    chip.title = `Zera às ${resetTime(u)}. Versões que já são karaokê não gastam separação.`;
  } else { chip.hidden = true; return; }
  chip.hidden = false;
}
$("alert-chip").addEventListener("click", () => openSettings().catch((e) => toast(e.message, true)));

function usageDetails() {
  const u = USAGE;
  if (!u || !u.supported) return null;
  if (u.error) return h("div", { class: "usage-box err-text" }, u.error);
  if (u.plan === "premium") return h("div", { class: "usage-box" }, `Conta premium: ${u.premium_minutes} minutos de crédito.`);
  const pct = Math.min(100, Math.round((u.used_today / u.daily_limit) * 100));
  return h("div", { class: "usage-box" },
    h("b", {}, "Uso hoje (plano grátis)"),
    h("div", { class: "meter " + usageLevel(u) }, h("div", { style: `width:${pct}%` })),
    h("div", {}, `${u.used_today} de ${u.daily_limit} separações · sobram ${u.remaining} (≈ ${u.songs_left} músicas)`),
    h("div", { class: "hint" }, `Cada música gasta ${u.per_song > 1 ? "2 separações (voz + backing vocals)" : "1 separação; separar os backing vocals gasta mais 1"}. O limite zera às ${resetTime(u)}. Até ${u.max_minutes} min e ${u.max_mb} MB por música. Inclui o que você usar no site do MVSEP.`));
}

loadUsage();
setInterval(() => loadUsage(), 120000);

// ---------- Estado em tempo real ----------

watchState((s) => {
  STATE = s;
  BY_ID = Object.fromEntries(s.songs.map((x) => [x.id, x]));
  // Atualiza o uso quando alguma música termina (ou falha)
  const statuses = s.songs.map((x) => x.id + x.status).join();
  if (lastStatuses && statuses !== lastStatuses && s.songs.some((x) => x.status === "ready" || x.status === "error")) loadUsage(true);
  lastStatuses = statuses;
  $("session-url").textContent = s.session_url;
  const n = s.party.online;
  $("online-count").textContent = n === 1 ? "1 na festa" : `${n} na festa`;
  Fx.setFiles(s.fx.files);
  Fx.setSounds(s.fx.sounds);
  renderSoundBoard($("fx-sounds"), s.fx.sounds || []);
  Fx.setVolume(s.config.fx_volume ?? 0.7);
  renderAlert();
  renderHero();
  renderStageQueue();
  renderPreparing();
  renderLibrary();
}, (fx) => {
  Fx.play(fx.name);
  if (fx.name !== "stop") fxToast(`${fx.label || fx.name}${fx.by && fx.by !== "Alguém" ? " · " + fx.by : ""}`);
});

setupSearch($("search-form"), $("search-input"), $("results"), {
  queueLabel: "Pôr na fila",
  allowSave: true,
  onOpen: () => { $("results-panel").hidden = false; },
  onAdded: (queued) => toast(queued ? "Na fila! Ela aparece ali quando ficar pronta." : "Guardada no repertório."),
});
$("close-results").addEventListener("click", () => { $("results-panel").hidden = true; $("results").replaceChildren(); });

// ---------- Palco: próximo e fila ----------

const queue = () => STATE.party.queue || [];
const isReady = (e) => BY_ID[e.song_id] && BY_ID[e.song_id].status === "ready";

async function startEntry(e) {
  try {
    const entry = await api("/api/stage/start", { method: "POST", body: { entry_id: e.id } });
    location.href = `/play/${entry.song_id}?entry=${entry.id}`;
  } catch (err) { toast(err.message, true); }
}

async function singNow(song) {
  try {
    const entry = await api("/api/stage/start", { method: "POST", body: { song_id: song.id } });
    location.href = `/play/${song.id}?entry=${entry.id}`;
  } catch (err) { toast(err.message, true); }
}

async function removeEntry(e) {
  try { await api(`/api/stage/${e.id}`, { method: "DELETE" }); } catch (err) { toast(err.message, true); }
}

function renderHero() {
  const box = $("hero-content");
  const next = queue().find(isReady);
  if (!next) {
    const waiting = queue().length;
    box.replaceChildren(h("div", { class: "hero-empty" },
      h("h2", { class: "hero-label", id: "hero-label" }, "PRÓXIMO NO PALCO"),
      h("div", { class: "big" }, waiting ? "PREPARANDO A PRÓXIMA…" : "O PALCO TÁ VAZIO!"),
      h("p", { class: "sub", style: "font-size:17px;margin:0" }, waiting
        ? "Os pedidos da fila ainda estão sendo preparados. Enquanto isso, escolhe uma no repertório."
        : "Escaneia o QR e pede a sua, ou escolhe uma música no repertório e manda ver.")));
    return;
  }
  const s = BY_ID[next.song_id];
  box.replaceChildren(h("div", { class: "hero-body" },
    h("img", { class: "hero-cover", src: s.cover, alt: "" }),
    h("div", { class: "hero-info" },
      h("h2", { class: "hero-label", id: "hero-label" }, "PRÓXIMO NO PALCO"),
      h("div", { class: "hero-singer" }, avatar(next.singer, "lg"), h("span", { class: "who" }, next.singer.name.toUpperCase())),
      h("div", { class: "hero-song" }, s.title, " ", h("span", {}, `· ${s.artist}`)),
      h("div", { class: "chips" },
        h("span", { class: `status ${songStatus(s).tone} pill` }, songStatus(s).label),
        s.duration ? h("span", { class: "pill" }, fmtTime(s.duration)) : null,
        s.key ? h("span", { class: "pill" }, `Tom: ${s.key.note} ${s.key.scale === "Minor" ? "menor" : "maior"}`) : null,
        s.kind === "karaoke" ? h("span", { class: "pill" }, "Versão karaokê") : null),
      h("div", { class: "hero-actions" },
        h("button", { class: "btn big", onclick: () => startEntry(next) }, icon("play", 22), "SOLTAR O SOM"),
        h("button", { class: "btn ghost", onclick: () => api(`/api/stage/${next.id}/later`, { method: "POST" }).catch((e) => toast(e.message, true)) }, "Pular a vez"),
        h("button", { class: "btn ghost", onclick: () => removeEntry(next) }, "Tirar da fila")))));
}

function progressInfo(s) {
  if (!s) return h("span", { class: "prog" }, "Sumiu do repertório");
  if (s.status === "ready") return s.duration ? h("span", { class: "sub" }, fmtTime(s.duration)) : null;
  if (s.status === "error") return h("span", { class: "prog" }, "Deu ruim", h("button", { class: "btn sm ghost", onclick: () => retry(s) }, "De novo"));
  return h("span", { class: "prog" }, s.step || "Na fila", h("span", { class: "bar" }, h("div", { style: `width:${Math.round((s.progress || 0) * 100)}%` })));
}

function renderStageQueue() {
  const list = $("stage-queue");
  const items = queue();
  list.replaceChildren();
  const total = items.reduce((acc, e) => acc + ((BY_ID[e.song_id] && BY_ID[e.song_id].duration) || 0), 0);
  $("queue-eta").textContent = items.length ? `${items.length} ${items.length === 1 ? "pedido" : "pedidos"} · ~${Math.max(1, Math.round(total / 60))} min` : "";
  if (!items.length) {
    list.append(h("li", { class: "empty" }, "Ninguém pediu nada ainda. Bora?"));
    return;
  }
  items.forEach((e, i) => {
    const s = BY_ID[e.song_id];
    list.append(h("li", { class: "q-item" + (s && s.status === "error" ? " err" : "") },
      h("span", { class: "n" }, i + 1),
      avatar(e.singer),
      h("span", { class: "meta" }, h("span", { class: "t" }, s ? s.title : "?"), h("span", { class: "s" }, e.singer.name)),
      progressInfo(s),
      s && s.status === "ready" ? h("button", { class: "x", title: "Cantar agora", "aria-label": `Cantar agora: ${s.title}`, onclick: () => startEntry(e) }, icon("play", 16)) : null,
      h("button", { class: "x", title: "Tirar da fila", "aria-label": "Tirar da fila", onclick: () => removeEntry(e) }, icon("x", 16))));
  });
}

// Músicas sendo preparadas que não estão na fila de ninguém
function renderPreparing() {
  const inQueue = new Set(queue().map((e) => e.song_id));
  const songs = STATE.songs.filter((s) => s.status !== "ready" && !inQueue.has(s.id));
  $("preparing-wrap").hidden = !songs.length;
  $("preparing").replaceChildren(...songs.map((s) => h("li", { class: "q-item" + (s.status === "error" ? " err" : "") },
    h("span", { class: "meta" }, h("span", { class: "t" }, s.title), h("span", { class: "s", title: s.error || "" }, s.status === "error" ? s.error : s.artist)),
    progressInfo(s),
    h("button", { class: "x", title: "Cancelar", "aria-label": "Cancelar", onclick: () => api(`/api/songs/${s.id}`, { method: "DELETE" }).catch((e) => toast(e.message, true)) }, icon("x", 16)))));
}

async function retry(song) {
  try { await api(`/api/songs/${song.id}/retry`, { method: "POST" }); } catch (e) { toast(e.message, true); }
}

// ---------- Repertório ----------

let libFilter = "all";
$("lib-filter").addEventListener("input", renderLibrary);
document.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => {
  libFilter = b.dataset.filter;
  document.querySelectorAll("[data-filter]").forEach((x) => x.classList.toggle("on", x === b));
  renderLibrary();
}));

function renderLibrary() {
  const box = $("library");
  const q = $("lib-filter").value.trim().toLowerCase();
  const ready = STATE.songs.filter((s) => s.status === "ready").reverse();
  const fix = ready.filter((s) => songStatus(s).fix);
  const counts = { all: ready.length, ready: ready.length - fix.length, fix: fix.length };
  const labels = { all: "Todas", ready: "Prontas", fix: "Precisam de ajuste" };
  document.querySelectorAll("[data-filter]").forEach((b) => { b.textContent = `${labels[b.dataset.filter]} · ${counts[b.dataset.filter]}`; });
  $("ready-count").textContent = `Ativo · ${counts.all} ${counts.all === 1 ? "música pronta" : "músicas prontas"}`;
  const songs = ready
    .filter((s) => libFilter === "all" || (libFilter === "fix") === Boolean(songStatus(s).fix))
    .filter((s) => !q || `${s.artist} ${s.title}`.toLowerCase().includes(q));
  box.replaceChildren();
  if (!songs.length) {
    box.append(h("p", { class: "empty" }, q ? "Nenhuma música com esse nome." : ready.length ? "Nada aqui." : "O repertório está vazio. Busca uma música lá em cima!"));
    return;
  }
  for (const s of songs) {
    const st = songStatus(s);
    box.append(h("button", { class: "song-card", onclick: () => openSong(s), "aria-label": `${s.title}, ${s.artist}. ${st.label}` },
      h("span", { class: "art" }, h("img", { src: s.cover, alt: "", loading: "lazy" }), h("span", { class: "play" }, icon("play", 20))),
      h("span", { class: "t" }, s.title),
      h("span", { class: "a" }, s.artist),
      h("span", { class: `status ${st.tone}` }, st.label)));
  }
}

// ---------- Ficha da música ----------

function openSong(s) {
  const notes = [];
  if (s.key) notes.push(["", `Tom: ${s.key.note} ${s.key.scale === "Minor" ? "menor" : "maior"}`]);
  if (s.kind === "karaoke") notes.push(["", "Versão karaokê (o vídeo já era instrumental)."]);
  else if (!s.separated) notes.push(["warn", s.warning || "A voz original ainda está na música (não passou pela separação)."]);
  else notes.push(["", s.has_backing ? "Voz principal e backing vocals separados." : "Voz separada. Os backing vocals estão junto com a voz."]);
  if (s.backing_error) notes.push(["err", `Falhou ao separar os backing vocals: ${s.backing_error}`]);
  if (!s.has_lyrics) notes.push(["warn", "Sem letra. Escolhe uma em Trocar letra."]);
  else if (!s.lyrics_synced) notes.push(["warn", "A letra não tem tempos. No palco, use Acertar letra › Gravar sincronia."]);

  const close = () => $("song-dlg").close();
  const actions = [
    h("button", { class: "btn", onclick: () => singNow(s) }, icon("play", 18), "Cantar agora"),
    h("button", { class: "btn pink", onclick: async () => {
      try { await api("/api/stage", { method: "POST", body: { song_id: s.id } }); toast("Na fila!"); close(); } catch (e) { toast(e.message, true); }
    } }, icon("plus", 18), "Pôr na fila"),
    h("button", { class: "btn ghost", onclick: () => { close(); openLyrics(s); } }, icon("lyrics", 18), "Trocar letra"),
    h("button", { class: "btn ghost", onclick: () => { close(); openCover(s); } }, icon("image", 18), "Trocar capa"),
  ];
  if (s.kind !== "karaoke" && !s.separated) actions.push(h("button", { class: "btn ghost", onclick: () => { close(); separateNow(s); } }, icon("wand", 18), "Tirar a voz"));
  if (s.separated && !s.has_backing) actions.push(h("button", { class: "btn ghost", title: "Gasta mais 1 separação", onclick: () => { close(); separateBacking(s); } }, icon("wand", 18), "Separar backing vocals"));
  actions.push(h("button", { class: "btn danger", onclick: () => { close(); removeSong(s); } }, icon("trash", 18), "Apagar"));

  $("song-body").replaceChildren(
    h("div", { class: "song-sheet" },
      h("img", { src: s.cover, alt: "" }),
      h("div", { class: "meta" },
        h("div", { class: "t" }, s.title),
        h("div", { class: "sub", style: "font-size:16px" }, `${s.artist}${s.duration ? " · " + fmtTime(s.duration) : ""}`),
        h("span", { class: `status ${songStatus(s).tone}` }, songStatus(s).label),
        h("div", { class: "notes" }, ...notes.map(([tone, text]) => h("div", { class: `note ${tone}` }, text))))),
    h("div", { class: "sheet-actions" }, ...actions));
  $("song-dlg").showModal();
}

async function separateNow(s) {
  const p = STATE.providers.find((x) => x.name === STATE.config.provider);
  if (!p || p.name === "none" || p.problem) {
    toast("Escolha e configure um serviço de separação primeiro.", true);
    openSettings();
    return;
  }
  await retry(s);
}

async function separateBacking(s) {
  try {
    await api(`/api/songs/${s.id}/backing`, { method: "POST" });
    toast("Separando os backing vocals. A música volta para o repertório quando terminar.");
  } catch (e) { toast(e.message, true); }
}

async function removeSong(s) {
  if (!confirm(`Apagar "${s.title}" do repertório?`)) return;
  try { await api(`/api/songs/${s.id}`, { method: "DELETE" }); } catch (e) { toast(e.message, true); }
}

// ---------- Mesa de efeitos ----------

const fxKeys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
$("fx-pads").replaceChildren(...FX_PADS.map(([name, label, color], i) => h("button", { class: `pad ${color}`, onclick: () => fireFx(name) },
  h("span", {}, label), fxKeys[i] ? h("span", { class: "key" }, fxKeys[i]) : null)));
$("open-fx").addEventListener("click", () => { Fx.play(""); $("fx-dlg").showModal(); });

// ---------- Escolher letra ----------

let lyricsSong = null;

async function openLyrics(song, q = "") {
  lyricsSong = song;
  $("lyrics-song").textContent = song.title;
  show("lyrics");
  const list = $("lyrics-list");
  list.replaceChildren(h("p", { class: "empty" }, "Buscando letras no LRCLIB…"));
  let items = [];
  try { items = await api(`/api/songs/${song.id}/lyrics/search${q ? "?q=" + encodeURIComponent(q) : ""}`); }
  catch (e) { list.replaceChildren(h("p", { class: "empty" }, e.message)); return; }
  list.replaceChildren();
  if (!items.length) list.append(h("p", { class: "empty" }, "Nenhuma letra encontrada. Tente buscar com outro nome."));
  for (const it of items) {
    const use = h("button", { class: "btn sm", onclick: async () => {
      use.disabled = true;
      try {
        await api(`/api/songs/${song.id}/lyrics`, { method: "POST", body: { lrclib_id: it.id } });
        toast("Letra salva.");
        show("home");
      } catch (e) { toast(e.message, true); use.disabled = false; }
    } }, "Usar");
    list.append(h("div", { class: "pick" },
      h("div", { class: "meta" },
        h("div", { style: "font-weight:700" }, `${it.artist} - ${it.title}`),
        h("div", { class: "sub" }, [it.duration ? fmtTime(it.duration) : null, it.synced ? "sincronizada" : "sem sincronia", it.album].filter(Boolean).join(" · "))),
      use));
  }
}
$("paste-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!lyricsSong) return;
  try {
    const res = await api(`/api/songs/${lyricsSong.id}/lyrics/text`, { method: "POST", body: { text: $("paste-text").value } });
    $("paste-text").value = "";
    toast(res.synced ? "Letra salva." : "Letra salva. Acerte o tempo no palco com Acertar letra.");
    show("home");
  } catch (err) { toast(err.message, true); }
});
$("lyrics-form").addEventListener("submit", (e) => { e.preventDefault(); if (lyricsSong) openLyrics(lyricsSong, $("lyrics-q").value.trim()); });

// ---------- Escolher capa ----------

let coverSong = null;

async function openCover(song, q = "") {
  coverSong = song;
  $("cover-song").textContent = song.title;
  show("cover");
  const list = $("cover-list");
  list.replaceChildren(h("p", { class: "empty" }, "Buscando capas no iTunes…"));
  let urls = [];
  try { urls = await api(`/api/songs/${song.id}/covers${q ? "?q=" + encodeURIComponent(q) : ""}`); }
  catch (e) { list.replaceChildren(h("p", { class: "empty" }, e.message)); return; }
  list.replaceChildren();
  for (const url of urls) {
    list.append(h("img", { src: url, alt: "", loading: "lazy", class: url === song.cover ? "sel" : "", onclick: async () => {
      try {
        await api(`/api/songs/${song.id}/cover`, { method: "POST", body: { url } });
        show("home");
      } catch (e) { toast(e.message, true); }
    } }));
  }
}
$("cover-form").addEventListener("submit", (e) => { e.preventDefault(); if (coverSong) openCover(coverSong, $("cover-q").value.trim()); });

// ---------- Ajustes do anfitrião ----------

const PROVIDER_FIELDS = {
  mvsep: {
    help: 'Grátis com fila; pago por créditos. Token em <a href="https://mvsep.com/user-api" target="_blank">mvsep.com/user-api</a>.<br>Escolhe sozinho o melhor modelo que a sua conta permite (os melhores são só para premium; no plano grátis ele usa o próximo da lista).',
    fields: [
      ["mvsep_api_token", "Token da API", "password"],
    ],
  },
  musicai: {
    help: 'Pago. Crie a chave e um workflow de separação em <a href="https://music.ai/dashboard" target="_blank">music.ai/dashboard</a>. Se o workflow já separar voz principal e backing, o app usa.',
    fields: [
      ["musicai_api_key", "Chave da API", "password"],
      ["musicai_workflow", "Slug do workflow", "text"],
    ],
  },
  replicate: {
    help: 'Pago por segundo de GPU (centavos por música). Token em <a href="https://replicate.com/account/api-tokens" target="_blank">replicate.com/account/api-tokens</a>.',
    fields: [
      ["replicate_api_token", "Token da API", "password"],
      ["replicate_model", "Modelo de separação", "text"],
      ["replicate_karaoke_model", "Modelo de karaokê para principal/backing (opcional)", "text"],
    ],
  },
  local: {
    help: "Grátis e sem internet, mas lento neste notebook (~10 min por música).",
    fields: [
      ["local_model", "Modelo (audio-separator)", "text"],
      ["local_karaoke_model", "Modelo de karaokê (opcional)", "text"],
    ],
  },
};

const SECRET = new Set(["mvsep_api_token", "musicai_api_key", "replicate_api_token"]);

async function openSettings() {
  const { config: cfg, providers } = await api("/api/config");
  const body = $("settings-body");
  body.replaceChildren(
    h("div", { class: "dlg-section" }, "FESTA"),
    h("label", { class: "field" }, h("span", {}, "Seu nome na fila (quando você pede pelo notebook)"),
      h("input", { type: "text", id: "host-name", value: cfg.host_name || "", maxlength: "24" })),
    h("label", { class: "field" }, h("span", {}, "Volume dos efeitos sonoros"),
      h("input", { type: "range", id: "fx-volume", min: "0", max: "1", step: "0.05", value: cfg.fx_volume ?? 0.7 })),
    h("div", { class: "hint", style: "margin:-6px 0 4px" }, "Quer o som de verdade de algum efeito? Coloque um arquivo em data/fx com o nome dele (aplausos.mp3, buzina.mp3, errou.mp3…)."),
    h("label", { class: "field", style: "margin-top:12px" }, h("span", {}, "Atraso da caixa Bluetooth (segundos): a letra espera esse tempo"),
      h("input", { type: "number", id: "bt-delay", step: "0.05", min: "0", max: "2", value: cfg.bt_delay, style: "width:120px" })),
    h("div", { class: "dlg-section" }, "SEPARAÇÃO DE VOZ"),
  );
  for (const p of providers) {
    const meta = PROVIDER_FIELDS[p.name] || { fields: [], help: "" };
    const box = h("div", { class: "prov" + (cfg.provider === p.name ? " active" : "") },
      h("h4", {},
        h("input", { type: "radio", name: "provider", value: p.name, checked: cfg.provider === p.name, id: `prov-${p.name}` }),
        h("label", { for: `prov-${p.name}` }, p.label)),
      h("div", { class: p.problem ? "err-text" : "ok-text" }, p.problem || "Pronto para usar"));
    const help = h("div", { class: "hint" });
    help.innerHTML = meta.help;
    box.append(help);
    const fields = h("div", { class: "fields" });
    for (const [key, label, type] of meta.fields) {
      const isSet = SECRET.has(key) && cfg[key + "_set"];
      fields.append(h("label", { class: "small", style: "margin:0" }, label,
        h("input", { type, "data-key": key, value: SECRET.has(key) ? "" : (cfg[key] ?? ""), placeholder: isSet ? "•••••• (já salvo; deixe vazio para manter)" : "" })));
    }
    box.append(fields);
    if (p.name === "mvsep") {
      const details = usageDetails();
      if (details) box.append(details);
    }
    body.append(box);
  }
  body.append(
    h("label", { class: "check" }, h("input", { type: "checkbox", id: "split-backing", checked: cfg.split_backing }),
      "Separar backing vocals automaticamente em toda música (gasta 2 separações por música em vez de 1)"),
    h("div", { class: "hint", style: "margin:-4px 0 12px 26px" }, "Desligado, dá para separar só nas músicas que você quiser, na ficha da música."),
  );
  body.querySelectorAll("input[name=provider]").forEach((r) => r.addEventListener("change", () => {
    body.querySelectorAll(".prov").forEach((b) => b.classList.toggle("active", b.contains(r) && r.checked));
  }));
  $("fx-volume").addEventListener("input", (e) => Fx.setVolume(parseFloat(e.target.value)));
  $("fx-volume").addEventListener("change", () => Fx.play("aplausos"));
  $("settings").showModal();
}

$("open-settings").addEventListener("click", () => openSettings().catch((e) => toast(e.message, true)));

$("save-settings").addEventListener("click", async () => {
  const body = $("settings-body");
  const values = {
    provider: body.querySelector("input[name=provider]:checked")?.value,
    split_backing: $("split-backing").checked,
    bt_delay: parseFloat($("bt-delay").value) || 0,
    host_name: $("host-name").value.trim() || "Anfitrião",
    fx_volume: parseFloat($("fx-volume").value),
  };
  body.querySelectorAll("input[data-key]").forEach((i) => {
    const key = i.dataset.key;
    if (SECRET.has(key) && !i.value) return;
    values[key] = i.type === "number" ? parseInt(i.value, 10) : i.value.trim();
  });
  try {
    const res = await api("/api/config", { method: "POST", body: values });
    $("settings").close();
    loadUsage(true);
    const p = res.providers.find((x) => x.name === res.config.provider);
    toast(p && p.problem ? p.problem : "Ajustes salvos.", Boolean(p && p.problem));
  } catch (e) { toast(e.message, true); }
});
