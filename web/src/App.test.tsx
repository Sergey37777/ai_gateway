import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { App } from "./App";

test("рендерит заголовок", () => {
  render(<App />);
  expect(screen.getByText("ai_gateway")).toBeInTheDocument();
});
