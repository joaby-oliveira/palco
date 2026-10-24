# Karaokê caseiro

Clone do app de karaokê mostrado pelo Funky (busca no YouTube, tira a voz,
letra sincronizada, capa de fundo e fila pelo celular), sem a parte do Reaper:
o notebook só toca a música (pela caixa Bluetooth) e mostra a letra; o
microfone vai direto na caixa.

## Como usar

1. Dê dois cliques em `iniciar.bat`. Ele instala tudo na primeira vez, atualiza
   o yt-dlp e abre http://localhost:8000.
2. Clique em ⚙ e cole o token do MVSEP (https://mvsep.com/user-api).
3. Busque uma música, ouça a prévia (▶) e clique em **Adicionar**.
4. Quando ela aparecer na **Biblioteca**, clique para tocar.

Na primeira vez, o Windows pergunta se o Python pode usar a rede: permita em
**redes privadas**, senão os celulares não conseguem entrar pelo QR code.

## Versão karaokê e uso sem separação

- Na busca, escolha **Versão karaokê** para procurar vídeos que já são
  instrumentais. Eles entram sem passar por nenhum serviço de separação.
  Títulos com "karaokê", "instrumental" ou "playback" são reconhecidos sozinhos.
- Sem nenhum serviço configurado (ou com **Nenhuma** no seletor), as músicas
  originais tocam inteiras, com a letra. Depois de configurar um serviço, use
  **Separar voz** na biblioteca.
- Versões karaokê costumam ter tempos diferentes da gravação original. No
  player, use **● Gravar sincronia**: toque a música e aperte **espaço** no
  começo de cada linha. Cada marca também empurra as linhas seguintes, então
  marcar só a primeira linha já corrige uma letra inteira atrasada. Backspace
  desfaz, Esc salva. Clicar numa linha escolhe de onde continuar.
- Sem letra no LRCLIB? Em 🎤, cole a letra (texto simples ou LRC) e sincronize
  com **Gravar sincronia**.

## Trocar o serviço de separação

Use o seletor **Separação** no topo da tela (MVSEP, Music.AI, Replicate ou
Local). A troca vale para as próximas músicas da fila; as já processadas não
mudam. As chaves de cada serviço ficam em ⚙ e são salvas em `data/config.json`.

| Serviço  | O que precisa                                                        |
|----------|----------------------------------------------------------------------|
| MVSEP    | Token da API. Usa BS Roformer + modelo de karaokê para backing vocals |
| Music.AI | Chave da API e o slug de um workflow de separação criado no painel   |
| Replicate| Token da API. Modelo padrão `cottom/bs-roformer`                     |
| Local    | `uv pip install --python .venv "audio-separator[cpu]" audioread` (~10 min por música) |

No topo da tela, o indicador **MVSEP hoje: X/50** mostra o uso do plano
grátis (50 separações por dia; cada música gasta 1, e separar os backing
vocals dela gasta mais 1, só quando você clicar em **Separar backing**).
Ele conta pelo histórico da conta no MVSEP e zera às 21h (meia-noite UTC).
Se o limite acabar, o app avisa antes de enviar.

Para adicionar outro serviço, crie um arquivo em `app/providers/` seguindo o
`base.py` e registre-o em `app/providers/__init__.py`.

## No player

- **Original / Instrumental**: com ou sem a voz original.
- **Vocais de suporte / Vocais originais**: volume dos backing vocals e da voz principal.
- **-0.5s ... +0.5s**: adianta ou atrasa a letra desta música.
- **Sync com mouse**: ative e clique na linha no momento em que ela começa.
- **BT**: atraso da caixa Bluetooth, vale para todas as músicas. Comece com 0,2 s.
- **⛶ ou F**: tela cheia. Espaço toca/pausa, setas pulam 5 s.

## Arquivos

- `app/`: servidor (FastAPI). `worker.py` é a fila; `providers/` os serviços.
- `static/`: páginas do notebook (`index.html`), player e celular (`mobile.html`).
- `data/`: biblioteca, faixas separadas e configurações (não vai para o git).
