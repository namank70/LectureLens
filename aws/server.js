'use strict';

// LectureLens queue server.
//
// Run this on the computer where the AdaL CLI is installed and signed in.
// One process does two things:
//   - consumes jobs from SQS and runs them one at a time through AdaL
//     (the same processJob the plain worker uses), and
//   - serves an HTTP API that reports each job's output.
//
//   cd aws && npm install
//   SQS_QUEUE_URL=... npm run server
//
// Job state lives in memory only. On startup, finished jobs are read back
// from the bucket so earlier videos stay listed; jobs that were still
// waiting or running are not restored.
// AWS credentials come from the default provider chain.

const http = require('node:http');

const { findAdal, generateLesson } = require('../adal_generation.js');
const { JOB_ID, JOBS_DIR, processJob, s3Store } = require('./worker.js');

const URL_TTL_SECONDS = 3600;
const DEFAULT_BUCKET = 'lecturelens-uploads-20261113-690845170348';
const JOB_OBJECT = /^jobs\/([A-Za-z0-9_-]{1,64})\/(recording\.mp4|notes\.pdf|output\.mp4|error\.txt)$/;
const SQS_RETRY_MS = 5000;

// --- In-memory job store -------------------------------------------------
// Kept behind get/set/has/list so a real store can replace it later.

function createStore() {
  const jobs = new Map();
  return {
    get: (jobId) => jobs.get(jobId),
    set: (jobId, record) => { jobs.set(jobId, record); },
    has: (jobId) => jobs.has(jobId),
    list: () => [...jobs.values()],
  };
}

// Rebuilds records for jobs that finished before this process started, from
// what they left in the bucket: output.mp4 means done, error.txt means failed.
// Jobs with neither are left out, so SQS can deliver them again.
async function restoreJobs({ store, objectStore, bucket, log = console.log }) {
  const found = new Map();
  for (const { key, lastModified } of await objectStore.list(bucket, 'jobs/')) {
    const match = JOB_OBJECT.exec(key);
    if (!match) continue;
    const files = found.get(match[1]) || {};
    files[match[2]] = lastModified ? new Date(lastModified).toISOString() : null;
    found.set(match[1], files);
  }

  let restored = 0;
  for (const [jobId, files] of found) {
    const done = 'output.mp4' in files;
    if (store.has(jobId) || (!done && !('error.txt' in files))) continue;
    const finishedAt = files[done ? 'output.mp4' : 'error.txt'];
    store.set(jobId, {
      job_id: jobId,
      status: done ? 'done' : 'failed',
      message: done ? 'The lesson video is ready.' : 'This job failed before the server last restarted.',
      input: { bucket, video_key: `jobs/${jobId}/recording.mp4`, notes_key: `jobs/${jobId}/notes.pdf` },
      output: done ? { bucket, key: `jobs/${jobId}/output.mp4` } : null,
      received_at: files['recording.mp4'] || finishedAt,
      finished_at: finishedAt,
    });
    restored += 1;
  }
  log(`Restored ${restored} finished job${restored === 1 ? '' : 's'} from s3://${bucket}`);
  return restored;
}

// --- Queue consumer ------------------------------------------------------
// sqs:         { receive() -> [{ Body, ReceiptHandle }], delete(message) }
// store:       the job store above
// objectStore: { download, upload, putText } (see s3Store in worker.js)

function createConsumer({
  sqs, store, objectStore, generate = generateLesson, command, log = console.log,
  ffprobe, jobsDir = JOBS_DIR, retryMs = SQS_RETRY_MS,
}) {
  const fifo = [];
  const latestMessage = new Map(); // job_id -> most recent SQS delivery of that job
  let running = null;
  let stopped = false;
  let wake = () => {};

  async function deleteMessage(message, label) {
    try {
      await sqs.delete(message);
    } catch (error) {
      // SQS redelivers it; the redelivery is deleted once the job is finished.
      log(`[${label}] could not delete the queue message: ${error.message}`);
    }
  }

  function update(jobId, changes) {
    store.set(jobId, { ...store.get(jobId), ...changes });
  }

  async function runJob(job) {
    const jobId = job.job_id;
    try {
      update(jobId, { message: 'Downloading the recording and notes.' });
      const result = await processJob(job, {
        store: objectStore,
        generate,
        command,
        log,
        ffprobe,
        jobsDir,
        onProgress: (message) => update(jobId, { message: String(message) }),
      });
      if (!result.ok) throw result.error;
      update(jobId, {
        status: 'done',
        message: 'The lesson video is ready.',
        output: { bucket: job.bucket, key: job.output_key },
        finished_at: new Date().toISOString(),
      });
    } catch (error) {
      update(jobId, {
        status: 'failed',
        message: String(error?.message || error || 'The job failed.'),
        finished_at: new Date().toISOString(),
      });
    }
    // Only now is the job settled, so only now may the message go.
    const message = latestMessage.get(jobId);
    latestMessage.delete(jobId);
    await deleteMessage(message, jobId);
  }

  // The single runner: never more than one AdaL generation at a time.
  function pump() {
    if (running) return;
    running = (async () => {
      while (fifo.length) {
        const job = fifo.shift();
        try {
          await runJob(job);
        } catch (error) {
          log(`[${job.job_id}] unexpected error: ${error.message}`);
        }
      }
      running = null;
    })();
  }

  // Registers the job and returns straight away; generation runs behind it.
  async function handleMessage(message) {
    let job = null;
    try {
      job = JSON.parse(message.Body);
    } catch {
      // Handled below with every other unusable body.
    }
    const jobId = job && typeof job === 'object' ? job.job_id : null;
    if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) {
      log('Dropping a queue message without a valid job_id.');
      await deleteMessage(message, 'invalid');
      return;
    }

    if (store.has(jobId)) {
      // Redelivery. Never run it twice.
      if (store.get(jobId).status === 'pending') {
        latestMessage.set(jobId, message); // the newest receipt handle is the one to delete later
      } else {
        await deleteMessage(message, jobId);
      }
      return;
    }

    store.set(jobId, {
      job_id: jobId,
      status: 'pending',
      message: 'Waiting to start.',
      input: { bucket: job.bucket, video_key: job.video_key, notes_key: job.notes_key },
      output: null,
      received_at: new Date().toISOString(),
      finished_at: null,
    });
    latestMessage.set(jobId, message);
    fifo.push(job);
    log(`[${jobId}] received`);
    pump();
  }

  function pause(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => { clearTimeout(timer); resolve(); };
    });
  }

  // Long-poll loop. Nothing that happens in here may end it except stop().
  async function start() {
    stopped = false;
    while (!stopped) {
      try {
        const messages = await sqs.receive();
        for (const message of messages) {
          try {
            await handleMessage(message);
          } catch (error) {
            log(`Could not handle a queue message: ${error.message}`);
          }
        }
      } catch (error) {
        if (stopped) break;
        log(`SQS error: ${error.message}. Retrying in ${Math.round(retryMs / 1000)} seconds.`);
        await pause(retryMs);
      }
    }
  }

  function stop() {
    stopped = true;
    wake();
  }

  // Resolves once every job received so far has finished. Used by tests.
  async function idle() {
    while (running) await running;
  }

  return { handleMessage, start, stop, idle };
}

// --- HTTP API ------------------------------------------------------------

function createHttpHandler({ store, presign, queueUrl = null, adalFound = true, log = console.log }) {
  function send(res, status, body, headers = {}) {
    const text = body === null ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Content-Length': Buffer.byteLength(text),
      ...headers,
    });
    res.end(text);
  }

  async function jobOutput(res, jobId) {
    const record = JOB_ID.test(jobId) ? store.get(jobId) : null;
    if (!record) return send(res, 404, { job_id: jobId, status: 'notfound' });

    const { job_id, status, message, input, output } = record;
    if (status === 'done') {
      const url = await presign(output.bucket, output.key, URL_TTL_SECONDS);
      return send(res, 200, {
        job_id, status, input, output: { ...output, url, expires_in: URL_TTL_SECONDS },
      });
    }
    return send(res, 200, { job_id, status, message, input });
  }

  function health(res) {
    const jobs = { pending: 0, done: 0, failed: 0 };
    for (const record of store.list()) jobs[record.status] += 1;
    send(res, 200, { ok: true, queue_url: queueUrl, adal_found: Boolean(adalFound), jobs });
  }

  function listJobs(res) {
    // Newest first; the reverse keeps that order for jobs received in the same millisecond.
    const jobs = store.list().reverse()
      .sort((a, b) => String(b.received_at).localeCompare(String(a.received_at)));
    send(res, 200, { jobs });
  }

  return async function handle(req, res) {
    try {
      if (req.method === 'OPTIONS') {
        return send(res, 204, null, {
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
      }

      const { pathname } = new URL(req.url, 'http://localhost');
      const outputRoute = /^\/jobs\/([^/]+)\/output$/.exec(pathname);
      const known = outputRoute || pathname === '/jobs' || pathname === '/health';
      if (!known) return send(res, 404, { error: 'not_found' });
      if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, OPTIONS' });

      if (pathname === '/health') return health(res);
      if (pathname === '/jobs') return listJobs(res);

      let jobId = outputRoute[1];
      try {
        jobId = decodeURIComponent(jobId);
      } catch {
        // Leave a badly encoded ID as it is; it fails the pattern and reports notfound.
      }
      return await jobOutput(res, jobId);
    } catch (error) {
      log(`HTTP error on ${req.method} ${req.url}: ${error.message}`);
      if (res.headersSent) return res.end();
      return send(res, 500, { error: 'internal_error' });
    }
  };
}

// --- Real AWS wiring -----------------------------------------------------

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main() {
  const queueUrl = process.env.SQS_QUEUE_URL;
  if (!queueUrl) fail('Set SQS_QUEUE_URL to the SQS queue URL before starting the server.');
  const command = findAdal();
  if (!command) fail('The AdaL CLI was not found. Install it, run "adal" once to sign in, or set ADAL_BIN.');

  const region = process.env.AWS_REGION || 'us-east-2';
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '127.0.0.1';
  const bucket = process.env.UPLOADS_BUCKET || DEFAULT_BUCKET;

  const s3sdk = require('@aws-sdk/client-s3');
  const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

  const s3 = new s3sdk.S3Client({ region });
  const sqsClient = new SQSClient({ region });
  const sqs = {
    async receive() {
      const { Messages = [] } = await sqsClient.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 20,
      }));
      return Messages;
    },
    async delete(message) {
      await sqsClient.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    },
  };
  const presign = (Bucket, Key, expiresIn) => getSignedUrl(s3, new s3sdk.GetObjectCommand({ Bucket, Key }), { expiresIn });

  const store = createStore();
  const objectStore = s3Store(s3, s3sdk);
  const consumer = createConsumer({
    sqs, store, objectStore, command, ffprobe: process.env.FFPROBE || 'ffprobe',
  });
  // Before polling starts, so a redelivered message for a finished job is recognised.
  try {
    await restoreJobs({ store, objectStore, bucket });
  } catch (error) {
    console.error(`Could not restore earlier jobs from s3://${bucket}: ${error.message}`);
  }
  const server = http.createServer(createHttpHandler({ store, presign, queueUrl, adalFound: true }));

  server.on('error', (error) => fail(`Could not listen on ${host}:${port}: ${error.message}`));
  server.listen(port, host, () => {
    console.log(`LectureLens queue server on http://${host}:${port}`);
    console.log(`Polling ${queueUrl}`);
    consumer.start();
  });
}

if (require.main === module) main().catch((error) => fail(error.message));

module.exports = { createStore, createConsumer, createHttpHandler, restoreJobs };
