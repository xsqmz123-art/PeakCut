import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import "./style.css";

const app = document.querySelector("#app");

app.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <div class="brand"><span class="brand-mark">P</span><span>PeakCut</span></div>
      <span class="local-pill"><i></i> Runs on this device</span>
    </header>

    <section class="intro">
      <p class="eyebrow">BROWSER CLIPPER</p>
      <h1>Turn a video into a <span>vertical clip.</span></h1>
      <p class="sub">Choose a video, select the moment you want, and export it in a Shorts / Reels format. Your video stays on your device.</p>
    </section>

    <section class="panel">
      <label class="file-picker" for="video-file">
        <span class="upload-icon">↑</span>
        <strong>Choose a video</strong>
        <span>MP4, MOV, WebM and other browser-supported video files</span>
        <small>For phones, start with a file under 100 MB. Maximum for this first version: 250 MB.</small>
      </label>
      <input id="video-file" type="file" accept="video/*" hidden />

      <div id="editor" class="editor" hidden>
        <div class="video-wrap"><video id="preview" controls playsinline></video></div>
        <div class="file-meta"><strong id="file-name"></strong><span id="file-duration"></span></div>
        <div class="time-grid">
          <label>Start time (seconds)<input id="start-time" type="number" min="0" step="0.1" value="0" inputmode="decimal"></label>
          <label>End time (seconds)<input id="end-time" type="number" min="0.1" step="0.1" value="30" inputmode="decimal"></label>
        </div>
        <p class="hint">Choose a segment up to 60 seconds. The centre of the video is cropped to a 9:16 vertical frame at 720 × 1280.</p>
        <button id="make-clip" class="primary" disabled>Create vertical clip</button>
        <button id="choose-another" class="secondary">Choose another video</button>
      </div>
    </section>

    <section id="status" class="status" aria-live="polite" hidden>
      <div class="status-line"><strong id="status-title">Preparing…</strong><span id="status-percent"></span></div>
      <div class="progress"><span id="progress-bar"></span></div>
      <p id="status-detail"></p>
    </section>

    <section id="result" class="result" hidden>
      <p class="eyebrow">YOUR CLIP IS READY</p>
      <video id="output-preview" controls playsinline></video>
      <a id="download" class="primary download" download="peakcut-vertical.mp4">Download clip</a>
    </section>

    <aside class="notice">
      <strong>Important for this free version</strong>
      <p>Processing happens inside your phone or computer browser, not on a server. Keep this page open while it works. Large videos may be slow or exceed your device's available memory.</p>
      <p>YouTube links aren't supported in this version. YouTube doesn't provide a reliable direct video file to browser pages; link importing would need a separate server. Use a video file you own or have permission to edit.</p>
    </aside>
    <footer>Private by design · No account · No upload · No subscription</footer>
  </main>
`;

const fileInput = document.querySelector("#video-file");
const editor = document.querySelector("#editor");
const preview = document.querySelector("#preview");
const fileName = document.querySelector("#file-name");
const fileDuration = document.querySelector("#file-duration");
const startInput = document.querySelector("#start-time");
const endInput = document.querySelector("#end-time");
const makeButton = document.querySelector("#make-clip");
const statusBox = document.querySelector("#status");
const statusTitle = document.querySelector("#status-title");
const statusPercent = document.querySelector("#status-percent");
const statusDetail = document.querySelector("#status-detail");
const progressBar = document.querySelector("#progress-bar");
const result = document.querySelector("#result");
const outputPreview = document.querySelector("#output-preview");
const download = document.querySelector("#download");

const MAX_FILE_BYTES = 250 * 1024 * 1024;
const MAX_CLIP_SECONDS = 60;
let selectedFile = null;
let sourceUrl = null;
let outputUrl = null;
let ffmpeg = null;
let ffmpegLoading = null;
let busy = false;

function showStatus(title, detail = "", percent = null) {
  statusBox.hidden = false;
  statusTitle.textContent = title;
  statusDetail.textContent = detail;
  statusPercent.textContent = percent === null ? "" : `${Math.round(percent * 100)}%`;
  progressBar.style.width = percent === null ? "0%" : `${Math.max(0, Math.min(100, percent * 100))}%`;
}

function validateTimes() {
  const start = Number(startInput.value);
  const end = Number(endInput.value);
  const duration = end - start;
  const valid = selectedFile && Number.isFinite(start) && Number.isFinite(end) &&
    start >= 0 && end > start && end <= selectedFile.duration + 0.05 &&
    duration <= MAX_CLIP_SECONDS && !busy;
  makeButton.disabled = !valid;
  return valid;
}

function cleanupOutput() {
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = null;
  outputPreview.removeAttribute("src");
  download.removeAttribute("href");
  result.hidden = true;
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  cleanupOutput();
  if (file.size > MAX_FILE_BYTES) {
    showStatus("That file is too large", "Choose a video under 250 MB for this first version.");
    fileInput.value = "";
    return;
  }
  selectedFile = null;
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceUrl = URL.createObjectURL(file);
  preview.src = sourceUrl;
  fileName.textContent = file.name;
  editor.hidden = false;
  statusBox.hidden = true;
  preview.onloadedmetadata = () => {
    selectedFile = { file, duration: preview.duration };
    fileDuration.textContent = `${preview.duration.toFixed(1)} sec · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
    startInput.value = "0";
    endInput.value = Math.min(30, preview.duration).toFixed(1);
    endInput.max = String(preview.duration);
    validateTimes();
  };
  preview.onerror = () => showStatus("Couldn't preview this file", "Try an MP4 video encoded with H.264.");
});

startInput.addEventListener("input", validateTimes);
endInput.addEventListener("input", validateTimes);

document.querySelector("#choose-another").addEventListener("click", () => {
  fileInput.value = "";
  fileInput.click();
});

async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  if (ffmpegLoading) return ffmpegLoading;
  ffmpegLoading = (async () => {
    const instance = new FFmpeg();
    instance.on("progress", ({ progress }) => {
      if (busy && Number.isFinite(progress)) {
        statusPercent.textContent = `${Math.round(progress * 100)}%`;
        progressBar.style.width = `${Math.max(0, Math.min(100, progress * 100))}%`;
      }
    });
    instance.on("log", ({ message }) => {
      if (message && /error/i.test(message)) statusDetail.textContent = message.slice(-180);
    });
    const base = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
    showStatus("Loading video engine…", "The first load downloads the browser video processor. It can be cached by your browser.");
    await instance.load({
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
    });
    ffmpeg = instance;
    return instance;
  })();
  try {
    return await ffmpegLoading;
  } finally {
    ffmpegLoading = null;
  }
}

makeButton.addEventListener("click", async () => {
  if (!validateTimes()) return;
  busy = true;
  makeButton.disabled = true;
  cleanupOutput();
  const start = Number(startInput.value);
  const duration = Number(endInput.value) - start;
  const inputName = "peakcut-input";
  const outputName = "peakcut-vertical.mp4";
  try {
    const engine = await getFFmpeg();
    showStatus("Creating your clip…", "Keep this tab open. Processing speed depends on your device.");
    await engine.writeFile(inputName, await fetchFile(selectedFile.file));
    const code = await engine.exec([
      "-ss", String(start),
      "-i", inputName,
      "-t", String(duration),
      "-map", "0:v:0",
      "-map", "0:a?",
      "-vf", "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280",
      "-r", "30",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "28",
      "-c:a", "aac",
      "-b:a", "96k",
      "-movflags", "+faststart",
      outputName
    ]);
    if (code !== 0) throw new Error("The video processor returned an error.");
    const data = await engine.readFile(outputName);
    const blob = new Blob([data.buffer], { type: "video/mp4" });
    outputUrl = URL.createObjectURL(blob);
    outputPreview.src = outputUrl;
    download.href = outputUrl;
    result.hidden = false;
    showStatus("Clip created!", "Your video is ready to preview and download.", 1);
  } catch (error) {
    console.error(error);
    showStatus("Couldn't create this clip", error?.message || "Try a shorter or smaller video, or another browser.");
  } finally {
    if (ffmpeg) {
      try { await ffmpeg.deleteFile(inputName); } catch {}
      try { await ffmpeg.deleteFile(outputName); } catch {}
    }
    busy = false;
    validateTimes();
  }
});

window.addEventListener("beforeunload", () => {
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  if (outputUrl) URL.revokeObjectURL(outputUrl);
});
