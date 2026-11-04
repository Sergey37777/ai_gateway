import { expect, test } from "vitest";
import { baseName, isVideo, pickRecorderType } from "./media";

test("isVideo по type и по расширению", () => {
  expect(isVideo({ name: "x.bin", type: "video/quicktime" })).toBe(true);
  expect(isVideo({ name: "clip.MOV", type: "" })).toBe(true);
  expect(isVideo({ name: "voice.webm", type: "audio/webm" })).toBe(false);
  expect(isVideo({ name: "a.mp3", type: "audio/mpeg" })).toBe(false);
});

test("baseName", () => {
  expect(baseName("a.b.mp4")).toBe("a.b");
  expect(baseName("noext")).toBe("noext");
  expect(baseName("")).toBe("transcript");
  expect(baseName(".mp4")).toBe("transcript");
});

test("pickRecorderType", () => {
  expect(pickRecorderType((t) => t === "audio/mp4")).toEqual({ mimeType: "audio/mp4", ext: "m4a" });
  expect(pickRecorderType(() => true)).toEqual({
    mimeType: "audio/webm;codecs=opus",
    ext: "webm",
  });
  expect(pickRecorderType(() => false)).toBeNull();
});
