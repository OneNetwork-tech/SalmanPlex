import { api, session, artFor } from './api.js';
import { h, clear, toast, formatClock, errorMessage } from './ui.js';

const PROGRESS_INTERVAL_MS = 10000;

function reportProgress(itemId, positionSeconds, completed) {
  // keepalive lets the request finish when the page is being closed.
  return fetch(`/api/media/${itemId}/progress`, {
    method: 'PUT',
    keepalive: true,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
    body: JSON.stringify(completed === undefined ? { positionSeconds } : { positionSeconds, completed }),
  }).catch(() => {});
}

// --- Video player ----------------------------------------------------------

let activeCleanup = null;

export function stopVideo() {
  if (activeCleanup) activeCleanup();
  activeCleanup = null;
}

export async function playVideo(container, itemId, { navigate }) {
  stopVideo();
  audioPlayer.pause();
  const [{ data: item }, { data: pb }] = await Promise.all([
    api(`/media/${itemId}`),
    api(`/media/${itemId}/playback`, { method: 'POST' }),
  ]);

  const video = h('video', {
    controls: true, autoplay: true, playsinline: true, preload: 'auto', 'x-webkit-airplay': 'allow', crossorigin: 'anonymous',
  });
  const status = h('div', { class: 'player-status', hidden: true });
  const qualitySelect = h('select', { 'aria-label': 'Quality' });
  const subtitleSelect = h('select', { 'aria-label': 'Subtitles' }, h('option', { value: '' }, 'Subtitles off'));
  const castBtn = h('button', { class: 'btn btn-sm', type: 'button', hidden: true }, '📺 Cast');
  const airplayBtn = h('button', { class: 'btn btn-sm', type: 'button', hidden: true }, 'AirPlay');
  const title = item.kind === 'episode'
    ? `${item.seriesTitle} · S${item.seasonNumber ?? '?'}E${item.episodeNumber ?? '?'} · ${item.title}`
    : item.title;
  const page = h('div', { class: 'player-page' },
    video,
    h('div', { class: 'player-bar' },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back', onclick: () => history.back() }, '←'),
      h('div', { class: 'player-title' }, title),
      subtitleSelect, qualitySelect, castBtn, airplayBtn),
    status);
  clear(container, page);

  let hls = null;
  let lastReport = 0;
  let destroyed = false;
  let resumeAt = pb.resumePositionSeconds > 10 ? pb.resumePositionSeconds : 0;

  const showStatus = (text, ms = 2500) => {
    status.textContent = text;
    status.hidden = false;
    clearTimeout(showStatus.t);
    if (ms) showStatus.t = setTimeout(() => { status.hidden = true; }, ms);
  };

  // Subtitles as native <track> elements (WebVTT served by the API).
  pb.subtitles.forEach((s, i) => {
    video.append(h('track', { kind: 'subtitles', label: s.label, srclang: s.language || 'und', src: s.url }));
    subtitleSelect.append(h('option', { value: String(i) }, s.label));
  });
  subtitleSelect.hidden = !pb.subtitles.length;
  subtitleSelect.addEventListener('change', () => {
    [...video.textTracks].forEach((t, i) => { t.mode = String(i) === subtitleSelect.value ? 'showing' : 'disabled'; });
  });

  const nativeHls = video.canPlayType('application/vnd.apple.mpegurl');
  const hlsJs = window.Hls && window.Hls.isSupported();
  const canHls = Boolean(pb.hlsUrl && (nativeHls || hlsJs));

  function destroyHls() {
    if (hls) {
      hls.destroy();
      hls = null;
    }
  }

  function startDirect(at) {
    destroyHls();
    video.src = pb.directUrl;
    seekWhenReady(at);
  }

  function startHls(at, level = -1) {
    destroyHls();
    if (nativeHls && !hlsJs) {
      video.src = pb.hlsUrl;
      seekWhenReady(at);
      return;
    }
    hls = new window.Hls({ startPosition: at || -1, maxBufferLength: 30, backBufferLength: 60 });
    hls.on(window.Hls.Events.MANIFEST_PARSED, (_, data) => {
      // Rebuild the quality list from the manifest.
      [...qualitySelect.querySelectorAll('option[data-level]')].forEach((o) => o.remove());
      data.levels.forEach((l, i) => qualitySelect.append(h('option', { value: `hls:${i}`, dataset: { level: String(i) } }, `${l.height}p`)));
      if (level >= 0) {
        hls.currentLevel = level;
        qualitySelect.value = `hls:${level}`;
      }
      video.play().catch(() => {});
    });
    hls.on(window.Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
        showStatus('Network problem, retrying…');
        hls.startLoad();
      } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
      } else {
        showStatus('Playback failed', 0);
      }
    });
    hls.loadSource(pb.hlsUrl);
    hls.attachMedia(video);
  }

  function seekWhenReady(at) {
    if (!at) return;
    video.addEventListener('loadedmetadata', () => { video.currentTime = at; }, { once: true });
  }

  // Quality options: Original (direct) and Auto/fixed HLS levels.
  if (pb.directPlayable) qualitySelect.append(h('option', { value: 'direct' }, 'Original'));
  if (canHls) qualitySelect.append(h('option', { value: 'hls:auto' }, 'Auto (transcode)'));
  qualitySelect.hidden = qualitySelect.options.length < 2 && !canHls;

  qualitySelect.addEventListener('change', () => {
    const at = video.currentTime;
    const v = qualitySelect.value;
    if (v === 'direct') startDirect(at);
    else if (v === 'hls:auto') {
      if (hls) hls.currentLevel = -1;
      else startHls(at);
    } else if (v.startsWith('hls:')) {
      const level = Number(v.slice(4));
      if (hls) hls.currentLevel = level;
      else startHls(at, level);
    }
    showStatus(`Quality: ${qualitySelect.selectedOptions[0].textContent}`);
  });

  if (pb.directPlayable) {
    qualitySelect.value = 'direct';
    startDirect(resumeAt);
  } else if (canHls) {
    qualitySelect.value = 'hls:auto';
    startHls(resumeAt);
    showStatus('Transcoding for your browser…');
  } else {
    startDirect(resumeAt);
    showStatus('This format may not play in your browser and transcoding is unavailable.', 6000);
  }
  resumeAt = 0;

  // If direct play fails (e.g. unsupported codec inside an mp4), fall back to HLS.
  video.addEventListener('error', () => {
    if (destroyed) return;
    if (qualitySelect.value === 'direct' && canHls) {
      showStatus('Switching to transcoded stream…');
      qualitySelect.value = 'hls:auto';
      startHls(video.currentTime || 0);
    } else if (!hls) {
      showStatus('Playback failed', 0);
    }
  });

  // Cast / AirPlay (Remote Playback API works with direct URLs).
  if (video.remote && 'prompt' in video.remote) {
    castBtn.hidden = false;
    castBtn.addEventListener('click', async () => {
      if (hls) {
        qualitySelect.value = 'direct';
        startDirect(video.currentTime);
      }
      try {
        await video.remote.prompt();
      } catch (err) {
        if (err.name !== 'AbortError') toast(`Casting unavailable: ${err.message}`, 'error');
      }
    });
  }
  if (window.WebKitPlaybackTargetAvailabilityEvent) {
    video.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => {
      airplayBtn.hidden = e.availability !== 'available';
    });
    airplayBtn.addEventListener('click', () => video.webkitShowPlaybackTargetPicker());
  }

  // Progress reporting.
  const onTime = () => {
    const now = Date.now();
    if (now - lastReport > PROGRESS_INTERVAL_MS && !video.paused) {
      lastReport = now;
      reportProgress(item.id, video.currentTime);
    }
  };
  const onPause = () => {
    if (video.currentTime > 0 && !video.ended) reportProgress(item.id, video.currentTime);
  };
  let upNextTimer = null;
  const onEnded = () => {
    reportProgress(item.id, video.duration || video.currentTime, true);
    if (item.nextItemId) {
      let left = 8;
      const cancel = h('button', { class: 'btn btn-sm', type: 'button' }, 'Cancel');
      const playNow = h('button', { class: 'btn btn-sm btn-primary', type: 'button' }, 'Play now');
      const label = h('div', {}, `Next episode in ${left}s`);
      const box = h('div', { class: 'up-next' }, label, h('div', { class: 'row', style: 'margin-top:10px' }, playNow, cancel));
      page.append(box);
      const go = () => navigate(`#/play/${item.nextItemId}`, { replace: true });
      upNextTimer = setInterval(() => {
        left -= 1;
        label.textContent = `Next episode in ${left}s`;
        if (left <= 0) {
          clearInterval(upNextTimer);
          go();
        }
      }, 1000);
      cancel.addEventListener('click', () => { clearInterval(upNextTimer); box.remove(); });
      playNow.addEventListener('click', () => { clearInterval(upNextTimer); go(); });
    }
  };
  video.addEventListener('timeupdate', onTime);
  video.addEventListener('pause', onPause);
  video.addEventListener('ended', onEnded);

  // Hide chrome when idle.
  let idleTimer;
  const wake = () => {
    page.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!video.paused) page.classList.add('idle'); }, 3000);
  };
  page.addEventListener('mousemove', wake);
  page.addEventListener('touchstart', wake, { passive: true });
  wake();

  const onKey = (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === ' ' || e.key === 'k') {
      e.preventDefault();
      if (video.paused) video.play(); else video.pause();
    } else if (e.key === 'ArrowRight' || e.key === 'l') {
      video.currentTime = Math.min((video.duration || Infinity), video.currentTime + 10);
      showStatus(`+10s · ${formatClock(video.currentTime)}`, 1000);
    } else if (e.key === 'ArrowLeft' || e.key === 'j') {
      video.currentTime = Math.max(0, video.currentTime - 10);
      showStatus(`−10s · ${formatClock(video.currentTime)}`, 1000);
    } else if (e.key === 'f') {
      if (document.fullscreenElement) document.exitFullscreen(); else page.requestFullscreen().catch(() => {});
    } else if (e.key === 'm') {
      video.muted = !video.muted;
    } else if (e.key === 'Escape' && !document.fullscreenElement) {
      history.back();
    }
    wake();
  };
  document.addEventListener('keydown', onKey);
  const onHide = () => {
    if (document.visibilityState === 'hidden' && video.currentTime > 0 && !video.ended) reportProgress(item.id, video.currentTime);
  };
  document.addEventListener('visibilitychange', onHide);

  activeCleanup = () => {
    destroyed = true;
    if (video.currentTime > 0 && !video.ended) reportProgress(item.id, video.currentTime);
    clearInterval(upNextTimer);
    clearTimeout(idleTimer);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onHide);
    destroyHls();
    video.pause();
    video.removeAttribute('src');
    video.load();
  };
}

// --- Music player (persistent mini player) ---------------------------------

class AudioPlayer {
  constructor() {
    this.audio = document.getElementById('audio');
    this.el = document.getElementById('mini-player');
    this.queue = [];
    this.index = -1;
    this.offset = 0; // start offset for transcoded (non-seekable) streams
    this.transcoded = false;
    this.seeking = false;
    this.bind();
  }

  bind() {
    const $ = (id) => document.getElementById(id);
    $('mini-toggle').addEventListener('click', () => (this.audio.paused ? this.audio.play() : this.audio.pause()));
    $('mini-next').addEventListener('click', () => this.next());
    $('mini-prev').addEventListener('click', () => this.prev());
    $('mini-close').addEventListener('click', () => this.close());
    const seek = $('mini-seek');
    seek.addEventListener('input', () => { this.seeking = true; });
    seek.addEventListener('change', () => {
      this.seeking = false;
      const dur = this.duration();
      if (dur) this.seekTo((Number(seek.value) / 1000) * dur);
    });
    this.audio.addEventListener('timeupdate', () => {
      const dur = this.duration();
      if (dur && !this.seeking) seek.value = String(Math.round(((this.offset + this.audio.currentTime) / dur) * 1000));
    });
    this.audio.addEventListener('ended', () => {
      const item = this.current();
      if (item) reportProgress(item.id, item.durationSeconds || 0, true);
      this.next();
    });
    this.audio.addEventListener('play', () => { $('mini-toggle').textContent = '⏸'; });
    this.audio.addEventListener('pause', () => { $('mini-toggle').textContent = '▶'; });
    this.audio.addEventListener('error', () => {
      if (this.current() && !this.transcoded && this.playback && this.playback.audioTranscodeUrl) {
        this.transcoded = true;
        this.audio.src = this.playback.audioTranscodeUrl;
        this.audio.play().catch(() => {});
      } else if (this.current()) {
        toast(`Cannot play ${this.current().title}`, 'error');
      }
    });
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
      navigator.mediaSession.setActionHandler('previoustrack', () => this.prev());
    }
  }

  current() { return this.queue[this.index]; }

  duration() {
    const item = this.current();
    if (this.transcoded) return item ? item.durationSeconds : 0;
    return Number.isFinite(this.audio.duration) ? this.audio.duration : (item && item.durationSeconds) || 0;
  }

  async play(queue, index = 0) {
    stopVideo();
    this.queue = queue;
    this.index = index;
    await this.load();
  }

  async load() {
    const item = this.current();
    if (!item) return this.close();
    try {
      const { data } = await api(`/media/${item.id}/playback`, { method: 'POST' });
      this.playback = data;
      this.offset = 0;
      this.transcoded = !data.directPlayable && Boolean(data.audioTranscodeUrl);
      this.audio.src = this.transcoded ? data.audioTranscodeUrl : data.directUrl;
      await this.audio.play().catch(() => {});
      this.render(item);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
    return undefined;
  }

  seekTo(seconds) {
    if (!this.transcoded) {
      this.audio.currentTime = seconds;
      return;
    }
    this.offset = seconds;
    this.audio.src = `${this.playback.audioTranscodeUrl}&start=${seconds.toFixed(1)}`;
    this.audio.play().catch(() => {});
  }

  render(item) {
    this.el.hidden = false;
    document.getElementById('mini-title').textContent = item.title;
    document.getElementById('mini-sub').textContent = [item.artist, item.album].filter(Boolean).join(' · ');
    const art = document.getElementById('mini-art');
    art.src = artFor(item) || '';
    if ('mediaSession' in navigator && window.MediaMetadata) {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: item.title, artist: item.artist || '', album: item.album || '', artwork: art.src ? [{ src: art.src }] : [],
      });
    }
  }

  next() {
    if (this.index < this.queue.length - 1) {
      this.index += 1;
      this.load();
    } else {
      this.audio.pause();
    }
  }

  prev() {
    if (this.audio.currentTime > 5 || this.index === 0) this.seekTo(0);
    else {
      this.index -= 1;
      this.load();
    }
  }

  pause() { this.audio.pause(); }

  close() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.queue = [];
    this.index = -1;
    this.el.hidden = true;
  }
}

export const audioPlayer = new AudioPlayer();
