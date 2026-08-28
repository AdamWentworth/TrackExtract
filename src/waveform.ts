export interface WaveformData {
  durationSeconds: number;
  peaks: number[];
}

export const WAVEFORM_PEAK_COUNT = 192;
const MAX_WAVEFORM_BYTES = 256 * 1024 * 1024;
const MAX_WAVEFORM_CACHE_ENTRIES = 24;
const MAX_CONCURRENT_WAVEFORM_DECODES = 2;
const waveformCache = new Map<string, WaveformData>();
const waveformRequests = new Map<string, Promise<WaveformData>>();
const waveformQueue: Array<() => void> = [];
let activeWaveformDecodes = 0;

export function getWaveformData(mediaUrl: string): Promise<WaveformData> {
  const cached = waveformCache.get(mediaUrl);
  if (cached) {
    waveformCache.delete(mediaUrl);
    waveformCache.set(mediaUrl, cached);
    return Promise.resolve(cached);
  }

  const pending = waveformRequests.get(mediaUrl);
  if (pending) {
    return pending;
  }

  const request = new Promise<WaveformData>((resolve, reject) => {
    waveformQueue.push(() => {
      activeWaveformDecodes += 1;
      void loadWaveformData(mediaUrl)
        .then((loaded) => {
          waveformCache.set(mediaUrl, loaded);
          while (waveformCache.size > MAX_WAVEFORM_CACHE_ENTRIES) {
            const oldest = waveformCache.keys().next().value;
            if (oldest === undefined) {
              break;
            }
            waveformCache.delete(oldest);
          }
          resolve(loaded);
        }, reject)
        .finally(() => {
          activeWaveformDecodes -= 1;
          waveformRequests.delete(mediaUrl);
          drainWaveformQueue();
        });
    });
    drainWaveformQueue();
  });
  waveformRequests.set(mediaUrl, request);
  return request;
}

async function loadWaveformData(mediaUrl: string): Promise<WaveformData> {
  if (typeof window === "undefined" || typeof fetch === "undefined") {
    throw new Error("Waveform decoding is not available.");
  }

  const AudioContextConstructor =
    window.AudioContext ??
    (window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) {
    throw new Error("This browser cannot decode waveform previews.");
  }

  const response = await fetch(mediaUrl);
  if (!response.ok) {
    throw new Error("Could not load audio for waveform preview.");
  }

  const declaredSize = Number(response.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_WAVEFORM_BYTES) {
    throw new Error("Audio is too large for an in-memory waveform preview.");
  }
  const bytes = await readBoundedResponse(response, MAX_WAVEFORM_BYTES);
  const context = new AudioContextConstructor();
  try {
    const audioBuffer = await context.decodeAudioData(bytes.slice(0));
    return {
      durationSeconds: audioBuffer.duration,
      peaks: buildWaveformPeaks(audioBuffer, WAVEFORM_PEAK_COUNT),
    };
  } finally {
    void context.close();
  }
}

function drainWaveformQueue() {
  while (activeWaveformDecodes < MAX_CONCURRENT_WAVEFORM_DECODES && waveformQueue.length > 0) {
    waveformQueue.shift()?.();
  }
}

export async function readBoundedResponse(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  if (!response.body) {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maxBytes) {
      throw new Error("Audio is too large for an in-memory waveform preview.");
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error("Audio is too large for an in-memory waveform preview.");
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

export function buildWaveformPeaks(audioBuffer: AudioBuffer, peakCount: number) {
  const channels = Array.from({ length: Math.min(audioBuffer.numberOfChannels, 2) }, (_, index) =>
    audioBuffer.getChannelData(index),
  );
  if (channels.length === 0 || audioBuffer.length === 0) {
    return new Array(peakCount).fill(0.03);
  }

  const blockSize = Math.max(1, Math.floor(audioBuffer.length / peakCount));
  const peaks = new Array(peakCount).fill(0).map((_, blockIndex) => {
    const start = blockIndex * blockSize;
    const end = blockIndex === peakCount - 1 ? audioBuffer.length : Math.min(audioBuffer.length, start + blockSize);
    const stride = Math.max(1, Math.floor((end - start) / 420));
    let peak = 0;

    for (const channel of channels) {
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += stride) {
        peak = Math.max(peak, Math.abs(channel[sampleIndex] ?? 0));
      }
    }

    return peak;
  });

  const maxPeak = Math.max(...peaks);
  if (maxPeak <= 0) {
    return peaks.map(() => 0.03);
  }
  return peaks.map((peak) => Math.max(0.035, peak / maxPeak));
}
