'use strict';

/**
 * On-demand HLS transcoding.
 *
 * Playlists are generated up-front from the media duration (VOD style, fixed
 * segment length), so players can seek anywhere immediately. Segments are
 * produced by an ffmpeg job per (item, quality). When a client requests a
 * segment far from what the current job is producing (a seek), the job is
 * restarted at that segment. Idle jobs are reaped and their segments removed.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const ffmpeg = require('./ffmpeg');

const QUALITIES = {
  '1080p': { height: 1080, videoBitrate: 5000, audioBitrate: 192 },
  '720p': { height: 720, videoBitrate: 2800, audioBitrate: 160 },
  '480p': { height: 480, videoBitrate: 1200, audioBitrate: 128 },
  '360p': { height: 360, videoBitrate: 700, audioBitrate: 96 },
};

const LOOKAHEAD_SEGMENTS = 4; // how far ahead of the encoder we wait instead of restarting
const SEGMENT_WAIT_MS = 45000;

const jobs = new Map(); // key -> job
let reaper = null;

const segSeconds = () => config.ffmpeg.hlsSegmentSeconds;
const keyFor = (itemId, quality) => `${itemId}:${quality}`;
const dirFor = (itemId, quality) => path.join(config.media.cacheDir, 'hls', String(itemId), quality);

function availableQualities(item) {
  const sourceHeight = item.height || 1080;
  const list = Object.entries(QUALITIES)
    .filter(([, q]) => q.height <= Math.max(sourceHeight, 360))
    .map(([name, q]) => ({ name, ...q }));
  return list.length ? list : [{ name: '360p', ...QUALITIES['360p'] }];
}

function segmentCount(duration) {
  return Math.max(1, Math.ceil(duration / segSeconds()));
}

function withToken(uri, token) {
  return token ? `${uri}?token=${encodeURIComponent(token)}` : uri;
}

function masterPlaylist(item, token) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const q of availableQualities(item)) {
    const width = item.width && item.height ? Math.round((item.width / item.height) * q.height / 2) * 2 : Math.round(q.height * 16 / 9 / 2) * 2;
    const bandwidth = (q.videoBitrate + q.audioBitrate) * 1000;
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${width}x${q.height},CODECS="avc1.640028,mp4a.40.2",NAME="${q.name}"`);
    lines.push(withToken(`${q.name}/index.m3u8`, token));
  }
  return `${lines.join('\n')}\n`;
}

function mediaPlaylist(item, token) {
  const seg = segSeconds();
  const count = segmentCount(item.durationSeconds);
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${seg + 1}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ];
  for (let i = 0; i < count; i += 1) {
    const dur = i === count - 1 ? item.durationSeconds - seg * i : seg;
    lines.push(`#EXTINF:${Math.max(dur, 0.1).toFixed(3)},`);
    lines.push(withToken(`seg_${i}.ts`, token));
  }
  lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

function segmentPath(itemId, quality, index) {
  return path.join(dirFor(itemId, quality), `seg_${index}.ts`);
}

const exists = (p) => fs.promises.access(p).then(() => true, () => false);

function killJob(job, { removeFiles = false } = {}) {
  if (job.proc && job.proc.exitCode === null) job.proc.kill('SIGKILL');
  job.killed = true;
  if (jobs.get(job.key) === job) jobs.delete(job.key);
  if (removeFiles) fs.promises.rm(job.dir, { recursive: true, force: true }).catch(() => {});
}

function startReaper() {
  if (reaper) return;
  reaper = setInterval(() => {
    const now = Date.now();
    for (const job of jobs.values()) {
      if (now - job.lastAccess > config.ffmpeg.transcodeIdleTimeoutMs) killJob(job, { removeFiles: true });
    }
  }, 10000);
  reaper.unref();
}

function startJob(item, sourcePath, quality, startSegment) {
  const q = QUALITIES[quality];
  const key = keyFor(item.id, quality);
  const dir = dirFor(item.id, quality);
  const seg = segSeconds();
  const startTime = startSegment * seg;

  const existing = jobs.get(key);
  if (existing) killJob(existing);

  const active = [...jobs.values()];
  if (active.length >= config.ffmpeg.maxConcurrentTranscodes) {
    // Evict the least recently used job if it has gone quiet; otherwise refuse.
    const lru = active.sort((a, b) => a.lastAccess - b.lastAccess)[0];
    if (Date.now() - lru.lastAccess < 15000) {
      throw Object.assign(new Error('Transcoder is busy, try again shortly'), { status: 503, expose: true });
    }
    killJob(lru);
  }

  fs.mkdirSync(dir, { recursive: true });
  const scale = item.height && item.height > q.height ? `scale=-2:${q.height},` : '';
  const args = [
    ...(startTime > 0 ? ['-ss', String(startTime)] : []),
    '-i', sourcePath,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-sn', '-dn',
    '-c:v', 'libx264', '-preset', config.ffmpeg.preset, '-profile:v', 'high', '-level', '4.0',
    '-vf', `${scale}format=yuv420p`,
    '-b:v', `${q.videoBitrate}k`, '-maxrate', `${Math.round(q.videoBitrate * 1.2)}k`, '-bufsize', `${q.videoBitrate * 2}k`,
    '-force_key_frames', `expr:gte(t,n_forced*${seg})`, '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', `${q.audioBitrate}k`, '-ac', '2',
    '-output_ts_offset', String(startTime),
    '-max_muxing_queue_size', '1024',
    '-f', 'hls', '-hls_time', String(seg), '-hls_list_size', '0',
    '-hls_flags', 'temp_file+independent_segments',
    '-hls_segment_type', 'mpegts',
    '-start_number', String(startSegment),
    '-hls_segment_filename', path.join(dir, 'seg_%d.ts'),
    path.join(dir, `job_${startSegment}.m3u8`),
  ];

  const proc = ffmpeg.spawnFfmpeg(args);
  const job = { key, dir, proc, startSegment, lastAccess: Date.now(), error: null, exited: false, killed: false };
  let stderr = '';
  proc.stderr.on('data', (d) => {
    if (stderr.length < 4000) stderr += d.toString();
  });
  proc.on('error', (err) => {
    job.error = err;
    job.exited = true;
  });
  proc.on('close', (code) => {
    job.exited = true;
    if (code !== 0 && !job.killed) job.error = new Error(`ffmpeg failed (${code}): ${stderr.trim().slice(0, 500)}`);
    if (jobs.get(key) === job) jobs.delete(key);
  });
  jobs.set(key, job);
  startReaper();
  return job;
}

/** Highest contiguous segment produced so far by a job. */
async function producedUpTo(job) {
  let i = job.startSegment;
  // eslint-disable-next-line no-await-in-loop
  while (await exists(path.join(job.dir, `seg_${i}.ts`))) i += 1;
  return i - 1;
}

/**
 * Return the path to a ready segment, transcoding (or re-seeking) as needed.
 */
async function getSegment(item, sourcePath, quality, index) {
  if (!QUALITIES[quality]) throw Object.assign(new Error('Unknown quality'), { status: 404, expose: true });
  const total = segmentCount(item.durationSeconds);
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    throw Object.assign(new Error('Segment out of range'), { status: 404, expose: true });
  }
  const file = segmentPath(item.id, quality, index);
  const key = keyFor(item.id, quality);
  let job = jobs.get(key);
  if (job) job.lastAccess = Date.now();

  if (await exists(file)) return file;

  if (!job || job.exited || index < job.startSegment || index > (await producedUpTo(job)) + LOOKAHEAD_SEGMENTS) {
    job = startJob(item, sourcePath, quality, index);
  }

  const deadline = Date.now() + SEGMENT_WAIT_MS;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await exists(file)) {
      job.lastAccess = Date.now();
      return file;
    }
    if (job.error) throw Object.assign(job.error, { status: 500 });
    if (job.exited && !job.killed) {
      // Encoder finished but this segment never appeared (e.g. duration overestimated).
      throw Object.assign(new Error('Segment not available'), { status: 404, expose: true });
    }
    if (job.killed && jobs.get(key) !== job) {
      // Another request re-seeked this quality; follow the new job.
      job = jobs.get(key) || startJob(item, sourcePath, quality, index);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 150));
  }
  throw Object.assign(new Error('Timed out waiting for transcoder'), { status: 504, expose: true });
}

function stopAll({ removeFiles = false } = {}) {
  for (const job of [...jobs.values()]) killJob(job, { removeFiles });
  if (reaper) {
    clearInterval(reaper);
    reaper = null;
  }
}

/** Remove stale HLS output from a previous run. */
async function cleanCache() {
  await fs.promises.rm(path.join(config.media.cacheDir, 'hls'), { recursive: true, force: true });
}

function activeJobs() {
  return [...jobs.values()].map((j) => ({ key: j.key, startSegment: j.startSegment, idleMs: Date.now() - j.lastAccess }));
}

module.exports = {
  QUALITIES,
  availableQualities,
  masterPlaylist,
  mediaPlaylist,
  getSegment,
  stopAll,
  cleanCache,
  activeJobs,
};
