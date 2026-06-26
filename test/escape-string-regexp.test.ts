import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {escapeStringRegexp} from "../src/escape-string-regexp";

describe("escapeStringRegexp()", () => {
  it("should escape regexp control characters and hyphen exactly like escape-string-regexp", () => {
    assert.equal(
      escapeStringRegexp("[btrz]-monitoring?(test)+foo.bar\\baz"),
      "\\[btrz\\]\\x2dmonitoring\\?\\(test\\)\\+foo\\.bar\\\\baz"
    );
  });

  it("should throw TypeError when input is not a string", () => {
    assert.throws(() => escapeStringRegexp(123 as unknown as string), new TypeError("Expected a string"));
  });
});
