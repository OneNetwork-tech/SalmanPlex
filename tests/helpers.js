'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'ignore' });
}

/** Write a file, creating parent directories. */
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/**
 * Build a small media tree. With ffmpeg, real encoded files are produced so that
 * probing, HLS and thumbnails can be exercised; otherwise placeholder bytes.
 */
function createFixtures(root) {
  const real = hasFfmpeg();
  const movie = path.join(root, 'Movies', 'The Test Movie (2021)', 'The.Test.Movie.2021.1080p.BluRay.x264.mp4');
  const mkv = path.join(root, 'Movies', 'Another Film 1999.mkv');
  const ep1 = path.join(root, 'TV', 'Test Show', 'Season 1', 'Test Show - S01E01 - Pilot.mp4');
  const ep2 = path.join(root, 'TV', 'Test Show', 'Season 1', 'Test.Show.S01E02.The.Second.mkv');
  const track = path.join(root, 'Music', 'Test Artist', 'Test Album', '01 - First Song.mp3');
  const photo = path.join(root, 'Photos', 'Holiday', 'beach.png');
  [movie, mkv, ep1, ep2, track, photo].forEach((f) => fs.mkdirSync(path.dirname(f), { recursive: true }));

  if (real) {
    const video = ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12'];
    ffmpeg([...video, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', movie]);
    ffmpeg([...video, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', ep1]);
    ffmpeg([...video, '-c:v', 'mpeg4', '-c:a', 'mp2', '-shortest', mkv]);
    ffmpeg([...video, '-c:v', 'mpeg4', '-c:a', 'mp2', '-shortest', ep2]);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=3', '-c:a', 'libmp3lame',
      '-metadata', 'title=First Song (Tagged)', '-metadata', 'artist=Tagged Artist', '-metadata', 'album=Tagged Album',
      '-metadata', 'track=1/10', '-metadata', 'date=2020', track]);
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=64x48', '-frames:v', '1', photo]);
  } else {
    [movie, mkv, ep1, ep2, track, photo].forEach((f) => fs.writeFileSync(f, Buffer.alloc(4096, 1)));
  }
  write(path.join(path.dirname(movie), 'The.Test.Movie.2021.1080p.BluRay.x264.en.srt'),
    '1\n00:00:00,500 --> 00:00:02,000\nHello <i>world</i>\n\n2\n00:00:02,500 --> 00:00:04,000\nSecond line\n');
  write(path.join(root, 'Movies', 'notes.txt'), 'not media');
  write(path.join(root, 'Movies', '.hidden', 'secret.mp4'), 'hidden');
  return { real, movie, mkv, ep1, ep2, track, photo };
}

module.exports = { createFixtures, hasFfmpeg, write };
