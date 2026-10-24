#!/bin/sh
# Rota fixa do Palco no Traefik do Easypanel (provider de arquivo). Ela aponta para o alias
# de rede palco-live, que o deploy passa do container antigo para o novo; o retry segura os
# requests que caem bem na troca (o Traefik espalha as tentativas em ~1,5 × 25 × 300 ms ≈ 10 s),
# então ninguém vê erro.
DOMAIN=${DOMAIN:-palco.lavagest.website}
FILE=/etc/easypanel/traefik/config/palco.yaml
cat > $FILE.tmp <<YAML
http:
  routers:
    palco-http:
      rule: Host(\`$DOMAIN\`)
      entryPoints: [http]
      middlewares: [redirect-to-https]
      service: palco
    palco:
      rule: Host(\`$DOMAIN\`)
      entryPoints: [https]
      middlewares: [palco-retry]
      service: palco
      tls:
        certResolver: letsencrypt
  middlewares:
    palco-retry:
      retry:
        attempts: 25
        initialInterval: 300ms
  services:
    palco:
      loadBalancer:
        servers:
          - url: http://palco-live:8000
YAML
cmp -s $FILE.tmp $FILE 2>/dev/null && rm $FILE.tmp || mv $FILE.tmp $FILE
