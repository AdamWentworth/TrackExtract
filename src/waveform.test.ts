import { describe, expect, it } from "vitest";
import { buildWaveformPeaks, readBoundedResponse } from "./waveform";

describe("waveform utilities", () => {
  it("normalizes waveform peaks across two channels", () => {
    const channels = [new Float32Array([0, 0.25, -1, 0.5]), new Float32Array([0, 0.5, -0.5, 0.25])];
    const audioBuffer = {
      numberOfChannels: channels.length,
      length: channels[0].length,
      getChannelData: (index: number) => channels[index],
    } as AudioBuffer;

    const peaks = buildWaveformPeaks(audioBuffer, 4);

    expect(peaks).toHaveLength(4);
    expect(Math.max(...peaks)).toBe(1);
    expect(peaks.every((peak) => peak >= 0.035 && peak <= 1)).toBe(true);
  });

  it("rejects response bodies above the memory budget", async () => {
    const response = new Response(new Uint8Array([1, 2, 3, 4]));

    await expect(readBoundedResponse(response, 3)).rejects.toThrow("too large");
  });
});
