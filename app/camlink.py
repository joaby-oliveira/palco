"""Celular como câmera do modo dança.

O celular roda o detector de pose e manda só os pontos do corpo (uns 2 KB por
quadro); o servidor repassa para o palco de dança aberto no notebook. Os dois
lados ficam sabendo um do outro: o palco, de quais celulares estão ligados; o
celular, se tem palco aberto recebendo.
"""
import json

from fastapi import WebSocket

MAX_MESSAGE = 20_000  # um quadro com duas pessoas tem bem menos que isso

stages: set[WebSocket] = set()
cams: set[WebSocket] = set()


async def _send(sockets: set[WebSocket], text: str):
    for ws in list(sockets):
        try:
            await ws.send_text(text)
        except Exception:  # noqa: BLE001 — conexão caiu no meio
            sockets.discard(ws)


async def to_stages(text: str):
    if len(text) <= MAX_MESSAGE:
        await _send(stages, text)


async def cam_status(cam_id: str, on: bool):
    await to_stages(json.dumps({"type": "cam", "id": cam_id, "on": on}))


async def stage_count():
    """Conta para os celulares quantos palcos de dança estão abertos."""
    await _send(cams, json.dumps({"type": "stages", "n": len(stages)}))
