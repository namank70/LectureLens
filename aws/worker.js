'use strict';

// LectureLens queue worker.
//
// Run this on the computer where the AdaL CLI is installed and signed in.
// It long-polls the SQS queue. For each job it downloads the recording and
// notes from S3, runs the same AdaL generation the studio uses
// (adal_generation.js), and uploads the finished MP4 back to S3.
//
//   cd aws && npm install
//   SQS_QUEUE_URL=... AWS_REGION=us-east-2 node worker.js
//
// AWS credentials come from the usual places (environment, ~/.aws, SSO).

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const { findAdal, generateLesson } = require('../adal_generation.js');

const ROOT = path.resolve(__dirname, '..');
const PROMPT_FILE = path.join(ROOT, 'ADAL-VIDEO-PROMPT.md');
const SAMPLE_DIR = path.join(ROOT, 'sample');
const JOBS_DIR = path.join(ROOT, '.local', 'aws-jobs');

const REGION = process.env.AWS_REGION || 'us-east-2';
const QUEUE_URL = process.env.SQS_QUEUE_URL;
const FFPROBE = process.env.FFPROBE || 'ffprobe';

// Job IDs become folder names, so accept only what the upload API issues.
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

function buildPrompt(video, pdf) {
  const tokens = { VIDEO: video, PDF: pdf, REFERENCES: SAMPLE_DIR };
  if (fs.existsSync(PROMPT_FILE)) {
    return fs
      .readFileSync(PROMPT_FILE, 'utf8')
      .replace(/^﻿/, '')
      .replace(/\{\{\s*([A-Z_]+)\s*\}\}/g, (whole, name) => tokens[name] ?? whole)
      .trim();
  }
  return [
    'LectureLens: AdaL video brief',
    '',
    `- Presenter recording (keep the original voice): ${video}`,
    `- Source notes PDF: ${pdf}`,
    '',
    'Turn the recording and notes into a short 16:9 narrated lesson with one labeled scene per main point.',
  ].join('\n');
}

// store: { download(bucket, key, file), upload(bucket, key, file, contentType), putText(bucket, key, text) }
// onProgress, ffprobe and jobsDir are optional; the queue server (server.js) uses them to
// surface progress through its API and to keep test runs out of .local/.
async function processJob(job, {
  store, generate = generateLesson, command = findAdal(), log = console.log,
  onProgress = () => {}, ffprobe = FFPROBE, jobsDir = JOBS_DIR,
}) {
  if (!JOB_ID.test(String(job.job_id || ''))) throw new Error('The queue message has no valid job_id.');
  const dir = path.join(jobsDir, job.job_id);
  await fsp.mkdir(dir, { recursive: true });
  const video = path.join(dir, 'recording.mp4');
  const pdf = path.join(dir, 'notes.pdf');

  try {
    await store.download(job.bucket, job.video_key, video);
    await store.download(job.bucket, job.notes_key, pdf);
    const output = await generate({
      folder: dir,
      prompt: buildPrompt(video, pdf),
      command,
      ffprobe,
      onProgress: (message) => {
        log(`[${job.job_id}] ${message}`);
        onProgress(message);
      },
    });
    await store.upload(job.bucket, job.output_key, output, 'video/mp4');
    log(`[${job.job_id}] uploaded s3://${job.bucket}/${job.output_key}`);
    return { ok: true, output };
  } catch (error) {
    log(`[${job.job_id}] failed: ${error.message}`);
    await store.putText(job.bucket, job.error_key, error.message).catch(() => {});
    return { ok: false, error };
  }
}

function s3Store(s3, { GetObjectCommand, PutObjectCommand, ListObjectsV2Command }) {
  return {
    async download(Bucket, Key, file) {
      const { Body } = await s3.send(new GetObjectCommand({ Bucket, Key }));
      await pipeline(Body, fs.createWriteStream(file));
    },
    async upload(Bucket, Key, file, ContentType) {
      const { size } = await fsp.stat(file);
      await s3.send(new PutObjectCommand({ Bucket, Key, Body: fs.createReadStream(file), ContentLength: size, ContentType }));
    },
    async putText(Bucket, Key, text) {
      await s3.send(new PutObjectCommand({ Bucket, Key, Body: text, ContentType: 'text/plain; charset=utf-8' }));
    },
    // Every object under a prefix, as [{ key, lastModified }].
    async list(Bucket, Prefix) {
      const objects = [];
      let ContinuationToken;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
        for (const item of page.Contents || []) objects.push({ key: item.Key, lastModified: item.LastModified });
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return objects;
    },
  };
}

async function main() {
  if (!QUEUE_URL) throw new Error('Set SQS_QUEUE_URL to the queue URL from the stack outputs.');
  const command = findAdal();
  if (!command) throw new Error('The AdaL CLI was not found. Install it, run "adal" once to sign in, or set ADAL_BIN.');

  const s3sdk = require('@aws-sdk/client-s3');
  const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
  const sqs = new SQSClient({ region: REGION });
  const store = s3Store(new s3sdk.S3Client({ region: REGION }), s3sdk);

  console.log(`Polling ${QUEUE_URL}`);
  for (;;) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: QUEUE_URL, MaxNumberOfMessages: 1, WaitTimeSeconds: 20 }),
    );
    for (const message of Messages) {
      let job = {};
      try {
        job = JSON.parse(message.Body);
        console.log(`[${job.job_id}] started`);
        await processJob(job, { store, command });
      } catch (error) {
        console.error(`Skipping a message that could not be processed: ${error.message}`);
      }
      // Delete either way so a broken job cannot loop. Resubmit to retry.
      await sqs.send(new DeleteMessageCommand({ QueueUrl: QUEUE_URL, ReceiptHandle: message.ReceiptHandle }));
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { JOB_ID, JOBS_DIR, buildPrompt, processJob, s3Store };
