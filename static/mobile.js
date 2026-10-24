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

let firstState = true;
watchState((s) => {
  STATE = s;
  BY_ID = Object.fromEntries(s.songs.map((x) => [x.id, x]));
  const me = s.party.me;
  if (firstState && !me) askName();
  firstState = false;
  $("me-chip").replaceChildren(avatar(me || { name: "?", color: "#B9ADD1" }), me ? me.name : "Entrar");
  $("queue-count").textContent = s.party.queue.length || "";
  renderNow();
  renderMyTurn();
  renderQueue();
  renderLibrary();
  renderSoundBoard($("sounds"), s.fx, { preview: true });
});

const mine = (e) => e.client === CLIENT;

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
  const head = h("div", { class: "head" }, avatar(e.singer),
    h("div", {}, h("div", { class: "k" }, live ? "No palco agora" : "Acabou de cantar"),
      h("div", { class: "who" }, `${e.singer.name}${s ? " · " + s.title : ""}`)));
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
      `${s ? s.title : ""}${st.busy ? ` · tá ficando pronta (${Math.round((s.progress || 0) * 100)}%)` : st.tone === "err" ? " · deu ruim no preparo" : ""}`));
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
      avatar(e.singer),
      h("span", { class: "meta" }, h("span", { class: "t" }, s ? s.title : "?"), h("span", { class: "s" }, `${e.singer.name}${st.busy || st.tone === "err" ? " · " + st.label : ""}`)),
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
      h("button", { class: "x", "aria-label": `Cantar ${s.title}`, title: "Entrar na fila com essa", onclick: async () => {
        try { await api("/api/stage", { method: "POST", body: { song_id: s.id } }); toast("Pedido feito!"); } catch (err) { toast(err.message, true); }
      } }, icon("plus", 18))));
  }
}

// ---------- Efeitos ----------

// Vibra de leve ao disparar um som (o botão de ouvir não dispara nada no telão)
document.addEventListener("click", (e) => {
  if (e.target.closest && e.target.closest(".pad.snd") && navigator.vibrate) navigator.vibrate(20);
});

