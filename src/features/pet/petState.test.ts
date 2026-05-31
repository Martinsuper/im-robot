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
    expect(completed).toMatchObject({ mode: "success", emotion: "happy", reaction: "celebrate" });
  });

  it("supports resting and waking", () => {
    const resting = reducePetState(initialPetState, { type: "REST" });
    const awake = reducePetState(resting, { type: "WAKE" });

    expect(resting.mode).toBe("resting");
    expect(awake.mode).toBe("idle");
  });

  it("shows file processing and reminder reactions", () => {
    expect(reducePetState(initialPetState, { type: "ATTACHMENT_READY" })).toMatchObject({
      mode: "confirming",
      emotion: "curious",
    });
    expect(reducePetState(initialPetState, { type: "WORK_STARTED" })).toMatchObject({
      mode: "working",
      emotion: "curious",
    });
    expect(reducePetState(initialPetState, { type: "REMINDER_FIRED", message: "stand up" })).toMatchObject({
      mode: "success",
      emotion: "surprised",
      message: "stand up",
    });
  });

  it("resets transient reactions", () => {
    const completed = reducePetState(initialPetState, { type: "CHAT_COMPLETED" });
    expect(reducePetState(completed, { type: "RESET" })).toEqual(initialPetState);
  });

  it("surfaces failures", () => {
    expect(reducePetState(initialPetState, { type: "FAILED", message: "offline" })).toMatchObject({
      mode: "error",
      message: "offline",
      emotion: "worried",
    });
  });
});
