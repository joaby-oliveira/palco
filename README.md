# Palco — o animador da sua festa

Karaokê caseiro com cara de programa de auditório: o notebook (ou a TV) vira o
telão, a galera entra pelo celular com o nome, pede música, vota em quem
cantou e dispara efeitos sonoros. Busca no YouTube, tira a voz, letra
sincronizada e capa de fundo. O notebook só toca a música (pela caixa
Bluetooth) e mostra a letra; o microfone vai direto na caixa.

A v1 (visual antigo, sem fila da festa) está na branch `v1`.

## Como usar

1. Dê dois cliques em `iniciar.bat`. Ele instala tudo na primeira vez, atualiza
   o yt-dlp e abre http://localhost:8000.
2. Em **Ajustes do anfitrião** (ícone no canto de cima), cole o token do MVSEP
   (https://mvsep.com/user-api).
3. A galera escaneia o QR **Chama a galera**, diz o nome e pede música. Do
   notebook também dá: busque e clique em **Pôr na fila**.
4. Quando a música fica pronta, o pedido vira **Próximo no palco**. Clique em
   **Soltar o som**.
5. No fim, aparece a nota da galera e o próximo cantor é chamado sozinho em
   15 segundos.

Na primeira vez, o Windows pergunta se o Python pode usar a rede: permita em
**redes privadas**, senão os celulares não conseguem entrar pelo QR code.

## No celular

- **Pedir**: busca no YouTube ou escolhe uma música que já está pronta. Mostra
  a sua posição na fila.
- **Fila**: quem vai cantar e em que ordem. Dá para tirar os próprios pedidos.
- **Efeitos**: 12 botões (aplausos, buzina, risada da plateia, errou!, grilo…)
  que tocam no telão.
- Enquanto alguém canta, aparece a votação (de "Desafinou" a "Bis!"). Não dá
  para votar em si mesmo.

## Efeitos sonoros

Os sons ficam em `data/sounds/` (fora do git). O `sounds.json` dá nome e cor a
cada arquivo; um áudio jogado na pasta sem estar nele entra com o nome do
arquivo.

- **Principais**: a seção de cima da mesa, igual para todo mundo da festa. A
  estrela tira um som dela; em **Seus sons**, a estrela traz o som para ela. A
  ordem fica em `data/sounds/favorites.json`. No palco, os 6 primeiros ficam na
  coluna lateral, as teclas 1 a 9 e 0 disparam os dez primeiros e **Mais sons**
  (ou a tecla S) abre a mesa inteira.
- Cada pessoa tem o seu canal: um som novo dela corta o anterior dela, sem
  mexer no som dos outros. **Parar sons** cala tudo.
- No celular, o fone em cada botão toca uma prévia só no próprio celular, para
  saber qual é o som antes de soltar no telão.

## Versão karaokê e uso sem separação

- Na busca, escolha **Já é karaokê** para procurar vídeos que já são
  instrumentais. Eles entram sem passar por nenhum serviço de separação.
  Títulos com "karaokê", "instrumental" ou "playback" são reconhecidos sozinhos.
- Sem nenhum serviço configurado (ou com **Nenhuma**), as músicas originais
  tocam inteiras, com a letra. Depois de configurar um serviço, use **Tirar a
  voz** na ficha da música (clique na capa no repertório).
- Versões karaokê costumam ter tempos diferentes da gravação original. No
  palco, abra **Letra fora do tempo?** › **● Gravar sincronia**: toque a música
  e aperte **espaço** no começo de cada linha. Cada marca também empurra as
  linhas seguintes, então marcar só a primeira linha já corrige uma letra
  inteira atrasada. Backspace desfaz, Esc salva. Clicar numa linha escolhe de
  onde continuar.
- Sem letra no LRCLIB? Na ficha da música, **Trocar letra** › cole a letra
  (texto simples ou LRC) e sincronize com **Gravar sincronia**.

## Trocar o serviço de separação

Em **Ajustes do anfitrião** › **Separação de voz** (MVSEP, Music.AI, Replicate
ou Local). A troca vale para as próximas músicas; as já processadas não mudam.
As chaves ficam salvas em `data/config.json`.

| Serviço  | O que precisa                                                        |
|----------|----------------------------------------------------------------------|
| MVSEP    | Token da API. Usa BS Roformer + modelo de karaokê para backing vocals |
| Music.AI | Chave da API e o slug de um workflow de separação criado no painel   |
| Replicate| Token da API. Modelo padrão `cottom/bs-roformer`                     |
| Local    | `uv pip install --python .venv "audio-separator[cpu]" audioread` (~10 min por música) |

O uso do plano grátis do MVSEP (50 separações por dia; cada música gasta 1, e
separar os backing vocals dela gasta mais 1) aparece nos ajustes. O telão só
mostra um aviso no topo quando o serviço precisa ser configurado ou o limite
do dia está acabando. Ele zera às 21h (meia-noite UTC).

Para adicionar outro serviço, crie um arquivo em `app/providers/` seguindo o
`base.py` e registre-o em `app/providers/__init__.py`.

## No palco

- **Com voz / Voz guia / Sem voz**: a voz original inteira, baixinha ou fora.
- **Letra fora do tempo?**: adianta ou atrasa a letra desta música, clique na
  linha certa ou grave a sincronia.
- **Ajustes**: volume dos backing vocals, da voz, da música e dos efeitos;
  desfoque do fundo; tom; atraso da caixa Bluetooth (comece com 0,2 s).
- Botão **próximo** (ao lado do play): encerra e mostra a nota da galera.
- Espaço toca/pausa, setas pulam 5 s, F é tela cheia. Os controles somem
  sozinhos enquanto a música toca.

## Arquivos

- `app/`: servidor (FastAPI). `party.py` é a festa (convidados, fila do palco,
  votos, sons); `worker.py` é a fila de preparo; `providers/` os serviços.
- `static/`: telão (`index.html`), palco (`player.html`), celular
  (`mobile.html`) e os sons do telão (`fx.js`).
- `data/`: biblioteca, faixas separadas, convidados e configurações (não vai
  para o git).
