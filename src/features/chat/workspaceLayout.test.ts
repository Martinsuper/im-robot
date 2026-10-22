import { expect, it } from "vitest";
import { fitWorkspace } from "./workspaceLayout";

it("moves an expanded workspace away from the monitor edge", () => {
  expect(fitWorkspace({ x: 1200, y: 700, width: 480, height: 420 }, { x: 0, y: 0, width: 1440, height: 900 }))
    .toEqual({ x: 560, y: 200, width: 880, height: 700 });
});

it("fits small displays and monitors with negative origins", () => {
  expect(fitWorkspace({ x: -100, y: 0, width: 480, height: 420 }, { x: -800, y: 0, width: 800, height: 600 }))
    .toEqual({ x: -800, y: 0, width: 800, height: 600 });
});


it("keeps the chat origin when there is room to expand right", () => {
  expect(fitWorkspace({ x: 100, y: 100, width: 480, height: 420 }, { x: 0, y: 0, width: 1920, height: 1080 }))
    .toEqual({ x: 100, y: 100, width: 880, height: 700 });
});

it("expands compact windows only to the minimum two-column width", () => {
  expect(fitWorkspace({ x: 100, y: 100, width: 600, height: 800 }, { x: 0, y: 0, width: 1920, height: 1080 }))
    .toEqual({ x: 100, y: 100, width: 880, height: 800 });
});


it("splits an existing wide window without increasing its bounds", () => {
  expect(fitWorkspace({ x: 100, y: 100, width: 1200, height: 600 }, { x: 0, y: 0, width: 1920, height: 1080 }))
    .toEqual({ x: 100, y: 100, width: 1200, height: 600 });
});
