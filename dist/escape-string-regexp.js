"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.escapeStringRegexp = escapeStringRegexp;
// Vendored from escape-string-regexp@4.0.0 to avoid an ESM-only dependency upgrade.
function escapeStringRegexp(string) {
    if (typeof string !== "string") {
        throw new TypeError("Expected a string");
    }
    // Escape characters with special meaning either inside or outside character sets.
    // Use a simple backslash escape when it is always valid, and a \unnnn escape when
    // the simpler form would be disallowed by Unicode patterns stricter grammar.
    return string
        .replace(/[|\\{}()[\]^$+*?.]/g, "\\$&")
        .replace(/-/g, "\\x2d");
}
//# sourceMappingURL=escape-string-regexp.js.map