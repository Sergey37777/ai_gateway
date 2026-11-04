import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MicRecorder } from "./MicRecorder";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("вне secure context кнопка неактивна и есть подсказка", () => {
  vi.stubGlobal("isSecureContext", false);
  render(<MicRecorder disabled={false} onRecorded={() => undefined} />);
  expect(screen.getByRole("button", { name: "Записать с микрофона" })).toBeDisabled();
  expect(
    screen.getByText(/chrome:\/\/flags\/#unsafely-treat-insecure-origin-as-secure/),
  ).toBeInTheDocument();
});
