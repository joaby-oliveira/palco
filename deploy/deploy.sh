#!/bin/sh
# Deploy sem queda (blue-green) do Palco no servidor:
#  1. build da imagem nova enquanto o container atual segue no ar;
#  2. sobe o container novo em espera (fora da rede do Traefik): não lê data/ nem prepara músicas;
#  3. para o antigo, ativa o novo (que só então lê fila, votos e músicas do disco) e passa
#     o alias palco-live para ele. O retry do Traefik segura os requests desse segundo;
#     só a conexão ao vivo (WebSocket) fecha e volta sozinha;
#  4. se o novo não subir, o antigo continua (ou volta) no ar.
{
set -e
cd /opt/palco
sh deploy/traefik.sh
docker build -q -t palco:latest . >/dev/null

DATA=$(docker volume inspect -f '{{.Mountpoint}}' palco-data)
OLD=$(docker ps --format '{{.Names}}' | grep -E '^palco(-[0-9]+)?$' || true)
NEW=palco-$(date +%s)
touch "$DATA/standby-$NEW"
docker run -d --name "$NEW" --restart unless-stopped \
  --env-file /opt/palco/.env -e PALCO_NAME="$NEW" -v palco-data:/app/data \
  --health-cmd 'curl -fs -o /dev/null http://localhost:8000/api/health' --health-interval 30s --health-start-period 60s \
  palco:latest >/dev/null

health() { docker exec "$NEW" curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/api/health 2>/dev/null; }

# Espera o novo responder (em espera ele devolve 503 no /api/health)
i=0
until [ "$(health)" = 503 ]; do
  i=$((i + 1))
  if [ $i -gt 360 ]; then
    echo "Container novo não subiu; o antigo segue no ar."; docker logs --tail 30 "$NEW"
    docker rm -f "$NEW" >/dev/null; rm -f "$DATA/standby-$NEW"; exit 1
  fi
  sleep 0.5
done

# Troca: o antigo para ainda na rede, para fechar os WebSockets direito (os navegadores
# reconectam sozinhos), terminar o que estava em andamento e recusar conexões novas, que o
# retry do Traefik segura. Aí o novo lê o estado do disco e assume o alias palco-live.
[ -n "$OLD" ] && docker stop -t 5 $OLD >/dev/null
if ! docker exec "$NEW" curl -fs -o /dev/null -X POST http://localhost:8000/api/activate \
   || ! docker network connect --alias palco-live easypanel "$NEW"; then
  echo "Ativação falhou; voltando o antigo."; docker logs --tail 30 "$NEW"
  docker rm -f "$NEW" >/dev/null; rm -f "$DATA/standby-$NEW"
  [ -n "$OLD" ] && docker start $OLD >/dev/null
  exit 1
fi
[ -n "$OLD" ] && docker rm -f $OLD >/dev/null
docker image prune -f >/dev/null
echo "No ar: $NEW"
exit 0
}
