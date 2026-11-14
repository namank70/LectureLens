"use strict";

const byId = (id) => document.getElementById(id);
const sampleStoryboardButton = byId("view-sample");
const chapterList = byId("chapter-list");

let sample = null;
let chapters = [];
let chapterIndex = 0;
let sourcePdf = null;

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

function showSample() {
  if (sample) {
    showStoryboard(sample.chapters, sample.pdf_url, "SEVEN WONDERS EXAMPLE", "The example has no scenes.");
  }
}

sampleStoryboardButton.addEventListener("click", () => {
  if (!sample?.chapters?.length) return;
  showSample();
  byId("storyboard-heading").focus({ preventScroll: true });
  byId("storyboard").scrollIntoView({ block: "start" });
});

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

// The upload page opens in a dialog. Without <dialog> support the links still navigate to it.
const uploadDialog = byId("upload-dialog");
const uploadFrame = byId("upload-frame");
if (typeof uploadDialog.showModal === "function") {
  for (const link of document.querySelectorAll("[data-open-upload]")) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      // Loaded on first open and then kept, so an upload or a status check in progress survives closing.
      if (!uploadFrame.getAttribute("src")) uploadFrame.src = link.getAttribute("href");
      uploadDialog.showModal();
    });
  }
  byId("upload-dialog-close").addEventListener("click", () => uploadDialog.close());
  uploadDialog.addEventListener("close", () => loadLessons()); // a new upload may have been queued
  uploadDialog.addEventListener("click", (event) => {
    if (event.target === uploadDialog) uploadDialog.close(); // a click on the backdrop
  });
}

// ==== Your lessons ====================================================================
// Past jobs come from the queue server (aws/server.js) on the AdaL computer. If this page is
// opened anywhere else, change QUEUE_SERVER here and in upload.html to that computer's address.
const QUEUE_SERVER = "http://127.0.0.1:8080";
const lessonsList = byId("lessons-list");
const lessonVideo = byId("lesson-video");
const lessonDownload = byId("lesson-download");
let selectedLesson = null;
let lessonsTimer = null;

function lessonWhen(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "Unknown date"
    : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Each click asks for a fresh link, because the links expire after an hour.
async function playLesson(jobId) {
  selectedLesson = jobId;
  for (const button of lessonsList.querySelectorAll("button")) {
    button.setAttribute("aria-current", String(button.dataset.jobId === jobId));
  }
  showStatus("lesson-player-status", "Loading the video…");
  try {
    const job = await request(`${QUEUE_SERVER}/jobs/${encodeURIComponent(jobId)}/output`, { cache: "no-store" });
    if (selectedLesson !== jobId) return;
    if (job.status !== "done" || !job.output?.url) {
      lessonVideo.hidden = true;
      lessonDownload.hidden = true;
      showStatus("lesson-player-status", job.status === "pending"
        ? (job.message || "AdaL is still making this lesson.")
        : "This lesson has no video to play.", job.status !== "pending");
      return;
    }
    lessonVideo.src = job.output.url;
    lessonVideo.hidden = false;
    lessonDownload.href = job.output.url;
    lessonDownload.hidden = false;
    showStatus("lesson-player-status", "");
  } catch (error) {
    if (selectedLesson !== jobId) return;
    lessonVideo.hidden = true;
    lessonDownload.hidden = true;
    showStatus("lesson-player-status", `Could not load this lesson. ${error.message}`, true);
  }
}

async function loadLessons() {
  clearTimeout(lessonsTimer);
  let jobs;
  try {
    jobs = (await request(`${QUEUE_SERVER}/jobs`, { cache: "no-store" })).jobs;
    if (!Array.isArray(jobs)) throw new Error("Unexpected response.");
  } catch {
    lessonsList.hidden = true;
    showStatus("lessons-status", "Could not reach the queue server, so past lessons are unavailable.", true);
    return;
  }
  // Failed jobs have nothing to play, so they stay out of this list.
  const lessons = jobs.filter((job) => job.status === "done" || job.status === "pending");
  showStatus("lessons-status", lessons.length ? "" : "No lessons yet. Create your first one above.");
  lessonsList.hidden = !lessons.length;
  lessonsList.replaceChildren(...lessons.map((job) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.jobId = job.job_id;
    button.setAttribute("aria-current", String(job.job_id === selectedLesson));
    const when = document.createElement("span");
    when.className = "lesson-when";
    when.textContent = lessonWhen(job.finished_at || job.received_at);
    const state = document.createElement("span");
    state.className = `lesson-state${job.status === "done" ? " ready" : ""}`;
    state.textContent = job.status === "done" ? "Ready" : "In progress";
    const id = document.createElement("span");
    id.className = "lesson-id";
    id.textContent = job.job_id;
    button.append(when, state, id);
    button.addEventListener("click", () => playLesson(job.job_id));
    item.append(button);
    return item;
  }));
  // Keep checking while something is still being made, so it turns Ready without a reload.
  if (lessons.some((job) => job.status === "pending")) lessonsTimer = setTimeout(loadLessons, 15000);
}

lessonVideo.addEventListener("error", () => {
  if (!lessonVideo.getAttribute("src")) return;
  showStatus("lesson-player-status", "The video did not load. Choose the lesson again to get a fresh link.", true);
});
byId("lessons-refresh").addEventListener("click", loadLessons);
loadLessons();

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
    sampleStoryboardButton.disabled = !sample.chapters?.length;
  } catch {
    sampleStoryboardButton.disabled = true;
  }
}

loadSample();
