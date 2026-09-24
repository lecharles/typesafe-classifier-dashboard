import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StatTile } from "@/components/charts/StatTile";
import { Gauge } from "@/components/charts/Gauge";
import { ConfidenceBadge } from "@/components/charts/ConfidenceBadge";

describe("presentational charts", () => {
  it("StatTile renders label and value", () => {
    const { getByText } = render(<StatTile label="Total" value={42} />);
    expect(getByText("Total")).toBeTruthy();
    expect(getByText("42")).toBeTruthy();
  });

  it("Gauge renders a percentage and sets aria attributes", () => {
    const { getByRole, getByText } = render(<Gauge label="Urgent" value={0.8} />);
    expect(getByText("80%")).toBeTruthy();
    expect(getByRole("meter").getAttribute("aria-valuenow")).toBe("80");
  });

  it("ConfidenceBadge clamps and rounds", () => {
    const { getByText } = render(<ConfidenceBadge value={0.923} />);
    expect(getByText("92%")).toBeTruthy();
  });
});
