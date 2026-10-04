import { describe, expect, it } from "vitest";
import { andList, orList } from "../src/text.ts";

describe("andList and orList (house style: no comma before the last word)", () => {
  it("joins 0, 1, 2 and 3+ items exactly as the old hand-written listJoin did", () => {
    expect(andList([])).toBe("");
    expect(andList(["apixaban"])).toBe("apixaban");
    expect(andList(["apixaban", "aspirin"])).toBe("apixaban and aspirin");
    expect(andList(["apixaban", "aspirin", "sertraline"])).toBe("apixaban, aspirin and sertraline");
    expect(andList(["a", "b", "c", "d"])).toBe("a, b, c and d");
    expect(orList([])).toBe("");
    expect(orList(["“Yes”"])).toBe("“Yes”");
    expect(orList(["“Yes”", "“No”"])).toBe("“Yes” or “No”");
    expect(orList(["“Yes”", "“A little”", "“No”"])).toBe("“Yes”, “A little” or “No”");
  });
});
