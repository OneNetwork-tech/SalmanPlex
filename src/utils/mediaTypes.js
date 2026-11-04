'use strict';

const path = require('path');

const VIDEO_EXT = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.3gp': 'video/3gpp',
  '.ogv': 'video/ogg',
};

const AUDIO_EXT = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wma': 'audio/x-ms-wma',
  '.alac': 'audio/mp4',
};

const IMAGE_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};

const SUBTITLE_EXT = ['.srt', '.vtt'];

/** File extensions accepted for each library type. */
const LIBRARY_EXTENSIONS = {
  movies: VIDEO_EXT,
  tv: VIDEO_EXT,
  music: AUDIO_EXT,
  photos: IMAGE_EXT,
};

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return VIDEO_EXT[ext] || AUDIO_EXT[ext] || IMAGE_EXT[ext] || 'application/octet-stream';
}

function isAllowedForLibrary(libraryType, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return Boolean(LIBRARY_EXTENSIONS[libraryType] && LIBRARY_EXTENSIONS[libraryType][ext]);
}

// Containers/codecs that mainstream browsers can play without transcoding.
const BROWSER_VIDEO_CONTAINERS = new Set(['.mp4', '.m4v', '.webm']);
const BROWSER_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const BROWSER_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const BROWSER_AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.oga', '.opus']);

/**
 * Decide whether a media item can be sent to a browser as-is.
 * Unknown codecs (ffprobe unavailable) are assumed playable when the container is.
 */
function isDirectPlayable(item) {
  const ext = path.extname(item.relativePath).toLowerCase();
  if (item.kind === 'photo') return true;
  if (item.kind === 'track') {
    if (!BROWSER_AUDIO_EXT.has(ext)) return false;
    return !item.audioCodec || BROWSER_AUDIO_CODECS.has(item.audioCodec) || item.audioCodec.startsWith('pcm_');
  }
  if (!BROWSER_VIDEO_CONTAINERS.has(ext)) return false;
  if (item.videoCodec && !BROWSER_VIDEO_CODECS.has(item.videoCodec)) return false;
  if (item.audioCodec && !BROWSER_AUDIO_CODECS.has(item.audioCodec)) return false;
  return true;
}

module.exports = {
  VIDEO_EXT,
  AUDIO_EXT,
  IMAGE_EXT,
  SUBTITLE_EXT,
  LIBRARY_EXTENSIONS,
  mimeFor,
  isAllowedForLibrary,
  isDirectPlayable,
};
