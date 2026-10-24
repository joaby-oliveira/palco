@echo off
cd /d "%~dp0"
if not exist .venv (
  echo Instalando pela primeira vez...
  uv venv --python 3.12 .venv
  uv pip install --python .venv -r pyproject.toml
)
echo Atualizando o yt-dlp (o YouTube muda direto e versoes velhas param de baixar)...
uv pip install --python .venv -q -U yt-dlp
rem O modo danca chegou depois: instala o MediaPipe em quem ja tinha o app
.venv\Scripts\python.exe -c "import mediapipe, cryptography" 2>nul || uv pip install --python .venv -q mediapipe cryptography
start "" http://localhost:8000
.venv\Scripts\python.exe -m app
pause
