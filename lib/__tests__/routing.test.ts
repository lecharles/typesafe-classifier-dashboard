import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  normalizeThresholds,
  routeDecision,
  summarizeRouting,
} from "../routing";

describe("routeDecision", () => {
  it("routes at-or-above high to auto", () => {
    expect(routeDecision(0.8, DEFAULT_THRESHOLDS)).toBe("auto");
    expect(routeDecision(1, DEFAULT_THRESHOLDS)).toBe("auto");
  });

  it("routes strictly below low to human", () => {
    expect(routeDecision(0.49, DEFAULT_THRESHOLDS)).toBe("human");
    expect(routeDecision(0, DEFAULT_THRESHOLDS)).toBe("human");
  });

  it("routes the band between low and high to assist", () => {
    expect(routeDecision(0.5, DEFAULT_THRESHOLDS)).toBe("assist");
    expect(routeDecision(0.79, DEFAULT_THRESHOLDS)).toBe("assist");
  });
});

describe("summarizeRouting", () => {
  it("buckets counts and computes auto rate", () => {
    const s = summarizeRouting([0.95, 0.85, 0.6, 0.2], DEFAULT_THRESHOLDS);
    expect(s).toEqual({ auto: 2, assist: 1, human: 1, total: 4, autoRate: 0.5 });
  });

  it("handles empty input without dividing by zero", () => {
    const s = summarizeRouting([], DEFAULT_THRESHOLDS);
    expect(s.total).toBe(0);
    expect(s.autoRate).toBe(0);
  });

  it("moves items between buckets as thresholds slide", () => {
    const confs = [0.9, 0.7, 0.4];
    expect(summarizeRouting(confs, { high: 0.8, low: 0.5 }).auto).toBe(1);
    expect(summarizeRouting(confs, { high: 0.95, low: 0.5 }).auto).toBe(0);
    expect(summarizeRouting(confs, { high: 0.8, low: 0.3 }).human).toBe(0);
  });
});

describe("normalizeThresholds", () => {
  it("swaps crossed sliders instead of producing an inverted band", () => {
    expect(normalizeThresholds(0.3, 0.7)).toEqual({ high: 0.7, low: 0.3 });
  });

  it("clamps out-of-range values into 0..1", () => {
    expect(normalizeThresholds(1.4, -0.2)).toEqual({ high: 1, low: 0 });
  });

  it("leaves a valid ordered pair untouched", () => {
    expect(normalizeThresholds(0.8, 0.5)).toEqual({ high: 0.8, low: 0.5 });
  });
});
