'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer, matchesMimeSignature } = require('./server');

const pdf = Buffer.from('%PDF-1.7 sample');
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);

async function withServer(options, run) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('validates content signatures instead of trusting the supplied MIME header', () => {
  assert.equal(matchesMimeSignature(pdf, 'application/pdf'), true);
  assert.equal(matchesMimeSignature(png, 'image/png'), true);
  assert.equal(matchesMimeSignature(jpeg, 'image/jpeg'), true);
  assert.equal(matchesMimeSignature(Buffer.from('not a pdf'), 'application/pdf'), false);
  assert.equal(matchesMimeSignature(png, 'image/jpeg'), false);
});

test('returns a clean verdict without echoing or logging file contents', async () => {
  let scanned;
  await withServer({ scan: async (buffer) => { scanned = buffer; return 'CLEAN'; }, scannerVersion: 'test-engine' }, async (base) => {
    const response = await fetch(`${base}/scan`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: pdf });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'CLEAN', scannerVersion: 'test-engine' });
    assert.deepEqual(scanned, pdf);
  });
});

test('reports infected files without making them available as clean', async () => {
  await withServer({ scan: async () => 'INFECTED' }, async (base) => {
    const response = await fetch(`${base}/scan`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: pdf });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'INFECTED');
  });
});

test('rejects spoofed MIME types and never returns CLEAN when the engine fails', async () => {
  await withServer({ scan: async () => { throw new Error('engine unavailable'); } }, async (base) => {
    const spoofed = await fetch(`${base}/scan`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: png });
    assert.equal(spoofed.status, 415);
    assert.equal((await spoofed.json()).status, 'UNAVAILABLE');
    const unavailable = await fetch(`${base}/scan`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: pdf });
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).status, 'UNAVAILABLE');
  });
});
