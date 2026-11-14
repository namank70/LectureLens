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
