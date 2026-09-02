/* «Калька» — референс поверх камеры телефона.
   «Зафиксировать» останавливает кадр; референс двигается пальцем всегда —
   и по живой картинке, и по застывшей. Лупа переключает жесты на сцену.
   Всё локально: картинка живёт в IndexedDB, никуда не уходит. */

const $ = s => document.querySelector(s);
const stage = $("#stage"), scene = $("#scene"), video = $("#cam"), frame = $("#frame");
const ov = $("#ov"), grid = $("#grid"), panel = $("#panel"), gate = $("#gate");
const hintEl = $("#hint"), zoomEl = $("#zoom");
const fctx = frame.getContext("2d");
const octx = ov.getContext("2d");

let stream = null;
let photoCv = null;              // референс как есть
let edgeCv = null;               // он же контуром
let edgeThr = 88;                // перцентиль порога контура
let mode = "photo";              // photo | edges | diff
let opacity = .45;
let frozen = false;              // на экране застывший кадр, а не живая камера
let zoomMode = false;            // жесты двигают всю сцену, а не референс
let mirrored = false, blinkTimer = null, wakeLock = null;

const T = { x: 0, y: 0, s: 1 };         // референс: сдвиг от центра и масштаб
const V = { x: 0, y: 0, s: 1 };         // вид: сдвиг и приближение всей сцены

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
      T, mode, opacity, edgeThr, mirrored, grid: grid.classList.contains("on")
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
    keepAwake();
    hint(photoCv ? "Наведите на лист и жмите «зафиксировать»" : "Теперь «референс» — выберите картинку", 3400);
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

/* ---------- стоп-кадр и лупа ---------- */
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
  hint("Кадр застыл. Двигайте референс: пальцем — по кадру, двумя — размер", 3400);
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

function paintOverlay() {
  const src = mode === "edges" ? edgeCv : photoCv;
  if (!src) { ov.style.display = "none"; return; }
  if (ov.width !== src.width || ov.height !== src.height) { ov.width = src.width; ov.height = src.height; }
  octx.clearRect(0, 0, ov.width, ov.height);
  octx.drawImage(src, 0, 0);
  ov.style.width = src.width + "px";
  ov.style.height = src.height + "px";
  ov.style.display = "block";
  ov.classList.toggle("diff", mode === "diff");
  if (!blinkTimer) ov.style.opacity = opacity;
  applyOv();
}
function applyOv() {
  ov.style.transform = `translate(-50%,-50%) translate(${T.x}px,${T.y}px) scale(${T.s})`;
}
function applyView() {
  scene.style.transform = `translate(${V.x}px,${V.y}px) scale(${V.s})`;
  const on = Math.abs(V.s - 1) > .02;
  zoomEl.classList.toggle("on", on);
  if (on) zoomEl.textContent = V.s.toFixed(1).replace(".", ",") + "×";
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
  const { w, h } = stageSize();
  T.s = Math.min(w / photoCv.width, h / photoCv.height) * .92;
  T.x = 0; T.y = 0;
  applyOv(); saveState();
}

async function useImage(file, { restore = false } = {}) {
  const img = await fileToImage(file);
  photoCv = toCanvas(img);
  edgeCv = buildEdges(photoCv, edgeThr);
  URL.revokeObjectURL(img.src);
  if (!restore) {
    fit();
    hint("Пальцем двигать, двумя — размер");
    kvSet("ref", file).catch(() => {});
  }
  paintOverlay();
}

/* ---------- жесты: до фиксации двигаем референс, после — всю сцену ---------- */
const pts = new Map();
let prev = null, lastTap = 0, tapPos = null;

function toStage(e) {
  const r = stage.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  return { x: mirrored ? r.width - x : x, y };      // в зеркале двигаем так, как видим
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
/* Экран → координаты сцены: после приближения палец проходит меньше, чем кажется. */
function toScene(p) {
  const { w, h } = stageSize();
  return { x: (p.x - w / 2 - V.x) / V.s + w / 2, y: (p.y - h / 2 - V.y) / V.s + h / 2 };
}
/* Общая математика: объект с центром O следует за щепотью пальцев. */
function drive(target, cur, inScene) {
  const k = cur.n > 1 ? cur.d / prev.d : 1;                    // поворота нет: только сдвиг и размер
  const { w, h } = stageSize();
  const p0 = inScene ? toScene({ x: prev.cx, y: prev.cy }) : { x: prev.cx, y: prev.cy };
  const p1 = inScene ? toScene({ x: cur.cx, y: cur.cy }) : { x: cur.cx, y: cur.cy };
  const ox = w / 2 + target.x, oy = h / 2 + target.y;
  target.x = p1.x + (ox - p0.x) * k - w / 2;
  target.y = p1.y + (oy - p0.y) * k - h / 2;
  return k;
}
stage.addEventListener("pointerdown", e => {
  if (!photoCv && !zoomMode) return;
  try { stage.setPointerCapture(e.pointerId); } catch (err) {}
  pts.set(e.pointerId, toStage(e));
  prev = gather();
  if (pts.size === 1) tapPos = { x: e.clientX, y: e.clientY, t: Date.now() };
});
stage.addEventListener("pointermove", e => {
  if (!pts.has(e.pointerId)) return;
  pts.set(e.pointerId, toStage(e));
  const cur = gather();
  if (!prev || cur.n !== prev.n) { prev = cur; return; }
  if (zoomMode) {
    const k = drive(V, cur, false);
    V.s = Math.max(.5, Math.min(12, V.s * k));
    clampView(); applyView();
  } else {
    const k = drive(T, cur, true);
    T.s = Math.max(.03, Math.min(40, T.s * k));
    applyOv();
  }
  prev = cur;
  if (tapPos && Math.hypot(e.clientX - tapPos.x, e.clientY - tapPos.y) > 12) tapPos = null;
});
function endPointer(e) {
  if (!pts.delete(e.pointerId)) return;
  prev = pts.size ? gather() : null;
  if (!zoomMode) saveState();
  if (tapPos && Date.now() - tapPos.t < 300 && !pts.size) {     // двойное касание
    const now = Date.now();
    if (now - lastTap < 320) { zoomMode ? resetView() : fit(); hint(zoomMode ? "Масштаб 1:1" : "Референс вписан"); lastTap = 0; }
    else lastTap = now;
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
  const t = zoomMode ? V : T;
  const p = zoomMode ? { x: cx, y: cy } : toScene({ x: cx, y: cy });
  const ox = r.width / 2 + t.x, oy = r.height / 2 + t.y;
  t.x = p.x + (ox - p.x) * k - r.width / 2;
  t.y = p.y + (oy - p.y) * k - r.height / 2;
  if (zoomMode) { V.s = Math.max(.5, Math.min(12, V.s * k)); clampView(); applyView(); }
  else { T.s = Math.max(.03, Math.min(40, T.s * k)); applyOv(); saveState(); }
}, { passive: false });

/* ---------- кнопки ---------- */
$("#bStart").onclick = startCamera;
$("#bNoCam").onclick = () => $("#fileBg").click();
$("#bPick").onclick = () => $("#file").click();
$("#file").onchange = e => { const f = e.target.files[0]; if (f) useImage(f); e.target.value = ""; };
$("#fileBg").onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const img = await fileToImage(f); setBackgroundImage(img); URL.revokeObjectURL(img.src);
  e.target.value = "";
  hint("Снимок вместо камеры. «Референс» — и сверяйте.", 3000);
};
$("#bFix").onclick = () => { frozen ? goLive() : freezeNow(); };
$("#bZoom").onclick = () => {
  setZoom(!zoomMode);
  hint(zoomMode ? "Лупа: пальцы приближают кадр, референс стоит" : "Снова двигаем референс");
};
$("#bFit").onclick = () => {
  if (zoomMode) { resetView(); hint("Масштаб 1:1"); }
  else { fit(); hint("Референс вписан в кадр"); }
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
  if (src) {
    c.save();
    c.translate((w / 2 + T.x) * k, (h / 2 + T.y) * k);
    c.scale(T.s * k, T.s * k);
    c.globalAlpha = blinkTimer ? Math.max(.85, opacity) : opacity;
    if (mode === "diff") c.globalCompositeOperation = "difference";
    c.drawImage(src, -src.width / 2, -src.height / 2);
    c.restore();
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
      Object.assign(T, st.T || {});
      mode = st.mode || "photo"; opacity = st.opacity ?? .45; edgeThr = st.edgeThr || 88;
      $("#op").value = Math.round(opacity * 100); $("#thr").value = edgeThr;
      document.querySelectorAll("[data-mode]").forEach(x => x.classList.toggle("on", x.dataset.mode === mode));
      $("#thrRow").hidden = mode !== "edges";
      if (st.grid) { grid.classList.add("on"); $("#bGrid").classList.add("on"); }
      if (st.mirrored) { mirrored = true; stage.classList.add("mirror"); $("#bMirror").classList.add("on"); }
    }
    let f = await kvGet("ref");
    let own = !!f;
    if (!f) {                                   // исходный референс зашит в приложение
      const r = await fetch("ref-default.png").catch(() => null);
      if (r && r.ok) f = new File([await r.blob()], "ref-default.png", { type: "image/png" });
    }
    if (f) {
      await useImage(f, { restore: true });
      if (!own && !(st && st.T)) fit();
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
fitChrome();

applyView();
syncFreezeBtn();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
