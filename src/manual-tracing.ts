import {
  Attributes,
  AttributeValue,
  Link,
  Span,
  SpanKind,
  SpanStatusCode,
  SpanOptions,
  trace as otlpTrace,
} from "@opentelemetry/api";
import {ReadableSpan,} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_CODE_FUNCTION_NAME,
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
} from "@opentelemetry/semantic-conventions";
import {monitoringAttributes} from "./attributes";

type TraceableFunction<T extends unknown[], R> = (...args: T) => R;
type TraceableFunctionWithoutArgs<R> = () => R;
type TraceOptions = SpanOptions & { inheritAttributesFromParentTrace?: boolean };

// NonRecordingSpan is an OpenTelemetry type that is not currently exported.  Fake it for our own use.
type NonRecordingSpan = {};

export function trace<R>(fn: TraceableFunctionWithoutArgs<R>): R;
export function trace<R>(spanName: string, fn: TraceableFunctionWithoutArgs<R>): R;
export function trace<R>(options: TraceOptions, fn: TraceableFunctionWithoutArgs<R>): R;
export function trace<R>(spanName: string, options: TraceOptions, fn: TraceableFunctionWithoutArgs<R>): R;
export function trace<R>(arg1: string | TraceOptions | TraceableFunctionWithoutArgs<R>, arg2?: TraceOptions | TraceableFunctionWithoutArgs<R>, arg3?: TraceableFunctionWithoutArgs<R>): R {
  const tracer = otlpTrace.getTracer("btrz-monitoring");

  const {
    spanNameFromArgs,
    traceOptions,
    functionToTrace
  } = extractArguments(arg1, arg2, arg3);
  const spanName = spanNameFromArgs || functionToTrace.name || getNameOfCallingFunction() || "unnamed trace";

  let result: R;

  const { inheritAttributesFromParentTrace, ..._spanOptions } = traceOptions;
  const activeSpan: NonRecordingSpan | ReadableSpan | undefined = otlpTrace.getActiveSpan();
  let attributesToCopy: Attributes = {};
  let linksToCopy: Link[] = [];
  let spanKind = SpanKind.INTERNAL;

  if (inheritAttributesFromParentTrace && activeSpan) {
    attributesToCopy = getSpanAttributes(activeSpan);
    linksToCopy = getSpanLinks(activeSpan);
    spanKind = getSpanKind(activeSpan);
  }

  const spanOptions: SpanOptions = {
    ..._spanOptions,
    attributes: {
      [ATTR_CODE_FUNCTION_NAME]: functionToTrace.name || getNameOfCallingFunction() || undefined,
      ...attributesToCopy,
      ...(_spanOptions.attributes || {})
    },
    links: [...(_spanOptions.links || []), ...linksToCopy],
    kind: _spanOptions.kind ?? spanKind,
  };

  tracer.startActiveSpan(spanName, spanOptions, (span) => {
    try {
      result = functionToTrace();
    } catch (synchronousError: any) {
      attachErrorToSpan(synchronousError, span);
      span.end();
      throw synchronousError;
    }

    if (isPromiseLike(result)) {
      result = Promise.resolve(result)
        .then((result) => {
          span.setStatus({
            code: SpanStatusCode.OK
          });
          span.end();
          return result;
        }, (_error) => {
          attachErrorToSpan(_error, span);
          span.end();
          throw _error;
        }) as R;
    } else {
      span.setStatus({
        code: SpanStatusCode.OK
      });
      span.end();
    }
  });

  return result!;
}

export function withTracing<T extends unknown[], R>(fn: TraceableFunction<T, R>): TraceableFunction<T, R>;
export function withTracing<T extends unknown[], R>(spanName: string, fn: TraceableFunction<T, R>): TraceableFunction<T, R>;
export function withTracing<T extends unknown[], R>(options: TraceOptions, fn: TraceableFunction<T, R>): TraceableFunction<T, R>;
export function withTracing<T extends unknown[], R>(spanName: string, options: TraceOptions, fn: TraceableFunction<T, R>): TraceableFunction<T, R>;
export function withTracing<T extends unknown[], R>(arg1: string | TraceOptions | TraceableFunction<T, R>, arg2?: TraceOptions | TraceableFunction<T, R>, arg3? : TraceableFunction<T, R>): TraceableFunction<T, R> {
  const {
    spanNameFromArgs,
    traceOptions,
    functionToTrace
  } = extractArguments(arg1, arg2, arg3);
  const spanName = spanNameFromArgs || simplifyFunctionName(functionToTrace.name) || getNameOfCallingFunction() || "unnamed trace";

  const wrapperFunction = (...args: T) => {
    const traceExecutor = () => functionToTrace(...args);
    Object.defineProperty(traceExecutor, "name", {value: functionToTrace.name});

    return trace(spanName, traceOptions, traceExecutor);
  };

  Object.defineProperty(wrapperFunction, "length", {value: functionToTrace.length});
  Object.defineProperty(wrapperFunction, "name", {value: functionToTrace.name});
  return wrapperFunction;
}

function extractArguments<T extends unknown[], R>(
  arg1: string | TraceOptions | TraceableFunction<T, R>,
  arg2?: TraceOptions | TraceableFunction<T, R>,
  arg3? : TraceableFunction<T, R>
) {
  let spanNameFromArgs: string | undefined;
  let traceOptions: TraceOptions;
  let functionToTrace: TraceableFunction<T, R>;

  if (typeof arg1 === "function") {
    functionToTrace = arg1;
    spanNameFromArgs = undefined;
    traceOptions = {};
  } else if (typeof arg1 === "string" && typeof arg2 === "function") {
    spanNameFromArgs = arg1;
    functionToTrace = arg2;
    traceOptions = {};
  } else if (typeof arg1 === "object" && typeof arg2 === "function") {
    traceOptions = arg1;
    functionToTrace = arg2;
    spanNameFromArgs = undefined;
  } else {
    spanNameFromArgs = arg1 as string;
    traceOptions = arg2 as TraceOptions || {};
    functionToTrace = arg3!;
  }

  return {
    spanNameFromArgs,
    traceOptions,
    functionToTrace
  };
}

function attachErrorToSpan(error: any, span: Span) {
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error?.message
  });
  span.setAttributes({
    [ATTR_EXCEPTION_MESSAGE]: error?.message,
    [ATTR_EXCEPTION_STACKTRACE]: error?.stack
  });
}

function getSpanAttributes(span?: NonRecordingSpan | ReadableSpan): Attributes {
  if (!span || !(span as any).attributes) {
    return {};
  }
  return (span as ReadableSpan).attributes;
}

function getSpanLinks(span?: NonRecordingSpan | ReadableSpan): Link[] {
  if (!span || !(span as any).links) {
    return [];
  }
  return (span as ReadableSpan).links;
}

function getSpanKind(span?: NonRecordingSpan | ReadableSpan): SpanKind {
  if (!span || !(span as any).kind) {
    return SpanKind.INTERNAL;
  }
  return (span as ReadableSpan).kind;
}

function isPromiseLike(value: any): value is PromiseLike<any> {
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

function simplifyFunctionName(functionName?: string) {
  return (functionName || "")
    .trim()
    .replace(/^bound /, "");
}

export function getActiveSpan(): Span | undefined {
  return otlpTrace.getActiveSpan();
}

export function setAttributeOnSpan(
  span: Span | undefined,
  key: typeof monitoringAttributes[keyof typeof monitoringAttributes],
  value: AttributeValue
) {
  span?.setAttribute(key as string,  value);
}

export function setAttributeOnActiveSpan(
  key: typeof monitoringAttributes[keyof typeof monitoringAttributes],
  value: AttributeValue
) {
  return setAttributeOnSpan(otlpTrace.getActiveSpan(), key, value);
}
