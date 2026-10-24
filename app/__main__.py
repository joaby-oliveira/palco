import uvicorn

from . import config

if __name__ == "__main__":
    config.load()
    port = config.get("port")
    print(f"\n  Karaokê rodando em  http://localhost:{port}\n")
    uvicorn.run("app.main:app", host="0.0.0.0", port=port, log_level="warning")
