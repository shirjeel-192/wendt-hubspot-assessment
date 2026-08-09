import { describe, it, expect } from "vitest";
import {
  coerceBool,
  coerceDate,
  coerceAmount,
  coercePercent,
  coercePhone,
  coerceInt,
  coerceEnum,
  boolForHubspot,
  CoercionError,
} from "../src/clean.js";
import { mapAirtableDealStage } from "../src/mappers.js";

describe("coerceBool", () => {
  it.each([
    ["1", true],
    ["0", false],
    ["True", true],
    ["false", false],
    ["Yes", true],
    ["no", false],
    ["", null],
    [null, null],
    [undefined, null],
  ] as const)("coerces %o -> %s", (input, expected) => {
    expect(coerceBool("t", input)).toBe(expected);
  });

  it("throws on unknown value", () => {
    expect(() => coerceBool("t", "maybe")).toThrow(CoercionError);
  });
});

describe("coerceDate", () => {
  it("handles YYYY-MM-DD", () => {
    expect(coerceDate("t", "2023-12-18")).toBe(Date.UTC(2023, 11, 18));
  });
  it("handles YYYY/MM/DD", () => {
    expect(coerceDate("t", "2023/12/18")).toBe(Date.UTC(2023, 11, 18));
  });
  it("handles MM/DD/YYYY", () => {
    expect(coerceDate("t", "04/06/2024")).toBe(Date.UTC(2024, 3, 6));
  });
  it("handles MM-DD-YYYY", () => {
    expect(coerceDate("t", "01-25-2023")).toBe(Date.UTC(2023, 0, 25));
  });
  it("handles MM/YYYY partial by defaulting to day 1", () => {
    expect(coerceDate("t", "02/2024")).toBe(Date.UTC(2024, 1, 1));
  });
  it("interprets first component > 12 as DD/MM/YYYY", () => {
    expect(coerceDate("t", "14/05/2021")).toBe(Date.UTC(2021, 4, 14));
    expect(coerceDate("t", "27/09/2021")).toBe(Date.UTC(2021, 8, 27));
  });
  it("interprets second component > 12 as MM/DD/YYYY", () => {
    expect(coerceDate("t", "05/14/2021")).toBe(Date.UTC(2021, 4, 14));
  });
  it("defaults ambiguous slash dates (both <=12) to MM/DD/YYYY", () => {
    expect(coerceDate("t", "04/06/2024")).toBe(Date.UTC(2024, 3, 6));
  });
  it("returns null for empty", () => {
    expect(coerceDate("t", "")).toBeNull();
    expect(coerceDate("t", null)).toBeNull();
  });
  it("throws on unrecognised format", () => {
    expect(() => coerceDate("t", "not a date")).toThrow(CoercionError);
    expect(() => coerceDate("t", "13/45/2024")).toThrow(CoercionError);
  });
});

describe("coerceAmount", () => {
  it.each([
    ['"$48,469"'.replace(/^"|"$/g, ""), 48469],
    ["141994.39", 141994.39],
    ["89084.49", 89084.49],
    ["89084", 89084],
    ["", null],
    [null, null],
  ] as const)("coerces %o -> %s", (input, expected) => {
    expect(coerceAmount("t", input)).toBe(expected);
  });

  it("strips $ and commas", () => {
    expect(coerceAmount("t", "$1,234,567.89")).toBeCloseTo(1234567.89);
  });

  it("throws on non-numeric", () => {
    expect(() => coerceAmount("t", "abc")).toThrow(CoercionError);
  });

  it("throws on negative", () => {
    expect(() => coerceAmount("t", "-50")).toThrow(CoercionError);
  });
});

describe("coercePercent", () => {
  it.each([
    ["20", 20],
    ["15%", 15],
    ["0", 0],
    ["0%", 0],
    ["100", 100],
    ["", null],
  ] as const)("coerces %o -> %s", (input, expected) => {
    expect(coercePercent("t", input)).toBe(expected);
  });

  it("rejects out-of-range", () => {
    expect(() => coercePercent("t", "150")).toThrow(CoercionError);
    expect(() => coercePercent("t", "-5")).toThrow(CoercionError);
  });
});

describe("coercePhone", () => {
  it("normalises 7-digit to +1555 prefix", () => {
    expect(coercePhone("t", "5550422")).toBe("+15555550422");
  });
  it("normalises 3-4 dash to +1555 prefix", () => {
    expect(coercePhone("t", "555-0245")).toBe("+15555550245");
  });
  it("normalises 3.4 dot to +1555 prefix", () => {
    expect(coercePhone("t", "555.0611")).toBe("+15555550611");
  });
  it("normalises +1-3-4 to E.164", () => {
    expect(coercePhone("t", "+1-555-0278")).toBe("+15555550278");
  });
  it("normalises (XXX) prefix", () => {
    expect(coercePhone("t", "(555) 0141")).toBe("+15555550141");
  });
  it("returns null on empty", () => {
    expect(coercePhone("t", "")).toBeNull();
  });
});

describe("coerceInt", () => {
  it("parses ints", () => {
    expect(coerceInt("t", "3684")).toBe(3684);
  });
  it("rejects decimals", () => {
    expect(() => coerceInt("t", "3684.5")).toThrow(CoercionError);
  });
  it("returns null on empty", () => {
    expect(coerceInt("t", "")).toBeNull();
  });
});

describe("coerceEnum", () => {
  it("matches case-insensitively and returns canonical case", () => {
    expect(coerceEnum("t", "amer", ["AMER", "EMEA"])).toBe("AMER");
    expect(coerceEnum("t", "EMEA", ["AMER", "EMEA"])).toBe("EMEA");
  });
  it("throws on unknown enum", () => {
    expect(() => coerceEnum("t", "OCEANIA", ["AMER"])).toThrow(CoercionError);
  });
});

describe("boolForHubspot", () => {
  it("returns literal string 'true'/'false' or null", () => {
    expect(boolForHubspot(true)).toBe("true");
    expect(boolForHubspot(false)).toBe("false");
    expect(boolForHubspot(null)).toBeNull();
  });
});

describe("mapAirtableDealStage", () => {
  it("maps Won -> closedwon", () => {
    expect(mapAirtableDealStage("Won")).toBe("closedwon");
    expect(mapAirtableDealStage("won")).toBe("closedwon");
    expect(mapAirtableDealStage("WON")).toBe("closedwon");
  });
  it("maps Lost -> closedlost", () => {
    expect(mapAirtableDealStage("Lost")).toBe("closedlost");
  });
  it("maps anything else -> qualifiedtobuy", () => {
    expect(mapAirtableDealStage("Negotiation")).toBe("qualifiedtobuy");
    expect(mapAirtableDealStage("Pending")).toBe("qualifiedtobuy");
    expect(mapAirtableDealStage("")).toBe("qualifiedtobuy");
    expect(mapAirtableDealStage(null)).toBe("qualifiedtobuy");
    expect(mapAirtableDealStage(undefined)).toBe("qualifiedtobuy");
  });
});
