/* «Калька» — референс поверх камеры телефона.
   Картинка лежит не прямоугольником, а четырёхугольником: телефон почти
   никогда не стоит перпендикулярно листу, поэтому наложение считается
   через гомографию — отметил углы листа, и референс сел в перспективу.
   Всё локально: картинка живёт в IndexedDB, никуда не уходит. */

const $ = s => document.querySelector(s);
const stage = $("#stage"), scene = $("#scene"), video = $("#cam"), frame = $("#frame");
const ov = $("#ov"), grid = $("#grid"), panel = $("#panel"), gate = $("#gate");
const hintEl = $("#hint"), zoomEl = $("#zoom");
const quadLayer = $("#quadLayer"), qSheet = $("#qSheet"), qImg = $("#qImg"), qHandles = $("#qHandles");
const fctx = frame.getContext("2d");
const octx = ov.getContext("2d");
const A4 = Math.SQRT2;

let stream = null;
let photoCv = null;              // референс как есть
let edgeCv = null;               // он же контуром
let edgeThr = 88;                // перцентиль порога контура
let mode = "photo";              // photo | edges | diff
let opacity = .45;
let frozen = false;              // на экране застывший кадр, а не живая камера
let zoomMode = false;            // жесты двигают всю сцену, а не референс
let frameMode = false;           // разметка углов листа
let ghost = false;               // в разметке показывать бледную картинку
let paperMode = "a4";            // a4 | free — во что вписывать картинку
let mirrored = false, blinkTimer = null, wakeLock = null;

let sheet = null;                // 4 угла листа в координатах сцены
let marks = null;                // пока размечаем — точки, поставленные касанием
let dragCorner = -1;
const V = { x: 0, y: 0, s: 1 };  // вид: сдвиг и приближение всей сцены
let lastSize = null;

/* ---------- хранилище ---------- */
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("kalka", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kvSet(k, v) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction("kv", "readwrite");
    t.objectStore("kv").put(v, k);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
}
async function kvGet(k) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction("kv", "readonly");
    const q = t.objectStore("kv").get(k);
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
}
const saveState = () => {
  try {
    localStorage.setItem("kalka.state", JSON.stringify({
      sheet, paperMode, mode, opacity, edgeThr, mirrored,
      grid: grid.classList.contains("on"), size: stageSize()
    }));
  } catch (e) {}
};

/* ---------- подсказка ---------- */
let hintTimer = null;
function hint(text, ms = 2400) {
  hintEl.textContent = text; hintEl.classList.add("on");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => hintEl.classList.remove("on"), ms);
}

/* ---------- камера ---------- */
async function startCamera() {
  const err = $("#err");
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
    gate.hidden = true;
    keepAwake(); syncFreezeBtn();
    hint("Наведите на лист и жмите «зафиксировать»", 3400);
  } catch (e) {
    err.hidden = false;
    err.textContent = (location.protocol !== "https:" && location.hostname !== "localhost")
      ? "Камера работает только по https. Откройте страницу по защищённому адресу."
      : "Камера не открылась: " + (e && e.message ? e.message : e) + ". Можно работать со снимком.";
  }
}
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch (e) {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && stream) keepAwake();
});

/* ---------- кадр ---------- */
function stageSize() {
  const r = stage.getBoundingClientRect();
  return { w: r.width, h: r.height, dpr: Math.min(2, window.devicePixelRatio || 1) };
}
function drawCover(ctx, src, sw, sh, dw, dh) {
  const k = Math.max(dw / sw, dh / sh), w = sw * k, h = sh * k;
  ctx.drawImage(src, (dw - w) / 2, (dh - h) / 2, w, h);
}
function grabFrame() {
  if (!stream || !video.videoWidth) return false;
  frame.width = video.videoWidth; frame.height = video.videoHeight;   // родное разрешение: есть что приближать
  fctx.clearRect(0, 0, frame.width, frame.height);
  fctx.drawImage(video, 0, 0);
  frame.style.display = "block"; video.style.visibility = "hidden";
  frozen = true; syncFreezeBtn();
  return true;
}
function goLive() {
  if (!stream) return;
  frame.style.display = "none"; video.style.visibility = "";
  frozen = false; syncFreezeBtn();
  setZoom(false); resetView();
  hint("Живая камера");
}
function setBackgroundImage(img) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const k = Math.min(1, 3000 / Math.max(iw, ih));
  frame.width = Math.round(iw * k); frame.height = Math.round(ih * k);
  fctx.clearRect(0, 0, frame.width, frame.height);
  fctx.drawImage(img, 0, 0, frame.width, frame.height);
  frame.style.display = "block"; video.style.visibility = "hidden";
  frozen = true; gate.hidden = true;
  syncFreezeBtn();
}

/* ---------- стоп-кадр, лупа ---------- */
function syncFreezeBtn() {
  const b = $("#bFix");
  b.textContent = frozen ? "живая камера" : "зафиксировать";
  b.disabled = frozen && !stream;
}
function setZoom(on) {
  zoomMode = on;
  $("#bZoom").classList.toggle("on", on);
  stage.style.cursor = on ? "grab" : "";
}
function freezeNow() {
  if (!grabFrame()) { hint("Камера не запущена"); return; }
  setZoom(false);
  hint("Кадр застыл. «Рамка» — отметить углы листа", 3200);
}

/* ---------- матрицы ---------- */
function mul3(a, b) {
  const r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    r[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
  return r;
}
function apply3(m, x, y) {
  const w = m[2][0] * x + m[2][1] * y + m[2][2];
  return { x: (m[0][0] * x + m[0][1] * y + m[0][2]) / w, y: (m[1][0] * x + m[1][1] * y + m[1][2]) / w };
}
/* Единичный квадрат → четырёхугольник (Heckbert): (0,0)→p0, (1,0)→p1, (1,1)→p2, (0,1)→p3. */
function unitToQuad(q) {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  let a, b, c, d, e, f, g = 0, h = 0;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    a = p1.x - p0.x; b = p2.x - p1.x; c = p0.x;
    d = p1.y - p0.y; e = p2.y - p1.y; f = p0.y;
  } else {
    const den = dx1 * dy2 - dy1 * dx2 || 1e-9;
    g = (dx3 * dy2 - dy3 * dx2) / den;
    h = (dx1 * dy3 - dy1 * dx3) / den;
    a = p1.x - p0.x + g * p1.x; b = p3.x - p0.x + h * p3.x; c = p0.x;
    d = p1.y - p0.y + g * p1.y; e = p3.y - p0.y + h * p3.y; f = p0.y;
  }
  return [[a, b, c], [d, e, f], [g, h, 1]];
}
function css3d(m) {
  return `matrix3d(${m[0][0]},${m[1][0]},0,${m[2][0]},` +
         `${m[0][1]},${m[1][1]},0,${m[2][1]},0,0,1,0,${m[0][2]},${m[1][2]},0,${m[2][2]})`;
}

/* ---------- лист и вписанная в него картинка ---------- */
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function sheetIsLandscape(q = sheet) {
  if (!q) return false;
  const w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  return w > h;
}
function paperAspect() {                       // ширина/высота листа
  if (paperMode === "free") return photoCv ? photoCv.width / photoCv.height : 1 / A4;
  return sheetIsLandscape() ? A4 : 1 / A4;
}
/* Доля листа, которую занимает картинка: вписываем целиком, без растяжения. */
function innerRect() {
  const ai = photoCv ? photoCv.width / photoCv.height : 1;
  const ar = paperAspect();
  let uw = 1, uh = 1;
  if (ai >= ar) uh = ar / ai; else uw = ai / ar;
  return { uw, uh, ux: (1 - uw) / 2, uy: (1 - uh) / 2 };
}
function imageMatrix() {
  const H = unitToQuad(sheet), { uw, uh, ux, uy } = innerRect();
  const iw = photoCv.width, ih = photoCv.height;
  return mul3(H, [[uw / iw, 0, ux], [0, uh / ih, uy], [0, 0, 1]]);
}
function imageQuad() {
  const H = unitToQuad(sheet), { uw, uh, ux, uy } = innerRect();
  return [[ux, uy], [ux + uw, uy], [ux + uw, uy + uh], [ux, uy + uh]].map(p => apply3(H, p[0], p[1]));
}
function defaultSheet() {
  const { w, h } = stageSize();
  const ar = paperMode === "free" && photoCv ? photoCv.width / photoCv.height
           : (photoCv && photoCv.width > photoCv.height ? A4 : 1 / A4);
  let sw = w * .84, sh = sw / ar;
  if (sh > h * .84) { sh = h * .84; sw = sh * ar; }
  const cx = w / 2, cy = h / 2;
  return [{ x: cx - sw / 2, y: cy - sh / 2 }, { x: cx + sw / 2, y: cy - sh / 2 },
          { x: cx + sw / 2, y: cy + sh / 2 }, { x: cx - sw / 2, y: cy + sh / 2 }];
}

/* ---------- отрисовка ---------- */
function paintOverlay() {
  const src = mode === "edges" ? edgeCv : photoCv;
  if (!src) { ov.style.display = "none"; quadLayer.classList.remove("on"); return; }
  if (!sheet && !marks) sheet = defaultSheet();
  if (marks) {                                   // разметка идёт — картинку не показываем
    ov.style.display = ghost && sheet ? "block" : "none";
    if (ghost && sheet) { ov.style.opacity = .3; applyOv(); }
    quadLayer.classList.add("on"); drawQuad(); updateNote();
    return;
  }
  if (ov.width !== src.width || ov.height !== src.height) { ov.width = src.width; ov.height = src.height; }
  octx.clearRect(0, 0, ov.width, ov.height);
  octx.drawImage(src, 0, 0);
  ov.style.width = src.width + "px";
  ov.style.height = src.height + "px";
  ov.classList.toggle("diff", mode === "diff");
  ov.style.display = "block";
  if (!blinkTimer) ov.style.opacity = opacity;
  quadLayer.classList.add("on");
  applyOv();
}
function applyOv() {
  if (!photoCv || !sheet) return;
  ov.style.transform = css3d(imageMatrix());
  drawQuad();
}
function activePts() { return marks || sheet || []; }
/* Плечи угольника смотрят на соседние углы: уголок ложится на угол листа. */
const AXES = [[[1, 0], [0, 1]], [[-1, 0], [0, 1]], [[-1, 0], [0, -1]], [[1, 0], [0, -1]]];
function cornerDirs(pts, i) {
  if (pts.length === 4) {
    const p = pts[i], a = pts[(i + 1) % 4], b = pts[(i + 3) % 4];
    const to = q => { const dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy) || 1; return { x: dx / l, y: dy / l }; };
    return [to(a), to(b)];
  }
  return (AXES[i] || AXES[0]).map(([x, y]) => ({ x, y }));
}
function drawQuad() {
  const pts4 = activePts();
  qSheet.setAttribute("points", pts4.map(p => `${p.x},${p.y}`).join(" "));
  qImg.setAttribute("points", (!marks && sheet && photoCv) ? imageQuad().map(p => `${p.x},${p.y}`).join(" ") : "");
  const NS = "http://www.w3.org/2000/svg", L = 30 / V.s;
  if (qHandles.childElementCount !== pts4.length * 3) {
    qHandles.innerHTML = "";
    for (let i = 0; i < pts4.length; i++) {
      qHandles.appendChild(document.createElementNS(NS, "path"));
      qHandles.appendChild(document.createElementNS(NS, "circle"));
      const t = document.createElementNS(NS, "text");
      t.textContent = i + 1;
      qHandles.appendChild(t);
    }
  }
  pts4.forEach((p, i) => {
    const [d0, d1] = cornerDirs(pts4, i);
    const path = qHandles.children[i * 3], dot = qHandles.children[i * 3 + 1], t = qHandles.children[i * 3 + 2];
    path.setAttribute("d", `M${p.x + d0.x * L} ${p.y + d0.y * L}L${p.x} ${p.y}L${p.x + d1.x * L} ${p.y + d1.y * L}`);
    path.classList.toggle("hot", dragCorner === i);
    dot.setAttribute("cx", p.x); dot.setAttribute("cy", p.y); dot.setAttribute("r", 2.6 / V.s);
    const bx = d0.x + d1.x, by = d0.y + d1.y, bl = Math.hypot(bx, by) || 1;
    t.setAttribute("x", p.x + bx / bl * 17 / V.s);
    t.setAttribute("y", p.y + by / bl * 17 / V.s + 5 / V.s);
    t.setAttribute("font-size", 14 / V.s);
  });
}
function applyView() {
  scene.style.transform = `translate(${V.x}px,${V.y}px) scale(${V.s})`;
  const on = Math.abs(V.s - 1) > .02;
  zoomEl.classList.toggle("on", on);
  if (on) zoomEl.textContent = V.s.toFixed(1).replace(".", ",") + "×";
  if (sheet) drawQuad();
}
function clampView() {
  const { w, h } = stageSize();
  const mx = Math.max(0, (w * V.s - w) / 2) + w * .3;
  const my = Math.max(0, (h * V.s - h) / 2) + h * .3;
  V.x = Math.max(-mx, Math.min(mx, V.x));
  V.y = Math.max(-my, Math.min(my, V.y));
}
function resetView() { V.x = 0; V.y = 0; V.s = 1; applyView(); }
function fit() {
  if (!photoCv) return;
  sheet = defaultSheet();
  applyOv(); saveState();
}

/* ---------- референс ---------- */
const MAX_SIDE = 1500;
function fileToImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = url;
  });
}
function toCanvas(img) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const k = Math.min(1, MAX_SIDE / Math.max(iw, ih));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(iw * k)); c.height = Math.max(1, Math.round(ih * k));
  c.getContext("2d", { willReadFrequently: true }).drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/* Контур: серый → лёгкое размытие → Собель → порог по перцентилю. */
function buildEdges(base, pct) {
  const w = base.width, h = base.height, n = w * h;
  const d = base.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const g = new Float32Array(n);
  for (let i = 0, p = 0; p < n; i += 4, p++) g[p] = d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114;

  const tmp = new Float32Array(n), b = new Float32Array(n);   // box-blur 3×3, раздельно
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, l = x > 0 ? g[i - 1] : g[i], r = x < w - 1 ? g[i + 1] : g[i];
    tmp[i] = (l + g[i] + r) / 3;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, u = y > 0 ? tmp[i - w] : tmp[i], dn = y < h - 1 ? tmp[i + w] : tmp[i];
    b[i] = (u + tmp[i] + dn) / 3;
  }

  const mag = new Float32Array(n);
  let max = 1e-6;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const a0 = b[i - w - 1], a1 = b[i - w], a2 = b[i - w + 1];
    const a3 = b[i - 1],                    a5 = b[i + 1];
    const a6 = b[i + w - 1], a7 = b[i + w], a8 = b[i + w + 1];
    const gx = (a2 + 2 * a5 + a8) - (a0 + 2 * a3 + a6);
    const gy = (a6 + 2 * a7 + a8) - (a0 + 2 * a1 + a2);
    const m = Math.hypot(gx, gy);
    mag[i] = m; if (m > max) max = m;
  }

  const BINS = 512, hist = new Uint32Array(BINS);
  for (let i = 0; i < n; i++) hist[Math.min(BINS - 1, (mag[i] / max * BINS) | 0)]++;
  const want = n * pct / 100;
  let acc = 0, bin = BINS - 1;
  for (let i = 0; i < BINS; i++) { acc += hist[i]; if (acc >= want) { bin = i; break; } }
  const lo = bin / BINS * max, hi = Math.max(lo * 2.2, lo + max * .04);

  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const oc = out.getContext("2d");
  const im = oc.createImageData(w, h), p = im.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const m = mag[i];
    if (m <= lo) continue;
    const a = Math.min(1, (m - lo) / (hi - lo));
    p[j] = 0xFF; p[j + 1] = 0x5A; p[j + 2] = 0x47; p[j + 3] = Math.round(a * 255);
  }
  oc.putImageData(im, 0, 0);
  return out;
}

async function useImage(file, { restore = false } = {}) {
  const img = await fileToImage(file);
  photoCv = toCanvas(img);
  edgeCv = buildEdges(photoCv, edgeThr);
  URL.revokeObjectURL(img.src);
  if (!restore) {
    sheet = defaultSheet();
    hint(a4Note(), 3600);
    kvSet("ref", file).catch(() => {});
  }
  paintOverlay();
  updateNote();
}

/* ---------- проверка на A4 ---------- */
function ratioText(ai) {
  const r = Math.max(ai, 1 / ai);
  return "1:" + r.toFixed(2).replace(".", ",");
}
function isA4(ai) { return Math.abs(Math.max(ai, 1 / ai) - A4) < .035; }
function a4Note() {
  if (!photoCv) return "";
  const ai = photoCv.width / photoCv.height, { uw, uh } = innerRect();
  const size = `Картинка ${photoCv.width}×${photoCv.height}, ${ratioText(ai)}` +
               (isA4(ai) ? " — это ровно A4" : ` — не A4 (${ratioText(A4)})`);
  if (uw > .99 && uh > .99) return size + ". Встанет во весь лист.";
  if ((ai > 1) !== (paperAspect() > 1))
    return size + ". Лист лежит поперёк картинки — «повернуть» развернёт её по листу.";
  return size + (uw > .99 ? ". Впишу по ширине: поля сверху и снизу."
                          : ". Впишу по высоте: поля по бокам.");
}
const CORNER_NAMES = ["левый верхний", "правый верхний", "правый нижний", "левый нижний"];
function startPlacing() {
  marks = []; dragCorner = -1;
  paintOverlay(); updateNote();
  hint("Ставьте угол 1: " + CORNER_NAMES[0] + " край листа", 3200);
}
function updateNote() {
  const n = $("#frameNote");
  n.hidden = !frameMode;
  if (n.hidden) return;
  if (marks) {
    const i = marks.length;
    n.textContent = i < 4
      ? `Угол ${i + 1} из 4 — ${CORNER_NAMES[i]} край листа. Касание ставит точку, два пальца приближают, точку можно перетащить.`
      : "";
  } else n.textContent = a4Note();
}

/* ---------- жесты ---------- */
const pts = new Map();
let prev = null, lastTap = 0, tapPos = null;
let panLock = false, grabOff = null, startPt = null;   // порог протяжки и захват угла «за место»

function toStage(e) {
  const r = stage.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  return { x: mirrored ? r.width - x : x, y };      // в зеркале двигаем так, как видим
}
function toScene(p) {
  const { w, h } = stageSize();
  return { x: (p.x - w / 2 - V.x) / V.s + w / 2, y: (p.y - h / 2 - V.y) / V.s + h / 2 };
}
function gather() {
  const a = [...pts.values()];
  const cx = a.reduce((s, p) => s + p.x, 0) / a.length;
  const cy = a.reduce((s, p) => s + p.y, 0) / a.length;
  let d = 1, ang = 0;
  if (a.length > 1) {
    d = Math.hypot(a[1].x - a[0].x, a[1].y - a[0].y) || 1;
    ang = Math.atan2(a[1].y - a[0].y, a[1].x - a[0].x);
  }
  return { cx, cy, d, ang, n: a.length };
}
function moveSheet(cur, k, p0, p1) {                 // весь лист следом за щепотью
  sheet = sheet.map(p => ({
    x: p1.x + (p.x - p0.x) * k,
    y: p1.y + (p.y - p0.y) * k
  }));
}
stage.addEventListener("pointerdown", e => {
  if (!photoCv && !zoomMode) return;
  try { stage.setPointerCapture(e.pointerId); } catch (err) {}
  pts.set(e.pointerId, toStage(e));
  prev = gather();
  dragCorner = -1; grabOff = null;
  if (pts.size === 1) { panLock = true; startPt = { x: prev.cx, y: prev.cy }; }
  else panLock = false;
  if (frameMode && pts.size === 1) {                  // взялись за уже поставленную точку?
    const p = toScene(toStage(e));
    let bi = -1, bd = 34 / V.s;
    activePts().forEach((c, i) => { const d = dist(c, p); if (d < bd) { bd = d; bi = i; } });
    dragCorner = bi;
    if (bi >= 0) {                                    // тащим «за место», а не подтягиваем к пальцу
      grabOff = { x: activePts()[bi].x - p.x, y: activePts()[bi].y - p.y };
      panLock = false; drawQuad();
    }
  }
  if (pts.size === 1) tapPos = { x: e.clientX, y: e.clientY, t: Date.now() };
});
stage.addEventListener("pointermove", e => {
  if (!pts.has(e.pointerId)) return;
  pts.set(e.pointerId, toStage(e));
  const cur = gather();
  if (!prev || cur.n !== prev.n) { prev = cur; return; }
  if (cur.n === 1 && panLock) {                        // короткое касание кадр не двигает
    if (Math.hypot(cur.cx - startPt.x, cur.cy - startPt.y) < 10) { prev = cur; return; }
    panLock = false;
  }
  if (dragCorner >= 0 && cur.n === 1) {
    const p = toScene({ x: cur.cx, y: cur.cy });
    activePts()[dragCorner] = { x: p.x + grabOff.x, y: p.y + grabOff.y };
    marks ? drawQuad() : applyOv();
  } else if (zoomMode || frameMode) {                  // в разметке пальцы возят кадр
    const k = cur.n > 1 ? cur.d / prev.d : 1;
    const { w, h } = stageSize();
    const ox = w / 2 + V.x, oy = h / 2 + V.y;
    V.x = cur.cx + (ox - prev.cx) * k - w / 2;
    V.y = cur.cy + (oy - prev.cy) * k - h / 2;
    V.s = Math.max(.5, Math.min(12, V.s * k));
    clampView(); applyView();
  } else if (sheet && !marks) {
    const k = cur.n > 1 ? cur.d / prev.d : 1;
    moveSheet(cur, k, toScene({ x: prev.cx, y: prev.cy }), toScene({ x: cur.cx, y: cur.cy }));
    applyOv();
  }
  prev = cur;
  if (tapPos && Math.hypot(e.clientX - tapPos.x, e.clientY - tapPos.y) > 12) tapPos = null;
});
function endPointer(e) {
  if (!pts.delete(e.pointerId)) return;
  prev = pts.size ? gather() : null;
  if (!pts.size) { dragCorner = -1; grabOff = null; panLock = false; drawQuad(); saveState(); }
  const wasTap = tapPos && Date.now() - tapPos.t < 400 && !pts.size;
  if (wasTap && marks && dragCorner < 0 && marks.length < 4) {     // касание ставит угол
    const r = stage.getBoundingClientRect();
    const x = tapPos.x - r.left, y = tapPos.y - r.top;
    marks.push(toScene({ x: mirrored ? r.width - x : x, y }));
    if (marks.length === 4) {
      sheet = marks; marks = null; dragCorner = -1;
      paintOverlay(); updateNote(); saveState();
      hint("Картинка легла в лист. Углы ещё можно поправить", 3200);
    } else {
      drawQuad(); updateNote();
      hint(`Угол ${marks.length + 1}: ${CORNER_NAMES[marks.length]} край`, 1800);
    }
  } else if (wasTap && !frameMode) {
    const now = Date.now();
    if (now - lastTap < 320) {
      zoomMode ? resetView() : fit();
      hint(zoomMode ? "Масштаб 1:1" : "Рамка сброшена");
      lastTap = 0;
    } else lastTap = now;
  }
  tapPos = null;
}
stage.addEventListener("pointerup", endPointer);
stage.addEventListener("pointercancel", endPointer);
stage.addEventListener("wheel", e => {
  if (!photoCv && !zoomMode) return;
  e.preventDefault();
  const r = stage.getBoundingClientRect();
  const cx = mirrored ? r.width - (e.clientX - r.left) : e.clientX - r.left, cy = e.clientY - r.top;
  const k = Math.exp(-e.deltaY * .0016);
  if (zoomMode || frameMode) {                       // в разметке колесо приближает кадр
    const ox = r.width / 2 + V.x, oy = r.height / 2 + V.y;
    V.x = cx + (ox - cx) * k - r.width / 2;
    V.y = cy + (oy - cy) * k - r.height / 2;
    V.s = Math.max(.5, Math.min(12, V.s * k));
    clampView(); applyView();
  } else if (sheet) {
    const p = toScene({ x: cx, y: cy });
    moveSheet(null, k, p, p);
    applyOv(); saveState();
  }
}, { passive: false });

/* ---------- режим рамки ---------- */
function setFrameMode(on) {
  frameMode = on;
  if (!on && marks) { marks = null; if (!sheet) sheet = defaultSheet(); }
  $("#bFrame").classList.toggle("on", on);
  quadLayer.classList.toggle("edit", on);
  $("#frameRow1").hidden = !on; $("#frameRow2").hidden = !on;
  $("#mainRow").hidden = on;
  panel.querySelector(".row").hidden = on;                 // ряд режимов
  $("#op").closest("label").hidden = on;
  $("#thrRow").hidden = on || mode !== "edges";
  paintOverlay();
  updateNote();
  if (on && !marks) hint("Углы можно тащить, «заново» — расставить с нуля", 3000);
}
$("#bFrame").onclick = () => setFrameMode(!frameMode);
$("#bFrameDone").onclick = () => { setFrameMode(false); hint("Картинка села в рамку"); saveState(); };
$("#bQuadReset").onclick = startPlacing;
$("#bTurn").onclick = () => {                      // сдвиг углов = поворот картинки на листе
  if (!sheet || marks) { hint("Сначала отметьте четыре угла"); return; }
  sheet = [sheet[1], sheet[2], sheet[3], sheet[0]];
  paintOverlay(); updateNote(); saveState();
  hint("Картинка повёрнута на листе");
};
$("#bGhost").onclick = () => {
  ghost = !ghost;
  $("#bGhost").classList.toggle("on", ghost);
  $("#bGhost").textContent = ghost ? "спрятать" : "показать";
  paintOverlay();
};
$("#bPaper").onclick = () => {
  paperMode = paperMode === "a4" ? "free" : "a4";
  $("#bPaper").textContent = paperMode === "a4" ? "лист: A4" : "лист: свободно";
  applyOv(); updateNote(); saveState();
};

/* ---------- кнопки ---------- */
$("#bStart").onclick = startCamera;
$("#bNoCam").onclick = () => $("#fileBg").click();
$("#bPick").onclick = () => $("#file").click();
$("#file").onchange = e => { const f = e.target.files[0]; if (f) useImage(f); e.target.value = ""; };
$("#fileBg").onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const img = await fileToImage(f); setBackgroundImage(img); URL.revokeObjectURL(img.src);
  e.target.value = "";
  hint("Снимок вместо камеры. «Рамка» — отметить углы листа", 3000);
};
$("#bFix").onclick = () => { frozen ? goLive() : freezeNow(); };
$("#bZoom").onclick = () => {
  setZoom(!zoomMode);
  hint(zoomMode ? "Лупа: пальцы приближают кадр, картинка стоит" : "Снова двигаем картинку");
};
$("#bFit").onclick = () => {
  if (zoomMode) { resetView(); hint("Масштаб 1:1"); }
  else { fit(); hint("Рамка сброшена в центр кадра"); }
};
$("#bGrid").onclick = () => {
  grid.classList.toggle("on");
  $("#bGrid").classList.toggle("on", grid.classList.contains("on"));
  saveState();
};
$("#bMirror").onclick = () => {
  mirrored = !mirrored;
  stage.classList.toggle("mirror", mirrored);
  $("#bMirror").classList.toggle("on", mirrored);
  hint(mirrored ? "Зеркало: свежий взгляд — ошибки видно сразу" : "Зеркало выключено");
  saveState();
};
$("#bPanel").onclick = () => {
  panel.classList.toggle("hidden");
  $("#bPanel").querySelector("svg").style.transform = panel.classList.contains("hidden") ? "rotate(180deg)" : "";
};
document.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => {
  mode = b.dataset.mode;
  document.querySelectorAll("[data-mode]").forEach(x => x.classList.toggle("on", x === b));
  $("#thrRow").hidden = mode !== "edges";
  paintOverlay(); saveState();
});
$("#op").oninput = e => { opacity = e.target.value / 100; if (!blinkTimer) ov.style.opacity = opacity; saveState(); };
$("#thr").onchange = e => {
  edgeThr = +e.target.value;
  if (photoCv) { edgeCv = buildEdges(photoCv, edgeThr); if (mode === "edges") paintOverlay(); }
  saveState();
};
$("#bBlink").onclick = () => {
  const b = $("#bBlink");
  if (blinkTimer) {
    clearInterval(blinkTimer); blinkTimer = null;
    ov.style.opacity = opacity; b.classList.remove("on"); return;
  }
  let on = true;
  blinkTimer = setInterval(() => { on = !on; ov.style.opacity = on ? Math.max(.85, opacity) : 0; }, 620);
  b.classList.add("on");
  hint("Мигание: разница в пропорциях бьёт по глазам");
};

/* ---------- снимок ---------- */
/* Canvas не умеет перспективу, поэтому картинка кладётся сеткой
   треугольников: внутри каждой ячейки искажение почти аффинное. */
function drawTri(ctx, img, s0, s1, s2, d0, d1, d2) {
  const cxx = (d0.x + d1.x + d2.x) / 3, cyy = (d0.y + d1.y + d2.y) / 3;
  const grow = p => ({ x: cxx + (p.x - cxx) * 1.02, y: cyy + (p.y - cyy) * 1.02 });  // без швов
  const e0 = grow(d0), e1 = grow(d1), e2 = grow(d2);
  ctx.save();
  ctx.beginPath(); ctx.moveTo(e0.x, e0.y); ctx.lineTo(e1.x, e1.y); ctx.lineTo(e2.x, e2.y); ctx.closePath();
  ctx.clip();
  const u1x = s1.x - s0.x, u1y = s1.y - s0.y, u2x = s2.x - s0.x, u2y = s2.y - s0.y;
  const v1x = d1.x - d0.x, v1y = d1.y - d0.y, v2x = d2.x - d0.x, v2y = d2.y - d0.y;
  const det = u1x * u2y - u2x * u1y;
  if (Math.abs(det) > 1e-9) {
    const a = (v1x * u2y - v2x * u1y) / det, b = (v1y * u2y - v2y * u1y) / det;
    const c = (v2x * u1x - v1x * u2x) / det, d = (v2y * u1x - v1y * u2x) / det;
    ctx.transform(a, b, c, d, d0.x - (a * s0.x + c * s0.y), d0.y - (b * s0.x + d * s0.y));
    ctx.drawImage(img, 0, 0);
  }
  ctx.restore();
}
$("#bSave").onclick = async () => {
  const { w, h, dpr } = stageSize();
  const out = document.createElement("canvas");
  out.width = Math.round(w * dpr); out.height = Math.round(h * dpr);
  const c = out.getContext("2d");
  const k = out.width / w;
  c.fillStyle = "#000"; c.fillRect(0, 0, out.width, out.height);
  c.save();
  if (mirrored) { c.translate(out.width, 0); c.scale(-1, 1); }
  c.translate(out.width / 2 + V.x * k, out.height / 2 + V.y * k);
  c.scale(V.s, V.s);
  c.translate(-out.width / 2, -out.height / 2);
  if (frozen) drawCover(c, frame, frame.width, frame.height, out.width, out.height);
  else if (video.videoWidth) drawCover(c, video, video.videoWidth, video.videoHeight, out.width, out.height);
  const src = mode === "edges" ? edgeCv : photoCv;
  if (src && sheet) {
    c.globalAlpha = blinkTimer ? Math.max(.85, opacity) : opacity;
    if (mode === "diff") c.globalCompositeOperation = "difference";
    const M = mul3([[k, 0, 0], [0, k, 0], [0, 0, 1]], imageMatrix());
    const N = 20, iw = src.width, ih = src.height;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const x0 = iw * i / N, x1 = iw * (i + 1) / N, y0 = ih * j / N, y1 = ih * (j + 1) / N;
      const s = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
      const d = s.map(p => apply3(M, p.x, p.y));
      drawTri(c, src, s[0], s[1], s[2], d[0], d[1], d[2]);
      drawTri(c, src, s[0], s[2], s[3], d[0], d[2], d[3]);
    }
  }
  c.restore();
  const blob = await new Promise(r => out.toBlob(r, "image/jpeg", .92));
  const file = new File([blob], "kalka-" + Date.now() + ".jpg", { type: "image/jpeg" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  hint("Снимок сохранён");
};

/* ---------- вставка и перетаскивание (десктоп) ---------- */
window.addEventListener("paste", e => {
  const it = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith("image/"));
  if (it) useImage(it.getAsFile());
});
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("drop", e => {
  e.preventDefault();
  const f = [...e.dataTransfer.files].find(x => x.type.startsWith("image/"));
  if (f) useImage(f);
});

/* ---------- восстановление ---------- */
(async () => {
  try {
    const st = JSON.parse(localStorage.getItem("kalka.state") || "null");
    if (st) {
      mode = st.mode || "photo"; opacity = st.opacity ?? .45; edgeThr = st.edgeThr || 88;
      paperMode = st.paperMode || "a4";
      $("#bPaper").textContent = paperMode === "a4" ? "лист: A4" : "лист: свободно";
      $("#op").value = Math.round(opacity * 100); $("#thr").value = edgeThr;
      document.querySelectorAll("[data-mode]").forEach(x => x.classList.toggle("on", x.dataset.mode === mode));
      $("#thrRow").hidden = mode !== "edges";
      if (st.grid) { grid.classList.add("on"); $("#bGrid").classList.add("on"); }
      if (st.mirrored) { mirrored = true; stage.classList.add("mirror"); $("#bMirror").classList.add("on"); }
      if (Array.isArray(st.sheet) && st.sheet.length === 4) {
        const cur = stageSize(), old = st.size || cur;      // экран мог сменить размер
        const kx = cur.w / (old.w || cur.w), ky = cur.h / (old.h || cur.h);
        sheet = st.sheet.map(p => ({ x: p.x * kx, y: p.y * ky }));
      }
    }
    let f = await kvGet("ref");
    const own = !!f;
    if (!f) {                                   // исходный референс зашит в приложение
      const r = await fetch("ref-default.png").catch(() => null);
      if (r && r.ok) f = new File([await r.blob()], "ref-default.png", { type: "image/png" });
    }
    if (f) {
      await useImage(f, { restore: true });
      if (!own && !(st && st.sheet)) fit();
    }
  } catch (e) {}
})();

/* Панели держатся за видимую часть экрана, а не за макетную:
   в Safari адресная строка иначе накрывает нижний ряд кнопок. */
function fitChrome() {
  const vv = window.visualViewport;
  if (!vv) return;
  const bottom = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
  const top = Math.max(0, Math.round(vv.offsetTop));
  document.documentElement.style.setProperty("--vvb", bottom + "px");
  document.documentElement.style.setProperty("--vvt", top + "px");
}
if (window.visualViewport) {
  visualViewport.addEventListener("resize", fitChrome);
  visualViewport.addEventListener("scroll", fitChrome);
}
window.addEventListener("orientationchange", () => setTimeout(fitChrome, 250));
window.addEventListener("resize", () => {
  const cur = stageSize();
  if (sheet && lastSize && lastSize.w && lastSize.h) {
    const kx = cur.w / lastSize.w, ky = cur.h / lastSize.h;
    if (Math.abs(kx - 1) > .01 || Math.abs(ky - 1) > .01)
      sheet = sheet.map(p => ({ x: p.x * kx, y: p.y * ky }));
  }
  lastSize = cur;
  applyOv(); fitChrome();
});
lastSize = stageSize();
fitChrome();
applyView();
syncFreezeBtn();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
