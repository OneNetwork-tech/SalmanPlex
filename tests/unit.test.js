'use strict';

const path = require('path');
const {
  parseMovie, parseEpisode, parseTrack, sortTitle,
} = require('../src/utils/filenameParser');
const { isDirectPlayable, isAllowedForLibrary, mimeFor } = require('../src/utils/mediaTypes');
const { sanitizeFilename, isInside } = require('../src/utils/paths');
const { srtToVtt } = require('../src/services/subtitles');
const transcoder = require('../src/services/transcoder');

describe('filename parser', () => {
  test.each([
    ['The.Matrix.1999.1080p.BluRay.x264.mkv', 'The Matrix', 1999],
    ['Heat (1995).mp4', 'Heat', 1995],
    ['Blade Runner 2049 (2017).mkv', 'Blade Runner 2049', 2017],
    ['Inception.mkv', 'Inception', null],
    ['Some Movie (2010)/movie.mkv', 'Some Movie', 2010],
    ['[Group] Spirited.Away.2001.WEB-DL.mkv', 'Spirited Away', 2001],
  ])('parseMovie(%s)', (file, title, year) => {
    expect(parseMovie(file)).toEqual({ title, year });
  });

  test.each([
    ['Breaking Bad/Season 1/Breaking Bad - S01E02 - Cat in the Bag.mkv', 'Breaking Bad', 1, 2, 'Cat in the Bag'],
    ['The.Office.S03E10.720p.HDTV.mkv', 'The Office', 3, 10, 'Episode 10'],
    ['Lost/Lost 2x05.avi', 'Lost', 2, 5, 'Episode 5'],
    ['Show (2005)/Season 02/show.s02e03.the.title.mp4', 'Show', 2, 3, 'the title'],
  ])('parseEpisode(%s)', (file, seriesTitle, seasonNumber, episodeNumber, title) => {
    expect(parseEpisode(file)).toEqual({ seriesTitle, seasonNumber, episodeNumber, title });
  });

  test('parseTrack uses folder structure', () => {
    expect(parseTrack('Artist/Album/03 - Song Name.flac')).toEqual({
      title: 'Song Name', trackNumber: 3, artist: 'Artist', album: 'Album',
    });
  });

  test('sortTitle strips articles', () => {
    expect(sortTitle('The Matrix')).toBe('matrix');
    expect(sortTitle('A Quiet Place')).toBe('quiet place');
  });
});

describe('media types', () => {
  test('library extension whitelist', () => {
    expect(isAllowedForLibrary('movies', 'x.mkv')).toBe(true);
    expect(isAllowedForLibrary('movies', 'x.mp3')).toBe(false);
    expect(isAllowedForLibrary('music', 'x.flac')).toBe(true);
    expect(isAllowedForLibrary('photos', 'x.html')).toBe(false);
    expect(mimeFor('a.MP4')).toBe('video/mp4');
  });

  test('direct play decisions', () => {
    expect(isDirectPlayable({ kind: 'movie', relativePath: 'a.mp4', videoCodec: 'h264', audioCodec: 'aac' })).toBe(true);
    expect(isDirectPlayable({ kind: 'movie', relativePath: 'a.mp4', videoCodec: 'hevc', audioCodec: 'aac' })).toBe(false);
    expect(isDirectPlayable({ kind: 'movie', relativePath: 'a.mkv', videoCodec: 'h264' })).toBe(false);
    expect(isDirectPlayable({ kind: 'movie', relativePath: 'a.mp4', videoCodec: 'h264', audioCodec: 'ac3' })).toBe(false);
    expect(isDirectPlayable({ kind: 'track', relativePath: 'a.wma', audioCodec: 'wmav2' })).toBe(false);
    expect(isDirectPlayable({ kind: 'track', relativePath: 'a.flac', audioCodec: 'flac' })).toBe(true);
  });
});

describe('path safety', () => {
  test('sanitizeFilename removes traversal and control characters', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    // Backslashes are not separators on POSIX; they are replaced, never kept.
    expect(sanitizeFilename('..\\..\\win.ini')).not.toMatch(/[\\/]/);
    expect(sanitizeFilename('.bashrc')).toBe('bashrc');
    expect(sanitizeFilename('a<b>c?.mp4')).toBe('a_b_c_.mp4');
    expect(sanitizeFilename('')).toBe('upload');
  });

  test('isInside', () => {
    expect(isInside('/media', '/media/a/b')).toBe(true);
    expect(isInside('/media', '/media')).toBe(true);
    expect(isInside('/media', '/media-other/x')).toBe(false);
    expect(isInside('/media', path.resolve('/media/../etc'))).toBe(false);
  });
});

describe('subtitles', () => {
  test('srtToVtt converts timestamps', () => {
    const vtt = srtToVtt('﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nHi\r\n');
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
    expect(vtt).toContain('00:00:01.000 --> 00:00:02.500');
    expect(vtt).not.toContain('\r');
  });
});

describe('HLS playlists', () => {
  const item = { id: 1, durationSeconds: 5, width: 1920, height: 1080 };

  test('master playlist lists qualities up to source height and carries token', () => {
    const m = transcoder.masterPlaylist(item, 'abc');
    expect(m).toContain('#EXTM3U');
    expect(m).toContain('1080p/index.m3u8?token=abc');
    expect(m).toContain('360p/index.m3u8?token=abc');
  });

  test('low resolution sources only get matching variants', () => {
    const names = transcoder.availableQualities({ height: 480 }).map((q) => q.name);
    expect(names).toEqual(['480p', '360p']);
  });

  test('media playlist covers the full duration', () => {
    const p = transcoder.mediaPlaylist(item, null);
    expect(p).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(p).toContain('#EXT-X-ENDLIST');
    expect((p.match(/seg_\d+\.ts/g) || []).length).toBe(Math.ceil(5 / 2));
  });
});
