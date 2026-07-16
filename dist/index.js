"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.monitoringAttributes = exports.setAttributeOnActiveSpan = exports.setAttributeOnSpan = exports.getActiveSpan = exports.withTracing = exports.trace = exports.warmUpDatabaseConnectionForTracing = exports.initializeTracing = void 0;
var install_instrumentation_1 = require("./install-instrumentation");
Object.defineProperty(exports, "initializeTracing", { enumerable: true, get: function () { return install_instrumentation_1.initializeTracing; } });
Object.defineProperty(exports, "warmUpDatabaseConnectionForTracing", { enumerable: true, get: function () { return install_instrumentation_1.warmUpDatabaseConnectionForTracing; } });
var manual_tracing_1 = require("./manual-tracing");
Object.defineProperty(exports, "trace", { enumerable: true, get: function () { return manual_tracing_1.trace; } });
Object.defineProperty(exports, "withTracing", { enumerable: true, get: function () { return manual_tracing_1.withTracing; } });
Object.defineProperty(exports, "getActiveSpan", { enumerable: true, get: function () { return manual_tracing_1.getActiveSpan; } });
Object.defineProperty(exports, "setAttributeOnSpan", { enumerable: true, get: function () { return manual_tracing_1.setAttributeOnSpan; } });
Object.defineProperty(exports, "setAttributeOnActiveSpan", { enumerable: true, get: function () { return manual_tracing_1.setAttributeOnActiveSpan; } });
var attributes_1 = require("./attributes");
Object.defineProperty(exports, "monitoringAttributes", { enumerable: true, get: function () { return attributes_1.monitoringAttributes; } });
//# sourceMappingURL=index.js.map