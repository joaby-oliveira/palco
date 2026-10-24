// Câmera da dança no celular: roda o detector de pose aqui mesmo e manda só os
// pontos do corpo para o palco no notebook (nenhuma imagem sai do celular).

import { flatten, SKELETON } from "/static/dance-score.js?v=3";

const $ = (id) => document.getElementById(id);
const MEDIAPIPE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1";
const MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";
const COLORS = ["#FFC93C", "#FF4FA3"];
const SEND_EVERY = 40; // ms entre envios (~25 por segundo)
const CAM_ID = Math.random().toString(36).slice(2, 10);
const video = $("video");

let ws = null;
let stages = 0;
let landmarker = null;
let facing = "environment";
let running = false;
let lastFrame = -1, lastStamp = 0, lastSent = 0;
let wakeLock = null;

// ---------- Conexão com o notebook ----------

function setLink(text, tone = "") {
  $("link").textContent = text;
  $("link").className = `link ${tone}`;
}

function linkStatus() {
  if (!ws || ws.readyState !== WebSocket.OPEN) setLink("Sem conexão com o notebook. Tentando de novo…", "warn");
  else if (!stages) setLink("Conectado. Abre uma música de dança no notebook.", "warn");
  else setLink(running ? "Mandando os movimentos para o telão" : "Conectado ao palco. Liga a câmera!", "ok");
}

function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/cam?id=${CAM_ID}`);
  ws.onopen = linkStatus;
  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === "stages") { stages = data.n; linkStatus(); }
  };
  ws.onclose = () => { linkStatus(); setTimeout(connect, 1500); };
}

// ---------- Câmera e detector ----------

async function loadDetector() {
  const { FilesetResolver, PoseLandmarker } = await import(`${MEDIAPIPE}/vision_bundle.mjs`);
  const files = await FilesetResolver.forVisionTasks(`${MEDIAPIPE}/wasm`);
  let lastError = null;
  for (const delegate of ["GPU", "CPU"]) {
    try {
      return await PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: "VIDEO", numPoses: 2,
      });
    } catch (e) { lastError = e; }
  }
  throw lastError;
}

async function openCamera() {
  if (video.srcObject) video.srcObject.getTracks().forEach((t) => t.stop());
  video.srcObject = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
  });
  await video.play();
  $("view").classList.toggle("front", facing === "user");
}

// A tela não pode apagar no meio da música
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { wakeLock = null; }
}
document.addEventListener("visibilitychange", () => { if (running && document.visibilityState === "visible") keepAwake(); });

async function start() {
  $("toggle").disabled = true;
  $("msg").textContent = "Ligando a câmera…";
  try {
    if (!landmarker) {
      const [l] = await Promise.all([loadDetector(), openCamera()]);
      landmarker = l;
    } else await openCamera();
  } catch (e) {
    console.error(e);
    $("msg").textContent = e.name === "NotAllowedError"
      ? "O celular bloqueou a câmera. Libera nas permissões do navegador e recarrega."
      : `Não deu para ligar a câmera (${e.message}).`;
    $("toggle").disabled = false;
    return;
  }
  running = true;
  $("msg").hidden = true;
  $("toggle").textContent = "PARAR";
  $("toggle").disabled = false;
  $("flip").disabled = false;
  keepAwake();
  linkStatus();
  requestAnimationFrame(loop);
}

function stop() {
  running = false;
  if (video.srcObject) video.srcObject.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
  if (wakeLock) wakeLock.release().catch(() => {});
  $("skeleton").getContext("2d").clearRect(0, 0, $("skeleton").width, $("skeleton").height);
  $("msg").hidden = false;
  $("msg").textContent = "Câmera desligada.";
  $("people").hidden = true;
  $("toggle").textContent = "LIGAR CÂMERA";
  $("flip").disabled = true;
  linkStatus();
}

$("toggle").addEventListener("click", () => (running ? stop() : start()));
$("flip").addEventListener("click", async () => {
  facing = facing === "environment" ? "user" : "environment";
  try { await openCamera(); } catch (e) { $("msg").hidden = false; $("msg").textContent = e.message; }
});

function loop() {
  if (!running) return;
  requestAnimationFrame(loop);
  if (video.readyState < 2 || video.currentTime === lastFrame) return;
  lastFrame = video.currentTime;
  const stamp = Math.max(performance.now(), lastStamp + 1);
  lastStamp = stamp;
  landmarker.detectForVideo(video, stamp, (res) => {
    const poses = (res.landmarks || []).map((lm) => flatten(lm).map((v) => Math.round(v * 1000) / 1000));
    draw(poses);
    if (ws && ws.readyState === WebSocket.OPEN && stamp - lastSent >= SEND_EVERY) {
      lastSent = stamp;
      ws.send(JSON.stringify({ type: "pose", id: CAM_ID, w: video.videoWidth, h: video.videoHeight, poses }));
    }
  });
}

function draw(poses) {
  const canvas = $("skeleton");
  const w = video.videoWidth, hgt = video.videoHeight;
  if (canvas.width !== w || canvas.height !== hgt) { canvas.width = w; canvas.height = hgt; }
  const g = canvas.getContext("2d");
  g.clearRect(0, 0, w, hgt);
  g.lineCap = "round";
  g.lineWidth = Math.max(5, w / 100);
  poses.forEach((p, i) => {
    g.strokeStyle = COLORS[i % COLORS.length];
    for (const [a, b] of SKELETON) {
      if (p[a * 3 + 2] < 0.5 || p[b * 3 + 2] < 0.5) continue;
      g.beginPath();
      g.moveTo(p[a * 3] * w, p[a * 3 + 1] * hgt);
      g.lineTo(p[b * 3] * w, p[b * 3 + 1] * hgt);
      g.stroke();
    }
  });
  $("people").hidden = false;
  $("people").textContent = poses.length === 0 ? "Ninguém à vista" : poses.length === 1 ? "1 pessoa" : "2 pessoas";
}

if (!window.isSecureContext || !navigator.mediaDevices) {
  $("msg").textContent = "Abre esta página pelo QR code do telão (endereço com https://).";
  $("toggle").disabled = true;
}
connect();
