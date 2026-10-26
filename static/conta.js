// Minha conta: entrar, comprar passe ou plano, começar o passe e ver os pagamentos.

const $ = (id) => document.getElementById(id);
fillIcons();

let DATA = null;
let authMode = "login";
const brl = (cents) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const when = (ts) => new Date(ts * 1000).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const day = (ts) => new Date(ts * 1000).toLocaleDateString("pt-BR", { day: "2-digit", month: "long" });

async function load() {
  DATA = await api("/api/account");
  render();
}

function render() {
  const acc = DATA.account;
  $("auth").hidden = !!acc;
  $("me").hidden = !acc;
  if (!acc) return;
  $("hello").textContent = `OLÁ, ${acc.name.split(" ")[0].toUpperCase()}`;
  renderAccess();
  renderPlans();
  renderProfile();
  renderOrders();
}

// ---------- Entrar / criar conta ----------

document.querySelectorAll("[data-auth]").forEach((b) => b.addEventListener("click", () => {
  authMode = b.dataset.auth;
  document.querySelectorAll("[data-auth]").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", x === b); });
  $("auth").classList.toggle("registering", authMode === "register");
  $("auth-form").password.autocomplete = authMode === "register" ? "new-password" : "current-password";
  $("auth-submit").textContent = authMode === "register" ? "CRIAR CONTA" : "ENTRAR";
  $("auth-error").textContent = "";
}));

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { email: f.email.value, password: f.password.value };
  if (authMode === "register") Object.assign(body, { name: f.name.value, phone: f.phone.value });
  $("auth-error").textContent = "";
  try {
    await api(`/api/account/${authMode}`, { method: "POST", body });
    await load();
    afterLogin();
  } catch (err) { $("auth-error").textContent = err.message; }
});

$("logout").addEventListener("click", async () => {
  await api("/api/account/logout", { method: "POST" });
  await load();
});

// Veio do telão para entrar: volta para ele assim que a conta estiver pronta
function afterLogin() {
  const back = new URLSearchParams(location.search).get("voltar");
  if (back === "telao" && DATA.access && (DATA.access.active || DATA.access.unused_passes.length)) location.href = "/";
}

// ---------- Acesso atual ----------

function renderAccess() {
  const a = DATA.access;
  const box = h("div", { class: "access-box" });
  if (!DATA.billing) box.append(h("p", { class: "sub" }, "A cobrança está desligada neste servidor: o Palco está liberado."));
  if (a.active) {
    box.append(h("div", { class: "big" }, a.name), h("div", { class: "sub" }, a.source === "pass" ? `Festa liberada até ${when(a.until)}` : `Vale até ${day(a.until)}`));
    if (a.limits.songs !== null) {
      box.append(h("div", {}, `${a.songs_used} de ${a.limits.songs} músicas novas usadas`),
        h("div", { class: "meter" }, h("div", { style: `width:${Math.min(100, (a.songs_used / a.limits.songs) * 100)}%` })));
    }
  } else {
    box.append(h("div", { class: "big" }, a.unused_passes.length ? "Passe guardado" : "Nenhum plano ativo"),
      h("div", { class: "sub" }, a.unused_passes.length ? "Quando a festa for começar, aperte o botão abaixo." : "Escolha um passe ou plano aqui embaixo para liberar o telão."));
  }
  const actions = h("div", { class: "actions" });
  if (a.unused_passes.length) {
    const p = a.unused_passes[0];
    const more = a.unused_passes.length > 1 ? ` (você tem ${a.unused_passes.length})` : "";
    actions.append(h("button", { class: "btn pink", onclick: startPass }, `Começar a festa agora: ${p.hours}h${more}`));
  }
  const sub = a.subscription;
  if (sub && sub.status === "active") {
    box.append(h("div", { class: "sub" }, `Assinatura ${sub.name} ativa, renova todo mês.`));
    actions.append(h("button", { class: "btn ghost sm", onclick: openPortal }, "Pagamentos e cartão"));
    actions.append(cancelButton());
  } else if (sub && sub.status === "cancelled" && sub.until * 1000 > Date.now()) {
    box.append(h("div", { class: "sub" }, `Assinatura ${sub.name} cancelada: continua valendo até ${day(sub.until)}.`));
  }
  if (actions.children.length) box.append(actions);
  $("access").replaceChildren(box);
}

async function startPass() {
  try {
    DATA.access = await api("/api/billing/pass/start", { method: "POST" });
    toast(`Festa liberada até ${when(DATA.access.until)}!`);
    render();
  } catch (e) { toast(e.message, true); }
}

// Dois toques para cancelar (sem confirm() do navegador, que trava o controle remoto da TV)
function cancelButton() {
  const b = h("button", { class: "btn danger sm" }, "Cancelar assinatura");
  b.addEventListener("click", async () => {
    if (!b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "Toque de novo para cancelar"; return; }
    try {
      DATA.access = await api("/api/billing/cancel", { method: "POST" });
      toast("Assinatura cancelada. Ela vale até o fim do mês pago.");
      render();
    } catch (e) { toast(e.message, true); }
  });
  return b;
}

async function openPortal() {
  try { location.href = (await api("/api/billing/portal")).url; } catch (e) { toast(e.message, true); }
}

// ---------- Passes e planos ----------

function features(p) {
  const l = p.limits;
  return [
    p.kind === "pass" ? `${p.hours} horas de festa a partir de quando você começar` : null,
    l.songs === null ? "Músicas novas sem limite" : `${l.songs} músicas novas por mês`,
    "Músicas que já estão no repertório não contam",
    l.guests === null ? "Convidados sem limite" : `Até ${l.guests} celulares na festa`,
    l.dance ? "Modo dança com nota pela câmera" : null,
    l.screens > 1 ? `Até ${l.screens} telões ao mesmo tempo` : null,
    "Fila pelo celular, votação, duelo e mesa de efeitos",
  ].filter(Boolean);
}

function planCard(p) {
  const a = DATA.access;
  const isCurrent = p.kind === "monthly" && a.subscription && a.subscription.status === "active" && a.subscription.plan === p.id;
  const card = h("div", { class: `plan${p.featured ? " featured" : ""}` },
    p.featured ? h("span", { class: "ribbon" }, "MAIS ESCOLHIDO") : null,
    h("div", { class: "pname" }, p.name),
    h("div", { class: "sub" }, p.pitch),
    h("div", { class: "price" }, brl(p.price), p.kind === "monthly" ? h("small", {}, " /mês") : h("small", {}, " por festa")),
    h("ul", {}, features(p).map((f) => h("li", {}, f))));
  if (isCurrent) card.append(h("div", { class: "current" }, "Seu plano atual"));
  else {
    const label = p.kind === "monthly" ? (a.subscription && a.subscription.status === "active" ? "Trocar para este" : "Assinar") : "Comprar passe";
    card.append(h("button", { class: p.featured ? "btn" : "btn ghost", onclick: (e) => buy(p.id, e.currentTarget) }, label));
  }
  return card;
}

function renderPlans() {
  $("passes").replaceChildren(...DATA.plans.filter((p) => p.kind === "pass").map(planCard));
  $("monthly").replaceChildren(...DATA.plans.filter((p) => p.kind === "monthly").map(planCard));
  const pick = $("broker");
  $("broker-pick").hidden = DATA.brokers.length < 2;
  if (pick.options.length !== DATA.brokers.length) {
    pick.replaceChildren(...DATA.brokers.map((b) => h("option", { value: b.name }, b.label)));
  }
}

async function buy(plan, btn) {
  if (!DATA.brokers.length) { toast("O servidor ainda não tem forma de pagamento configurada.", true); return; }
  btn.disabled = true;
  btn.textContent = "Abrindo o pagamento...";
  try {
    const r = await api("/api/billing/checkout", { method: "POST", body: { plan, provider: $("broker").value || undefined } });
    location.href = r.url;
  } catch (e) {
    toast(e.message, true);
    renderPlans();
  }
}

// ---------- Dados e pagamentos ----------

function renderProfile() {
  const f = $("profile");
  if (document.activeElement && f.contains(document.activeElement)) return;
  f.name.value = DATA.account.name;
  f.phone.value = DATA.account.phone || "";
  f.tax_id.placeholder = DATA.account.tax_id_set ? "Já informado (digite para trocar)" : "Só números";
  $("tax-hint").textContent = DATA.brokers.some((b) => b.name === "asaas") ? "(o Asaas pede)" : "";
}

$("profile").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { name: f.name.value, phone: f.phone.value };
  if (f.tax_id.value.trim()) body.tax_id = f.tax_id.value;
  try {
    DATA.account = await api("/api/account", { method: "PATCH", body });
    f.tax_id.value = "";
    toast("Dados salvos.");
    render();
  } catch (err) { toast(err.message, true); }
});

const STATUS = { paid: "Pago", pending: "Aguardando pagamento", refunded: "Estornado" };

function renderOrders() {
  $("orders-card").hidden = !DATA.orders.length;
  const names = Object.fromEntries(DATA.plans.map((p) => [p.id, p.name]));
  const brokers = Object.fromEntries(DATA.brokers.map((b) => [b.name, b.label]));
  $("orders").replaceChildren(...DATA.orders.map((o) => h("div", { class: "order" },
    h("span", {}, `${names[o.plan] || o.plan} · ${brl(o.price)}`, h("span", { class: "hint" }, ` ${when(o.created)} · ${brokers[o.provider] || o.provider}`)),
    h("b", { class: `st-${o.status}` }, STATUS[o.status] || o.status))));
}

// ---------- Voltando do checkout ----------

async function waitPayment(orderId) {
  const box = $("paying");
  box.hidden = false;
  box.replaceChildren(h("div", { class: "spinner" }), h("div", {}, h("b", {}, "Confirmando o pagamento..."), h("div", { class: "sub" }, "PIX costuma cair em segundos.")));
  for (let i = 0; i < 60; i++) {
    let o = null;
    try { o = await api(`/api/billing/orders/${encodeURIComponent(orderId)}`); } catch (e) { break; }
    if (o.status === "paid") {
      DATA.access = o.access;
      const isPass = DATA.plans.find((p) => p.id === o.plan)?.kind === "pass";
      box.replaceChildren(h("div", {},
        h("b", {}, "Pagamento confirmado!"),
        h("div", { class: "sub" }, isPass ? "Seu passe está guardado. Aperte Começar a festa agora quando a festa for começar." : "Seu plano está ativo. É só voltar para o telão."),
        h("div", { style: "margin-top:10px" }, h("a", { class: "btn sm", href: "/" }, "Ir para o telão"))));
      history.replaceState(null, "", "/conta");
      await load();
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  box.replaceChildren(h("div", {}, h("b", {}, "O pagamento ainda não caiu."),
    h("div", { class: "sub" }, "Assim que o pagamento for confirmado, o plano aparece aqui sozinho. Pode fechar esta página.")));
}

load().then(() => {
  const pedido = new URLSearchParams(location.search).get("pedido");
  if (pedido && DATA.account) waitPayment(pedido);
}).catch((e) => toast(e.message, true));
