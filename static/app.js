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
const sourceVideo = byId("source-video");
const outputVideo = byId("output-video");
const chapterList = byId("chapter-list");
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
let changingOutput = false;

function showStatus(id, message, isError = false) {
  const status = byId(id);
  status.textContent = message;
  status.classList.toggle("error", isError);
}

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.detail ?? data?.message ?? data?.error;
    throw new Error(typeof detail === "string" ? detail : "The request could not be completed.");
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

function refreshOutputActions() {
  const busy = changingOutput || job?.status === "rendering";
  renderButton.disabled = busy || !job?.chapters?.length || job?.render_mode === "adal";
  importInput.disabled = busy || !job;
}

function showJob(update) {
  job = update;
  byId("production").hidden = false;
  promptBox.value = job.adal_prompt || "";
  byId("copy-prompt").disabled = !promptBox.value;
  byId("playback-detail").textContent = job.chapters?.length
    ? "Check the lesson with a local preview using the recording and source illustrations."
    : "Import the MP4 exported from AdaL to review and download your lesson.";
  renderButton.hidden = !job.chapters?.length;
  const result = byId("render-result");
  const renderUrl = job.render_url;
  result.hidden = !renderUrl;
  if (renderUrl) {
    if (outputVideo.getAttribute("src") !== renderUrl) outputVideo.src = renderUrl;
    byId("download-render").href = renderUrl;
  } else {
    outputVideo.removeAttribute("src");
    outputVideo.load();
  }
  let message = job.message || "";
  if (renderUrl && !message) {
    message = job.render_mode === "adal" ? "AdaL export ready to play." : "Local preview ready to play.";
  }
  showStatus("render-status", message, job.status === "error");
  refreshOutputActions();
  clearTimeout(pollTimer);
  if (job.status === "rendering") {
    pollTimer = setTimeout(() => pollJob(job.job_id), 1500);
  }
}

async function pollJob(jobId) {
  try {
    const update = await request(`/api/project/${encodeURIComponent(jobId)}`);
    if (job?.job_id === jobId) showJob(update);
  } catch (error) {
    if (job?.job_id !== jobId) return;
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
  showStatus("copy-status", "");
  byId("storyboard").hidden = true;
  showStatus("project-status", "Prepare the project to use the new inputs.");
}

sampleButton.addEventListener("click", () => {
  if (!sample) return;
  usingSample = true;
  pdfInput.value = "";
  byId("pdf-detail").textContent = "Seven Wonders of the Ancient World · example notes selected";
  clearProject();
  showStatus("project-status", "Example notes selected. Choose a presenter recording to continue.");
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
  byId("pdf-detail").textContent = pdfInput.files[0]?.name || notesHint;
  clearProject();
  byId("storyboard").hidden = true;
});

videoInput.addEventListener("change", () => {
  if (sourceObjectUrl) URL.revokeObjectURL(sourceObjectUrl);
  const recording = videoInput.files[0];
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
});

sourceVideo.addEventListener("error", () => {
  if (!sourceObjectUrl) return;
  byId("recording-preview").open = true;
  showStatus("source-playback-status", "This browser could not play the recording. Use an H.264/AAC MP4 to preview it here.", true);
});

byId("previous-chapter").addEventListener("click", () => selectChapter(chapterIndex - 1));
byId("next-chapter").addEventListener("click", () => selectChapter(chapterIndex + 1));

byId("project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (uploading) return;
  const video = videoInput.files[0];
  const pdf = pdfInput.files[0];
  if ((!usingSample && !pdf) || !video) {
    showStatus("project-status", "Select a PDF and a camera recording.", true);
    return;
  }
  clearProject();
  uploading = true;
  submitButton.disabled = true;
  pdfInput.disabled = true;
  videoInput.disabled = true;
  sampleButton.disabled = true;
  showStatus("project-status", "Preparing your recording and notes…");
  try {
    const form = new FormData();
    form.append("video", video);
    if (usingSample) form.append("sample_notes", "true");
    else form.append("pdf", pdf);
    const project = await request("/api/project", { method: "POST", body: form });
    if (project.chapters?.length) {
      showStoryboard(project.chapters, project.pdf_url, "PROJECT STORYBOARD", "");
    } else {
      byId("storyboard").hidden = true;
    }
    showJob(project);
    showStatus("project-status", "Project ready. Open the production options below.");
    byId("production-heading").focus({ preventScroll: true });
    byId("production").scrollIntoView({ block: "start" });
  } catch (error) {
    showStatus("project-status", error.message, true);
  } finally {
    uploading = false;
    submitButton.disabled = false;
    pdfInput.disabled = false;
    videoInput.disabled = false;
    sampleButton.disabled = !sample?.pdf_url;
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
  if (!job || changingOutput || job.status === "rendering") return;
  const id = job.job_id;
  const url = jobUrl(suffix);
  changingOutput = true;
  refreshOutputActions();
  showStatus("render-status", pendingMessage);
  try {
    const update = await request(url, { method: "POST", body });
    if (job?.job_id === id) showJob(update);
  } catch (error) {
    if (job?.job_id === id) showStatus("render-status", error.message, true);
  } finally {
    changingOutput = false;
    refreshOutputActions();
  }
}

renderButton.addEventListener("click", () => updateOutput("/render", undefined, "Starting the local preview…"));
importInput.addEventListener("change", () => {
  const file = importInput.files[0];
  if (!file) return;
  const form = new FormData();
  form.append("output", file);
  importInput.value = "";
  updateOutput("/import", form, "Importing your AdaL export…");
});

async function loadSample() {
  try {
    sample = await request("/api/demo");
    const notesLink = byId("sample-pdf");
    const scriptLink = byId("sample-script");
    if (sample.pdf_url) notesLink.href = sample.pdf_url;
    if (sample.script_url) scriptLink.href = sample.script_url;
    notesLink.hidden = !sample.pdf_url;
    scriptLink.hidden = !sample.script_url;
    byId("sample-links").hidden = !sample.pdf_url && !sample.script_url && !sample.chapters?.length;
    sampleButton.disabled = uploading || !sample.pdf_url;
    sampleStoryboardButton.disabled = !sample.chapters?.length;
  } catch {
    sampleButton.disabled = true;
    sampleStoryboardButton.disabled = true;
  }
}

loadSample();
