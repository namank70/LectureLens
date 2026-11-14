# LectureLens: Seven Wonders of the Ancient World

LectureLens turns an illustrated source PDF and a 40–50 second camera recording into a short narrated lesson. The studio shows seven source-linked chapters, renders a local preview with the presenter's original audio, and imports the MP4 exported from AdaL. The local preview is a fallback and is always labeled separately from the AdaL export.

## Branches

Branch from `main`. Push only your own branch; D combines them on `integration/demo`.

| Person | Branch | Owns |
| --- | --- | --- |
| A | `person-a/creative-frontend` | `static/`, `ADAL-VIDEO-PROMPT.md` |
| B | `person-b/notes-research` | source PDF, recording script, `sample/chapters.json`, seven illustrations |
| C | `person-c/video-production` | `video_render.py`, `sample/models/` (two model-orbit MP4 fixtures) |
| D | `person-d/backend-integration` | `server.js`, `.gitignore`, `README.md` |

Never commit raw footage, finished lesson exports, `.local/`, credentials or signed agreements. The AdaL MP4 is shared privately and imported through the app.

## Run

Requires Node 22+, Python 3, FFmpeg and ffprobe. No `npm install`.

```sh
node server.js
# open http://127.0.0.1:3000
```

The startup log lists which pieces are present (frontend, notes, renderer, Python, FFmpeg). FFmpeg is found from `FFMPEG`/`FFPROBE`, then `PATH`, then the AdaL Desktop bundle on Windows:

```sh
FFMPEG=/path/to/ffmpeg FFPROBE=/path/to/ffprobe node server.js
```

Other overrides: `PORT`, `HOST`, `PYTHON`. `GET /api/health` reports what the server resolved. Uploads, previews and imported exports stay on this computer under `.local/jobs/<job_id>/`.

## API

| Route | Behavior |
| --- | --- |
| `GET /api/demo` | `chapters`, `pdf_url`, `script_url`, `warnings`. Each chapter: `page` (1–7), `title`, `place`, `era`, `narration`, `visual`, `asset_url`, `source_url` (PDF link with `#page=N`). |
| `POST /api/project` | Multipart `video` + `pdf`, or `video` + `sample_notes=true` to use the supplied PDF. A different PDF gets no Seven Wonders chapters; it is handed to AdaL through the prompt. |
| `GET /api/project/{job_id}` | Current job. Poll while `status` is `rendering`. |
| `POST /api/project/{job_id}/render` | Starts the local preview with `video_render.py`. When done: `render_mode: "preview"`. |
| `POST /api/project/{job_id}/import` | Multipart `output` with the AdaL MP4. Returns `render_mode: "adal"` and a playable `render_url`. |

Job fields: `job_id`, `pdf_url`, `video_url`, `chapters`, `status` (`ready`, `rendering`, `error`), `message`, `adal_prompt`, `render_mode` (`null`, `preview`, `adal`), `render_url`, plus `render_label`, `preview_url` and `adal_url` so the UI can label the local preview separately from the AdaL export. Errors return `{ "error": "...", "message": "..." }` with a 4xx/5xx status. Add `?download=1` to any file URL to download it.

## Sample notes contract (Person B)

`sample/chapters.json` is either an array of seven chapters or `{ "pdf": "...", "script": "...", "chapters": [...] }`. Each chapter needs `page`, `title`, `place`, `era`, `narration`, `visual`, and optionally `asset` (a path relative to `sample/`). Without `asset`, the server matches an image in `sample/` named by page, such as `01-giza.png` or `page-1.jpg`. Without `pdf`/`script`, it uses the first PDF in `sample/` and the first file with `script` in its name.

## Renderer contract (Person C)

The server runs:

```sh
python video_render.py --manifest .local/jobs/<id>/manifest.json --output .local/jobs/<id>/preview.mp4
```

with `FFMPEG`, `FFPROBE` and `LECTURELENS_MANIFEST` in the environment. The manifest holds `video`, `pdf`, `output`, `width`/`height` (1280×720), `chapters` (each with an absolute `asset_path`), `models` (absolute paths of `sample/models/*`), `models_dir`, `ffmpeg` and `ffprobe`. Exit 0 after writing a 16:9 MP4 with the presenter's original audio and page labels. Progress lines on stdout appear in the UI; output is logged to `render.log`.

## AdaL prompt (Person A)

`adal_prompt` lists the absolute paths of the recording, PDF, illustrations and model fixtures, then the seven scenes. If `ADAL-VIDEO-PROMPT.md` exists, it is appended as creative direction; `{{VIDEO_PATH}}`, `{{PDF_PATH}}` and `{{JOB_DIR}}` are filled in.
