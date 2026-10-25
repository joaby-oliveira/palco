// Celular: entra com o nome, pede música, acompanha a fila, vota e toca efeitos no telão.

const $ = (id) => document.getElementById(id);
let STATE = null;
let BY_ID = {};
fillIcons();

// ---------- Nome ----------

function askName() {
  $("onboard").hidden = false;
  $("name-input").value = (STATE && STATE.party.me && STATE.party.me.name) || "";
  $("name-input").focus();
}
$("name-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/me", { method: "POST", body: { name: $("name-input").value } });
    $("onboard").hidden = true;
  } catch (err) { toast(err.message, true); }
});
$("me-chip").addEventListener("click", askName);

// ---------- Abas ----------

function showTab(name) {
  for (const t of ["pedir", "fila", "efeitos"]) $(`tab-${t}`).hidden = t !== name;
  document.querySelectorAll("[data-tab]").forEach((b) => {
    b.classList.toggle("on", b.dataset.tab === name);
    if (b.dataset.tab === name) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  window.scrollTo(0, 0);
}
document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ---------- Estado ----------

// ---------- Sala ----------

$("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if ($("join-input").value.trim()) joinRoom($("join-input").value);
});

let firstState = true;
watchState((s) => {
  STATE = s;
  BY_ID = Object.fromEntries(s.songs.map((x) => [x.id, x]));
  // Sem sala (ou a festa acabou): pede o código do telão
  $("join").hidden = Boolean(s.room);
  if (!s.room) {
    if (ROOM && ROOM.id) $("join-hint").textContent = `A festa ${ROOM.id} não existe mais. Confere o código no telão ou aponta a câmera para o QR.`;
    return;
  }
  $("room-code").textContent = s.room.id;
  const me = s.party.me;
  if (firstState && !me) askName();
  firstState = false;
  $("me-chip").replaceChildren(avatar(me || { name: "?", color: "#B9ADD1" }), me ? me.name : "Entrar");
  $("queue-count").textContent = s.party.queue.length || "";
  renderNow();
  renderMyTurn();
  renderQueue();
  renderLibrary();
  if (!$("challenge").hidden) renderChallenge();
  renderSoundBoard($("sounds"), s.fx, { preview: true });
});

// Pedido meu: eu canto, sozinho ou num duelo
const mine = (e) => e.client === CLIENT || Boolean(e.duel && e.duel.client === CLIENT);

// ---------- Agora no palco + voto ----------

const VOTES = [[20, "Desafinou"], [40, "Ok"], [60, "Bom"], [80, "Mandou bem"], [100, "Bis!"]];

function renderNow() {
  const p = STATE.party;
  const e = p.current || p.last;
  const box = $("now");
  if (!e) { box.hidden = true; return; }
  const s = BY_ID[e.song_id];
  const live = Boolean(p.current);
  box.hidden = false;
  const head = h("div", { class: "head" }, entryAvatars(e),
    h("div", {}, h("div", { class: "k" }, e.rival ? (live ? "Duelo no palco" : "Acabou o duelo") : live ? "No palco agora" : "Acabou de cantar"),
      h("div", { class: "who" }, `${entryName(e)}${s ? " · " + s.title : ""}`)));
  if (e.rival) { box.replaceChildren(head, ...duelVote(e, live)); return; }
  if (mine(e) || (!live && !p.last_votable)) {
    if (!mine(e)) { box.replaceChildren(head, h("div", { class: "sub" }, e.score == null ? "Ninguém votou dessa vez." : `A galera deu ${e.score}.`)); return; }
    box.replaceChildren(head, h("div", { class: "sub" }, live ? "É você! Solta a voz." : `A galera te deu ${e.score ?? "—"}${e.vote_count ? ` (${e.vote_count} votos)` : ""}.`));
    return;
  }
  box.replaceChildren(head,
    h("div", { class: "sub" }, p.my_vote == null ? "Dá a sua nota:" : "Valeu! Dá para mudar o voto."),
    h("div", { class: "votes" }, ...VOTES.map(([score, label]) => h("button", {
      class: p.my_vote === score ? "on" : "",
      "aria-pressed": p.my_vote === score,
      onclick: () => api("/api/vote", { method: "POST", body: { score } }).catch((err) => toast(err.message, true)),
    }, label))));
}

function duelVote(e, live) {
  const p = STATE.party;
  const { a, b } = e.duel;
  const c = duelColors(e);
  if (mine(e) || (!live && !p.last_votable)) {
    const win = a === b ? null : a > b ? e.singer : e.rival;
    const result = !a && !b ? "Ninguém votou dessa vez." : win ? `${win.name} venceu: ${Math.max(a, b)} × ${Math.min(a, b)}.` : `Empate: ${a} × ${b}.`;
    return [h("div", { class: "sub" }, live ? "É duelo! Canta a sua parte (na sua cor) e capricha." : result)];
  }
  return [
    h("div", { class: "sub" }, p.my_vote == null ? "Quem está mandando melhor?" : "Valeu! Dá para mudar o voto até o fim."),
    h("div", { class: "duel-votes" }, ...[["a", e.singer, c.a, a], ["b", e.rival, c.b, b]].map(([pick, who, color, n]) => h("button", {
      class: p.my_vote === pick ? "on" : "", style: `--c:${color}`, "aria-pressed": p.my_vote === pick,
      onclick: () => api("/api/vote", { method: "POST", body: { pick } }).catch((err) => toast(err.message, true)),
    }, avatar(who), h("span", { class: "nm" }, who.name), h("span", { class: "n" }, n)))),
  ];
}

function renderMyTurn() {
  const q = STATE.party.queue;
  const i = q.findIndex(mine);
  const box = $("my-turn");
  if (i < 0) { box.hidden = true; return; }
  const s = BY_ID[q[i].song_id];
  const st = s ? songStatus(s) : { label: "" };
  box.hidden = false;
  box.replaceChildren(h("span", { class: "pos" }, `${i + 1}º`),
    h("span", {}, h("b", {}, i === 0 ? "Você é o próximo!" : `Você é o ${i + 1}º da fila`),
      `${q[i].rival ? `Duelo ${entryName(q[i])} · ` : ""}${s ? s.title : ""}${st.busy ? ` · tá ficando pronta (${Math.round((s.progress || 0) * 100)}%)` : st.tone === "err" ? " · deu ruim no preparo" : ""}`));
}

// ---------- Fila ----------

function renderQueue() {
  const list = $("queue");
  const p = STATE.party;
  list.replaceChildren();
  if (!p.queue.length) { list.append(h("li", { class: "empty" }, "Fila vazia. Pede a sua na aba Pedir!")); return; }
  p.queue.forEach((e, i) => {
    const s = BY_ID[e.song_id];
    const st = s ? songStatus(s) : { tone: "err", label: "Sumiu" };
    list.append(h("li", { class: "q-item" + (mine(e) ? " mine" : "") },
      h("span", { class: "n" }, i + 1),
      entryAvatars(e),
      h("span", { class: "meta" }, h("span", { class: "t" }, s ? s.title : "?"), h("span", { class: "s" }, `${e.rival ? "Duelo: " : ""}${entryName(e)}${st.busy || st.tone === "err" ? " · " + st.label : ""}`)),
      mine(e) ? h("button", { class: "x", "aria-label": "Tirar meu pedido", title: "Tirar meu pedido", onclick: () => api(`/api/stage/${e.id}`, { method: "DELETE" }).catch((err) => toast(err.message, true)) }, icon("x", 16)) : null));
  });
}

// ---------- Pedir ----------

setupSearch($("search-form"), $("search-input"), $("results"), {
  queueLabel: "Pedir",
  onAdded: () => toast("Pedido feito! Acompanha na aba Fila."),
});

$("lib-filter").addEventListener("input", renderLibrary);

function renderLibrary() {
  const q = $("lib-filter").value.trim().toLowerCase();
  const songs = STATE.songs.filter((s) => s.status === "ready" && (!q || `${s.artist} ${s.title}`.toLowerCase().includes(q))).reverse();
  const box = $("library");
  box.replaceChildren();
  if (!songs.length) { box.append(h("li", { class: "empty" }, q ? "Nenhuma com esse nome." : "Nenhuma música pronta ainda. Busca uma aí em cima!")); return; }
  for (const s of songs) {
    box.append(h("li", { class: "q-item lib-row" },
      h("img", { src: s.cover, alt: "", loading: "lazy" }),
      h("span", { class: "meta" }, h("span", { class: "t" }, s.title), h("span", { class: "s" }, s.artist)),
      s.kind !== "dance" && s.has_lyrics ? h("button", { class: "x", "aria-label": `Duelar com ${s.title}`, title: "Desafiar alguém para um duelo", onclick: () => openChallenge(s) }, icon("duel", 18)) : null,
      h("button", { class: "x", "aria-label": `Cantar ${s.title}`, title: "Entrar na fila com essa", onclick: async () => {
        try { await api("/api/stage", { method: "POST", body: { song_id: s.id } }); toast("Pedido feito!"); } catch (err) { toast(err.message, true); }
      } }, icon("plus", 18))));
  }
}

// ---------- Duelo: desafiar alguém ----------

let challengeSong = null;

function openChallenge(s) {
  if (!STATE.party.me) { askName(); return; }
  challengeSong = s;
  $("challenge-song").textContent = `${s.title} · ${s.artist}${s.duel === "manual" ? " · pronta para duelo" : ""}`;
  renderChallenge();
  $("challenge").hidden = false;
}

function renderChallenge() {
  const people = (STATE.party.people || []).filter((p) => p.client !== CLIENT);
  const list = $("challenge-people");
  list.replaceChildren();
  if (!people.length) { list.append(h("li", { class: "empty" }, "Ninguém mais na festa ainda. Chama a galera!")); return; }
  for (const p of people) {
    list.append(h("li", {}, h("button", { class: "q-item person", type: "button", onclick: async () => {
      try {
        await api("/api/stage", { method: "POST", body: { song_id: challengeSong.id, rival: p.client } });
        $("challenge").hidden = true;
        toast(`Duelo contra ${p.name} na fila!`);
      } catch (err) { toast(err.message, true); }
    } }, avatar(p), h("span", { class: "meta" }, h("span", { class: "t" }, p.name), p.host ? h("span", { class: "s" }, "Anfitrião") : null))));
  }
}
$("challenge-close").addEventListener("click", () => { $("challenge").hidden = true; });
$("challenge").addEventListener("click", (e) => { if (e.target === $("challenge")) $("challenge").hidden = true; });

// ---------- Efeitos ----------

// Vibra de leve ao disparar um som (o botão de ouvir não dispara nada no telão)
document.addEventListener("click", (e) => {
  if (e.target.closest && e.target.closest(".pad.snd") && navigator.vibrate) navigator.vibrate(20);
});

