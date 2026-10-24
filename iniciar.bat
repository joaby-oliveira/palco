@echo off
cd /d "%~dp0"
if not exist .venv (
  echo Instalando pela primeira vez...
  uv venv --python 3.12 .venv
  uv pip install --python .venv -r pyproject.toml
)
echo Atualizando o yt-dlp (o YouTube muda direto e versoes velhas param de baixar)...
uv pip install --python .venv -q -U yt-dlp
start "" http://localhost:8000
.venv\Scripts\python.exe -m app
pause
