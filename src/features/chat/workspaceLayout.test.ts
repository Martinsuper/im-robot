import { expect, it } from "vitest";
import { fitWorkspace } from "./workspaceLayout";

it("moves an expanded workspace away from the monitor edge", () => {
  expect(fitWorkspace({ x: 1200, y: 700, width: 480, height: 420 }, { x: 0, y: 0, width: 1440, height: 900 }))
    .toEqual({ x: 400, y: 200, width: 1040, height: 700 });
});

it("fits small displays and monitors with negative origins", () => {
  expect(fitWorkspace({ x: -100, y: 0, width: 480, height: 420 }, { x: -800, y: 0, width: 800, height: 600 }))
    .toEqual({ x: -800, y: 0, width: 800, height: 600 });
});
