"use strict";

const byId = (id) => document.getElementById(id);
const pdfInput = byId("pdf-input");
const videoInput = byId("video-input");
const sampleButton = byId("use-sample");
const sampleStoryboardButton = byId("view-sample");
const submitButton = byId("prepare-project");
const promptBox = byId("adal-prompt");
const importInput = byId("import-video");
const renderButton = byId("render-preview");
const retryButton = byId("retry-generation");
const generationProgress = byId("generation-progress");
const manualProduction = byId("manual-production");
const sourceVideo = byId("source-video");
const outputVideo = byId("output-video");
const chapterList = byId("chapter-list");
const notesCard = pdfInput.closest(".upload-card");
const recordingCard = videoInput.closest(".upload-card");
const recordingHint = byId("video-detail").textContent;
const notesHint = byId("pdf-detail").textContent;

let sample = null;
let usingSample = false;
let job = null;
let chapters = [];
let chapterIndex = 0;
let sourcePdf = null;
let sourceObjectUrl = null;
let pollTimer = null;
let uploading = false;
let activeOutput = null;
let generationAvailable = false;

function showStatus(id, message, isError = false) {
  const status = byId(id);
  if (status.textContent !== message) status.textContent = message;
  status.classList.toggle("error", isError);
}

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.detail ?? data?.message ?? data?.error;
    const error = new Error(typeof detail === "string" ? detail : "The request could not be completed.");
    error.status = response.status;
    throw error;
  }
  if (!data || typeof data !== "object") {
    throw new Error("The server returned an unexpected response.");
  }
  return data;
}

function selectChapter(index) {
  if (!chapters.length) return;
  chapterIndex = (index + chapters.length) % chapters.length;
  const chapter = chapters[chapterIndex];
  const image = byId("chapter-image");
  image.parentElement.hidden = !chapter.asset_url;
  if (chapter.asset_url) {
    image.src = chapter.asset_url;
    image.alt = `Illustration of ${chapter.title}`;
  } else {
    image.removeAttribute("src");
    image.alt = "";
  }
  byId("chapter-place").textContent = [chapter.place, chapter.era].filter(Boolean).join(" · ");
  byId("chapter-title").textContent = chapter.title || `Page ${chapter.page}`;
  byId("chapter-narration").textContent = chapter.narration || "";
  byId("chapter-narration").hidden = !chapter.narration;
  byId("chapter-visual").textContent = chapter.visual || "";
  byId("chapter-visual").hidden = !chapter.visual;
  const link = byId("chapter-source");
  link.hidden = !sourcePdf || !chapter.page;
  if (!link.hidden) {
    link.href = `${sourcePdf.split("#")[0]}#page=${encodeURIComponent(chapter.page)}`;
    link.textContent = `Open source PDF · page ${chapter.page} ↗`;
  }
  for (const [buttonIndex, button] of Array.from(chapterList.children).entries()) {
    button.setAttribute("aria-pressed", String(buttonIndex === chapterIndex));
  }
  const selected = chapterList.children[chapterIndex];
  const stripBounds = chapterList.getBoundingClientRect();
  const selectedBounds = selected.getBoundingClientRect();
  if (selectedBounds.right > stripBounds.right) {
    chapterList.scrollLeft += selectedBounds.right - stripBounds.right + 4;
  } else if (selectedBounds.left < stripBounds.left) {
    chapterList.scrollLeft -= stripBounds.left - selectedBounds.left + 4;
  }
}

function showStoryboard(nextChapters, pdfUrl, label, emptyMessage) {
  chapters = Array.isArray(nextChapters) ? nextChapters : [];
  sourcePdf = pdfUrl;
  byId("storyboard").hidden = false;
  byId("storyboard-label").textContent = label;
  byId("chapter-view").hidden = !chapters.length;
  byId("chapter-controls").hidden = chapters.length < 2;
  chapterList.hidden = chapters.length < 2;
  showStatus("storyboard-status", chapters.length ? "" : emptyMessage);
  chapterList.replaceChildren(...chapters.map((chapter, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = chapter.title || `Page ${chapter.page}`;
    button.addEventListener("click", () => selectChapter(index));
    return button;
  }));
  selectChapter(0);
}

function jobUrl(suffix = "") {
  return `/api/project/${encodeURIComponent(job.job_id)}${suffix}`;
}

function productionIsRunning() {
  return job?.status === "rendering" || job?.generation?.status === "running";
}

function refreshOutputActions() {
  const busy = uploading || activeOutput !== null || productionIsRunning();
  submitButton.disabled = busy || Boolean(job);
  pdfInput.disabled = busy;
  videoInput.disabled = busy;
  sampleButton.disabled = busy || !sample?.pdf_url;
  renderButton.disabled = busy || renderButton.hidden;
  retryButton.disabled = busy || retryButton.hidden;
  importInput.disabled = busy || !job;
  generationProgress.hidden = !activeOutput && !productionIsRunning();
}

function refreshSubmitLabel() {
  byId("prepare-label").textContent = uploading
    ? "Uploading files…"
    : generationAvailable ? "Generate lesson video" : "Prepare lesson";
}

function showJob(update) {
  job = update;
  byId("production").hidden = false;
  promptBox.value = job.adal_prompt || "";
  byId("copy-prompt").disabled = !promptBox.value;
  const canGenerate = job.generation_available ?? generationAvailable;
  const generationFailed = job.generation?.status === "error";
  const generationRunning = job.generation?.status === "running";
  const renderUrl = job.render_url;
  const hasAdalVideo = Boolean(renderUrl) && job.render_mode === "adal";
  const showFallback = !hasAdalVideo && !generationRunning && (!canGenerate || generationFailed);

  retryButton.hidden = !canGenerate || generationRunning || hasAdalVideo;
  retryButton.textContent = generationFailed ? "Retry generation" : "Generate lesson video";
  renderButton.hidden = !job.chapters?.length || !showFallback;
  byId("video-actions").hidden = retryButton.hidden && renderButton.hidden;
  manualProduction.hidden = !showFallback;
  let nextStep = "";
  if (!hasAdalVideo && !canGenerate) {
    nextStep = "Automatic generation is unavailable here. Open the manual AdaL workflow below to make and import your lesson.";
  } else if (!hasAdalVideo && generationFailed) {
    nextStep = "Your source files are saved. Try AdaL again or finish the video manually.";
  }
  byId("playback-detail").textContent = nextStep;
  byId("render-result").hidden = !renderUrl;
  if (renderUrl) {
    byId("video-output-label").textContent = hasAdalVideo ? "AdaL video" : "Local preview";
    if (outputVideo.getAttribute("src") !== renderUrl) {
      showStatus("output-playback-status", "");
      outputVideo.src = renderUrl;
    }
    byId("download-render").href = renderUrl;
  } else if (outputVideo.hasAttribute("src")) {
    outputVideo.removeAttribute("src");
    outputVideo.load();
  }
  let message = job.message || "";
  let isError = job.status === "error";
  if (hasAdalVideo) {
    message ||= "AdaL lesson ready to play.";
    isError = false;
  } else if (generationRunning) {
    message = job.generation.message || "AdaL is creating your lesson…";
    isError = false;
  } else if (job.status !== "rendering" && !isError) {
    if (renderUrl && job.render_mode === "preview") {
      message = "Local preview ready to play. It uses the original recording and example illustrations.";
    } else if (generationFailed) {
      message = job.generation.message || "AdaL could not generate the lesson.";
      isError = true;
    }
  }
  showStatus("render-status", message, isError);
  refreshOutputActions();
  clearTimeout(pollTimer);
  if (productionIsRunning()) {
    pollTimer = setTimeout(() => pollJob(job.job_id), 1500);
  }
}

async function pollJob(jobId) {
  try {
    const update = await request(`/api/project/${encodeURIComponent(jobId)}`);
    if (job?.job_id === jobId) showJob(update);
  } catch (error) {
    if (job?.job_id !== jobId) return;
    if (error.status === 404) {
      clearProject();
      refreshOutputActions();
      showStatus("project-status", "The server lost this project. Your files are still selected. Try again to re-upload them.", true);
      byId("studio").scrollIntoView({ block: "start" });
      return;
    }
    showStatus("render-status", `Could not check progress. Retrying. ${error.message}`, true);
    pollTimer = setTimeout(() => pollJob(jobId), 3000);
  }
}

function showSample() {
  if (sample) {
    showStoryboard(sample.chapters, sample.pdf_url, "SEVEN WONDERS EXAMPLE", "The example has no scenes.");
  }
}

function clearProject() {
  if (!job) return;
  job = null;
  clearTimeout(pollTimer);
  outputVideo.removeAttribute("src");
  outputVideo.load();
  byId("production").hidden = true;
  manualProduction.open = false;
  showStatus("copy-status", "");
  byId("storyboard").hidden = true;
}

function showInputStatus() {
  const hasNotes = usingSample || pdfInput.files.length;
  const hasRecording = videoInput.files.length;
  let message = "Add both files to continue.";
  if (hasNotes && hasRecording) {
    message = generationAvailable
      ? "Both files are ready for AdaL."
      : "Both files are ready. Prepare them to use in AdaL.";
  } else if (hasNotes) {
    message = "Choose a presenter recording to continue.";
  } else if (hasRecording) {
    message = "Choose a source PDF to continue.";
  }
  showStatus("project-status", message);
  refreshOutputActions();
}

sampleButton.addEventListener("click", () => {
  if (!sample) return;
  usingSample = true;
  pdfInput.value = "";
  notesCard.classList.add("is-ready");
  byId("pdf-detail").textContent = "Seven Wonders of the Ancient World · example notes selected";
  clearProject();
  showInputStatus();
  byId("studio").scrollIntoView({ block: "start" });
});

sampleStoryboardButton.addEventListener("click", () => {
  if (!sample?.chapters?.length) return;
  showSample();
  byId("storyboard-heading").focus({ preventScroll: true });
  byId("storyboard").scrollIntoView({ block: "start" });
});

pdfInput.addEventListener("change", () => {
  if (!pdfInput.files.length && usingSample) return;
  usingSample = false;
  notesCard.classList.toggle("is-ready", Boolean(pdfInput.files.length));
  byId("pdf-detail").textContent = pdfInput.files[0]?.name || notesHint;
  clearProject();
  byId("storyboard").hidden = true;
  showInputStatus();
});

videoInput.addEventListener("change", () => {
  if (sourceObjectUrl) URL.revokeObjectURL(sourceObjectUrl);
  const recording = videoInput.files[0];
  recordingCard.classList.toggle("is-ready", Boolean(recording));
  sourceObjectUrl = recording ? URL.createObjectURL(recording) : null;
  showStatus("source-playback-status", "");
  if (sourceObjectUrl) {
    sourceVideo.src = sourceObjectUrl;
  } else {
    sourceVideo.removeAttribute("src");
    sourceVideo.load();
  }
  byId("video-detail").textContent = recording?.name || recordingHint;
  byId("recording-preview").hidden = !recording;
  clearProject();
  showInputStatus();
});

sourceVideo.addEventListener("error", () => {
  if (!sourceObjectUrl) return;
  byId("recording-preview").open = true;
  showStatus("source-playback-status", "This browser could not play the recording. Use an H.264/AAC MP4 to preview it here.", true);
});

function enableDrop(card, input) {
  const allowedExtensions = input.accept.split(",").filter((type) => type.startsWith("."));
  let dragDepth = 0;
  const hasFiles = (event) => event.dataTransfer?.types.includes("Files");

  card.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (!input.disabled) {
      dragDepth++;
      card.classList.add("is-dragging");
    }
  });
  card.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = input.disabled ? "none" : "copy";
  });
  card.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) card.classList.remove("is-dragging");
  });
  card.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    card.classList.remove("is-dragging");
    if (input.disabled) return;
    const files = event.dataTransfer.files;
    const file = files[0];
    if (files.length !== 1 || !allowedExtensions.some((ext) => file.name.toLowerCase().endsWith(ext))) {
      showStatus("project-status", input === pdfInput
        ? "Drop one PDF into Source notes."
        : "Drop one MP4, MOV, or WebM into Camera recording.", true);
      return;
    }
    input.files = files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

enableDrop(notesCard, pdfInput);
enableDrop(recordingCard, videoInput);

const workflowScene = document.querySelector(".workflow-scene");
const sceneInteraction = window.matchMedia("(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)");
workflowScene.addEventListener("pointermove", (event) => {
  if (!sceneInteraction.matches || event.pointerType === "touch") return;
  const rect = workflowScene.getBoundingClientRect();
  const horizontal = (event.clientX - rect.left) / rect.width - 0.5;
  const vertical = (event.clientY - rect.top) / rect.height - 0.5;
  workflowScene.style.setProperty("--tilt-x", `${vertical * -12}deg`);
  workflowScene.style.setProperty("--tilt-y", `${horizontal * 16}deg`);
});
workflowScene.addEventListener("pointerleave", () => {
  workflowScene.style.removeProperty("--tilt-x");
  workflowScene.style.removeProperty("--tilt-y");
});

byId("previous-chapter").addEventListener("click", () => selectChapter(chapterIndex - 1));
byId("next-chapter").addEventListener("click", () => selectChapter(chapterIndex + 1));

byId("project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (uploading || job || activeOutput || productionIsRunning()) return;
  const video = videoInput.files[0];
  const pdf = pdfInput.files[0];
  if ((!usingSample && !pdf) || !video) {
    showStatus("project-status", "Select a PDF and a camera recording.", true);
    return;
  }
  const generateAfterUpload = generationAvailable;
  uploading = true;
  refreshOutputActions();
  refreshSubmitLabel();
  showStatus("project-status", "Uploading your recording and notes…");
  let project = null;
  try {
    const form = new FormData();
    form.append("video", video);
    if (usingSample) form.append("sample_notes", "true");
    else form.append("pdf", pdf);
    project = await request("/api/project", { method: "POST", body: form });
    if (project.chapters?.length) {
      showStoryboard(project.chapters, project.pdf_url, "PROJECT STORYBOARD", "");
    } else {
      byId("storyboard").hidden = true;
    }
    showJob(project);
    showStatus("project-status", "Source files saved.");
    byId("production-heading").focus({ preventScroll: true });
    byId("production").scrollIntoView({ block: "start" });
  } catch (error) {
    showStatus("project-status", error.message, true);
  } finally {
    uploading = false;
    refreshOutputActions();
    refreshSubmitLabel();
  }
  if (project && generateAfterUpload && project.generation_available !== false) {
    await startGeneration();
  }
});

byId("copy-prompt").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(promptBox.value);
    showStatus("copy-status", "Prompt copied. Paste it into AdaL Video Producer.");
  } catch {
    promptBox.focus();
    promptBox.select();
    showStatus("copy-status", "Prompt selected. Press Ctrl+C to copy it.");
  }
});

async function updateOutput(suffix, body, pendingMessage) {
  if (!job || activeOutput || productionIsRunning()) return;
  const id = job.job_id;
  const url = jobUrl(suffix);
  activeOutput = suffix;
  refreshOutputActions();
  showStatus("render-status", pendingMessage);
  try {
    const update = await request(url, { method: "POST", body });
    if (job?.job_id === id) showJob(update);
  } catch (error) {
    if (job?.job_id !== id) return;
    if (suffix === "/generate") {
      showJob({ ...job, generation: { status: "error", message: error.message } });
    } else {
      showStatus("render-status", error.message, true);
    }
  } finally {
    activeOutput = null;
    refreshOutputActions();
  }
}

function startGeneration() {
  return updateOutput("/generate", undefined, "Starting AdaL Video Producer…");
}

retryButton.addEventListener("click", startGeneration);
renderButton.addEventListener("click", () => updateOutput("/render", undefined, "Starting the local preview…"));
importInput.addEventListener("change", () => {
  const file = importInput.files[0];
  if (!file) return;
  const form = new FormData();
  form.append("output", file);
  importInput.value = "";
  updateOutput("/import", form, "Importing your AdaL export…");
});
outputVideo.addEventListener("error", () => {
  if (!outputVideo.hasAttribute("src")) return;
  showStatus("output-playback-status", "This browser could not play the video. Download the MP4 to open it locally.", true);
});

async function loadSample() {
  try {
    sample = await request("/api/demo");
    generationAvailable = sample.generation_available === true;
    refreshSubmitLabel();
    if (!uploading && !job) showInputStatus();
    const notesLink = byId("sample-pdf");
    const scriptLink = byId("sample-script");
    if (sample.pdf_url) notesLink.href = sample.pdf_url;
    if (sample.script_url) scriptLink.href = sample.script_url;
    notesLink.hidden = !sample.pdf_url;
    scriptLink.hidden = !sample.script_url;
    byId("sample-links").hidden = !sample.pdf_url && !sample.script_url && !sample.chapters?.length;
    refreshOutputActions();
    sampleStoryboardButton.disabled = !sample.chapters?.length;
  } catch {
    sampleButton.disabled = true;
    sampleStoryboardButton.disabled = true;
  }
}

loadSample();
