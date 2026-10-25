'use strict';
// Google Drive (v3 REST) for the invoice copies in invoice-backup.js. It signs in with the Gmail OAuth client
// (a Desktop app) and DRIVE_REFRESH_TOKEN from `npm run drive-auth`. The drive.file permission lets the store
// see and change only the folders and files it created itself, nothing else in the Drive.
const crypto = require('crypto');
const config = require('../config');

const FOLDER = 'application/vnd.google-apps.folder';
const FIELDS = 'id,name,mimeType,trashed,parents,appProperties';

let client = null;
let tokenSource = null;

function isConfigured() {
  const { clientId, clientSecret } = config.mail.gmail;
  return Boolean(clientId && clientSecret && config.drive.refreshToken);
}

// The Google Cloud project behind the client ID ("290156006782-abc.apps…"), for the link that enables the API.
const projectNumber = () => (/^(\d+)-/.exec(config.mail.gmail.clientId) || [])[1] || null;

async function accessToken() {
  if (tokenSource) return tokenSource();
  if (!client) {
    const { OAuth2Client } = require('google-auth-library');
    client = new OAuth2Client(config.mail.gmail.clientId, config.mail.gmail.clientSecret);
    client.setCredentials({ refresh_token: config.drive.refreshToken });
  }
  const { token } = await client.getAccessToken();
  return token;
}

// "Drive API 403 storageQuotaExceeded: The user's Drive storage quota has been exceeded."
async function apiError(res) {
  const body = await res.text();
  let reason = '';
  let message = body.replace(/\s+/g, ' ');
  let project = null;
  try {
    const { error } = JSON.parse(body);
    const info = (error.details || []).find((d) => /ErrorInfo$/.test(d['@type'] || '')) || {};
    reason = [info.reason, ...(error.errors || []).map((e) => e.reason)].filter(Boolean).join(' ');
    message = error.message || message;
    project = (/projects\/(\d+)/.exec((info.metadata && info.metadata.consumer) || '') || /project (\d+)/.exec(message) || [])[1] || null;
  } catch {
    // Not JSON: keep the raw text.
  }
  return Object.assign(new Error(`Drive API ${res.status}${reason ? ` ${reason}` : ''}: ${message}`.slice(0, 400)), { status: res.status, reason, project });
}

async function call(method, path, { query = {}, json, body, type } = {}, again = false) {
  const url = new URL(path, config.drive.apiBase);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers = { Authorization: `Bearer ${await accessToken()}` };
  if (json !== undefined) headers['Content-Type'] = 'application/json; charset=UTF-8';
  else if (type) headers['Content-Type'] = type;
  const res = await fetch(url, { method, headers, body: json !== undefined ? JSON.stringify(json) : body, signal: AbortSignal.timeout(120000) });
  // A stale access token: sign in once more before calling it a failure.
  if (res.status === 401 && !again && !tokenSource) {
    client = null;
    return call(method, path, { query, json, body, type }, true);
  }
  if (!res.ok) throw await apiError(res);
  return res.status === 204 ? null : res.json();
}

const about = () => call('GET', '/drive/v3/about', { query: { fields: 'user(emailAddress,displayName)' } });

const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// The store's files (or folders) that carry all these private labels (appProperties), not in the bin.
async function findByLabels(labels, { folder = false } = {}) {
  const q = Object.entries(labels).map(([k, v]) => `appProperties has { key=${quote(k)} and value=${quote(v)} }`);
  q.push('trashed = false');
  if (folder) q.push(`mimeType = ${quote(FOLDER)}`);
  const out = await call('GET', '/drive/v3/files', { query: { q: q.join(' and '), fields: `files(${FIELDS})`, pageSize: 10, spaces: 'drive' } });
  return out.files || [];
}

// The file, or null when it was deleted or sits in the bin (directly or inside a folder in the bin).
async function file(id) {
  try {
    const f = await call('GET', `/drive/v3/files/${encodeURIComponent(id)}`, { query: { fields: FIELDS } });
    return f.trashed ? null : f;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

const createFolder = (name, parent, labels) =>
  call('POST', '/drive/v3/files', { query: { fields: FIELDS }, json: { name, mimeType: FOLDER, parents: parent ? [parent] : undefined, appProperties: labels } });

/**
 * Uploads content: a new file in `parents` when there is no id, else a new version of that file. With
 * keepRevision, Drive keeps the version it replaces for good instead of for 30 days.
 */
function upload({ id = null, name, mimeType, data, parents, labels, keepRevision = false }) {
  const boundary = `mts-${crypto.randomBytes(12).toString('hex')}`;
  const meta = { name, mimeType };
  if (!id && parents) meta.parents = parents;
  if (labels) meta.appProperties = labels;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const query = { uploadType: 'multipart', fields: FIELDS };
  if (id && keepRevision) query.keepRevisionForever = 'true';
  return call(id ? 'PATCH' : 'POST', id ? `/upload/drive/v3/files/${encodeURIComponent(id)}` : '/upload/drive/v3/files', {
    query,
    body,
    type: `multipart/related; boundary=${boundary}`,
  });
}

// Moves a file to another folder.
const move = (id, to, from) => call('PATCH', `/drive/v3/files/${encodeURIComponent(id)}`, { query: { fields: FIELDS, addParents: to, removeParents: from }, json: {} });

const folderUrl = (id) => `https://drive.google.com/drive/folders/${id}`;
const fileUrl = (id) => `https://drive.google.com/file/d/${id}/view`;

// Tests: a fixed access token instead of signing in to Google.
function useToken(fn) {
  tokenSource = fn;
  client = null;
}

module.exports = { FOLDER, isConfigured, projectNumber, about, findByLabels, file, createFolder, upload, move, folderUrl, fileUrl, useToken };
