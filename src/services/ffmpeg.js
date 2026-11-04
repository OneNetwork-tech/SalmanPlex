'use strict';

const { spawn, execFile } = require('child_process');
const config = require('../config');

let availability = null;

/** Detect once whether ffmpeg and ffprobe are installed. */
async function detect() {
  if (availability) return availability;
  const check = (bin) => new Promise((resolve) => {
    execFile(bin, ['-version'], { timeout: 5000 }, (err) => resolve(!err));
  });
  const [ffmpeg, ffprobe] = await Promise.all([check(config.ffmpeg.ffmpegPath), check(config.ffmpeg.ffprobePath)]);
  availability = { ffmpeg: ffmpeg && config.ffmpeg.enabled, ffprobe };
  return availability;
}

function resetDetection() {
  availability = null;
}

function parseRate(rate) {
  if (!rate || rate === '0/0') return null;
  const [n, d] = rate.split('/').map(Number);
  return d ? n / d : n;
}

/**
 * Run ffprobe and normalise the parts we care about. Returns null when ffprobe is
 * unavailable or the file cannot be probed (the scanner then relies on file names).
 */
async function probe(filePath) {
  const { ffprobe } = await detect();
  if (!ffprobe) return null;
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath];
  const raw = await new Promise((resolve) => {
    execFile(config.ffmpeg.ffprobePath, args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        return resolve(JSON.parse(stdout));
      } catch {
        return resolve(null);
      }
    });
  });
  if (!raw) return null;

  const streams = raw.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audio = streams.find((s) => s.codec_type === 'audio');
  const subtitleStreams = streams
    .filter((s) => s.codec_type === 'subtitle')
    .map((s, i) => ({
      streamIndex: s.index,
      ordinal: i,
      codec: s.codec_name,
      language: (s.tags && s.tags.language) || null,
      title: (s.tags && s.tags.title) || null,
      // Only text-based subtitles can be converted to WebVTT.
      textBased: ['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'].includes(s.codec_name),
    }));
  const tags = Object.fromEntries(
    Object.entries((raw.format && raw.format.tags) || {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const duration = Number.parseFloat((raw.format && raw.format.duration) || (video && video.duration) || (audio && audio.duration));

  return {
    durationSeconds: Number.isFinite(duration) ? duration : null,
    bitrate: raw.format && raw.format.bit_rate ? Number.parseInt(raw.format.bit_rate, 10) : null,
    container: raw.format ? raw.format.format_name : null,
    videoCodec: video ? video.codec_name : null,
    audioCodec: audio ? audio.codec_name : null,
    width: video ? video.width : null,
    height: video ? video.height : null,
    frameRate: video ? parseRate(video.avg_frame_rate) : null,
    hasCoverArt: streams.some((s) => s.disposition && s.disposition.attached_pic),
    embeddedSubtitles: subtitleStreams,
    tags,
  };
}

/** Spawn ffmpeg with stdin closed; caller owns the process lifecycle. */
function spawnFfmpeg(args, options = {}) {
  return spawn(config.ffmpeg.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], {
    stdio: ['ignore', options.stdout || 'ignore', 'pipe'],
  });
}

/** Run ffmpeg to completion; resolves on exit code 0. */
function runFfmpeg(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const proc = spawnFfmpeg(args);
    let stderr = '';
    proc.stderr.on('data', (d) => {
      if (stderr.length < 4000) stderr += d.toString();
    });
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

module.exports = { detect, resetDetection, probe, spawnFfmpeg, runFfmpeg };
