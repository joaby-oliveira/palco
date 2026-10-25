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
2. Em **Ajustes** (ícone no canto de cima), cole o token do MVSEP
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
  coluna lateral, as teclas 1 a 9 e 0 (também as do teclado numérico)
  disparam os dez primeiros, no telão e no palco, e **Mais sons**
  (ou a tecla S) abre a mesa inteira.
- Cada pessoa tem o seu canal: um som novo dela corta o anterior dela, sem
  mexer no som dos outros. **Parar sons** cala tudo.
- Cada som tem um emoji (campo `emoji` no `sounds.json`). Quando alguém
  dispara, o emoji sobe no telão com o nome de quem mandou e o nome do som.
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

## Na TV, pelo controle remoto

Abra o endereço do Palco no navegador da TV e use só as setas, o OK e o Voltar.

- **Setas** levam o contorno dourado para o botão mais próximo naquela
  direção; **OK** aperta. Funciona no telão, nas fichas, nos ajustes e na mesa
  de sons.
- **Voltar** fecha o que estiver aberto (ficha, ajustes, gaveta do palco,
  resultados da busca, tela de letra/capa).
- Nos controles deslizantes, ← → mexem em passos de ~5%; nas listas de opções,
  ← → trocam a opção.
- **No palco**: com os controles escondidos, ← → pulam 5 s e ↑ ↓ ou OK mostram
  os controles (com o foco no play). Botões de mídia do controle (play/pausa,
  avançar, voltar) também funcionam.
- **Gravar sincronia** pelo controle: o foco fica em **Marcar linha**, então
  cada OK marca uma linha. Para desfazer ou concluir, ande até o botão e aperte
  OK. Em **Clicar na linha certa**, ↑ leva às linhas da letra na tela e o OK
  escolhe a que está tocando.
- No fim da música o foco já fica no botão do próximo cantor; ← vai para o
  **Bis!**.

## Duelo

Dois cantores, a mesma música: a letra vem dividida entre eles (cada um na
sua cor, e o refrão dos dois juntos) e a galera vota no celular em quem está
mandando melhor.

- **No telão**: cartão **DUELO** (ou **Duelo** na ficha da música) › escolha a
  música, o cantor A e o cantor B › **Pôr na fila** ou **Duelar agora**. Quem
  está sem celular entra pelo campo **Alguém sem celular?**.
- **No celular**: no repertório, o botão de duelo ao lado do **+** desafia
  alguém da festa. O duelo entra na fila como qualquer pedido.
- **No palco**: no topo aparece de quem é a vez (e quem vem depois, nos
  trechos sem letra); embaixo do nome dos dois, o placar dos votos ao vivo. No
  fim, o vencedor. **Bis!** repete o mesmo duelo.
- **Votos**: um voto por pessoa (A ou B), dá para mudar até o fim. Os dois
  cantores não votam.

### Dividir as vozes

Na primeira vez que uma música vai para um duelo, o app divide a letra
sozinho. Com a voz separada e a letra sincronizada, ele mede o tom e o timbre
de cada linha: se acha duas vozes bem diferentes (homem e mulher, por
exemplo), cada uma vira um cantor. Senão (um cantor só, ou duas vozes
parecidas), divide pelas estrofes: elas alternam e o refrão que mais se
repete é dos dois.

Para acertar à mão, na ficha da música, **Dividir as vozes**: cada linha tem
**A**, **B** ou **Juntos**, e o ▶ toca a partir dela (só a voz, quando foi
separada) para ouvir quem canta. **Dividir sozinho** refaz a sugestão
automática. Depois de **Salvar divisão**, a música aparece com ★ na lista do
duelo (pronta para duelo). Trocar a letra apaga a divisão.

## Modo dança

Um "Just Dance" caseiro: o vídeo da coreografia toca na tela e a webcam do
notebook dá nota para quem imita o coach.

1. Na busca, escolha **Dança** (ou clique no cartão **DANÇA**). O app procura
   vídeos de "just dance" da música; também dá para colar o link de qualquer
   vídeo de coreografia com o dançarino de corpo inteiro.
2. No preparo, o app baixa o vídeo (até 720p) e marca a pose do coach quadro a
   quadro com o MediaPipe (~1,5 min para uma música de 4 min). Não gasta
   separação de voz: a música toca inteira.
3. No palco, fique na frente da câmera de corpo inteiro (ou da cintura para
   cima) e aperte **COMEÇAR**. Imite como num espelho. Cabem duas pessoas,
   uma de cada lado da tela; o jogador 2 entra sozinho quando a câmera vê
   duas pessoas por um instante.

Cada movimento (um compasso da música) vale PERFEITO, SUPER, BOM, OK ou
ERROU, conforme a direção dos braços e das pernas e quanto você se mexeu; a
nota vai até 10.000, com 5 estrelas. Ficar parado não pontua. **C** mostra ou
esconde a câmera e muda o tamanho dela.

Na primeira vez o navegador pede para usar a câmera (permita) e baixa o
detector de movimentos da internet. Sem câmera, dá para **Dançar sem nota**.

### Celular como câmera

A webcam do notebook costuma ficar baixa e perto demais. Um celular de pé, a
2 ou 3 metros, pega todo mundo de corpo inteiro. Na tela de preparação do
palco de dança tem um QR code: abra no celular, aperte **LIGAR CÂMERA** e
apoie o celular. O palco troca para ele sozinho (e volta para a webcam se o
celular parar).

O celular roda o detector e manda só os pontos do corpo pela rede; nenhuma
imagem sai dele. Como o navegador só libera a câmera em página segura, o app
também abre a porta **8443** com HTTPS e um certificado próprio (em
`data/tls/`). Na primeira vez o celular avisa que a conexão não é particular:
toque em **Avançado › Continuar**.

### Análise da dança e calibragem

Toda dança com nota fica guardada (em `data/songs/<id>/sessions/`). No fim
da dança, **Ver análise** (ou, na ficha da música, **Análise das danças**)
mostra:

- **Resumo**: nota, quanto a câmera viu os seus braços, quadros por segundo
  da câmera, atraso típico e se você imitou como espelho ou do mesmo lado.
- **Coach × você**: o vídeo com o esqueleto que o app marcou no coach e os
  dois esqueletos sobrepostos, com a diferença de cada osso em graus. Use
  0,25× e as setas (quadro a quadro) para achar onde a nota errou.
- **Nota de cada movimento**: a linha do tempo; clique para ver o detalhe.
- **Atraso**: em quanto tempo você vem depois do coach, comparado com a
  janela que a nota aceita.
- **Calibragem**: mexa na tolerância, na janela de atraso, no peso das
  pernas, no castigo por ficar parado e nos limites de cada nota; a dança
  é recalculada na hora. **Usar nas próximas danças** salva os valores.

**Baixar dados** dá o JSON da dança (pontos de cada quadro e notas).

## Arquivos

- `app/`: servidor (FastAPI). `party.py` é a festa (convidados, fila do palco,
  votos, sons); `duel.py` divide a letra para o duelo; `worker.py` é a fila
  de preparo; `providers/` os serviços.
- `static/`: telão (`index.html`), palco (`player.html`), palco de dança
  (`dance.html`, nota em `dance-score.js`), celular (`mobile.html`) e os sons
  do telão (`fx.js`). `app/dance.py` prepara o gabarito da dança.
- `data/`: biblioteca, faixas separadas, convidados e configurações (não vai
  para o git).

## No servidor (Docker)

O `Dockerfile` roda o Palco atrás de um proxy que cuida do HTTPS (Traefik,
Caddy, nginx). Os dados ficam no volume `/app/data`.

```
docker build -t palco .
docker run -d -v palco-data:/app/data -p 8000:8000 \
  -e PUBLIC_URL=https://palco.seudominio.com -e HOST_KEY=uma-chave-longa palco
```

- `PUBLIC_URL`: endereço que vai nos QR codes (celular e câmera do modo dança).
- Festas: qualquer pessoa que abre o site vira anfitriã de uma festa própria,
  com um código (aparece no telão, embaixo do QR). O QR leva os convidados
  para essa festa; cada uma tem a sua fila, palco, votos e efeitos. O
  repertório e os sons são de todos. **Começar uma festa nova** (nos ajustes)
  zera a fila e troca o código.
- `HOST_KEY`: chave do dono do servidor. Abrindo
  `https://palco.seudominio.com/?host=uma-chave-longa` uma vez (fica num
  cookie por um ano), aparecem nos ajustes as partes do servidor: separação
  de voz, tokens e cookies do YouTube. Também pode apagar qualquer música do
  repertório. No notebook (localhost) isso vale sem chave.
- `HTTPS_PORT=0` (já é o padrão da imagem): sem a porta 8443 com certificado
  próprio, porque o domínio já tem HTTPS.
- YouTube bloqueando o download ("Sign in to confirm you're not a bot"),
  comum em IP de datacenter: em **Ajustes do anfitrião › YouTube**, envie um
  `cookies.txt` de uma conta (de preferência secundária). Para exportar: numa
  janela anônima, entre no YouTube, exporte com a extensão "Get cookies.txt
  LOCALLY" e feche a janela sem sair da conta. O app testa na hora se o
  YouTube liberou. Os cookies vencem de tempos em tempos; quando o download
  voltar a falhar, a mensagem de erro avisa para enviar de novo.

### Deploy automático e sem queda

No servidor, o `palco-autodeploy.timer` (systemd) confere o `main` do GitHub a
cada minuto. Se tem commit novo, roda `deploy/deploy.sh`, que troca o container
sem derrubar o site (blue-green):

1. faz o build da imagem nova com o container atual ainda no ar;
2. sobe o novo em espera (arquivo `data/standby-<nome>`), fora da rede do
   Traefik: ele não lê `data/` nem prepara músicas, para não brigar com o atual;
3. tira o atual da rede, ativa o novo (que aí lê a fila, os votos e as músicas
   do disco) e passa para ele o alias `palco-live`, para onde aponta a rota
   fixa do Traefik (`deploy/traefik.sh`). O retry do Traefik segura os
   requests desse meio segundo; só a conexão ao vivo do telão e dos celulares
   cai e volta sozinha em 1,5 s. A fila do palco fica salva em `data/party.json`;
4. se o novo não subir, o antigo continua (ou volta) no ar.

Com uma música no meio do preparo, o deploy espera ela terminar (até 20
minutos), para não perder a separação. Para acompanhar:
`journalctl -u palco-autodeploy -f`.
