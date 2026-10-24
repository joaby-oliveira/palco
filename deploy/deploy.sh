#!/bin/sh
# Deploy sem queda (blue-green) do Palco no servidor:
#  1. build da imagem nova enquanto o container atual segue no ar;
#  2. sobe o container novo em espera (PALCO_STANDBY=1): não lê data/ nem roda a fila de preparo;
#  3. para o antigo e ativa o novo, que só então lê o estado (fila, votos, músicas) do disco;
#  4. o Traefik passa a mandar para o novo quando o healthcheck dele fica verde.
# Se o novo não subir, o antigo continua (ou volta) no ar.
{
set -e
DOMAIN=${DOMAIN:-palco.lavagest.website}
cd /opt/palco
docker build -q -t palco:latest . >/dev/null

OLD=$(docker ps --format '{{.Names}}' | grep -E '^palco(-[0-9]+)?$' || true)
NEW=palco-$(date +%s)
docker run -d --name "$NEW" --restart unless-stopped --network easypanel \
  --env-file /opt/palco/.env -e PALCO_STANDBY=1 -v palco-data:/app/data \
  --health-cmd 'curl -fs -o /dev/null http://localhost:8000/api/health' \
  --health-interval 30s --health-start-period 180s --health-start-interval 500ms --health-retries 3 \
  -l traefik.enable=true -l traefik.docker.network=easypanel \
  -l "traefik.http.routers.palco-http.rule=Host(\`$DOMAIN\`)" -l traefik.http.routers.palco-http.entrypoints=http \
  -l traefik.http.routers.palco-http.middlewares=redirect-to-https@file \
  -l "traefik.http.routers.palco.rule=Host(\`$DOMAIN\`)" -l traefik.http.routers.palco.entrypoints=https \
  -l traefik.http.routers.palco.tls.certresolver=letsencrypt \
  -l traefik.http.services.palco.loadbalancer.server.port=8000 \
  palco:latest >/dev/null

# Espera o novo responder (em espera ele devolve 503 no /api/health)
i=0
until [ "$(docker exec "$NEW" curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/api/health 2>/dev/null)" = 503 ]; do
  i=$((i + 1))
  if [ $i -gt 240 ]; then
    echo "Container novo não subiu; o antigo segue no ar."; docker logs --tail 30 "$NEW"; docker rm -f "$NEW" >/dev/null; exit 1
  fi
  sleep 0.5
done

# Troca: daqui até o Traefik ver o novo saudável são uns 2 a 3 segundos
[ -n "$OLD" ] && docker stop -t 5 $OLD >/dev/null
if ! docker exec "$NEW" curl -fs -o /dev/null -X POST http://localhost:8000/api/activate; then
  echo "Ativação falhou; voltando o antigo."; docker logs --tail 30 "$NEW"; docker rm -f "$NEW" >/dev/null
  [ -n "$OLD" ] && docker start $OLD >/dev/null
  exit 1
fi
i=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$NEW")" = healthy ]; do
  i=$((i + 1)); [ $i -gt 60 ] && { echo "Novo não ficou saudável"; exit 1; }
  sleep 0.5
done
[ -n "$OLD" ] && docker rm $OLD >/dev/null
docker image prune -f >/dev/null
echo "No ar: $NEW"
exit 0
}
