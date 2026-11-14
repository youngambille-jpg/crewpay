import { test } from "node:test";
import assert from "node:assert/strict";
import { toBaseUnits, fromBaseUnits, formatBaseUnits, hasFunds } from "./format.js";

test("a decimal amount scales to base units at the asset's precision", () => {
  assert.equal(toBaseUnits("100", 6), "100000000");
  assert.equal(toBaseUnits("10.5", 6), "10500000");
  assert.equal(toBaseUnits("0.000001", 6), "1");
  assert.equal(toBaseUnits("1,250.25", 6), "1250250000");
});

test("toBaseUnits truncates past the scale rather than rounding", () => {
  assert.equal(toBaseUnits("1.0000009", 6), "1000000");
  assert.equal(toBaseUnits("0.9999999", 6), "999999");
});

test("toBaseUnits treats junk as zero, so a bad input never mints", () => {
  assert.equal(toBaseUnits("", 6), "0");
  assert.equal(toBaseUnits("abc", 6), "0");
  assert.equal(toBaseUnits(".", 6), "0");
});

test("toBaseUnits avoids float rounding on a large amount", () => {
  // 2^53 + 1 is not representable as a float; string math keeps it exact.
  assert.equal(toBaseUnits("9007199254740993", 0), "9007199254740993");
  assert.equal(toBaseUnits("90071992547.40993", 6), "90071992547409930");
});

test("base units round-trip back through fromBaseUnits", () => {
  assert.equal(fromBaseUnits(toBaseUnits("10.5", 6), 6), "10.5");
  assert.equal(fromBaseUnits(toBaseUnits("100", 6), 6), "100");
});

test("formatBaseUnits trims to a short display and hasFunds reads positivity", () => {
  assert.equal(formatBaseUnits("10000000", 6, { maxFractionDigits: 2 }), "10");
  assert.equal(formatBaseUnits("10500000", 6, { maxFractionDigits: 2 }), "10.5");
  assert.equal(hasFunds("0"), false);
  assert.equal(hasFunds("1"), true);
  assert.equal(hasFunds(undefined), false);
});
