"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trace = trace;
exports.withTracing = withTracing;
exports.getActiveSpan = getActiveSpan;
exports.setAttributeOnSpan = setAttributeOnSpan;
exports.setAttributeOnActiveSpan = setAttributeOnActiveSpan;
const api_1 = require("@opentelemetry/api");
const semantic_conventions_1 = require("@opentelemetry/semantic-conventions");
function trace(arg1, arg2, arg3) {
    const tracer = api_1.trace.getTracer("btrz-monitoring");
    const { spanNameFromArgs, traceOptions, functionToTrace } = extractArguments(arg1, arg2, arg3);
    const spanName = spanNameFromArgs || functionToTrace.name || getNameOfCallingFunction() || "unnamed trace";
    let result;
    const { inheritAttributesFromParentTrace, ..._spanOptions } = traceOptions;
    const activeSpan = api_1.trace.getActiveSpan();
    let attributesToCopy = {};
    let linksToCopy = [];
    let spanKind = api_1.SpanKind.INTERNAL;
    if (inheritAttributesFromParentTrace && activeSpan) {
        attributesToCopy = getSpanAttributes(activeSpan);
        linksToCopy = getSpanLinks(activeSpan);
        spanKind = getSpanKind(activeSpan);
    }
    const spanOptions = {
        ..._spanOptions,
        attributes: {
            [semantic_conventions_1.ATTR_CODE_FUNCTION_NAME]: functionToTrace.name || getNameOfCallingFunction() || undefined,
            ...attributesToCopy,
            ...(_spanOptions.attributes || {})
        },
        links: [...(_spanOptions.links || []), ...linksToCopy],
        kind: _spanOptions.kind ?? spanKind,
    };
    tracer.startActiveSpan(spanName, spanOptions, (span) => {
        try {
            result = functionToTrace();
        }
        catch (synchronousError) {
            attachErrorToSpan(synchronousError, span);
            span.end();
            throw synchronousError;
        }
        if (isPromiseLike(result)) {
            result = Promise.resolve(result)
                .then((result) => {
                span.setStatus({
                    code: api_1.SpanStatusCode.OK
                });
                span.end();
                return result;
            }, (_error) => {
                attachErrorToSpan(_error, span);
                span.end();
                throw _error;
            });
        }
        else {
            span.setStatus({
                code: api_1.SpanStatusCode.OK
            });
            span.end();
        }
    });
    return result;
}
function withTracing(arg1, arg2, arg3) {
    const { spanNameFromArgs, traceOptions, functionToTrace } = extractArguments(arg1, arg2, arg3);
    const spanName = spanNameFromArgs || simplifyFunctionName(functionToTrace.name) || getNameOfCallingFunction() || "unnamed trace";
    const wrapperFunction = (...args) => {
        const traceExecutor = () => functionToTrace(...args);
        Object.defineProperty(traceExecutor, "name", { value: functionToTrace.name });
        return trace(spanName, traceOptions, traceExecutor);
    };
    Object.defineProperty(wrapperFunction, "length", { value: functionToTrace.length });
    Object.defineProperty(wrapperFunction, "name", { value: functionToTrace.name });
    return wrapperFunction;
}
function extractArguments(arg1, arg2, arg3) {
    let spanNameFromArgs;
    let traceOptions;
    let functionToTrace;
    if (typeof arg1 === "function") {
        functionToTrace = arg1;
        spanNameFromArgs = undefined;
        traceOptions = {};
    }
    else if (typeof arg1 === "string" && typeof arg2 === "function") {
        spanNameFromArgs = arg1;
        functionToTrace = arg2;
        traceOptions = {};
    }
    else if (typeof arg1 === "object" && typeof arg2 === "function") {
        traceOptions = arg1;
        functionToTrace = arg2;
        spanNameFromArgs = undefined;
    }
    else {
        spanNameFromArgs = arg1;
        traceOptions = arg2 || {};
        functionToTrace = arg3;
    }
    return {
        spanNameFromArgs,
        traceOptions,
        functionToTrace
    };
}
function attachErrorToSpan(error, span) {
    span.setStatus({
        code: api_1.SpanStatusCode.ERROR,
        message: error?.message
    });
    span.setAttributes({
        [semantic_conventions_1.ATTR_EXCEPTION_MESSAGE]: error?.message,
        [semantic_conventions_1.ATTR_EXCEPTION_STACKTRACE]: error?.stack
    });
}
function getSpanAttributes(span) {
    if (!span || !span.attributes) {
        return {};
    }
    return span.attributes;
}
function getSpanLinks(span) {
    if (!span || !span.links) {
        return [];
    }
    return span.links;
}
function getSpanKind(span) {
    if (!span || !span.kind) {
        return api_1.SpanKind.INTERNAL;
    }
    return span.kind;
}
function isPromiseLike(value) {
    return typeof value?.then === "function";
}
// Adapted from https://devimalplanet.com/javascript-how-to-get-the-caller-parent-functions-name
function getNameOfCallingFunction() {
    const e = new Error();
    // matches this function, the caller and the parent
    const allMatches = e.stack?.match(/(\w+)@|at(.*) [(\/\\]/g) ?? [];
    // match parent function name
    const parentMatches = allMatches[2]?.match(/(\w+)@|at(.*) [(\/\\]/) ?? [];
    // return only name
    return simplifyFunctionName(parentMatches[1] || parentMatches[2]);
}
function simplifyFunctionName(functionName) {
    return (functionName || "")
        .trim()
        .replace(/^bound /, "");
}
function getActiveSpan() {
    return api_1.trace.getActiveSpan();
}
function setAttributeOnSpan(span, key, value) {
    span?.setAttribute(key, value);
}
function setAttributeOnActiveSpan(key, value) {
    return setAttributeOnSpan(api_1.trace.getActiveSpan(), key, value);
}
//# sourceMappingURL=manual-tracing.js.map