// Tela principal no notebook: busca, fila, biblioteca, letra, capa e configurações.

let STATE = { songs: [], config: {}, providers: [] };
const $ = (id) => document.getElementById(id);

// ---------- Navegação entre telas ----------

function show(view) {
  for (const v of ["home", "lyrics", "cover"]) $(`view-${v}`).hidden = v !== view;
  window.scrollTo(0, 0);
}
document.querySelectorAll("[data-back]").forEach((a) => a.addEventListener("click", () => show("home")));

// ---------- Estado em tempo real ----------

// ---------- Uso do serviço (limite diário do MVSEP grátis) ----------

let USAGE = null;
let lastStatuses = "";

async function loadUsage(force = false) {
  try { USAGE = await api(`/api/usage${force ? "?force=true" : ""}`); } catch (e) { USAGE = null; }
  renderUsage();
}

function usageLevel(u) {
  if (u.remaining < u.per_song) return "out";
  if (u.remaining <= 10) return "warn";
  return "";
}

function resetTime(u) {
  return new Date(u.resets_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function renderUsage() {
  const chip = $("usage");
  const u = USAGE;
  if (!u || !u.supported || u.error) {
    chip.hidden = !(u && u.supported && u.error);
    if (!chip.hidden) { chip.textContent = "MVSEP: uso indisponível"; chip.title = u.error; chip.className = "usage-chip"; }
    return;
  }
  chip.hidden = false;
  if (u.plan === "premium") {
    chip.textContent = `MVSEP premium: ${u.premium_minutes} min`;
    chip.className = "usage-chip";
    chip.title = "Créditos premium restantes (1 crédito = 1 minuto de música por separação).";
    return;
  }
  chip.className = "usage-chip " + usageLevel(u);
  chip.textContent = `MVSEP hoje: ${u.used_today}/${u.daily_limit} · ~${u.songs_left} músicas`;
  chip.title = `Plano grátis: ${u.daily_limit} separações por dia. Cada música gasta ${u.per_song}${u.per_song === 1 ? " (+1 se separar os backing vocals)" : ""}. Zera às ${resetTime(u)}.`;
}

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

$("usage").addEventListener("click", () => openSettings().catch((e) => toast(e.message, true)));
loadUsage();
setInterval(() => loadUsage(), 120000);

watchState((s) => {
  STATE = s;
  // Atualiza o uso quando alguma música termina (ou falha)
  const statuses = s.songs.map((x) => x.id + x.status).join();
  if (lastStatuses && statuses !== lastStatuses && s.songs.some((x) => x.status === "ready" || x.status === "error")) loadUsage(true);
  lastStatuses = statuses;
  $("session-url").textContent = s.session_url;
  renderProviderSelect();
  const pending = s.songs.filter((x) => x.status !== "ready");
  $("queue-section").hidden = !pending.length;
  renderQueue($("queue"), pending, () => true, retry);
  renderLibrary();
});

async function retry(song) {
  try { await api(`/api/songs/${song.id}/retry`, { method: "POST" }); } catch (e) { toast(e.message, true); }
}

setupSearch($("search-form"), $("search-input"), $("results"));

// ---------- Biblioteca ----------

$("lib-filter").addEventListener("input", renderLibrary);

function renderLibrary() {
  const box = $("library");
  const q = $("lib-filter").value.trim().toLowerCase();
  const songs = STATE.songs
    .filter((s) => s.status === "ready")
    .filter((s) => !q || `${s.artist} ${s.title}`.toLowerCase().includes(q))
    .reverse();
  box.replaceChildren();
  if (!songs.length) {
    box.append(h("p", { class: "empty" }, q ? "Nenhuma música com esse nome." : "Nenhuma música processada ainda."));
    return;
  }
  for (const s of songs) {
    const play = () => { location.href = `/play/${s.id}`; };
    box.append(h("div", { class: "lib-item" },
      h("div", { class: "body", onclick: play, title: "Tocar" },
        h("img", { src: s.cover, alt: "" }),
        h("div", { class: "meta" },
          h("div", { class: "title" }, `${s.artist} - ${s.title}`),
          h("div", { class: "badges" },
            h("span", { class: "sub" }, s.artist),
            s.key ? h("span", { class: "badge" }, `${s.key.note} ${s.key.scale}`) : null,
            s.kind === "karaoke" ? h("span", { class: "badge info" }, "versão karaokê") : null,
            s.kind !== "karaoke" && !s.separated ? h("span", { class: "badge info", title: s.warning || "" }, "sem separação") : null,
            s.kind !== "karaoke" && !s.separated ? h("button", { class: "badge-btn", title: "Processar de novo tirando a voz", onclick: (e) => { e.stopPropagation(); separateNow(s); } }, "Separar voz") : null,
            s.separated && !s.has_backing ? h("button", { class: "badge-btn", title: "Separa a voz principal dos backing vocals (gasta mais 1 separação)", onclick: (e) => { e.stopPropagation(); separateBacking(s); } }, "Separar backing") : null,
            s.backing_error ? h("span", { class: "badge warn", title: s.backing_error }, "falha no backing") : null,
            !s.has_lyrics ? h("span", { class: "badge warn" }, "sem letra") : null,
            s.has_lyrics && !s.lyrics_synced ? h("span", { class: "badge warn" }, "letra sem sincronia") : null))),
      h("button", { class: "act", title: "Tocar", onclick: play }, "▶"),
      h("button", { class: "act", title: "Trocar a letra", onclick: () => openLyrics(s) }, "🎤"),
      h("button", { class: "act", title: "Trocar a capa", onclick: () => openCover(s) }, "🖼️"),
      h("button", { class: "act", title: "Apagar", onclick: () => removeSong(s) }, "🗑️")));
  }
}

async function separateNow(s) {
  const p = STATE.providers.find((x) => x.name === STATE.config.provider);
  if (!p || p.name === "none" || p.problem) {
    toast("Escolha e configure um serviço de separação primeiro (⚙).", true);
    openSettings();
    return;
  }
  await retry(s);
}

async function separateBacking(s) {
  try {
    await api(`/api/songs/${s.id}/backing`, { method: "POST" });
    toast("Separando os backing vocals. A música volta para a biblioteca quando terminar.");
  } catch (e) { toast(e.message, true); }
}

async function removeSong(s) {
  if (!confirm(`Apagar "${s.title}" da biblioteca?`)) return;
  try { await api(`/api/songs/${s.id}`, { method: "DELETE" }); } catch (e) { toast(e.message, true); }
}

// ---------- Escolher letra ----------

let lyricsSong = null;

async function openLyrics(song, q = "") {
  lyricsSong = song;
  $("lyrics-song").textContent = song.title;
  show("lyrics");
  const list = $("lyrics-list");
  list.replaceChildren(h("p", { class: "empty" }, "Buscando letras no LRCLIB..."));
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
        h("div", { class: "title" }, `${it.artist} - ${it.title}`),
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
    toast(res.synced ? "Letra salva." : "Letra salva. Sincronize no player com Gravar sincronia.");
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
  list.replaceChildren(h("p", { class: "empty" }, "Buscando capas no iTunes..."));
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

// ---------- Provedor de separação ----------

function renderProviderSelect() {
  const sel = $("provider");
  if (document.activeElement === sel) return;
  sel.replaceChildren(...STATE.providers.map((p) =>
    h("option", { value: p.name, selected: p.name === STATE.config.provider }, p.label + (p.problem ? " (configurar)" : ""))));
}

$("provider").addEventListener("change", async (e) => {
  const name = e.target.value;
  const p = STATE.providers.find((x) => x.name === name);
  try {
    await api("/api/config", { method: "POST", body: { provider: name } });
    if (p && p.problem) { toast(p.problem, true); openSettings(); }
    else toast(`Separação agora com ${p ? p.label : name}.`);
    loadUsage(true);
  } catch (err) { toast(err.message, true); }
});

// ---------- Configurações ----------

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
  body.replaceChildren();
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
    h("div", { class: "hint", style: "margin:-4px 0 12px 26px" }, "Desligado, dá para separar só nas músicas que você quiser, pelo botão Separar backing."),
    h("label", { class: "small" }, "Atraso da caixa Bluetooth (segundos) — a letra espera esse tempo",
      h("input", { type: "number", id: "bt-delay", step: "0.05", min: "0", max: "2", value: cfg.bt_delay, style: "width:120px;display:block;margin-top:6px" })),
  );
  body.querySelectorAll("input[name=provider]").forEach((r) => r.addEventListener("change", () => {
    body.querySelectorAll(".prov").forEach((b) => b.classList.toggle("active", b.contains(r) && r.checked));
  }));
  $("settings").showModal();
}

$("open-settings").addEventListener("click", () => openSettings().catch((e) => toast(e.message, true)));
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => $("settings").close()));

$("save-settings").addEventListener("click", async () => {
  const body = $("settings-body");
  const values = {
    provider: body.querySelector("input[name=provider]:checked")?.value,
    split_backing: $("split-backing").checked,
    bt_delay: parseFloat($("bt-delay").value) || 0,
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
    toast(p && p.problem ? p.problem : "Configurações salvas.", Boolean(p && p.problem));
  } catch (e) { toast(e.message, true); }
});
