#!/bin/sh
# Chamado pelo palco-autodeploy.timer a cada minuto: se o main do GitHub andou, faz o deploy.
# Tudo entre chaves: o shell lê o script inteiro antes de rodar, porque o git pull pode trocar este arquivo.
{
cd /opt/palco
# Se o Easypanel apagar a rota do Palco, ela volta aqui
[ -f /etc/easypanel/traefik/config/palco.yaml ] || sh deploy/traefik.sh
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0

# Música no meio do preparo (separação de voz): espera terminar, senão o preparo recomeça do zero
# e gasta outra separação. Depois de 20 minutos esperando, faz o deploy mesmo assim.
CUR=$(docker ps --format '{{.Names}}' | grep -E '^palco(-[0-9]+)?$' | head -1)
WAIT=/run/palco-deploy-waiting
if [ -n "$CUR" ] && docker exec "$CUR" curl -s http://localhost:8000/api/state | grep -q '"status": *"processing"'; then
  [ -f $WAIT ] || date +%s > $WAIT
  if [ $(( $(date +%s) - $(cat $WAIT) )) -lt 1200 ]; then
    echo "Commit novo, mas tem música sendo preparada: deploy no próximo minuto."; exit 0
  fi
fi
rm -f $WAIT

echo "Novo commit: $(git log -1 --format='%h %s' origin/main)"
git merge -q --ff-only origin/main
if sh deploy/deploy.sh && curl -fsS -o /dev/null https://palco.lavagest.website/m; then
  echo "Deploy ok: $(git log -1 --format=%h)"
else
  echo "ATENÇÃO: deploy falhou"; exit 1
fi
exit 0
}
