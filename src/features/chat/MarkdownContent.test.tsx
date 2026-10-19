// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MarkdownContent } from "./ChatPresentationComponents";

vi.mock("../app/appShared", () => ({ PetSprite: () => null }));
afterEach(cleanup);

it("renders inline and display formulas through the upgraded math plugins", () => {
  const { container } = render(
    <MarkdownContent>
      {"公式 $x^2 + y^2$\n\n$$\n\\frac{1}{2}\n$$"}
    </MarkdownContent>,
  );
  expect(container.querySelectorAll(".katex").length).toBe(2);
  expect(container.querySelectorAll(".katex-display").length).toBe(1);
  expect(container.querySelector(".katex-error")).toBeNull();
  expect(container.querySelectorAll("math").length).toBe(2);
});

it("keeps untrusted TeX HTML and URL commands inert", () => {
  const { container } = render(
    <MarkdownContent>
      {
        "$\\href{javascript:alert(1)}{click}$\n\n$\\htmlClass{injected}{content}$"
      }
    </MarkdownContent>,
  );
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(container.querySelector(".injected")).toBeNull();
  expect(container.querySelector("script")).toBeNull();
});
