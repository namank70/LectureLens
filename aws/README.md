# Cloud upload queue

Lets a hosted frontend submit a recording and notes PDF without reaching the AdaL computer directly. Files go to S3, a job lands in SQS, and a worker on the AdaL computer picks it up.

```
frontend ──POST──> API Gateway ──> upload links ──PUT──> S3
                                                          │ (both files present)
                                                          ▼
AdaL computer: server.js <── long poll ── SQS <── enqueue Lambda
        │    │
        │    └── adal_generation.js ──> output.mp4 ──> S3
        │
        └── HTTP API: GET /jobs/{job_id}/output
```

## Deployed stack

Stack `lecturelens-uploads-20261113` in `us-east-2`, defined by `template.yaml`.

| Resource | Value |
| --- | --- |
| API base URL | `https://ugm369dj9a.execute-api.us-east-2.amazonaws.com` |
| Bucket | `lecturelens-uploads-20261113-690845170348` |
| Queue | `https://sqs.us-east-2.amazonaws.com/690845170348/lecturelens-jobs-20261113` |

The API has no authentication. Delete the stack after the demo.

To deploy a copy elsewhere (resource names include the account ID, so they will differ):

```sh
aws cloudformation deploy --template-file template.yaml \
  --stack-name lecturelens-uploads-20261113 --capabilities CAPABILITY_NAMED_IAM
```

## Frontend contract

1. `POST /uploads/video` (no body) returns `{ job_id, bucket, key, content_type, upload_url }`.
2. `PUT <upload_url>` with the raw MP4 as the body and `Content-Type: video/mp4`.
3. `POST /uploads/notes?job_id=<job_id>` returns the same shape for the PDF.
4. `PUT <upload_url>` with the raw PDF as the body and `Content-Type: application/pdf`.

Once both files exist the job is queued automatically; there is no submit call.

```js
const API = 'https://ugm369dj9a.execute-api.us-east-2.amazonaws.com';

async function submitJob(videoFile, notesFile) {
  const v = await (await fetch(`${API}/uploads/video`, { method: 'POST' })).json();
  await fetch(v.upload_url, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: videoFile });
  const n = await (await fetch(`${API}/uploads/notes?job_id=${v.job_id}`, { method: 'POST' })).json();
  await fetch(n.upload_url, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: notesFile });
  return v.job_id;
}
```

- The `Content-Type` on each `PUT` must match exactly, or S3 returns 403.
- Send the `File` itself as the body, not `FormData`.
- Upload links expire after 15 minutes.
- `job_id` accepts letters, digits, `-` and `_`, up to 64 characters.
- Each job is queued once. Re-uploading a file replaces it but does not queue the job again.
- Job status comes from the queue server on the AdaL computer (see below), not from this API. The server writes `jobs/<job_id>/output.mp4`, or `jobs/<job_id>/error.txt` on failure.

## Queue message

```json
{
  "job_id": "…",
  "bucket": "lecturelens-uploads-20261113-690845170348",
  "video_key": "jobs/<job_id>/recording.mp4",
  "notes_key": "jobs/<job_id>/notes.pdf",
  "output_key": "jobs/<job_id>/output.mp4",
  "error_key": "jobs/<job_id>/error.txt"
}
```

## Run the queue server

`server.js` consumes the queue and serves job status from one process. Run it on the computer where the AdaL CLI is installed and signed in. It needs Node 22+, ffprobe, and AWS credentials (default provider chain) that can read and write the bucket and receive and delete on the queue.

```sh
cd aws
npm install
# PowerShell: $env:SQS_QUEUE_URL = "..."; npm run server
SQS_QUEUE_URL=https://sqs.us-east-2.amazonaws.com/690845170348/lecturelens-jobs-20261113 npm run server
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `SQS_QUEUE_URL` | none, required | Queue to consume |
| `AWS_REGION` | `us-east-2` | Region for S3 and SQS |
| `PORT` | `8080` | HTTP port (3000 is taken by the studio) |
| `HOST` | `127.0.0.1` | Bind address |
| `FFPROBE` | `ffprobe` | ffprobe used to verify the MP4 |
| `ADAL_BIN` | unset | AdaL CLI path, if it is not on `PATH` |
| `UPLOADS_BUCKET` | the deployed bucket above | Bucket read at startup to restore finished jobs |

The server exits with a one-line message if `SQS_QUEUE_URL` is missing or the AdaL CLI cannot be found.

Jobs run one at a time, in the order received. Each job fills `ADAL-VIDEO-PROMPT.md` with the downloaded files and calls `generateLesson` from `adal_generation.js`, the same call the studio server's generate route makes. It does not add the per-scene map that the studio's `server.js` appends for the sample notes. Working files stay under `.local/aws-jobs/<job_id>/`.

On startup the server lists the bucket and restores every job that already has an `output.mp4` (as `done`) or an `error.txt` (as `failed`), so earlier videos stay available after a restart. Jobs that were still waiting or running are not restored; SQS delivers them again.

A job's queue message is deleted only once the job is `done` or `failed`. A failed job is also recorded in `error.txt`. Upload again with a new job to retry.

### API

Every response is JSON and carries `Access-Control-Allow-Origin: *`. There is no authentication. Only `GET` (and `OPTIONS`) is accepted; other methods return 405, and unknown paths return 404 with `{ "error": "not_found" }`.

#### `GET /jobs/{job_id}/output`

`status` is always present and is one of `notfound`, `pending`, `done` or `failed`.

Unknown job (HTTP 404):

```json
{ "job_id": "dcb21e02a65244deb63459be110fcb99", "status": "notfound" }
```

Received, waiting or generating (HTTP 200):

```json
{
  "job_id": "dcb21e02a65244deb63459be110fcb99",
  "status": "pending",
  "message": "AdaL is producing the lesson. Video generation can take several minutes.",
  "input": {
    "bucket": "lecturelens-uploads-20261113-690845170348",
    "video_key": "jobs/dcb21e02a65244deb63459be110fcb99/recording.mp4",
    "notes_key": "jobs/dcb21e02a65244deb63459be110fcb99/notes.pdf"
  }
}
```

Finished (HTTP 200). `output.url` is a presigned S3 link to the video, valid for one hour and generated fresh on every request:

```json
{
  "job_id": "dcb21e02a65244deb63459be110fcb99",
  "status": "done",
  "input": { "bucket": "…", "video_key": "…", "notes_key": "…" },
  "output": {
    "bucket": "lecturelens-uploads-20261113-690845170348",
    "key": "jobs/dcb21e02a65244deb63459be110fcb99/output.mp4",
    "url": "https://lecturelens-uploads-20261113-690845170348.s3.us-east-2.amazonaws.com/jobs/…/output.mp4?X-Amz-…",
    "expires_in": 3600
  }
}
```

Generation failed (HTTP 200):

```json
{
  "job_id": "dcb21e02a65244deb63459be110fcb99",
  "status": "failed",
  "message": "AdaL generation timed out. Try a shorter clip or finish and export it from AdaL.",
  "input": { "bucket": "…", "video_key": "…", "notes_key": "…" }
}
```

`notfound` does not always mean the job does not exist. Job state is kept in memory only, so the server also answers `notfound` for:

- a job whose files are uploaded but whose queue message this server has not received yet (normally a few seconds, up to about 20), and
- a job from before the server last restarted that had not finished. It reports `notfound` until SQS delivers its message again, which can take up to the 30-minute visibility timeout. Finished jobs are restored from the bucket and keep reporting `done` or `failed`.

Keep polling for a short while after an upload before treating `notfound` as final.

#### `GET /jobs`

Every job the server knows about, newest first, without presigned URLs. This includes finished jobs restored from the bucket; the upload page uses it for its **Past lessons** list and asks `/jobs/{job_id}/output` for a link when one is chosen:

```json
{
  "jobs": [
    {
      "job_id": "dcb21e02a65244deb63459be110fcb99",
      "status": "done",
      "message": "The lesson video is ready.",
      "input": { "bucket": "…", "video_key": "…", "notes_key": "…" },
      "output": { "bucket": "…", "key": "jobs/dcb21e02a65244deb63459be110fcb99/output.mp4" },
      "received_at": "2026-11-13T19:42:10.123Z",
      "finished_at": "2026-11-13T19:49:55.456Z"
    }
  ]
}
```

#### `GET /health`

```json
{
  "ok": true,
  "queue_url": "https://sqs.us-east-2.amazonaws.com/690845170348/lecturelens-jobs-20261113",
  "adal_found": true,
  "jobs": { "pending": 1, "done": 3, "failed": 0 }
}
```

### Reaching the server

It listens on `127.0.0.1:8080` on the AdaL computer. A frontend hosted elsewhere cannot reach that address without a tunnel or a shared network.

### Tests

```sh
cd aws
npm test
```

The tests use fakes for SQS, S3 and AdaL, so they need no credentials. From the repo root, run `node --test aws/server.test.js`.

## Worker without the API

`worker.js` is the original queue consumer with no HTTP API: `npm start` with the same `SQS_QUEUE_URL`, `AWS_REGION`, `ADAL_BIN` and `FFPROBE` variables. Run either the worker or the server against a queue, not both.
