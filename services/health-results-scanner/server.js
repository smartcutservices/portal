'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const SCAN_TIMEOUT_MS = 30_000;
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);

function matchesMimeSignature(buffer, mime) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (mime === 'application/pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mime === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return false;
}

function readLimitedBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_FILE_BYTES) {
        reject(Object.assign(new Error('file-too-large'), { statusCode: 413 }));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function scanWithClamAV(buffer) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sch-scan-'));
  const filePath = path.join(directory, randomUUID());
  try {
    await writeFile(filePath, buffer, { mode: 0o600, flag: 'wx' });
    const verdict = await new Promise((resolve, reject) => {
      const process = spawn(process.env.CLAMSCAN_BIN || 'clamdscan', ['--no-summary', '--fdpass', filePath], { stdio: 'ignore' });
      const timer = setTimeout(() => { process.kill('SIGKILL'); reject(new Error('scan-timeout')); }, SCAN_TIMEOUT_MS);
      process.once('error', (error) => { clearTimeout(timer); reject(error); });
      process.once('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve('CLEAN');
        else if (code === 1) resolve('INFECTED');
        else reject(new Error('scanner-engine-failed'));
      });
    });
    return verdict;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createServer({ scan = scanWithClamAV, scannerVersion = 'ClamAV' } = {}) {
  return http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/scan') {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      const mime = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
      if (!ALLOWED_MIME.has(mime)) throw Object.assign(new Error('unsupported-file-type'), { statusCode: 415 });
      const buffer = await readLimitedBody(request);
      if (!buffer.length || !matchesMimeSignature(buffer, mime)) throw Object.assign(new Error('file-signature-mismatch'), { statusCode: 415 });
      const verdict = await scan(buffer);
      if (verdict !== 'CLEAN' && verdict !== 'INFECTED') throw new Error('invalid-scanner-verdict');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: verdict, scannerVersion: String(scannerVersion).slice(0, 80) }));
    } catch (error) {
      const status = Number(error?.statusCode) || 503;
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'UNAVAILABLE', error: status < 500 ? 'invalid-file' : 'scanner-unavailable' }));
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  const server = createServer({ scannerVersion: process.env.CLAMAV_VERSION || 'ClamAV' });
  server.listen(port, '0.0.0.0');
  server.on('error', () => process.exit(1));
}

module.exports = { MAX_FILE_BYTES, matchesMimeSignature, readLimitedBody, createServer };
