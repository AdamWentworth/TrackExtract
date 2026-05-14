import "@testing-library/jest-dom/vitest";

Object.defineProperty(window.HTMLMediaElement.prototype, "load", {
  configurable: true,
  value: () => undefined,
});

Object.defineProperty(window.HTMLMediaElement.prototype, "play", {
  configurable: true,
  value: () => Promise.resolve(),
});

Object.defineProperty(window.HTMLMediaElement.prototype, "pause", {
  configurable: true,
  value: () => undefined,
});

Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => ({
    beginPath: () => undefined,
    clearRect: () => undefined,
    clip: () => undefined,
    fill: () => undefined,
    fillRect: () => undefined,
    rect: () => undefined,
    restore: () => undefined,
    roundRect: () => undefined,
    save: () => undefined,
    setTransform: () => undefined,
    fillStyle: "",
  }),
});
