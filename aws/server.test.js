'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createStore, createConsumer, createHttpHandler } = require('./server.js');

const BUCKET = 'test-bucket';

function jobMessage(jobId, receipt = `receipt-${jobId}`) {
  return {
    ReceiptHandle: receipt,
    Body: JSON.stringify({
      job_id: jobId,
      bucket: BUCKET,
      video_key: `jobs/${jobId}/recording.mp4`,
      notes_key: `jobs/${jobId}/notes.pdf`,
      output_key: `jobs/${jobId}/output.mp4`,
      error_key: `jobs/${jobId}/error.txt`,
    }),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Builds a consumer and an HTTP server wired to fakes for SQS, S3, presign and generate.
async function setup(t, { generate } = {}) {
  const jobsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lecturelens-test-'));
  const deleted = [];
  const uploads = [];
  const texts = [];
  const generations = [];

  const sqs = {
    receive: async () => [],
    delete: async (message) => { deleted.push(message.ReceiptHandle); },
  };
  const objectStore = {
    download: async (bucket, key, file) => { await fsp.writeFile(file, `contents of ${key}`); },
    upload: async (bucket, key, file, contentType) => { uploads.push({ bucket, key, file, contentType }); },
    putText: async (bucket, key, text) => { texts.push({ bucket, key, text }); },
  };
  const defaultGenerate = async ({ folder }) => {
    const output = path.join(folder, 'lesson.mp4');
    await fsp.writeFile(output, 'video');
    return output;
  };
  const store = createStore();
  const consumer = createConsumer({
    sqs,
    store,
    objectStore,
    command: 'adal',
    log: () => {},
    jobsDir,
    generate: async (options) => {
      generations.push(options);
      return (generate || defaultGenerate)(options);
    },
  });

  const presign = async (bucket, key, expiresIn) => `https://signed.example/${bucket}/${key}?expires=${expiresIn}`;
  const server = http.createServer(createHttpHandler({
    store, presign, queueUrl: 'https://sqs.example/queue', adalFound: true, log: () => {},
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await consumer.idle();
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(jobsDir, { recursive: true, force: true });
  });

  const request = async (route, options) => {
    const response = await fetch(base + route, options);
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };

  return { consumer, store, jobsDir, deleted, uploads, texts, generations, request };
}

test('unknown job returns 404 with status notfound', async (t) => {
  const { request } = await setup(t);
  const response = await request('/jobs/doesnotexist/output');
  assert.strictEqual(response.status, 404);
  assert.deepStrictEqual(response.body, { job_id: 'doesnotexist', status: 'notfound' });
  assert.strictEqual(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.strictEqual(response.headers.get('access-control-allow-origin'), '*');
});

test('a malformed job_id in the URL reports notfound', async (t) => {
  const { request } = await setup(t);
  const response = await request('/jobs/bad%20id!/output');
  assert.strictEqual(response.status, 404);
  assert.deepStrictEqual(response.body, { job_id: 'bad id!', status: 'notfound' });
});

test('a received job reports pending before generation finishes', async (t) => {
  const gate = deferred();
  const started = deferred();
  const { consumer, deleted, request } = await setup(t, {
    generate: async ({ folder, onProgress }) => {
      onProgress('AdaL is producing the lesson.');
      started.resolve();
      await gate.promise;
      const output = path.join(folder, 'lesson.mp4');
      await fsp.writeFile(output, 'video');
      return output;
    },
  });

  await consumer.handleMessage(jobMessage('job1'));
  const waiting = await request('/jobs/job1/output');
  assert.strictEqual(waiting.status, 200);
  assert.strictEqual(waiting.body.status, 'pending');
  assert.deepStrictEqual(waiting.body.input, {
    bucket: BUCKET, video_key: 'jobs/job1/recording.mp4', notes_key: 'jobs/job1/notes.pdf',
  });
  assert.strictEqual(waiting.body.output, undefined);

  await started.promise;
  const generating = await request('/jobs/job1/output');
  assert.strictEqual(generating.body.status, 'pending');
  assert.strictEqual(generating.body.message, 'AdaL is producing the lesson.');
  assert.deepStrictEqual(deleted, [], 'the message stays on the queue while the job is pending');

  gate.resolve();
  await consumer.idle();
});

test('a successful run reports done, uploads the video and deletes the message', async (t) => {
  const { consumer, deleted, uploads, texts, generations, jobsDir, request } = await setup(t);
  await consumer.handleMessage(jobMessage('job1'));
  await consumer.idle();

  const response = await request('/jobs/job1/output');
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.body.status, 'done');
  assert.deepStrictEqual(response.body.output, {
    bucket: BUCKET,
    key: 'jobs/job1/output.mp4',
    url: `https://signed.example/${BUCKET}/jobs/job1/output.mp4?expires=3600`,
    expires_in: 3600,
  });
  assert.strictEqual(response.body.input.video_key, 'jobs/job1/recording.mp4');

  assert.strictEqual(uploads.length, 1);
  assert.strictEqual(uploads[0].bucket, BUCKET);
  assert.strictEqual(uploads[0].key, 'jobs/job1/output.mp4');
  assert.strictEqual(uploads[0].contentType, 'video/mp4');
  assert.deepStrictEqual(texts, []);
  assert.deepStrictEqual(deleted, ['receipt-job1']);

  // The inputs were downloaded into the job folder and handed to generate.
  assert.strictEqual(generations.length, 1);
  assert.strictEqual(generations[0].folder, path.join(jobsDir, 'job1'));
  assert.strictEqual(generations[0].command, 'adal');
  assert.ok(generations[0].prompt.includes(path.join(jobsDir, 'job1', 'recording.mp4')));
  assert.ok(generations[0].prompt.includes(path.join(jobsDir, 'job1', 'notes.pdf')));
  assert.ok(fs.existsSync(path.join(jobsDir, 'job1', 'notes.pdf')));
});

test('a failed generation reports failed, writes error_key and deletes the message', async (t) => {
  const { consumer, deleted, uploads, texts, request } = await setup(t, {
    generate: async () => { throw new Error('AdaL needs a signed-in account.'); },
  });
  await consumer.handleMessage(jobMessage('job1'));
  await consumer.idle();

  const response = await request('/jobs/job1/output');
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.body.status, 'failed');
  assert.strictEqual(response.body.message, 'AdaL needs a signed-in account.');
  assert.strictEqual(response.body.output, undefined);
  assert.deepStrictEqual(texts, [
    { bucket: BUCKET, key: 'jobs/job1/error.txt', text: 'AdaL needs a signed-in account.' },
  ]);
  assert.deepStrictEqual(uploads, []);
  assert.deepStrictEqual(deleted, ['receipt-job1']);
});

test('a second message with the same job_id does not start a second generation', async (t) => {
  const gate = deferred();
  const { consumer, deleted, generations } = await setup(t, {
    generate: async ({ folder }) => {
      await gate.promise;
      const output = path.join(folder, 'lesson.mp4');
      await fsp.writeFile(output, 'video');
      return output;
    },
  });

  await consumer.handleMessage(jobMessage('job1', 'first'));
  await consumer.handleMessage(jobMessage('job1', 'second'));
  assert.deepStrictEqual(deleted, [], 'a redelivery of a pending job is not deleted');

  gate.resolve();
  await consumer.idle();
  assert.strictEqual(generations.length, 1);
  assert.deepStrictEqual(deleted, ['second'], 'the newest receipt handle is deleted when the job finishes');

  // A redelivery after the job finished is deleted and still does not run again.
  await consumer.handleMessage(jobMessage('job1', 'third'));
  await consumer.idle();
  assert.strictEqual(generations.length, 1);
  assert.deepStrictEqual(deleted, ['second', 'third']);
});

test('a message with a bad job_id is deleted and creates no record and no folder', async (t) => {
  const { consumer, store, deleted, generations, jobsDir, request } = await setup(t);
  await consumer.handleMessage(jobMessage('../x', 'bad-id'));
  await consumer.handleMessage({ ReceiptHandle: 'not-json', Body: 'this is not JSON' });
  await consumer.handleMessage({ ReceiptHandle: 'no-id', Body: '{"bucket":"b"}' });
  await consumer.idle();

  assert.deepStrictEqual(deleted, ['bad-id', 'not-json', 'no-id']);
  assert.deepStrictEqual(store.list(), []);
  assert.strictEqual(generations.length, 0);
  assert.deepStrictEqual(await fsp.readdir(jobsDir), []);
  assert.ok(!fs.existsSync(path.join(jobsDir, '..', 'x')));
  assert.deepStrictEqual((await request('/jobs')).body, { jobs: [] });
});

test('two jobs received together run one after the other', async (t) => {
  let active = 0;
  let mostActive = 0;
  const order = [];
  const { consumer, deleted, request } = await setup(t, {
    generate: async ({ folder }) => {
      active += 1;
      mostActive = Math.max(mostActive, active);
      order.push(`start ${path.basename(folder)}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push(`end ${path.basename(folder)}`);
      active -= 1;
      const output = path.join(folder, 'lesson.mp4');
      await fsp.writeFile(output, 'video');
      return output;
    },
  });

  await consumer.handleMessage(jobMessage('jobA'));
  await consumer.handleMessage(jobMessage('jobB'));
  // The job waiting behind the first one already reports pending.
  assert.strictEqual((await request('/jobs/jobB/output')).body.status, 'pending');
  await consumer.idle();

  assert.strictEqual(mostActive, 1);
  assert.deepStrictEqual(order, ['start jobA', 'end jobA', 'start jobB', 'end jobB']);
  assert.deepStrictEqual(deleted, ['receipt-jobA', 'receipt-jobB']);

  const list = await request('/jobs');
  assert.deepStrictEqual(list.body.jobs.map((job) => job.job_id), ['jobB', 'jobA']);
  assert.ok(list.body.jobs.every((job) => job.status === 'done' && !('url' in job.output)));
});

test('health, CORS preflight, 405 and unknown routes', async (t) => {
  const { consumer, request } = await setup(t, {
    generate: async () => { throw new Error('nope'); },
  });
  await consumer.handleMessage(jobMessage('job1'));
  await consumer.idle();

  const health = await request('/health');
  assert.strictEqual(health.status, 200);
  assert.deepStrictEqual(health.body, {
    ok: true,
    queue_url: 'https://sqs.example/queue',
    adal_found: true,
    jobs: { pending: 0, done: 0, failed: 1 },
  });

  const preflight = await request('/jobs/job1/output', { method: 'OPTIONS' });
  assert.strictEqual(preflight.status, 204);
  assert.strictEqual(preflight.headers.get('access-control-allow-origin'), '*');

  for (const route of ['/jobs', '/health', '/jobs/job1/output']) {
    const response = await request(route, { method: 'POST' });
    assert.strictEqual(response.status, 405, route);
    assert.strictEqual(response.headers.get('access-control-allow-origin'), '*');
  }

  const unknown = await request('/nothing-here');
  assert.strictEqual(unknown.status, 404);
  assert.deepStrictEqual(unknown.body, { error: 'not_found' });
});

test('an SQS error does not stop the polling loop', async (t) => {
  const jobsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lecturelens-test-'));
  t.after(() => fsp.rm(jobsDir, { recursive: true, force: true }));
  const store = createStore();
  const logs = [];
  let calls = 0;
  let consumer;
  const sqs = {
    receive: async () => {
      calls += 1;
      if (calls === 1) throw new Error('network down');
      if (calls === 2) return [jobMessage('job1')];
      consumer.stop();
      return [];
    },
    delete: async () => {},
  };
  consumer = createConsumer({
    sqs,
    store,
    objectStore: { download: async () => {}, upload: async () => {}, putText: async () => {} },
    generate: async ({ folder }) => path.join(folder, 'lesson.mp4'),
    command: 'adal',
    log: (line) => logs.push(line),
    jobsDir,
    retryMs: 5,
  });

  await consumer.start();
  await consumer.idle();
  assert.strictEqual(calls, 3);
  assert.ok(logs.some((line) => line.includes('network down')));
  assert.strictEqual(store.get('job1').status, 'done');
});
