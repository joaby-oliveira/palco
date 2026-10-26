"""Página de vendas (a raiz do site): HTML montado no servidor, com os preços do plans.py.

O texto da página está no template.html e o estilo no landing.css (vai inline, sem
pedido extra). Os vídeos ficam em VIDEOS: enquanto um vídeo não tem src (arquivo
.mp4) nem youtube, o lugar dele mostra o roteiro para gravar.
"""
import gzip
import html
import json
import os
import time
from pathlib import Path

from fastapi import Request
from fastapi.responses import Response

from .. import plans

HERE = Path(__file__).parent
CONTACT_EMAIL = os.environ.get("CONTATO_EMAIL", "")
CONTACT_WHATSAPP = os.environ.get("CONTATO_WHATSAPP", "")  # só números, com DDI e DDD: 5514999999999

# ---------- Vídeos ----------
# Quando um vídeo ficar pronto, preencha só aqui:
#   src: "/static/videos/hero.mp4" (arquivo em static/videos/) ou youtube: "ID do vídeo"
#   poster: "/static/videos/hero.jpg" (1280x720), legenda: "/static/videos/hero.vtt"
#   enviado: "2026-11-02" (data de publicação, o Google pede)
# O roteiro some sozinho e o vídeo entra no lugar, com o VideoObject para o Google.

VIDEOS = {
    "hero": {
        "titulo": "O que é o Palco", "duracao": "30 a 45 s",
        "descricao": "O Palco transforma a TV no telão de um programa de auditório e o celular dos convidados no controle do karaokê.",
        "src": "", "youtube": "", "poster": "", "legenda": "", "enviado": "",
        "roteiro": [
            ("Gancho", "Festa em que todo mundo fica no celular? Aqui o celular é que faz a festa."),
            ("Fala", "Esse é o Palco: a TV vira o telão de um programa de auditório."),
            ("Fala", "A galera lê o QR, pede a música e entra na fila. A voz sai e a letra aparece no tempo."),
            ("Fala", "Quem assiste vota e solta aplauso e buzina, com o nome no telão."),
            ("CTA", "Escolhe o seu passe aqui embaixo e começa hoje."),
        ],
    },
    "como": {
        "titulo": "Da TV ligada à primeira música", "duracao": "60 s",
        "descricao": "Passo a passo: abrir o Palco na TV, a galera entrar pelo QR code e a primeira música tocar sem a voz, com a letra.",
        "src": "", "youtube": "", "poster": "", "legenda": "", "enviado": "",
        "roteiro": [
            ("Gancho", "Em um minuto eu te mostro a festa começando do zero."),
            ("Fala", "Abre o Palco no navegador da TV ou do notebook. Não instala nada."),
            ("Fala", "Aparece o QR. Cada um aponta a câmera, diz o nome e pede música."),
            ("Fala", "A música fica pronta sem a voz e com a letra: é só apertar Soltar o som."),
            ("Fala", "No fim sai a nota da galera e o próximo é chamado sozinho."),
            ("CTA", "Liga a TV e testa na sua próxima festa."),
        ],
    },
    "duelo": {
        "titulo": "Duelo e votação", "duracao": "30 s",
        "descricao": "No modo duelo, dois cantores dividem a mesma música e a galera vota pelo celular em quem está cantando melhor.",
        "src": "", "youtube": "", "poster": "", "legenda": "", "enviado": "",
        "roteiro": [
            ("Gancho", "Quem canta melhor? Agora quem decide é a galera."),
            ("Fala", "No duelo, dois cantores dividem a música, cada um na sua cor."),
            ("Fala", "Todo mundo vota no celular e o placar aparece ao vivo no telão."),
            ("CTA", "Chama o seu rival para o duelo."),
        ],
    },
    "danca": {
        "titulo": "Modo dança", "duracao": "30 s",
        "descricao": "No modo dança, a coreografia toca na tela e a câmera dá nota para quem imita o dançarino.",
        "src": "", "youtube": "", "poster": "", "legenda": "", "enviado": "",
        "roteiro": [
            ("Gancho", "Cansou de cantar? Agora é dançar valendo nota."),
            ("Fala", "A coreografia toca no telão e a câmera vê os seus movimentos."),
            ("Fala", "Cada passo vale de Perfeito a Errou. Dá para usar o celular de pé como câmera."),
            ("CTA", "Desafia a família no modo dança."),
        ],
    },
    "duvidas": {
        "titulo": "Tira-dúvidas", "duracao": "45 a 60 s",
        "descricao": "Respostas rápidas: o Palco não precisa de instalação, funciona na TV, usa o microfone da sua caixa de som e aceita Pix ou cartão.",
        "src": "", "youtube": "", "poster": "", "legenda": "", "enviado": "",
        "roteiro": [
            ("Gancho", "As quatro perguntas que todo mundo me faz, em um minuto."),
            ("Fala", "Instalar? Não. Abre no navegador, e os convidados entram pelo QR."),
            ("Fala", "Na TV? Sim, com o controle remoto: setas, OK e Voltar."),
            ("Fala", "Microfone? O da sua caixa de som. O Palco toca a música e mostra a letra."),
            ("Fala", "Pagamento? Pix ou cartão, e libera na hora na sua conta."),
            ("CTA", "Ficou mais alguma dúvida? Me chama."),
        ],
    },
    "planos": {
        "titulo": "Passe ou plano mensal?", "duracao": "30 s",
        "descricao": "Como escolher entre o passe para uma festa e os planos mensais do Palco.",
        "src": "", "youtube": "", "poster": "", "legenda": "", "enviado": "",
        "roteiro": [
            ("Gancho", "Passe ou plano mensal? Te ajudo a escolher em 30 segundos."),
            ("Fala", "Uma festa só? Pega o passe: as horas contam a partir de quando você começa."),
            ("Fala", "Festa todo mês? O Animador libera tudo. Bar ou buffet? O Casa / Bar."),
            ("CTA", "Escolhe aqui do lado e já deixa a próxima festa pronta."),
        ],
    },
}

# ---------- Dúvidas (a mesma lista vira o FAQPage do Google) ----------

def faq() -> list[tuple[str, str]]:
    pl = plans.public()
    limited = [p["name"] for p in pl if p["limits"]["guests"] is not None]
    unlimited = [p["name"] for p in pl if p["limits"]["guests"] is None]
    guests = max(p["limits"]["guests"] for p in pl if p["limits"]["guests"] is not None)
    return [
        ("Precisa instalar alguma coisa?",
         "Não. O Palco abre no navegador da TV, do notebook ou do computador, e os convidados entram pelo "
         "navegador do celular lendo o QR code. Ninguém baixa aplicativo."),
        ("Funciona na TV?",
         "Funciona. Abra o endereço do Palco no navegador da Smart TV e use só as setas, o OK e o Voltar do "
         "controle remoto. Também dá para ligar o notebook na TV pelo cabo HDMI."),
        ("Precisa de microfone especial?",
         "Não. O Palco toca a música e mostra a letra; o microfone vai direto na caixa de som, como num karaokê "
         "comum. Usando caixa Bluetooth, dá para acertar o atraso dela nos ajustes."),
        ("Quantas pessoas podem entrar na festa?",
         f"No {_join(limited)}, até {guests} celulares na mesma festa. No {_join(unlimited)}, sem limite. "
         "Quem está sem celular pode ser chamado pelo próprio telão para um duelo."),
        ("Que músicas dá para cantar?",
         "Quase qualquer uma: a busca é no YouTube. O Palco tira a voz da música e traz a letra sincronizada. "
         "Também dá para escolher vídeos que já são versão karaokê."),
        ("Como eu pago?",
         "Por Pix ou cartão, numa página de pagamento segura. Assim que o pagamento é confirmado, o passe ou o "
         "plano aparece liberado na sua conta."),
        ("Quando começam a contar as horas do passe?",
         "Só quando você aperta Começar a festa agora, no telão ou em Minha conta. Dá para comprar o passe com "
         "antecedência."),
        ("Posso cancelar o plano mensal?",
         "Pode, quando quiser, em Minha conta. O plano continua valendo até o fim do mês que já foi pago."),
    ]


def _join(names: list[str]) -> str:
    return names[0] if len(names) == 1 else ", no ".join(names[:-1]) + " e no " + names[-1]


# ---------- Planos ----------

def brl(cents: int) -> str:
    return f"R$ {cents // 100},{cents % 100:02d}"


def features(p: dict) -> list[str]:
    """Os mesmos itens do cartão de plano em Minha conta (conta.js)."""
    l = p["limits"]
    out = [
        f"{p['hours']} horas de festa a partir de quando você começar" if p["kind"] == "pass" else None,
        "Músicas novas sem limite" if l["songs"] is None else f"{l['songs']} músicas novas por mês",
        "Músicas que já estão no repertório não contam",
        "Convidados sem limite" if l["guests"] is None else f"Até {l['guests']} celulares na festa",
        "Modo dança com nota pela câmera" if l["dance"] else None,
        f"Até {l['screens']} telões ao mesmo tempo" if l["screens"] > 1 else None,
        "Fila pelo celular, votação, duelo e mesa de efeitos",
    ]
    return [f for f in out if f]


def plan_card(p: dict) -> str:
    e = html.escape
    pid = f"plano-{p['id']}"
    unit = "/mês" if p["kind"] == "monthly" else "por festa"
    action = "Assinar" if p["kind"] == "monthly" else "Comprar"
    items = "".join(f"<li>{e(f)}</li>" for f in features(p))
    ribbon = '<p class="ribbon">Mais escolhido</p>' if p.get("featured") else ""
    return f"""<article class="plan{' featured' if p.get('featured') else ''}" aria-labelledby="{pid}">
  {ribbon}<h4 class="pname" id="{pid}">{e(p['name'])}</h4>
  <p class="pitch">{e(p['pitch'])}</p>
  <p class="price">{brl(p['price'])} <small>{unit}</small></p>
  <ul>{items}</ul>
  <a class="btn{'' if p.get('featured') else ' ghost'}" href="/conta?plano={e(p['id'])}">{action} o {e(p['name'])}</a>
</article>"""


# ---------- Vídeos ----------

def video_block(key: str, base: str) -> str:
    v = VIDEOS[key]
    e = html.escape
    if v["youtube"]:
        yid = e(v["youtube"])
        poster = e(v["poster"] or f"https://i.ytimg.com/vi/{yid}/hqdefault.jpg")
        return f"""<figure class="video">
  <div class="frame"><a class="yt" href="https://www.youtube.com/watch?v={yid}" data-yt="{yid}">
    <img src="{poster}" alt="" width="1280" height="720" loading="lazy" decoding="async">
    <span class="yt-play" aria-hidden="true"></span><span class="sr-only">Assistir ao vídeo: {e(v['titulo'])}</span>
  </a></div>
  <figcaption>{e(v['titulo'])}</figcaption>
</figure>"""
    if v["src"]:
        poster = f' poster="{e(v["poster"])}"' if v["poster"] else ""
        track = (f'<track kind="captions" src="{e(v["legenda"])}" srclang="pt-BR" label="Português" default>'
                 if v["legenda"] else "")
        return f"""<figure class="video">
  <div class="frame"><video controls preload="none" playsinline width="1280" height="720"{poster}>
    <source src="{e(v['src'])}" type="video/mp4">{track}
  </video></div>
  <figcaption>{e(v['titulo'])}</figcaption>
</figure>"""
    beats = "".join(f'<li><span class="beat">{e(b)}</span> {e(t)}</li>' for b, t in v["roteiro"])
    return f"""<figure class="video script">
  <div class="frame">
    <p class="soon">Vídeo em breve</p>
    <p class="r-title">Roteiro: {e(v['titulo'])} <span class="dur">({e(v['duracao'])})</span></p>
    <ol>{beats}</ol>
  </div>
</figure>"""


def video_ld(base: str) -> list[dict]:
    out = []
    for v in VIDEOS.values():
        if not (v["src"] or v["youtube"]) or not v["enviado"]:
            continue
        thumb = v["poster"] or f"https://i.ytimg.com/vi/{v['youtube']}/hqdefault.jpg"
        item = {"@type": "VideoObject", "name": v["titulo"], "description": v["descricao"],
                "thumbnailUrl": thumb if thumb.startswith("http") else base + thumb, "uploadDate": v["enviado"]}
        if v["src"]:
            item["contentUrl"] = base + v["src"]
        else:
            item["embedUrl"] = f"https://www.youtube-nocookie.com/embed/{v['youtube']}"
        out.append(item)
    return out


YT_SCRIPT = """<script>
document.querySelectorAll("a[data-yt]").forEach((a) => a.addEventListener("click", (ev) => {
  ev.preventDefault();
  const f = document.createElement("iframe");
  f.src = `https://www.youtube-nocookie.com/embed/${a.dataset.yt}?autoplay=1&rel=0`;
  f.title = a.querySelector(".sr-only").textContent;
  f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
  f.allowFullscreen = true;
  a.replaceWith(f);
  f.focus();
}));
</script>"""


# ---------- Página ----------

def structured_data(base: str) -> str:
    pl = plans.public()
    offers = []
    for p in pl:
        offer = {"@type": "Offer", "name": p["name"], "description": p["pitch"], "price": f"{p['price'] / 100:.2f}",
                 "priceCurrency": "BRL", "url": f"{base}/conta?plano={p['id']}", "availability": "https://schema.org/InStock"}
        if p["kind"] == "monthly":
            offer["priceSpecification"] = {"@type": "UnitPriceSpecification", "price": f"{p['price'] / 100:.2f}",
                                           "priceCurrency": "BRL", "billingDuration": "P1M", "unitCode": "MON"}
        offers.append(offer)
    graph = [
        {"@type": "Organization", "@id": f"{base}/#org", "name": "Palco", "url": f"{base}/",
         "logo": f"{base}/static/site/icon-512.png"},
        {"@type": "WebSite", "@id": f"{base}/#site", "name": "Palco", "url": f"{base}/", "inLanguage": "pt-BR",
         "publisher": {"@id": f"{base}/#org"}},
        {"@type": "SoftwareApplication", "name": "Palco", "url": f"{base}/",
         "description": "Karaokê para festa em que a TV vira o telão e o celular dos convidados vira o controle: "
                        "fila de músicas, voz tirada, letra sincronizada, votação, duelo e modo dança.",
         "applicationCategory": "EntertainmentApplication", "operatingSystem": "Web", "inLanguage": "pt-BR",
         "image": f"{base}/static/site/og.png", "publisher": {"@id": f"{base}/#org"}, "offers": offers},
        {"@type": "FAQPage", "mainEntity": [
            {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faq()]},
        *video_ld(base),
    ]
    data = json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False)
    return data.replace("</", "<\\/")


def contact_links() -> str:
    out = []
    if CONTACT_WHATSAPP:
        out.append(f'<li><a href="https://wa.me/{html.escape(CONTACT_WHATSAPP)}">WhatsApp</a></li>')
    if CONTACT_EMAIL:
        out.append(f'<li><a href="mailto:{html.escape(CONTACT_EMAIL)}">{html.escape(CONTACT_EMAIL)}</a></li>')
    return "".join(out)


def render(base: str) -> str:
    pl = plans.public()
    passes = [p for p in pl if p["kind"] == "pass"]
    monthly = [p for p in pl if p["kind"] == "monthly"]
    bar = next((p for p in pl if p["limits"]["screens"] > 1), None)
    dance_in = [p["name"] for p in pl if p["limits"]["dance"]]
    page = (HERE / "template.html").read_text(encoding="utf-8")
    values = {
        "BASE": base,
        "CSS": (HERE / "landing.css").read_text(encoding="utf-8"),
        "JSONLD": structured_data(base),
        "FROM_PRICE": brl(min(p["price"] for p in pl)),
        "PASSES": "".join(plan_card(p) for p in passes),
        "MONTHLY": "".join(plan_card(p) for p in monthly),
        "DANCE_PLANS": html.escape(_join(dance_in)),
        "BAR_NAME": html.escape(bar["name"]) if bar else "",
        "BAR_SCREENS": str(bar["limits"]["screens"]) if bar else "",
        "FAQ": "".join(f"<details><summary>{html.escape(q)}</summary><p>{html.escape(a)}</p></details>" for q, a in faq()),
        "CONTACT": contact_links(),
        "YEAR": time.strftime("%Y"),
        "YT_SCRIPT": YT_SCRIPT if any(v["youtube"] for v in VIDEOS.values()) else "",
        **{f"VIDEO_{k.upper()}": video_block(k, base) for k in VIDEOS},
    }
    for k, v in values.items():
        page = page.replace("{{" + k + "}}", v)
    return page


def response(request: Request, base: str) -> Response:
    body = render(base).encode()
    headers = {"Vary": "Accept-Encoding, Cookie"}
    if "gzip" in request.headers.get("accept-encoding", ""):
        body = gzip.compress(body, 6)
        headers["Content-Encoding"] = "gzip"
    return Response(body, media_type="text/html; charset=utf-8", headers=headers)


def updated() -> str:
    """Data da última mudança da página (para o sitemap)."""
    files = [*HERE.iterdir(), Path(plans.__file__)]
    return time.strftime("%Y-%m-%d", time.gmtime(max(f.stat().st_mtime for f in files if f.is_file())))


def robots(base: str) -> str:
    # As telas do app não ficam bloqueadas aqui: elas mandam noindex, e o Google só lê isso se puder abrir a página
    return f"User-agent: *\nDisallow: /api/\nDisallow: /media/\n\nSitemap: {base}/sitemap.xml\n"


def sitemap(base: str) -> str:
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            f"  <url><loc>{base}/</loc><lastmod>{updated()}</lastmod></url>\n"
            "</urlset>\n")
