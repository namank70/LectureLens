# LectureLens

LectureLens turns a source PDF and a camera recording into a narrated lesson. When the AdaL CLI is configured, the studio can start generation and play the finished video. The optional Seven Wonders example also supports a local preview with the presenter's original audio.

## Branches

Branch from `main`. Push only your own branch; D combines them on `integration/demo`.

| Person | Branch | Owns |
| --- | --- | --- |
| A | `person-a/creative-frontend` | `static/`, `ADAL-VIDEO-PROMPT.md` |
| B | `person-b/notes-research` | source PDF, recording script, `sample/chapters.json`, seven illustrations |
| C | `person-c/video-production` | `video_render.py`, `sample/models/` (two model-orbit MP4 fixtures) |
| D | `person-d/backend-integration` | `server.js`, `.gitignore`, `README.md` |

Keep raw footage, finished lesson exports, `.local/`, credentials and signed agreements outside Git. The studio can also import an AdaL MP4 shared privately by a teammate.

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

### Connect AdaL generation

Install the [official AdaL CLI](https://docs.sylph.ai/) on the computer running LectureLens. Run `adal` once and complete browser sign-in if prompted, then restart the studio. Use `ADAL_BIN` to point to a different CLI installation. With the CLI and ffprobe present, **Generate lesson video** prepares the uploads, starts a headless Video Producer job, then displays its verified MP4 in the studio.

The two source files are provided to AdaL when generation starts. If AdaL needs sign-in, credits, or approval for a production step, the studio returns the error and keeps the uploaded files available for retry or the manual AdaL workflow.

## API

| Route | Behavior |
| --- | --- |
| `GET /api/demo` | `chapters`, `pdf_url`, `script_url`, `warnings`. Each chapter: `page` (1–7), `title`, `place`, `era`, `narration`, `visual`, `asset_url`, `source_url` (PDF link with `#page=N`). |
| `POST /api/project` | Multipart `video` + `pdf`, or `video` + `sample_notes=true` to use the supplied PDF. A different PDF gets no Seven Wonders chapters; it is handed to AdaL through the prompt. |
| `GET /api/project/{job_id}` | Current job. Poll while `status` is `rendering` or `generation.status` is `running`. |
| `POST /api/project/{job_id}/generate` | Starts AdaL Video Producer. On completion, returns an MP4 through the job's `render_url` with `render_mode: "adal"`. |
| `POST /api/project/{job_id}/render` | Starts the local preview with `video_render.py`. When done: `render_mode: "preview"`. |
| `POST /api/project/{job_id}/import` | Multipart `output` with the AdaL MP4. Returns `render_mode: "adal"` and a playable `render_url`. |

Jobs include `generation_available` and `generation: { status, message }`, where the status is `idle`, `running`, `complete`, or `error`. The existing local render fields (`status`, `message`, `render_mode`, `render_url`, `render_label`, `preview_url`, and `adal_url`) distinguish a local preview from an AdaL export. Errors return `{ "error": "...", "message": "..." }` with a 4xx/5xx status. Add `?download=1` to a file URL to download it.

## Sample notes contract (Person B)

`sample/chapters.json` is either an array of seven chapters or `{ "pdf": "...", "script": "...", "chapters": [...] }`. Each chapter needs `page`, `title`, `place`, `era`, `narration`, `visual`, and optionally `asset` (a path relative to `sample/`). Without `asset`, the server matches an image in `sample/` named by page, such as `01-giza.png` or `page-1.jpg`. The default notes and script are `Seven-Wonders-Source-Notes.pdf` and `Seven-Wonders-Recording-Script.pdf`.

## Renderer contract (Person C)

The server supports two calling conventions and picks one by reading `video_render.py`:

```sh
# default (positional)
python video_render.py RECORDING CHAPTERS_JSON OUTPUT_MP4
# used when the script mentions --manifest
python video_render.py --manifest .local/jobs/<id>/manifest.json --output .local/jobs/<id>/preview.mp4
```

Set `LECTURELENS_RENDERER_MODE=positional|manifest` to override. `CHAPTERS_JSON` is an array of the seven chapters, each with an absolute `asset_path` and a `motion_path` (`sample/models/giza-orbit.mp4` on page 1, `sample/models/alexandria-orbit.mp4` on page 7, otherwise `null`). The manifest wraps the same chapters with `video`, `pdf`, `output`, `width`/`height` (1280×720), `models`, `ffmpeg` and `ffprobe`. `FFMPEG`, `FFPROBE` and `LECTURELENS_MANIFEST` are set in the environment. Exit 0 after writing a 16:9 MP4 with the presenter's original audio and page labels. Stdout progress lines appear in the UI; everything is logged to `.local/jobs/<id>/render.log`.

## AdaL prompt (Person A)

For the sample notes, `adal_prompt` is `ADAL-VIDEO-PROMPT.md` with `{{VIDEO}}` (the uploaded recording), `{{PDF}}` (the job's notes PDF) and `{{REFERENCES}}` (the `sample/` folder) filled in, followed by a scene map with each page's illustration and orbit clip. A custom PDF gets a neutral handoff with the recording and PDF paths instead of the Seven Wonders brief.
