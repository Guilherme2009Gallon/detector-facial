/*
  Script comum (não módulo) com import() dinâmico: assim o site também funciona
  abrindo o index.html com duplo clique, sem servidor. O Chrome bloqueia <script type="module">
  externo em file://.
*/
(async () => {
"use strict";
const { FaceLandmarker, FilesetResolver, DrawingUtils } =
  await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm");
window.__appStarted = true;

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const $ = (id) => document.getElementById(id);
const video = $("video"), photo = $("photo"), canvas = $("overlay"), ctx = canvas.getContext("2d");
const frame = $("frame"), hero = $("hero"), heroTitle = $("heroTitle"), heroBody = $("heroBody");
const developEl = $("develop");
const chip = $("chip"), chipText = $("chipText"), chipCount = $("chipCount"), fpsEl = $("fps");
const btnCam = $("btnCam"), btnShot = $("btnShot"), fileInput = $("file");
const countEl = $("count"), facesEl = $("faces");
const strip = $("strip"), stripInfo = $("stripInfo"), btnClear = $("btnClear");

/* Cores do desenho sobre a imagem */
const OV = {
  mesh: "rgba(234,242,255,0.24)",
  line: "rgba(234,242,255,0.92)",
  iris: "#ffcf40",
  gold: "#ffcf40",
  goldInk: "#1b1400",
  deep: "rgba(4,17,43,0.82)",
  paper: "#eaf2ff",
  ink: "#071a3d"
};
const FONT = '"Archivo", "Segoe UI", system-ui, sans-serif';

let landmarker = null;
let mode = null;            // "camera" | "image" | null
let runningMode = "VIDEO";
let stream = null;
let rafId = null;
let lastVideoTime = -1;
let lastFrame = performance.now(), fpsSmooth = 0;
let objectUrl = null;
let last = null;            // último resultado, para redesenhar ao mudar as opções
let cyanOn = true;
let photos = [];            // fotos do banco, mais recentes primeiro
let lastNames = [];         // nomes reconhecidos no último quadro, gravados junto com a foto
const MAX_SHOTS = 4;

const drawing = new DrawingUtils(ctx);

/* ---------- Estado visual ---------- */
function setState(state, text) { chip.dataset.state = state; chipText.textContent = text; }
function setHero(title, body) { heroTitle.textContent = title; heroBody.innerHTML = body; hero.hidden = false; }
function setRatio(w, h) { frame.style.setProperty("--r", (w / h).toFixed(4)); }
function pulse(cls) {
  developEl.classList.remove("go", "flash");
  void developEl.offsetWidth;
  developEl.classList.add(cls);
}
function setControls() { btnShot.disabled = !mode; updateEnrollState(); }

/* ---------- Cianótipo / cor real ---------- */
const segCyan = $("segCyan"), segColor = $("segColor");
function setCyan(on) {
  cyanOn = on;
  frame.classList.toggle("cyan", on);
  segCyan.setAttribute("aria-pressed", String(on));
  segColor.setAttribute("aria-pressed", String(!on));
}
segCyan.addEventListener("click", () => setCyan(true));
segColor.addEventListener("click", () => setCyan(false));

/* ---------- Modelo ---------- */
async function createLandmarker(fileset, delegate) {
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: "VIDEO",
    numFaces: 4,
    outputFaceBlendshapes: true
  });
}

async function init() {
  try {
    const fileset = await FilesetResolver.forVisionTasks(WASM);
    try {
      landmarker = await createLandmarker(fileset, "GPU");
    } catch (gpuError) {
      landmarker = await createLandmarker(fileset, "CPU");
    }
    setHero("Olhe para a câmera.", "Ligue a câmera ou envie uma foto. O MediaPipe marca 478 pontos em cada rosto.");
    btnCam.disabled = false;
    fileInput.disabled = false;
    setState("ready", "Pronto");
  } catch (e) {
    console.error(e);
    const why = esc((e && e.message) ? e.message : String(e));
    setHero("Não carregou.", `Confira a internet e tente de novo. Detalhe do erro: <code>${why}</code>`);
    setState("error", "Erro");
  }
}

async function setRunningMode(m) {
  if (runningMode === m) return;
  await landmarker.setOptions({ runningMode: m });
  runningMode = m;
}

/* ---------- Câmera ---------- */
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      audio: false
    });
  } catch (e) {
    setState("error", "Câmera bloqueada");
    setHero("Sem acesso à câmera.", "Permita o uso da câmera nas configurações do navegador e tente de novo.");
    return;
  }
  await setRunningMode("VIDEO");
  recog = { items: [], t: 0, sticky: false };
  eyes.length = 0;
  photo.hidden = true;
  video.hidden = false;
  video.classList.add("mirror");
  video.srcObject = stream;
  await video.play();
  setRatio(video.videoWidth || 1280, video.videoHeight || 720);
  hero.hidden = true;
  mode = "camera";
  btnCam.textContent = "Desligar câmera";
  btnCam.classList.add("on");
  fpsEl.hidden = false;
  setState("live", "Ao vivo");
  setControls();
  pulse("go");
  lastVideoTime = -1;
  loop();
}

function stopCamera(showHero = true) {
  cancelAnimationFrame(rafId);
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
  video.hidden = true;
  mode = null;
  btnCam.textContent = "Ligar câmera";
  btnCam.classList.remove("on");
  fpsEl.hidden = true;
  last = null;
  recog = { items: [], t: 0, sticky: false };
  eyes.length = 0;
  showAlert(0);
  closeAll();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  setControls();
  renderReadout(0, []);
  chipCount.hidden = true;
  countEl.textContent = "Sem imagem";
  if (showHero) {
    setRatio(16, 9);
    setHero("Câmera desligada.", "Ligue de novo ou envie uma foto.");
    setState("ready", "Pronto");
  }
}

btnCam.addEventListener("click", () => {
  if (mode === "camera") stopCamera(); else startCamera();
});

function loop() {
  if (mode !== "camera") return;
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const result = landmarker.detectForVideo(video, performance.now());
    render(result, video.videoWidth, video.videoHeight, true);

    const now = performance.now();
    maybeRecognize(now);
    const inst = 1000 / (now - lastFrame);
    fpsSmooth = fpsSmooth ? fpsSmooth * 0.9 + inst * 0.1 : inst;
    lastFrame = now;
    fpsEl.textContent = Math.round(fpsSmooth) + " fps";
  }
  rafId = requestAnimationFrame(loop);
}

/* ---------- Foto ---------- */
fileInput.addEventListener("change", async () => {
  const f = fileInput.files[0];
  if (!f) return;
  if (mode === "camera") stopCamera(false);
  await setRunningMode("IMAGE");
  video.hidden = true;
  hero.hidden = true;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(f);
  photo.onload = async () => {
    setRatio(photo.naturalWidth, photo.naturalHeight);
    photo.hidden = false;
    const result = landmarker.detect(photo);
    mode = "image";
    recog = { items: [], t: 0, sticky: false };
    if (recReady && people.length) {
      try { recog = { items: await recognize(photo), t: 0, sticky: true }; } catch (e) { console.error(e); }
    }
    render(result, photo.naturalWidth, photo.naturalHeight, false);
    setState("photo", "Foto");
    setControls();
    pulse("go");
  };
  photo.src = objectUrl;
  fileInput.value = "";
});

/* ---------- Desenho sobre a imagem ---------- */
function brackets(x, y, w, h, len, lw, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x, y + len); ctx.lineTo(x, y); ctx.lineTo(x + len, y);
  ctx.moveTo(x + w - len, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + len);
  ctx.moveTo(x + w, y + h - len); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - len, y + h);
  ctx.moveTo(x + len, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - len);
  ctx.stroke();
}

function pill(text, x, y, fs, fill, color, canvasW) {
  ctx.font = `700 ${fs}px ${FONT}`;
  const padX = fs * 0.7, padY = fs * 0.42;
  const tw = ctx.measureText(text).width + padX * 2;
  const th = fs + padY * 2;
  const tx = Math.max(4, Math.min(x, canvasW - tw - 4));
  ctx.fillStyle = fill;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(tx, y, tw, th, th / 2); else ctx.rect(tx, y, tw, th);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, tx + padX, y + th / 2 + 1);
  return th;
}

function score(cats, name) {
  const c = cats.find(x => x.categoryName === name);
  return c ? c.score : 0;
}

function readFace(blend) {
  const cats = blend ? blend.categories : [];
  const smile = (score(cats, "mouthSmileLeft") + score(cats, "mouthSmileRight")) / 2;
  const jaw = score(cats, "jawOpen");
  const blink = (score(cats, "eyeBlinkLeft") + score(cats, "eyeBlinkRight")) / 2;
  const brow = score(cats, "browInnerUp");
  let label = "Neutro";
  if (smile > 0.5) label = "Sorrindo";
  else if (jaw > 0.45 && brow > 0.4) label = "Surpreso";
  else if (jaw > 0.45) label = "Boca aberta";
  else if (blink > 0.6) label = "Olhos fechados";
  return { smile, jaw, blink, brow, label };
}

function render(result, w, h, mirror, fresh = true) {
  last = { result, w, h, mirror };
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx.clearRect(0, 0, w, h);

  const faces = result.faceLandmarks || [];
  const blends = result.faceBlendshapes || [];
  const meshOn = $("optMesh").checked;
  const contOn = $("optContours").checked;
  const boxOn = $("optBox").checked;
  const lw = Math.max(1, w / 640);
  const fs = Math.max(13, w / 56);
  const ids = [], extras = [];
  const hide = $("optPrivacy").checked;
  const srcEl = mirror ? video : photo;
  const now = performance.now();
  if (mirror && fresh && eyes.length > faces.length) eyes.length = faces.length;

  faces.forEach((raw, i) => {
    const lm = mirror ? raw.map(p => ({ x: 1 - p.x, y: p.y, z: p.z })) : raw;
    const id = identify(raw, i);
    ids.push(id);

    const pose = headPose(raw, w, h);
    let eye = null;
    if (mirror) {
      if (fresh) trackEyes(i, readFace(blends[i]).blink, now);
      eye = eyeInfo(i, now);
    }
    extras.push({
      head: pose.head,
      tilt: pose.tilt,
      attentive: pose.attentive && !(eye && eye.closedMs > 700),
      blinks: eye ? eye.perMin : null,
      closedMs: eye ? eye.closedMs : 0
    });

    if (hide) pixelate(srcEl, raw, lm, w, h, mirror);

    if (meshOn) drawing.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_TESSELATION, { color: OV.mesh, lineWidth: lw * 0.55 });
    if (contOn) {
      const c = { color: OV.line, lineWidth: lw * 1.5 };
      drawing.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, { color: OV.line, lineWidth: lw * 1.8 });
      drawing.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_LIPS, c);
      drawing.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, c);
      drawing.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, c);
      drawing.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW, c);
      drawing.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW, c);
      drawing.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS, { color: OV.iris, lineWidth: lw * 1.8 });
      drawing.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS, { color: OV.iris, lineWidth: lw * 1.8 });
    }
    if (boxOn) {
      let minX = 1, minY = 1, maxX = 0, maxY = 0;
      for (const p of lm) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }
      const pad = 0.025;
      const bx = (minX - pad) * w, by = (minY - pad) * h;
      const bw = (maxX - minX + pad * 2) * w, bh = (maxY - minY + pad * 2) * h;
      brackets(bx, by, bw, bh, Math.min(bw, bh) * 0.2, lw * 2.8, id.known ? OV.gold : OV.paper);

      const state = readFace(blends[i]).label.toLowerCase();
      const th = fs + fs * 0.84;
      let ty = by - th - fs * 0.35;
      if (ty < 4) ty = by + fs * 0.35;
      pill(id.text, bx, ty, fs, id.known ? OV.gold : OV.paper, id.known ? OV.goldInk : OV.ink, w);
      let sy = by + bh - th - fs * 0.35;
      if (sy < ty + th) sy = by + bh + fs * 0.35;
      pill(state, bx + fs * 0.35, sy, fs, OV.deep, OV.paper, w);
    }
  });

  lastNames = ids.filter((x) => x.known).map((x) => x.name);
  showAlert(mirror ? extras.reduce((m, x) => Math.max(m, x.closedMs), 0) : 0);
  renderReadout(faces.length, blends, ids, extras);
}

/* ---------- Painel de leitura ---------- */
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function gauge(label, v) {
  const p = Math.round(clamp01(v) * 100);
  return `<div class="gauge"><div class="lab"><span>${label}</span><b>${p}%</b></div>
    <div class="rail"><span class="ticks"></span><span class="fill" style="width:${p}%"></span><span class="thumb" style="left:${p}%"></span></div></div>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function facts(x) {
  if (!x) return "";
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const rows = [
    ["Cabeça", cap(x.head), ""],
    ["Inclinação", cap(x.tilt), ""],
    ["Atenção", x.attentive ? "Na câmera" : "Desviada", x.attentive ? "yes" : ""]
  ];
  if (x.blinks != null) rows.push(["Piscadas", `${x.blinks} no último min`, ""]);
  return `<dl class="facts">${rows.map(([k, v, c]) => `<div><dt>${k}</dt><dd class="${c}">${esc(v)}</dd></div>`).join("")}</dl>`;
}

function faceBlock(id, state, r, ghost, known, extra) {
  return `<section class="face${ghost ? " ghost" : ""}">
    <div class="face-id${known ? " known" : ""}">${esc(id)}</div>
    <div class="face-state">${state}</div>
    ${facts(extra)}
    ${gauge("Sorriso", r.smile)}
    ${gauge("Boca aberta", r.jaw)}
    ${gauge("Piscando", r.blink)}
    ${gauge("Sobrancelhas levantadas", r.brow)}
  </section>`;
}

function renderReadout(n, blends, ids = [], extras = []) {
  const text = n === 1 ? "1 rosto" : n + " rostos";
  if (mode) {
    countEl.textContent = n === 0 ? "Nenhum rosto" : text;
    chipCount.textContent = text;
    chipCount.hidden = false;
  }
  if (!n) {
    const zero = { smile: 0, jaw: 0, blink: 0, brow: 0 };
    const id = mode ? "Chegue mais perto ou melhore a luz" : "A leitura aparece aqui";
    facesEl.innerHTML = faceBlock(id, "Sem rosto", zero, true);
    return;
  }
  facesEl.innerHTML = blends.map((b, i) => {
    const r = readFace(b);
    const id = ids[i] || { text: `Rosto ${i + 1}`, known: false };
    return faceBlock(id.text, r.label, r, false, id.known, extras[i]);
  }).join("");
}

/* ---------- Banco de dados (servidor local) e login ---------- */
let me = null;   // usuário logado

async function api(metodo, caminho, corpo) {
  let r;
  try {
    r = await fetch(caminho, {
      method: metodo,
      headers: corpo === undefined ? {} : { "Content-Type": "application/json" },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      credentials: "same-origin"
    });
  } catch (e) {
    const err = new Error("Servidor não encontrado.");
    err.offline = true;
    throw err;
  }
  let dados = null;
  try { dados = await r.json(); } catch (e) { /* resposta sem corpo */ }
  if (r.status === 401 && me) {          // sessão expirou: volta para o login
    me = null;
    resetData();
    showLogin(false);
  }
  if (!r.ok) {
    const err = new Error((dados && dados.erro) || `Erro ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return dados;
}

const dlgLogin = $("dlgLogin"), loginForm = $("loginForm"), loginOffline = $("loginOffline");
const loginTitle = $("loginTitle"), loginLead = $("loginLead"), setupFields = $("setupFields");
const setupNome = $("setupNome"), loginUser = $("loginUser"), loginPass = $("loginPass");
const loginError = $("loginError"), loginBtn = $("loginBtn"), btnRetry = $("btnRetry");
const account = $("account"), whoAmI = $("whoAmI"), btnUsers = $("btnUsers"), btnLogout = $("btnLogout");
const dlgUsers = $("dlgUsers"), usersList = $("usersList"), userForm = $("userForm"), userError = $("userError");

const openDialog = (d) => { if (!d.open) d.showModal(); };
const closeDialog = (d) => { if (d.open) d.close(); };
const showError = (el, texto) => { el.textContent = texto; el.hidden = false; };
dlgLogin.addEventListener("cancel", (e) => e.preventDefault());   // Esc não fecha o login

function showLogin(setup) {
  loginOffline.hidden = true;
  loginForm.hidden = false;
  setupFields.hidden = !setup;
  loginTitle.textContent = setup ? "Criar o primeiro usuário" : "Entrar";
  loginLead.textContent = setup
    ? "Esta conta será a administradora. Depois você pode criar outras."
    : "Use seu usuário e senha para abrir o detector.";
  loginPass.autocomplete = setup ? "new-password" : "current-password";
  loginBtn.textContent = setup ? "Criar e entrar" : "Entrar";
  loginError.hidden = true;
  account.hidden = true;
  openDialog(dlgLogin);
  (setup ? setupNome : loginUser).focus();
}

function showOffline() {
  loginForm.hidden = true;
  loginOffline.hidden = false;
  openDialog(dlgLogin);
}

function resetData() {
  if (mode === "camera") stopCamera();
  people = [];
  log = [];
  photos = [];
  open.clear();
  recog = { items: [], t: 0, sticky: false };
  renderPeople();
  renderPresence();
  renderStrip();
}

async function enter(u) {
  me = u;
  closeDialog(dlgLogin);
  whoAmI.textContent = u.nome;
  btnUsers.hidden = u.papel !== "admin";
  account.hidden = false;
  try {
    await Promise.all([loadPeople(), loadLog(), loadPhotos()]);
  } catch (e) {
    console.error(e);
    setMsg("Não consegui carregar os dados do banco: " + e.message);
  }
  recog = { items: [], t: 0, sticky: false };
  renderPeople();
  renderPresence();
  renderStrip();
}

async function boot() {
  let estado;
  try {
    estado = await api("GET", "/api/estado");
  } catch (e) {
    if (e.offline) { showOffline(); return; }
    throw e;
  }
  if (estado.usuario) await enter(estado.usuario);
  else showLogin(estado.precisaCriarAdmin);
}

btnRetry.addEventListener("click", boot);

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const setup = !setupFields.hidden;
  const usuario = loginUser.value.trim();
  const senha = loginPass.value;
  if (!usuario || !senha) { showError(loginError, "Preencha usuário e senha."); return; }
  loginBtn.disabled = true;
  try {
    const u = setup
      ? await api("POST", "/api/configurar", { nome: setupNome.value, usuario, senha })
      : await api("POST", "/api/entrar", { usuario, senha });
    loginPass.value = "";
    await enter(u);
  } catch (err) {
    showError(loginError, err.message);
  } finally {
    loginBtn.disabled = false;
  }
});

btnLogout.addEventListener("click", async () => {
  await closeAll();   // grava a presença de quem ainda está na câmera antes de sair
  try { await api("POST", "/api/sair"); } catch (e) { console.error(e); }
  me = null;
  resetData();
  showLogin(false);
});

async function renderUsers() {
  const lista = await api("GET", "/api/usuarios");
  usersList.textContent = "";
  for (const u of lista) {
    const li = document.createElement("li");
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = u.nome;
    const small = document.createElement("small");
    small.textContent = `@${u.usuario}, ${u.papel === "admin" ? "administrador" : "usuário"}`;
    who.appendChild(small);
    li.appendChild(who);
    if (me && u.id !== me.id) {
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "link danger";
      rm.textContent = "Remover";
      rm.setAttribute("aria-label", `Remover ${u.nome}`);
      rm.addEventListener("click", async () => {
        if (!window.confirm(`Remover o usuário ${u.nome}?`)) return;
        try {
          await api("DELETE", `/api/usuarios/${u.id}`);
          userError.hidden = true;
          await renderUsers();
        } catch (err) {
          showError(userError, err.message);
        }
      });
      li.appendChild(rm);
    }
    usersList.appendChild(li);
  }
}

btnUsers.addEventListener("click", async () => {
  userError.hidden = true;
  try {
    await renderUsers();
    openDialog(dlgUsers);
  } catch (e) {
    console.error(e);
  }
});
$("usersClose").addEventListener("click", () => closeDialog(dlgUsers));

userForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  userError.hidden = true;
  try {
    await api("POST", "/api/usuarios", {
      nome: $("newNome").value, usuario: $("newUser").value, senha: $("newPass").value, papel: $("newRole").value
    });
    userForm.reset();
    await renderUsers();
  } catch (err) {
    showError(userError, err.message);
  }
});

/* ---------- Reconhecimento (face-api.js) ---------- */
const MODELS_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model/";
const MATCH_MAX = 0.5;   // distância máxima para considerar a mesma pessoa (menor = mais rígido)
const SAMPLES = 3;       // amostras coletadas num cadastro pela câmera
const DEFAULT_MSG = "Ligue a câmera ou envie uma foto, digite um nome e cadastre.";

let recReady = false;
let people = [];
let recog = { items: [], t: 0, sticky: false };
let recBusy = false, lastRec = 0;

const personName = $("personName"), btnEnroll = $("btnEnroll"), enrollForm = $("enrollForm");
const enrollMsg = $("enrollMsg"), peopleList = $("peopleList"), peopleCount = $("peopleCount");
const btnForget = $("btnForget");

const detectorOptions = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const setMsg = (t) => { enrollMsg.textContent = t; };

async function loadPeople() {
  const lista = await api("GET", "/api/pessoas");
  people = lista.map((p) => ({ id: p.id, name: p.nome, descriptors: p.descritores, createdAt: p.criadoEm }));
}

function updateEnrollState() {
  btnEnroll.disabled = !(recReady && mode && personName.value.trim());
}
personName.addEventListener("input", updateEnrollState);

function renderPeople() {
  peopleCount.textContent = people.length === 0 ? "Nenhuma cadastrada" : people.length === 1 ? "1 pessoa" : `${people.length} pessoas`;
  peopleList.textContent = "";
  for (const p of people) {
    const li = document.createElement("li");
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = p.name;
    const small = document.createElement("small");
    small.textContent = `${p.descriptors.length} ${p.descriptors.length === 1 ? "amostra" : "amostras"}`;
    who.appendChild(small);
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "link danger";
    rm.textContent = "Remover";
    rm.setAttribute("aria-label", `Remover ${p.name}`);
    rm.addEventListener("click", async () => {
      try {
        await api("DELETE", `/api/pessoas/${p.id}`);
      } catch (err) {
        setMsg("Não consegui remover no banco: " + err.message);
        return;
      }
      people = people.filter((x) => x.id !== p.id);
      recog = { items: [], t: 0, sticky: false };
      renderPeople();
      redraw();
    });
    li.append(who, rm);
    peopleList.appendChild(li);
  }
  btnForget.hidden = people.length === 0;
  updateEnrollState();
}

btnForget.addEventListener("click", async () => {
  if (!window.confirm("Apagar todos os cadastros do banco de dados?")) return;
  try {
    await api("DELETE", "/api/pessoas");
  } catch (err) {
    setMsg("Não consegui apagar no banco: " + err.message);
    return;
  }
  people = [];
  recog = { items: [], t: 0, sticky: false };
  renderPeople();
  setMsg("Cadastros apagados.");
  redraw();
});

function distance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

function matchDescriptor(desc) {
  let best = { name: null, dist: Infinity };
  for (const p of people) {
    for (const q of p.descriptors) {
      const d = distance(desc, q);
      if (d < best.dist) best = { name: p.name, dist: d };
    }
  }
  return best.dist <= MATCH_MAX ? best : { name: null, dist: best.dist };
}

/* Detecta os rostos na imagem e diz quem é cada um. Posições normalizadas (0 a 1). */
async function recognize(src) {
  const det = await faceapi.detectAllFaces(src, detectorOptions()).withFaceLandmarks().withFaceDescriptors();
  const w = src.videoWidth || src.naturalWidth, h = src.videoHeight || src.naturalHeight;
  return det.map((d) => {
    const b = d.detection.box;
    const m = matchDescriptor(d.descriptor);
    return { cx: (b.x + b.width / 2) / w, cy: (b.y + b.height / 2) / h, w: b.width / w, name: m.name, dist: m.dist };
  });
}

function maybeRecognize(now) {
  if (!recReady || recBusy || !people.length || now - lastRec < 350) return;
  recBusy = true;
  lastRec = now;
  recognize(video)
    .then((items) => {
      recog = { items, t: performance.now(), sticky: false };
      const t = Date.now();
      for (const it of items) if (it.name) seen(it.name, t);
    })
    .catch((e) => console.error(e))
    .finally(() => { recBusy = false; });
}

/* Liga um rosto do MediaPipe ao resultado do reconhecimento mais próximo */
function identify(raw, i) {
  const fallback = { name: null, known: false, text: `Rosto ${i + 1}` };
  if (!people.length || !recog.items.length) return fallback;
  if (!recog.sticky && performance.now() - recog.t > 1500) return fallback;
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const p of raw) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, fw = maxX - minX;
  let best = null, bd = Infinity;
  for (const it of recog.items) {
    const d = Math.hypot(cx - it.cx, cy - it.cy);
    if (d < bd) { bd = d; best = it; }
  }
  if (!best || bd > Math.max(fw, best.w) * 0.6) return fallback;
  return best.name
    ? { name: best.name, known: true, text: best.name }
    : { name: null, known: false, text: "Desconhecido" };
}

enrollForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = personName.value.trim();
  if (!name || !mode || !recReady) return;
  btnEnroll.disabled = true;
  const src = mode === "camera" ? video : photo;
  const total = mode === "camera" ? SAMPLES : 1;
  const got = [];
  try {
    for (let i = 0; i < total; i++) {
      setMsg(total > 1 ? `Olhe para a câmera e mexa a cabeça devagar. Amostra ${i + 1} de ${total}.` : "Lendo o rosto da foto.");
      let desc = null;
      for (let tries = 0; tries < 6 && !desc; tries++) {
        const det = await faceapi.detectAllFaces(src, detectorOptions()).withFaceLandmarks().withFaceDescriptors();
        if (det.length === 1) {
          desc = det[0].descriptor;
        } else if (det.length > 1) {
          setMsg("Há mais de um rosto na imagem. Deixe só a pessoa que vai se cadastrar.");
          await wait(500);
        } else {
          setMsg("Nenhum rosto encontrado. Chegue mais perto e melhore a luz.");
          await wait(500);
        }
      }
      if (!desc) throw new Error("sem rosto");
      got.push(Array.from(desc));
      if (i < total - 1) await wait(600);
    }
    let p = people.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (p) {
      const novos = p.descriptors.concat(got).slice(-9);
      await api("PUT", `/api/pessoas/${p.id}`, { descritores: novos });
      p.descriptors = novos;
    } else {
      const c = await api("POST", "/api/pessoas", { nome: name, descritores: got });
      p = { id: c.id, name: c.nome, descriptors: c.descritores, createdAt: c.criadoEm };
      people.push(p);
    }
    renderPeople();
    personName.value = "";
    setMsg(`${name} cadastrado(a) no banco. Quando aparecer na imagem, o nome aparece junto ao rosto.`);
    if (mode === "image") recog = { items: await recognize(photo), t: 0, sticky: true };
    else lastRec = 0;
    redraw();
  } catch (err) {
    console.error(err);
    setMsg(err.status || err.offline
      ? "Não consegui salvar no banco: " + err.message
      : "Não consegui ler o rosto. Deixe só uma pessoa na imagem, com boa luz, e tente de novo.");
  } finally {
    updateEnrollState();
  }
});

async function initRecognition() {
  if (!window.faceapi) {
    setMsg("Reconhecimento indisponível: a biblioteca não carregou. Confira a internet.");
    return;
  }
  try {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODELS_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODELS_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODELS_URL)
    ]);
    recReady = true;
    setMsg(DEFAULT_MSG);
    updateEnrollState();
  } catch (e) {
    console.error(e);
    setMsg("Não foi possível carregar o reconhecimento. Confira a internet.");
  }
}

/* ---------- Cabeça, atenção e piscadas ---------- */
// Limites ajustáveis. A inclinação vertical depende do ângulo da câmera: se "para cima" ou "para baixo"
// aparecer com você olhando de frente, mexa em PITCH_MIN e PITCH_MAX.
const YAW_MAX = 0.11;                      // desvio do nariz em relação ao centro do rosto
const PITCH_MIN = 0.45, PITCH_MAX = 0.80;  // nariz entre a linha dos olhos e o queixo (de frente fica perto de 0.6)
const ROLL_MAX = 18;                       // graus de inclinação lateral aceitos como "atenção"
const CLOSED_ON = 0.55, CLOSED_OFF = 0.35; // histerese para olhos fechados e abertos
const DROWSY_MS = 1500;                    // olhos fechados por este tempo disparam o alerta
const eyes = [];                           // por rosto: { closed, since, blinks: [] }
const alertEl = $("alert");

function headPose(raw, w, h) {
  const nose = raw[1], chin = raw[152], r = raw[33], l = raw[263], e1 = raw[234], e2 = raw[454];
  const xl = Math.min(e1.x, e2.x), xr = Math.max(e1.x, e2.x);
  const yaw = (nose.x - xl) / Math.max(1e-6, xr - xl) - 0.5;          // > 0: virada para a esquerda da pessoa
  const eyeY = (r.y + l.y) / 2;
  const pitch = (nose.y - eyeY) / Math.max(1e-6, chin.y - eyeY);
  const [p, q] = r.x < l.x ? [r, l] : [l, r];
  const roll = Math.atan2((q.y - p.y) * h, (q.x - p.x) * w) * 180 / Math.PI; // > 0: inclinada para a esquerda
  const front = Math.abs(yaw) < YAW_MAX;
  const parts = [];
  if (!front) parts.push(yaw > 0 ? "virada à esquerda" : "virada à direita");
  if (pitch < PITCH_MIN) parts.push("para cima");
  else if (pitch > PITCH_MAX) parts.push("para baixo");
  const a = Math.abs(roll);
  return {
    head: parts.length ? parts.join(", ") : "de frente",
    tilt: a < 4 ? "reta" : `${Math.round(a)}° ${roll > 0 ? "à esquerda" : "à direita"}`,
    attentive: front && pitch >= PITCH_MIN && pitch <= PITCH_MAX && a <= ROLL_MAX
  };
}

function trackEyes(i, score, now) {
  const e = eyes[i] || (eyes[i] = { closed: false, since: 0, blinks: [] });
  if (!e.closed && score > CLOSED_ON) {
    e.closed = true;
    e.since = now;
  } else if (e.closed && score < CLOSED_OFF) {
    const dur = now - e.since;
    e.closed = false;
    if (dur >= 60 && dur <= 700) e.blinks.push(now);   // mais longo que isso não é piscada
  }
}

function eyeInfo(i, now) {
  const e = eyes[i];
  if (!e) return { perMin: 0, closedMs: 0 };
  e.blinks = e.blinks.filter((t) => now - t < 60000);
  return { perMin: e.blinks.length, closedMs: e.closed ? now - e.since : 0 };
}

function showAlert(ms) {
  if (ms >= DROWSY_MS) {
    alertEl.textContent = `Olhos fechados há ${Math.floor(ms / 1000)} s. Possível sonolência.`;
    alertEl.hidden = false;
  } else {
    alertEl.hidden = true;
  }
}

/* ---------- Ocultar rostos (pixelização) ---------- */
const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148,
  176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const px = document.createElement("canvas");
const pxc = px.getContext("2d", { willReadFrequently: true });

function pixelate(src, raw, lm, w, h, mirror) {
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const i of OVAL) {
    const p = raw[i];
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const pad = 0.02;
  const sx = Math.max(0, minX - pad) * w, sy = Math.max(0, minY - pad) * h;
  const sw = Math.min(1, maxX + pad) * w - sx, sh = Math.min(1, maxY + pad) * h - sy;
  if (sw < 4 || sh < 4) return;
  const cols = 12, rows = Math.max(2, Math.round(cols * sh / sw));
  px.width = cols;
  px.height = rows;
  pxc.drawImage(src, sx, sy, sw, sh, 0, 0, cols, rows);
  if (cyanOn) duotone(px);
  ctx.save();
  ctx.beginPath();
  OVAL.forEach((idx, k) => {
    const p = lm[idx];
    if (k) ctx.lineTo(p.x * w, p.y * h); else ctx.moveTo(p.x * w, p.y * h);
  });
  ctx.closePath();
  ctx.clip();
  ctx.imageSmoothingEnabled = false;
  if (mirror) {
    ctx.translate(w - sx, sy);
    ctx.scale(-1, 1);
    ctx.drawImage(px, 0, 0, sw, sh);
  } else {
    ctx.drawImage(px, sx, sy, sw, sh);
  }
  ctx.restore();
}

/* ---------- Registro de presença ---------- */
const GONE_MS = 3000;           // sem aparecer por este tempo = saiu
let log = [];                   // sessões encerradas: { name, in, out }
const open = new Map();         // quem está na câmera agora: name -> { in, last }
const presenceList = $("presenceList"), presenceCount = $("presenceCount"), presenceHint = $("presenceHint");
const btnCsv = $("btnCsv"), btnClearLog = $("btnClearLog"), optVoice = $("optVoice");
if (!("speechSynthesis" in window)) optVoice.closest(".chip").hidden = true;

async function loadLog() {
  const lista = await api("GET", "/api/presencas");
  log = lista.map((s) => ({ name: s.pessoa, in: s.entrada, out: s.saida }));
}

/* Grava uma sessão encerrada (entrada e saída) no banco */
function persistSession(s) {
  const p = people.find((x) => x.name === s.name);
  return api("POST", "/api/presencas", { pessoa: s.name, pessoaId: p ? p.id : null, entrada: s.in, saida: s.out })
    .catch((e) => console.error("Presença não salva no banco:", e));
}

function greet(name) {
  if (!optVoice.checked || !("speechSynthesis" in window)) return;
  try {
    const u = new SpeechSynthesisUtterance("Olá, " + name);
    u.lang = "pt-BR";
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (e) {}
}

function seen(name, now) {
  const o = open.get(name);
  if (o) { o.last = now; return; }
  open.set(name, { in: now, last: now });
  greet(name);
  renderPresence();
}

function sweep(now) {
  let changed = false;
  for (const [name, o] of open) {
    if (now - o.last > GONE_MS) {
      const s = { name, in: o.in, out: o.last };
      log.push(s);
      persistSession(s);
      open.delete(name);
      changed = true;
    }
  }
  if (changed) renderPresence();
}

function closeAll() {
  if (!open.size) return Promise.resolve();
  const gravando = [];
  for (const [name, o] of open) {
    const s = { name, in: o.in, out: o.last };
    log.push(s);
    gravando.push(persistSession(s));
  }
  open.clear();
  renderPresence();
  return Promise.all(gravando);
}

function summary() {
  const now = Date.now();
  const m = new Map();
  const add = (name, a, b, live) => {
    const r = m.get(name) || { name, first: a, total: 0, live: false };
    r.first = Math.min(r.first, a);
    r.total += Math.max(0, b - a);
    if (live) r.live = true;
    m.set(name, r);
  };
  log.forEach((s) => add(s.name, s.in, s.out, false));
  open.forEach((o, name) => add(name, o.in, now, true));
  return [...m.values()].sort((a, b) => (b.live - a.live) || (b.total - a.total));
}

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}
const fmtClock = (t) => new Date(t).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

function renderPresence() {
  const rows = summary();
  const here = rows.filter((r) => r.live).length;
  presenceCount.textContent = rows.length === 0 ? "Ninguém ainda"
    : here ? `${here} na câmera agora`
    : `${rows.length} ${rows.length === 1 ? "pessoa" : "pessoas"}`;
  presenceList.textContent = "";
  for (const r of rows) {
    const li = document.createElement("li");
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = r.name;
    const first = document.createElement("small");
    first.textContent = `Entrou às ${fmtClock(r.first)}`;
    who.appendChild(first);
    const st = document.createElement("span");
    st.className = "stay" + (r.live ? " live" : "");
    st.textContent = r.live ? "Presente" : "Ausente";
    const dur = document.createElement("small");
    dur.textContent = fmtDur(r.total);
    st.appendChild(dur);
    li.append(who, st);
    presenceList.appendChild(li);
  }
  presenceHint.hidden = rows.length > 0;
  btnCsv.hidden = btnClearLog.hidden = rows.length === 0;
}

function csvCell(v) {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // evita que a planilha trate o nome como fórmula
  return `"${s.replace(/"/g, '""')}"`;
}

btnCsv.addEventListener("click", () => {
  const all = log.slice();
  open.forEach((o, name) => all.push({ name, in: o.in, out: o.last }));
  all.sort((a, b) => a.in - b.in);
  const rows = [["Nome", "Entrada", "Saída", "Duração (s)"]].concat(all.map((s) => [
    s.name, new Date(s.in).toLocaleString("pt-BR"), new Date(s.out).toLocaleString("pt-BR"), Math.round((s.out - s.in) / 1000)
  ]));
  const blob = new Blob(["﻿" + rows.map((r) => r.map(csvCell).join(";")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "presenca.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

btnClearLog.addEventListener("click", async () => {
  if (!window.confirm("Apagar o registro de presença do banco de dados?")) return;
  try {
    await api("DELETE", "/api/presencas");
  } catch (err) {
    console.error(err);
    return;
  }
  log = [];
  const t = Date.now();
  open.forEach((o) => { o.in = t; });
  renderPresence();
});

setInterval(() => {
  sweep(Date.now());
  if (open.size) renderPresence();
}, 1000);

/* Fechou a aba com alguém ainda na câmera: grava a saída dessa pessoa */
window.addEventListener("pagehide", () => {
  if (!me) return;
  for (const [name, o] of open) {
    const p = people.find((x) => x.name === name);
    const corpo = JSON.stringify({ pessoa: name, pessoaId: p ? p.id : null, entrada: o.in, saida: o.last });
    try { navigator.sendBeacon("/api/presencas", new Blob([corpo], { type: "application/json" })); } catch (e) {}
  }
});

/* ---------- Fita de fotos ---------- */
const STOPS = [[7, 26, 61], [42, 99, 200], [234, 242, 255]];
const LUT = (() => {
  const t = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    const seg = v < 0.5 ? 0 : 1;
    const u = v < 0.5 ? v / 0.5 : (v - 0.5) / 0.5;
    const a = STOPS[seg], b = STOPS[seg + 1];
    for (let c = 0; c < 3; c++) t[i * 3 + c] = a[c] + (b[c] - a[c]) * u;
  }
  return t;
})();

function duotone(c) {
  const x = c.getContext("2d");
  const d = x.getImageData(0, 0, c.width, c.height);
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    let lum = p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114;
    lum = Math.min(255, Math.max(0, (lum - 128) * 1.12 + 128)) | 0;
    p[i] = LUT[lum * 3]; p[i + 1] = LUT[lum * 3 + 1]; p[i + 2] = LUT[lum * 3 + 2];
  }
  x.putImageData(d, 0, 0);
}

function capture() {
  if (!mode || !canvas.width) return;
  const src = mode === "camera" ? video : photo;
  const w = canvas.width, h = canvas.height;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const x = c.getContext("2d");
  if (mode === "camera") { x.translate(w, 0); x.scale(-1, 1); }
  x.drawImage(src, 0, 0, w, h);
  x.setTransform(1, 0, 0, 1, 0, 0);
  if (cyanOn) duotone(c);
  x.drawImage(canvas, 0, 0);
  pulse("flash");
  // Fotos muito grandes são reduzidas para caber no banco
  let out = c;
  if (w > 1600) {
    out = document.createElement("canvas");
    out.width = 1600;
    out.height = Math.round(h * 1600 / w);
    out.getContext("2d").drawImage(c, 0, 0, out.width, out.height);
  }
  api("POST", "/api/fotos", { imagem: out.toDataURL("image/jpeg", 0.92), pessoas: lastNames })
    .then(loadPhotos)
    .catch((e) => { stripInfo.textContent = "Não consegui salvar a foto: " + e.message; });
}

async function loadPhotos() {
  photos = await api("GET", "/api/fotos");
  renderStrip();
}

function renderStrip() {
  let html = "";
  for (let i = 0; i < MAX_SHOTS; i++) {
    const f = photos[i];
    html += f
      ? `<figure class="shot"><img src="/${esc(f.arquivo)}" alt="Foto capturada ${i + 1}"><a class="save" href="/${esc(f.arquivo)}" download="rosto-${esc(f.id)}.jpg">Salvar</a><button class="del" type="button" data-id="${esc(f.id)}">Excluir</button></figure>`
      : `<div class="slot"></div>`;
  }
  strip.innerHTML = html;
  btnClear.hidden = photos.length === 0;
  stripInfo.textContent = photos.length === 0 ? "Nenhuma foto salva"
    : photos.length <= MAX_SHOTS ? `${photos.length} ${photos.length === 1 ? "foto salva" : "fotos salvas"}`
    : `Últimas ${MAX_SHOTS} de ${photos.length} fotos salvas`;
}

btnShot.addEventListener("click", capture);

strip.addEventListener("click", async (e) => {
  const b = e.target.closest(".del");
  if (!b) return;
  try {
    await api("DELETE", `/api/fotos/${b.dataset.id}`);
    await loadPhotos();
  } catch (err) {
    stripInfo.textContent = "Não consegui excluir: " + err.message;
  }
});

btnClear.addEventListener("click", async () => {
  if (!window.confirm("Apagar todas as fotos salvas no banco de dados?")) return;
  try {
    await api("DELETE", "/api/fotos");
    await loadPhotos();
  } catch (err) {
    stripInfo.textContent = "Não consegui apagar: " + err.message;
  }
});

/* Malha, contornos e marcador: redesenha na hora, inclusive numa foto parada */
function redraw() {
  if (last) render(last.result, last.w, last.h, last.mirror, false);
}
["optMesh", "optContours", "optBox", "optPrivacy"].forEach((id) => $(id).addEventListener("change", redraw));

renderPeople();
renderPresence();
renderStrip();
renderReadout(0, []);
init();
initRecognition();
boot();
})().catch((e) => {
  console.error(e);
  const t = document.getElementById("heroTitle"), b = document.getElementById("heroBody");
  if (t) t.textContent = "Não carregou.";
  if (b) b.textContent = "Não consegui baixar o MediaPipe. Confira a internet e recarregue a página. Detalhe: " + ((e && e.message) || e);
  const c = document.getElementById("chip"), ct = document.getElementById("chipText");
  if (c) c.dataset.state = "error";
  if (ct) ct.textContent = "Erro";
});
