#!/usr/bin/env node
'use strict';

// LectureLens studio server. Node 22+, no npm dependencies.
// Run: node server.js  ->  http://127.0.0.1:3000

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFile } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const ROOT = __dirname;
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const SAMPLE_DIR = path.resolve(process.env.LECTURELENS_SAMPLE_DIR || path.join(ROOT, 'sample'));
const STATIC_DIR = path.join(ROOT, 'static');
const JOBS_DIR = path.join(ROOT, '.local', 'jobs');
const RENDERER = path.resolve(process.env.LECTURELENS_RENDERER || path.join(ROOT, 'video_render.py'));
const PROMPT_FILE = path.join(ROOT, 'ADAL-VIDEO-PROMPT.md');
const MAX_UPLOAD_BYTES = Number(process.env.LECTURELENS_MAX_UPLOAD_MB || 700) * 1024 * 1024;
const RENDER_TIMEOUT_MS = 15 * 60 * 1000;
const CHAPTER_COUNT = 7;
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const BROWSER_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  // Chrome refuses video/quicktime but plays H.264 .mov served as mp4.
  '.mov': 'video/mp4',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- external tools ----------

function onPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (dir && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

function findInTree(dir, fileName, depth) {
  if (depth < 0) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === fileName) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = findInTree(path.join(dir, e.name), fileName, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

function adalBundleDirs() {
  if (process.platform !== 'win32') return [];
  const env = process.env;
  const parents = [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'),
    env.LOCALAPPDATA,
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.USERPROFILE,
  ].filter(Boolean);
  const dirs = [];
  for (const parent of parents) {
    try {
      for (const e of fs.readdirSync(parent, { withFileTypes: true })) {
        if (e.isDirectory() && /^\.?adal/i.test(e.name)) dirs.push(path.join(parent, e.name));
      }
    } catch {}
  }
  return dirs;
}

function resolveTool(name, envVar) {
  const fromEnv = process.env[envVar];
  if (fromEnv) {
    return fs.existsSync(fromEnv) ? { path: fromEnv, source: envVar } : { path: null, source: `${envVar} points to a missing file: ${fromEnv}` };
  }
  const p = onPath(name);
  if (p) return { path: p, source: 'PATH' };
  for (const dir of adalBundleDirs()) {
    const hit = findInTree(dir, `${name}.exe`, 6);
    if (hit) return { path: hit, source: 'AdaL Desktop bundle' };
  }
  return { path: null, source: 'not found' };
}

function resolvePython() {
  const candidates = process.env.PYTHON
    ? [process.env.PYTHON]
    : process.platform === 'win32'
      ? ['python', 'py', 'python3']
      : ['python3', 'python'];
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (r.status === 0 && r.stdout.trim() === '3') return cmd;
  }
  return null;
}

const tools = {
  ffmpeg: resolveTool('ffmpeg', 'FFMPEG'),
  ffprobe: resolveTool('ffprobe', 'FFPROBE'),
  python: resolvePython(),
};

function probe(file) {
  if (!tools.ffprobe.path) return Promise.resolve(null);
  const args = ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name', '-of', 'json', file];
  return new Promise((resolve) => {
    execFile(tools.ffprobe.path, args, { timeout: 30000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ ok: false });
      try {
        const data = JSON.parse(stdout);
        const streams = data.streams || [];
        const video = streams.find((s) => s.codec_type === 'video');
        resolve({
          ok: true,
          duration: Number(data.format?.duration) || null,
          hasAudio: streams.some((s) => s.codec_type === 'audio'),
          hasVideo: Boolean(video),
          videoCodec: video?.codec_name || null,
        });
      } catch {
        resolve({ ok: false });
      }
    });
  });
}

// ---------- sample notes (Person B) ----------

function inside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function sampleUrl(abs) {
  return '/sample/' + path.relative(SAMPLE_DIR, abs).split(path.sep).map(encodeURIComponent).join('/');
}

function walk(dir, depth = 3, out = []) {
  if (depth < 0) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth - 1, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function resolveSampleRef(ref) {
  if (typeof ref !== 'string' || !ref.trim()) return null;
  const cleaned = ref.replace(/^\/?sample\//, '');
  const abs = path.resolve(SAMPLE_DIR, cleaned);
  return inside(SAMPLE_DIR, abs) && fs.existsSync(abs) ? abs : null;
}

function findIllustration(files, page) {
  const re = new RegExp(`^(?:page|wonder|chapter|p)?[-_ ]?0*${page}(?:[-_ .]|$)`, 'i');
  return files.find((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()) && re.test(path.basename(f))) || null;
}

function loadSample() {
  const chaptersFile = path.join(SAMPLE_DIR, 'chapters.json');
  if (!fs.existsSync(chaptersFile)) {
    throw new HttpError(503, "sample/chapters.json is missing. Merge Person B's branch (person-b/notes-research).");
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(chaptersFile, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    throw new HttpError(500, `sample/chapters.json is not valid JSON: ${err.message}`);
  }
  const list = Array.isArray(raw) ? raw : raw?.chapters;
  if (!Array.isArray(list)) throw new HttpError(500, 'sample/chapters.json must be an array of chapters or an object with a "chapters" array.');

  const files = walk(SAMPLE_DIR).filter((f) => !inside(path.join(SAMPLE_DIR, 'models'), f));
  const meta = Array.isArray(raw) ? {} : raw;
  const pdfAbs = resolveSampleRef(meta.pdf) || files.find((f) => path.extname(f).toLowerCase() === '.pdf') || null;
  const scriptAbs =
    resolveSampleRef(meta.script) ||
    files.find((f) => /script/i.test(path.basename(f)) && ['.md', '.txt', '.pdf'].includes(path.extname(f).toLowerCase())) ||
    null;

  const problems = [];
  const chapters = list.map((c, i) => {
    const page = Number(c.page);
    const chapter = { page };
    for (const key of ['title', 'place', 'era', 'narration', 'visual']) {
      chapter[key] = typeof c[key] === 'string' ? c[key].trim() : '';
      if (!chapter[key]) problems.push(`chapter ${i + 1} is missing "${key}"`);
    }
    if (!Number.isInteger(page) || page < 1 || page > CHAPTER_COUNT) problems.push(`chapter ${i + 1} has page ${JSON.stringify(c.page)}; pages must be 1-${CHAPTER_COUNT}`);
    const assetAbs = resolveSampleRef(c.asset || c.asset_path || c.image || c.illustration) || findIllustration(files, page);
    chapter._asset = assetAbs;
    chapter.asset_url = assetAbs ? sampleUrl(assetAbs) : null;
    if (!assetAbs) problems.push(`page ${page} has no illustration`);
    chapter.source_url = pdfAbs ? `${sampleUrl(pdfAbs)}#page=${page}` : null;
    return chapter;
  });
  chapters.sort((a, b) => a.page - b.page);
  const pages = chapters.map((c) => c.page);
  if (chapters.length !== CHAPTER_COUNT || new Set(pages).size !== CHAPTER_COUNT) {
    problems.push(`expected pages 1-${CHAPTER_COUNT} once each, got [${pages.join(', ')}]`);
  }
  if (!pdfAbs) problems.push('no source PDF in sample/');
  if (!scriptAbs) problems.push('no recording script in sample/');

  return { chapters, pdfAbs, scriptAbs, problems };
}

function publicChapters(chapters) {
  return chapters.map(({ _asset, ...c }) => c);
}

function modelFixtures() {
  return walk(path.join(ROOT, 'sample', 'models'), 1).filter((f) => VIDEO_EXTS.has(path.extname(f).toLowerCase()) || ['.glb', '.gltf'].includes(path.extname(f).toLowerCase()));
}

// ---------- jobs ----------

const jobs = new Map();
const JOB_ID_RE = /^[a-f0-9]{12}$/;

function jobDir(id) {
  return path.join(JOBS_DIR, id);
}

function fileUrl(id, name, bust) {
  return `/files/${id}/${encodeURIComponent(name)}${bust ? `?v=${bust}` : ''}`;
}

async function saveJob(job) {
  job.updated_at = new Date().toISOString();
  const file = path.join(jobDir(job.job_id), 'job.json');
  await fsp.writeFile(file + '.tmp', JSON.stringify(job, null, 2));
  await fsp.rename(file + '.tmp', file);
}

async function getJob(id) {
  if (!JOB_ID_RE.test(id)) throw new HttpError(404, 'Unknown project id.');
  if (jobs.has(id)) return jobs.get(id);
  try {
    const job = JSON.parse(await fsp.readFile(path.join(jobDir(id), 'job.json'), 'utf8'));
    if (job.status === 'rendering') {
      job.status = 'error';
      job.message = 'The server restarted during the local preview render. Click Render local preview again.';
    }
    jobs.set(id, job);
    return job;
  } catch {
    throw new HttpError(404, 'Unknown project id. Prepare the project again.');
  }
}

function view(job) {
  const { _internal, ...pub } = job;
  return pub;
}

// ---------- uploads ----------

async function readForm(req) {
  const type = req.headers['content-type'] || '';
  if (!type.toLowerCase().startsWith('multipart/form-data')) {
    throw new HttpError(400, 'Send the files as multipart/form-data.');
  }
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD_BYTES) throw new HttpError(413, `Upload is too large (limit ${MAX_UPLOAD_BYTES / 1048576} MB).`);
  let seen = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      cb(seen > MAX_UPLOAD_BYTES ? new HttpError(413, 'Upload is too large.') : null, chunk);
    },
  });
  const body = Readable.toWeb(req.pipe(limiter));
  try {
    return await new Request('http://local/upload', { method: 'POST', headers: { 'content-type': type }, body, duplex: 'half' }).formData();
  } catch {
    if (seen > MAX_UPLOAD_BYTES) throw new HttpError(413, `Upload is too large (limit ${MAX_UPLOAD_BYTES / 1048576} MB).`);
    throw new HttpError(400, 'Could not read the upload. Choose the files again and retry.');
  }
}

function isFile(v) {
  return v && typeof v === 'object' && typeof v.arrayBuffer === 'function' && typeof v.name === 'string';
}

async function head(file, n) {
  return Buffer.from(await file.slice(0, n).arrayBuffer());
}

async function looksLikeVideo(file) {
  const b = await head(file, 16);
  if (b.length < 12) return false;
  const box = b.toString('latin1', 4, 8);
  return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(box) || b.readUInt32BE(0) === 0x1a45dfa3;
}

async function looksLikeMp4(file) {
  const b = await head(file, 12);
  return b.length >= 12 && ['ftyp', 'moov', 'mdat', 'wide', 'free'].includes(b.toString('latin1', 4, 8));
}

async function looksLikePdf(file) {
  return (await head(file, 1024)).includes('%PDF-');
}

async function writeUpload(file, dest) {
  await pipeline(Readable.fromWeb(file.stream()), fs.createWriteStream(dest + '.part'));
  await fsp.rename(dest + '.part', dest);
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

function fmtSeconds(s) {
  return `${s.toFixed(1)} s`;
}

function recordingWarnings(info) {
  if (!info) return ['ffprobe is not available, so the recording was not checked.'];
  if (!info.ok) return ['ffprobe could not read the recording; it may not play.'];
  const w = [];
  if (!info.hasVideo) w.push('the recording has no video track');
  if (!info.hasAudio) w.push("the recording has no audio track, so the presenter's narration is missing");
  if (info.duration && (info.duration < 40 || info.duration > 50)) w.push(`the recording is ${fmtSeconds(info.duration)}; the plan calls for 40-50 s`);
  if (info.videoCodec && !BROWSER_CODECS.has(info.videoCodec)) w.push(`the recording uses ${info.videoCodec}, which browsers may not play; re-export as H.264 MP4 if the clip will not play`);
  return w;
}

// ---------- AdaL prompt ----------

function buildAdalPrompt(job, chapters) {
  const dir = jobDir(job.job_id);
  const video = path.join(dir, job._internal.video_file);
  const pdf = path.join(dir, 'notes.pdf');
  const models = modelFixtures();
  const lines = [];
  lines.push('LectureLens: AdaL video brief', '');
  lines.push('Files on this computer:');
  lines.push(`- Presenter recording (keep the original voice): ${video}`);
  lines.push(`- Source notes PDF: ${pdf}`);
  for (const m of models) lines.push(`- Model-orbit fixture: ${m}`);
  lines.push('');
  if (chapters.length) {
    lines.push(`Make a 16:9 MP4 lesson with ${chapters.length} labeled scenes in this order. Show the PDF page label on every scene.`);
    for (const c of chapters) {
      lines.push('', `Scene ${c.page}: ${c.title} (PDF page ${c.page}), ${c.place}, ${c.era}`);
      lines.push(`  Narration: ${c.narration}`);
      lines.push(`  Visual: ${c.visual}`);
      if (c._asset) lines.push(`  Illustration: ${c._asset}`);
    }
  } else {
    lines.push('This is a custom PDF, not the Seven Wonders notes. Read it, build one scene per topic, and label each scene with its PDF page number.');
  }
  lines.push('', "Keep the presenter's original narration as the soundtrack. Label creative reconstructions and uncertain historical scenes. Export a playable 16:9 MP4.");

  let prompt = lines.join('\n');
  if (fs.existsSync(PROMPT_FILE)) {
    const brief = fs
      .readFileSync(PROMPT_FILE, 'utf8')
      .replaceAll('{{VIDEO_PATH}}', video)
      .replaceAll('{{PDF_PATH}}', pdf)
      .replaceAll('{{JOB_DIR}}', dir)
      .trim();
    prompt += '\n\nCreative direction:\n' + brief;
  }
  return prompt;
}

// ---------- local preview (Person C's renderer) ----------

function startRender(job, chapters) {
  const dir = jobDir(job.job_id);
  const output = path.join(dir, 'preview.mp4');
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = {
    job_id: job.job_id,
    video: path.join(dir, job._internal.video_file),
    pdf: path.join(dir, 'notes.pdf'),
    output,
    width: 1280,
    height: 720,
    chapters: chapters.map(({ _asset, ...c }) => ({ ...c, asset_path: _asset })),
    models: modelFixtures(),
    models_dir: path.join(ROOT, 'sample', 'models'),
    ffmpeg: tools.ffmpeg.path,
    ffprobe: tools.ffprobe.path,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  fs.rmSync(output, { force: true });

  const startedAt = Date.now();
  job.status = 'rendering';
  job.message = 'Rendering the local preview...';
  job._internal.render_started_at = startedAt;

  const log = fs.createWriteStream(path.join(dir, 'render.log'));
  const child = spawn(tools.python, ['-u', RENDERER, '--manifest', manifestPath, '--output', output], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      FFMPEG: tools.ffmpeg.path,
      FFPROBE: tools.ffprobe.path || '',
      LECTURELENS_MANIFEST: manifestPath,
      PYTHONIOENCODING: 'utf-8',
    },
  });
  let tail = '';
  const onData = (chunk) => {
    log.write(chunk);
    tail = (tail + chunk.toString()).slice(-4000);
    const last = tail.trim().split(/\r?\n/).pop();
    if (last && job.status === 'rendering') job.message = `Rendering the local preview... ${last.slice(0, 140)}`;
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const timer = setTimeout(() => child.kill(), RENDER_TIMEOUT_MS);

  const finish = async (code, spawnError) => {
    clearTimeout(timer);
    log.end();
    const ok = !spawnError && code === 0 && fs.existsSync(output) && fs.statSync(output).size > 0;
    if (ok) {
      const info = await probe(output);
      const bust = Date.now();
      job.preview_url = fileUrl(job.job_id, 'preview.mp4', bust);
      // A newer AdaL import keeps priority over a preview that started before it.
      if (!job._internal.adal_imported_at || job._internal.adal_imported_at < startedAt) {
        job.render_mode = 'preview';
        job.render_url = job.preview_url;
        job.render_label = 'Local preview (fallback, not the AdaL export)';
      }
      job.status = 'ready';
      const warn = info?.ok && !info.hasAudio ? ' Warning: the preview has no audio track.' : '';
      job.message = `Local preview ready${info?.duration ? ` (${fmtSeconds(info.duration)})` : ''}.${warn}`;
    } else {
      const last = tail.trim().split(/\r?\n/).slice(-3).join(' | ');
      job.status = 'error';
      job.message = spawnError
        ? `Could not start the renderer: ${spawnError.message}`
        : `Local preview failed (exit ${code}). ${last || 'No output from video_render.py.'} (log: .local/jobs/${job.job_id}/render.log)`;
    }
    await saveJob(job).catch(() => {});
  };
  let done = false;
  child.on('error', (err) => !done && ((done = true), finish(null, err)));
  child.on('close', (code) => !done && ((done = true), finish(code)));
}

// ---------- HTTP helpers ----------

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

async function sendFile(req, res, file, { download, noStore } = {}) {
  let stat;
  try {
    stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error();
  } catch {
    throw new HttpError(404, 'File not found.');
  }
  const size = stat.size;
  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': noStore ? 'no-store' : 'no-cache',
    'Last-Modified': stat.mtime.toUTCString(),
  };
  if (download) headers['Content-Disposition'] = `attachment; filename="${download}"`;

  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range && size > 0) {
    const m = /^bytes=(\d*)-(\d*)/.exec(range);
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      } else {
        start = Math.max(size - Number(m[2]), 0);
      }
    }
    if (!m || start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) return res.end();
  await pipeline(fs.createReadStream(file, { start, end }), res).catch(() => {});
}

function fallbackPage() {
  return `<!doctype html><meta charset="utf-8"><title>LectureLens</title>
<style>body{font:16px system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;line-height:1.5}</style>
<h1>LectureLens server is running</h1>
<p>The studio frontend (<code>static/index.html</code>) is not on this checkout yet. Merge Person A's branch (<code>person-a/creative-frontend</code>).</p>
<p>API: <a href="/api/demo">/api/demo</a> · <a href="/api/health">/api/health</a></p>`;
}

// ---------- routes ----------

async function handleDemo(res) {
  const { chapters, pdfAbs, scriptAbs, problems } = loadSample();
  sendJson(res, 200, {
    chapters: publicChapters(chapters),
    pdf_url: pdfAbs ? sampleUrl(pdfAbs) : null,
    script_url: scriptAbs ? sampleUrl(scriptAbs) : null,
    warnings: problems,
  });
}

async function handleCreateProject(req, res) {
  const form = await readForm(req);
  const video = form.get('video');
  const pdf = form.get('pdf');
  const useSample = ['true', '1', 'on', 'yes'].includes(String(form.get('sample_notes') || '').toLowerCase());

  if (!isFile(video) || video.size === 0) throw new HttpError(400, 'Choose the camera recording (MP4 or MOV) before preparing the project.');
  const videoExt = path.extname(video.name).toLowerCase();
  if ((videoExt && !VIDEO_EXTS.has(videoExt)) || !(await looksLikeVideo(video))) {
    throw new HttpError(400, `"${video.name}" is not a video file. Choose the MP4 or MOV camera recording.`);
  }

  let sample = null;
  if (useSample) {
    sample = loadSample();
    if (!sample.pdfAbs) throw new HttpError(503, "The sample notes PDF is missing from sample/. Merge Person B's branch.");
  } else {
    if (!isFile(pdf) || pdf.size === 0) throw new HttpError(400, 'Choose the source notes PDF, or select Use sample notes.');
    if (!(await looksLikePdf(pdf))) throw new HttpError(400, `"${pdf.name}" is not a PDF. Choose the source notes PDF.`);
  }

  const id = crypto.randomBytes(6).toString('hex');
  const dir = jobDir(id);
  await fsp.mkdir(dir, { recursive: true });
  try {
    const videoFile = `recording${VIDEO_EXTS.has(videoExt) ? videoExt : '.mp4'}`;
    await writeUpload(video, path.join(dir, videoFile));
    const pdfPath = path.join(dir, 'notes.pdf');
    if (sample) {
      await fsp.copyFile(sample.pdfAbs, pdfPath);
    } else {
      await writeUpload(pdf, pdfPath);
      // An upload that is byte-identical to the supplied notes still gets the chapters.
      try {
        const candidate = loadSample();
        if (candidate.pdfAbs && (await sha256(candidate.pdfAbs)) === (await sha256(pdfPath))) sample = candidate;
      } catch {}
    }

    const info = await probe(path.join(dir, videoFile));
    const chapters = sample ? sample.chapters : [];
    const job = {
      job_id: id,
      created_at: new Date().toISOString(),
      notes: sample ? 'sample' : 'custom',
      pdf_name: sample ? path.basename(sample.pdfAbs) : pdf.name,
      video_name: video.name,
      pdf_url: fileUrl(id, 'notes.pdf'),
      video_url: fileUrl(id, videoFile),
      chapters: publicChapters(chapters),
      status: 'ready',
      message: '',
      adal_prompt: '',
      render_mode: null,
      render_url: null,
      render_label: null,
      preview_url: null,
      adal_url: null,
      recording: info?.ok ? { duration: info.duration, has_audio: info.hasAudio, video_codec: info.videoCodec } : null,
      _internal: { video_file: videoFile },
    };
    job.adal_prompt = buildAdalPrompt(job, chapters);
    const warnings = recordingWarnings(info);
    job.message = sample
      ? `Project ready with ${chapters.length} source-linked chapters.`
      : 'Custom PDF uploaded. The Seven Wonders chapters were not assigned; copy the AdaL prompt to hand the PDF and recording to AdaL.';
    if (warnings.length) job.message += ` Check: ${warnings.join('; ')}.`;
    jobs.set(id, job);
    await saveJob(job);
    sendJson(res, 201, view(job));
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

async function handleRender(res, id) {
  const job = await getJob(id);
  if (job.status === 'rendering') return sendJson(res, 202, view(job));
  if (job.notes !== 'sample') {
    throw new HttpError(409, 'The local preview needs the Seven Wonders sample notes. For a custom PDF, render in AdaL and use Import AdaL MP4.');
  }
  if (!fs.existsSync(RENDERER)) throw new HttpError(503, "video_render.py is missing. Merge Person C's branch (person-c/video-production), or import the AdaL MP4.");
  if (!tools.python) throw new HttpError(503, 'Python 3 was not found. Install Python 3 or set the PYTHON environment variable.');
  if (!tools.ffmpeg.path) throw new HttpError(503, 'FFmpeg was not found. Install FFmpeg, install AdaL Desktop, or set the FFMPEG and FFPROBE environment variables.');
  const { chapters } = loadSample();
  startRender(job, chapters);
  await saveJob(job);
  sendJson(res, 202, view(job));
}

async function handleImport(req, res, id) {
  const job = await getJob(id);
  const form = await readForm(req);
  const output = form.get('output');
  if (!isFile(output) || output.size === 0) throw new HttpError(400, "Choose the MP4 exported from AdaL.");
  const ext = path.extname(output.name).toLowerCase();
  if ((ext && !['.mp4', '.m4v', '.mov'].includes(ext)) || !(await looksLikeMp4(output))) {
    throw new HttpError(400, `"${output.name}" is not an MP4. Export the lesson from AdaL as MP4 and import that file.`);
  }
  const dest = path.join(jobDir(id), 'adal.mp4');
  await writeUpload(output, dest);
  const info = await probe(dest);
  const now = Date.now();
  job._internal.adal_imported_at = now;
  job._internal.adal_name = output.name;
  job.adal_url = fileUrl(id, 'adal.mp4', now);
  job.render_mode = 'adal';
  job.render_url = job.adal_url;
  job.render_label = 'AdaL export';
  if (job.status !== 'rendering') job.status = 'ready';
  const notes = [];
  if (info?.ok) {
    if (!info.hasAudio) notes.push("it has no audio track, so the presenter's narration is missing");
    if (info.videoCodec && !BROWSER_CODECS.has(info.videoCodec)) notes.push(`it uses ${info.videoCodec}, which browsers may not play`);
  }
  job.message = `AdaL export imported (${output.name}${info?.duration ? `, ${fmtSeconds(info.duration)}` : ''}).${notes.length ? ` Check: ${notes.join('; ')}.` : ''}`;
  await saveJob(job);
  sendJson(res, 200, view(job));
}

async function handleJobFile(req, res, id, name, download) {
  const job = await getJob(id);
  const allowed = new Set([job._internal.video_file, 'notes.pdf', 'preview.mp4', 'adal.mp4']);
  if (!allowed.has(name)) throw new HttpError(404, 'File not found.');
  const downloadName = {
    'preview.mp4': 'LectureLens-local-preview.mp4',
    'adal.mp4': 'LectureLens-AdaL-export.mp4',
    'notes.pdf': job.pdf_name || 'notes.pdf',
  }[name] || job.video_name;
  await sendFile(req, res, path.join(jobDir(id), name), { download: download ? downloadName.replace(/["\\\r\n]/g, '') : null, noStore: true });
}

async function handleStatic(req, res, pathname, root, { fallback } = {}) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'Bad path.');
  }
  const abs = path.resolve(root, '.' + path.sep + rel.replace(/^\/+/, ''));
  if (!inside(root, abs)) throw new HttpError(403, 'Forbidden.');
  let target = abs;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
  if (!fs.existsSync(target)) {
    if (fallback) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fallback());
    }
    throw new HttpError(404, 'Not found.');
  }
  await sendFile(req, res, target);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  const m = req.method;
  let match;

  if (m === 'GET' && p === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      node: process.version,
      python: tools.python,
      ffmpeg: tools.ffmpeg,
      ffprobe: tools.ffprobe,
      renderer: fs.existsSync(RENDERER),
      frontend: fs.existsSync(path.join(STATIC_DIR, 'index.html')),
      sample: fs.existsSync(path.join(SAMPLE_DIR, 'chapters.json')),
      adal_prompt_brief: fs.existsSync(PROMPT_FILE),
      models: modelFixtures().map((f) => path.basename(f)),
    });
  }
  if (m === 'GET' && p === '/api/demo') return handleDemo(res);
  if (m === 'POST' && p === '/api/project') return handleCreateProject(req, res);
  if ((match = /^\/api\/project\/([^/]+)$/.exec(p)) && m === 'GET') return sendJson(res, 200, view(await getJob(match[1])));
  if ((match = /^\/api\/project\/([^/]+)\/render$/.exec(p)) && m === 'POST') return handleRender(res, match[1]);
  if ((match = /^\/api\/project\/([^/]+)\/import$/.exec(p)) && m === 'POST') return handleImport(req, res, match[1]);
  if (p.startsWith('/api/')) throw new HttpError(404, `No route for ${m} ${p}.`);

  if (m !== 'GET' && m !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
  if ((match = /^\/files\/([^/]+)\/([^/]+)$/.exec(p))) {
    return handleJobFile(req, res, match[1], decodeURIComponent(match[2]), url.searchParams.has('download'));
  }
  if (p.startsWith('/sample/')) return handleStatic(req, res, p.slice('/sample'.length), SAMPLE_DIR);
  return handleStatic(req, res, p, STATIC_DIR, { fallback: p === '/' || p === '/index.html' ? fallbackPage : null });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (res.headersSent) return res.destroy();
    const message = err instanceof HttpError ? err.message : 'Internal server error. Check the server console.';
    if (req.url.startsWith('/api/')) sendJson(res, status, { error: message, message });
    else {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(message);
    }
  });
});
server.requestTimeout = 0;

fs.mkdirSync(JOBS_DIR, { recursive: true });
server.listen(PORT, HOST, () => {
  const tick = (ok) => (ok ? 'ok     ' : 'MISSING');
  console.log(`LectureLens studio: http://${HOST}:${PORT}`);
  console.log(`  ${tick(fs.existsSync(path.join(STATIC_DIR, 'index.html')))} frontend   static/index.html (Person A)`);
  console.log(`  ${tick(fs.existsSync(path.join(SAMPLE_DIR, 'chapters.json')))} notes      ${path.relative(ROOT, SAMPLE_DIR) || SAMPLE_DIR}/chapters.json (Person B)`);
  console.log(`  ${tick(fs.existsSync(RENDERER))} renderer   ${path.relative(ROOT, RENDERER) || RENDERER} (Person C)`);
  console.log(`  ${tick(tools.python)} python     ${tools.python || 'set PYTHON'}`);
  console.log(`  ${tick(tools.ffmpeg.path)} ffmpeg     ${tools.ffmpeg.path || 'set FFMPEG'} (${tools.ffmpeg.source})`);
  console.log(`  ${tick(tools.ffprobe.path)} ffprobe    ${tools.ffprobe.path || 'set FFPROBE'} (${tools.ffprobe.source})`);
});
