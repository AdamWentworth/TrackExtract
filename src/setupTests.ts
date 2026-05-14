import "@testing-library/jest-dom/vitest";

Object.defineProperty(window.HTMLMediaElement.prototype, "load", {
  configurable: true,
  value: () => undefined,
});

Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => ({
    beginPath: () => undefined,
    clearRect: () => undefined,
    fill: () => undefined,
    fillRect: () => undefined,
    roundRect: () => undefined,
    setTransform: () => undefined,
    fillStyle: "",
  }),
});
