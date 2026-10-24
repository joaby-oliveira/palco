import asyncio

import uvicorn

from . import config, tls

if __name__ == "__main__":
    config.load()
    from .main import app, lan_ip

    port, https_port = config.get("port"), config.get("https_port")
    cert, key = tls.ensure(lan_ip())
    print(f"\n  Karaokê rodando em  http://localhost:{port}")
    print(f"  Câmera do celular (modo dança) em  https://{lan_ip()}:{https_port}/cam\n")
    # O mesmo app nas duas portas (um processo só: fila, festa e câmera compartilhadas).
    # Só o primeiro roda a inicialização, senão a fila de preparo começaria duas vezes.
    servers = [
        uvicorn.Server(uvicorn.Config(app, host="0.0.0.0", port=port, log_level="warning")),
        uvicorn.Server(uvicorn.Config(app, host="0.0.0.0", port=https_port, log_level="warning", lifespan="off",
                                      ssl_certfile=str(cert), ssl_keyfile=str(key))),
    ]

    async def serve():
        main, https = (asyncio.create_task(s.serve()) for s in servers)
        done, _ = await asyncio.wait({main, https}, return_when=asyncio.FIRST_COMPLETED)
        if done == {https} and (https.cancelled() or https.exception()):
            # Porta HTTPS ocupada ou certificado com problema: o karaokê segue sem a câmera do celular
            print(f"  (Não consegui abrir a porta {https_port}: a câmera do celular fica desligada.)")
            await main
            return
        # Ctrl+C chega a um dos dois: fecha o outro também
        for s in servers:
            s.should_exit = True
        await asyncio.gather(main, https, return_exceptions=True)

    asyncio.run(serve())
