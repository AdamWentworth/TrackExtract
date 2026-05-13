import "@testing-library/jest-dom/vitest";

Object.defineProperty(window.HTMLMediaElement.prototype, "load", {
  configurable: true,
  value: () => undefined,
});
