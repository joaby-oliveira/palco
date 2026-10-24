// Navegação pelo controle remoto da TV: as setas levam o foco para o botão mais
// próximo naquela direção, OK (Enter) aperta, Voltar fecha o que estiver aberto.
// As páginas tratam as próprias teclas antes (no document); este módulo escuta no
// window e ignora o que a página já tratou com preventDefault.

const TvNav = (() => {
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]):not([type=file]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const DIRS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Up: "up", Down: "down", Left: "left", Right: "right" };
  const KEYCODE_DIRS = { 37: "left", 38: "up", 39: "right", 40: "down" };
  // Voltar: webOS (461), Tizen (10009) e o "Voltar" do navegador (166)
  const BACK_CODES = new Set([461, 10009, 166]);
  const TEXT = "input:not([type]), input[type=text], input[type=search], input[type=password], input[type=number], input[type=email], input[type=url], textarea";
  const root = document.documentElement;
  let last = null;    // { el, x, y }: o último foco e onde ele estava na tela
  let outside = null; // o mesmo, fora dos diálogos (para onde voltar quando um fecha)

  const api = {
    scroll: "nearest",  // "center" nas páginas que rolam (o telão)
    onBack: null,       // () => true quando a página tratou o Voltar
  };

  // ---------- Modo controle remoto ----------
  // O contorno de foco só aparece quando a pessoa usa teclas; o mouse esconde

  function keyMode() { root.classList.add("kbd-nav"); }
  document.addEventListener("pointerdown", (e) => { if (e.pointerType === "mouse") root.classList.remove("kbd-nav"); }, true);
  document.addEventListener("mousemove", (e) => { if (e.movementX || e.movementY) root.classList.remove("kbd-nav"); }, true);

  // ---------- O que dá para focar ----------

  function scope() {
    let dlg = null;
    try { dlg = document.querySelector("dialog:modal"); } catch (e) { dlg = document.querySelector("dialog[open]"); }
    return dlg || document;
  }

  function visible(el) {
    if (!el.getClientRects().length) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.pointerEvents === "none" || el.closest("[inert]")) return false;
    // Dentro de uma caixa que não rola (a letra no palco), só vale o que aparece nela
    const box = el.closest("[data-tv-noscroll]");
    if (box) {
      const b = box.getBoundingClientRect(), c = center(r);
      return c.y > b.top && c.y < b.bottom && c.x > b.left && c.x < b.right;
    }
    return true;
  }

  function candidates(sc = scope()) {
    return [...sc.querySelectorAll(FOCUSABLE)].filter(visible);
  }

  function center(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

  // Distância "de controle remoto": o que está na mesma linha (ou coluna) ganha
  function score(from, to, dir) {
    const a = center(from), b = center(to);
    const horiz = dir === "left" || dir === "right";
    const sign = dir === "right" || dir === "down" ? 1 : -1;
    const along = horiz ? (b.x - a.x) * sign : (b.y - a.y) * sign;
    if (along <= 1) return Infinity;
    const gap = horiz
      ? Math.max(0, sign > 0 ? to.left - from.right : from.left - to.right)
      : Math.max(0, sign > 0 ? to.top - from.bottom : from.top - to.bottom);
    const cross = horiz
      ? Math.max(0, to.top - from.bottom, from.top - to.bottom)
      : Math.max(0, to.left - from.right, from.left - to.right);
    // ← → ficam na mesma fileira: no fim da linha não pula para a de cima ou a de baixo
    if (horiz && cross > 0) return Infinity;
    const offset = horiz ? Math.abs(b.y - a.y) : Math.abs(b.x - a.x);
    return gap + along * 0.1 + cross * 3 + offset * 0.3;
  }

  function focus(el) {
    if (!el) return;
    el.focus({ preventScroll: true });
    if (!el.closest("[data-tv-noscroll]")) el.scrollIntoView({ block: api.scroll, inline: "nearest" });
    remember(el);
  }

  function remember(el) {
    last = { el, ...center(el.getBoundingClientRect()) };
    if (!el.closest("dialog")) outside = last;
  }

  // Sem nada focado: o botão principal da tela, ou o primeiro que aparece
  function focusDefault(sc = scope()) {
    const list = candidates(sc);
    const def = list.find((el) => el.matches("[data-tv-default]"));
    if (def) { focus(def); return true; }
    const inView = list.filter((el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
    const first = (inView.length ? inView : list).sort((p, q) => {
      const a = p.getBoundingClientRect(), b = q.getBoundingClientRect();
      return Math.abs(a.top - b.top) > 8 ? a.top - b.top : a.left - b.left;
    })[0];
    if (first) { focus(first); return true; }
    return false;
  }

  function nearestTo(x, y, sc = scope()) {
    let best = null, bestD = Infinity;
    for (const el of candidates(sc)) {
      const c = center(el.getBoundingClientRect());
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < bestD) { best = el; bestD = d; }
    }
    return best;
  }

  function move(dir) {
    const sc = scope();
    const cur = document.activeElement;
    if (!cur || cur === document.body || !sc.contains(cur) || !visible(cur)) return focusDefault(sc);
    const from = cur.getBoundingClientRect();
    let best = null, bestScore = Infinity;
    for (const el of candidates(sc)) {
      if (el === cur) continue;
      const s = score(from, el.getBoundingClientRect(), dir);
      if (s < bestScore) { best = el; bestScore = s; }
    }
    if (best) { focus(best); return true; }
    // Nada naquela direção: rola o que tiver para rolar (texto, fim da página)
    if (dir === "up" || dir === "down") {
      const box = sc === document ? null : sc.querySelector(".dlg-body");
      const dy = (dir === "down" ? 1 : -1) * innerHeight * 0.5;
      if (box) box.scrollBy(0, dy); else window.scrollBy(0, dy);
    }
    return true;
  }

  // ---------- Campos com teclas próprias ----------

  // Deixa a seta agir dentro do campo (mexer o cursor, o controle deslizante…)?
  function fieldKeepsKey(el, dir) {
    if (el.matches("input[type=range]")) {
      if (dir === "up" || dir === "down") return false;
      stepRange(el, dir === "right" ? 1 : -1);
      return true;
    }
    if (el.matches("select")) {
      if (dir === "up" || dir === "down") return false;
      // ← → trocam a opção; na primeira/última, saem da lista como qualquer botão
      const i = el.selectedIndex + (dir === "right" ? 1 : -1);
      if (i < 0 || i >= el.options.length) return false;
      el.selectedIndex = i;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    if (el.matches(TEXT)) {
      let start = 0, end = 0, len = el.value.length;
      try { start = el.selectionStart; end = el.selectionEnd; } catch (e) { return false; }
      if (start == null) return false;
      if (dir === "left") return !(start === 0 && end === 0);
      if (dir === "right") return !(start === len && end === len);
      if (el.matches("textarea")) return dir === "up" ? el.value.lastIndexOf("\n", start - 1) >= 0 : el.value.indexOf("\n", end) >= 0;
      return false;
    }
    if (el.matches("input[type=radio]")) return false; // sem trocar a opção marcada com as setas
    return false;
  }

  // O passo do controle deslizante vira ~5% do total: com o controle remoto ninguém aperta 100 vezes
  function stepRange(el, sign) {
    const min = parseFloat(el.min || "0"), max = parseFloat(el.max || "100");
    const step = parseFloat(el.step) || 1;
    const big = Math.max(step, Math.round((max - min) / 20 / step) * step);
    const v = Math.min(max, Math.max(min, parseFloat(el.value) + sign * big));
    el.value = String(Math.round(v / step) * step);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function isBack(e) {
    if (e.key === "GoBack" || e.key === "BrowserBack" || BACK_CODES.has(e.keyCode)) return true;
    if (e.key === "Escape") return true;
    return e.key === "Backspace" && !(e.target.matches && e.target.matches(TEXT));
  }

  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const dir = DIRS[e.key] || (!e.key || e.key === "Unidentified" ? KEYCODE_DIRS[e.keyCode] : null);
    if (dir || e.key === "Enter" || e.key === "Tab" || isBack(e)) keyMode();
    if (e.defaultPrevented) return;
    const t = document.activeElement;

    if (dir) {
      if (t && t !== document.body && fieldKeepsKey(t, dir)) { if (!t.matches(TEXT)) e.preventDefault(); return; }
      e.preventDefault();
      move(dir);
      return;
    }

    if (e.key === "Enter") {
      if (!t || t === document.body) { e.preventDefault(); focusDefault(); return; }
      // OK num quadradinho de marcar ou num item que age como botão
      if (t.matches("input[type=checkbox], input[type=radio], [role=button]:not(button):not(a)")) { e.preventDefault(); t.click(); return; }
      if (t.matches("select") && t.showPicker) { e.preventDefault(); try { t.showPicker(); } catch (err) {} }
      return;
    }

    if (isBack(e)) {
      const sc = scope();
      if (sc !== document) {
        if (e.key !== "Escape") { e.preventDefault(); sc.close(); }
        return; // o Esc fecha o diálogo sozinho
      }
      if (api.onBack && api.onBack(e)) e.preventDefault();
    }
  });

  // ---------- Foco que some quando a tela se redesenha ----------
  // O telão refaz listas a cada atualização da festa. Se o botão focado sumiu,
  // o foco vai para o que ficou no mesmo lugar, senão o controle "se perde".

  document.addEventListener("focusin", (e) => { if (e.target instanceof Element) remember(e.target); });
  document.addEventListener("scroll", () => { if (last && last.el.isConnected && last.el === document.activeElement) remember(last.el); }, { passive: true, capture: true });

  function restore(ref) {
    if (!root.classList.contains("kbd-nav") || !ref) return;
    const a = document.activeElement;
    if (a && a !== document.body) return;
    if (ref.el.isConnected && visible(ref.el)) { ref.el.focus({ preventScroll: true }); return; }
    const el = nearestTo(ref.x, ref.y);
    if (el) el.focus({ preventScroll: true });
  }
  new MutationObserver(() => { if (last && !last.el.isConnected) restore(last); })
    .observe(document.body, { childList: true, subtree: true });
  // Ao fechar um diálogo, o navegador devolve o foco para quem abriu; se ele sumiu, procura o vizinho
  document.addEventListener("close", (e) => { if (e.target.tagName === "DIALOG") setTimeout(() => restore(outside), 0); }, true);

  // Primeiro item focável (de cima para baixo) dentro de um bloco que acabou de abrir
  function focusFirst(box) {
    const el = candidates(box)[0];
    if (el) focus(el);
    return Boolean(el);
  }

  return Object.assign(api, { focus, focusDefault, focusFirst, move });
})();
