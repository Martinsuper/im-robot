import { describe, expect, it } from "vitest";
import { initialPetState, reducePetState } from "./petState";

describe("reducePetState", () => {
  it("moves through the chat lifecycle", () => {
    const listening = reducePetState(initialPetState, { type: "LISTEN" });
    const thinking = reducePetState(listening, { type: "CHAT_SUBMITTED" });
    const speaking = reducePetState(thinking, { type: "CHAT_STREAM_STARTED" });
    const completed = reducePetState(speaking, { type: "CHAT_COMPLETED" });

    expect(listening.mode).toBe("listening");
    expect(thinking.mode).toBe("thinking");
    expect(speaking.mode).toBe("speaking");
    expect(completed).toEqual(initialPetState);
  });

  it("supports resting and waking", () => {
    const resting = reducePetState(initialPetState, { type: "REST" });
    const awake = reducePetState(resting, { type: "WAKE" });

    expect(resting.mode).toBe("resting");
    expect(awake.mode).toBe("idle");
  });

  it("surfaces failures", () => {
    expect(reducePetState(initialPetState, { type: "FAILED", message: "offline" })).toEqual({
      mode: "error",
      message: "offline",
    });
  });
});
