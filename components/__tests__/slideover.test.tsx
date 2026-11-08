import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { SlideOver } from "@/components/SlideOver";

describe("SlideOver (D4 row drill-over)", () => {
  it("renders nothing while closed", () => {
    const { queryByRole } = render(
      <SlideOver open={false} title="Hidden" onClose={() => {}}>
        <p>payload</p>
      </SlideOver>,
    );
    expect(queryByRole("dialog")).toBeNull();
  });

  it("shows title + children in a dialog when open", () => {
    const { getByRole, getByText } = render(
      <SlideOver open title="Charged twice" onClose={() => {}}>
        <p>raw json</p>
      </SlideOver>,
    );
    const dialog = getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(getByText("raw json")).toBeTruthy();
    expect(dialog.getAttribute("aria-label")).toBe("Charged twice");
  });

  it("closes via the × button and the backdrop", () => {
    const onClose = vi.fn();
    const { getByLabelText } = render(
      <SlideOver open title="t" onClose={onClose}>
        <p>x</p>
      </SlideOver>,
    );
    fireEvent.click(getByLabelText("Close panel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    document.querySelector(".slide-backdrop") &&
      fireEvent.click(document.querySelector(".slide-backdrop") as Element);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("Escape key dismisses the panel", () => {
    const onClose = vi.fn();
    render(
      <SlideOver open title="t" onClose={onClose}>
        <p>x</p>
      </SlideOver>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "a" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
