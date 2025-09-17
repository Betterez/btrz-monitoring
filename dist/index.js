"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.monitoringAttributes = exports.setAttributeOnActiveSpan = exports.setAttributeOnSpan = exports.getActiveSpan = exports.withTracing = exports.trace = exports.warmUpDatabaseConnectionForTracing = exports.initializeTracing = void 0;
var tracing_1 = require("./tracing");
Object.defineProperty(exports, "initializeTracing", { enumerable: true, get: function () { return tracing_1.initializeTracing; } });
Object.defineProperty(exports, "warmUpDatabaseConnectionForTracing", { enumerable: true, get: function () { return tracing_1.warmUpDatabaseConnectionForTracing; } });
Object.defineProperty(exports, "trace", { enumerable: true, get: function () { return tracing_1.trace; } });
Object.defineProperty(exports, "withTracing", { enumerable: true, get: function () { return tracing_1.withTracing; } });
Object.defineProperty(exports, "getActiveSpan", { enumerable: true, get: function () { return tracing_1.getActiveSpan; } });
Object.defineProperty(exports, "setAttributeOnSpan", { enumerable: true, get: function () { return tracing_1.setAttributeOnSpan; } });
Object.defineProperty(exports, "setAttributeOnActiveSpan", { enumerable: true, get: function () { return tracing_1.setAttributeOnActiveSpan; } });
Object.defineProperty(exports, "monitoringAttributes", { enumerable: true, get: function () { return tracing_1.monitoringAttributes; } });
//# sourceMappingURL=index.js.map