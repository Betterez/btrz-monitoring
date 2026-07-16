import { AttributeValue, Span, SpanOptions } from "@opentelemetry/api";
import { monitoringAttributes } from "./attributes";
type TraceableFunction<T extends unknown[], R> = (...args: T) => R;
type TraceableFunctionWithoutArgs<R> = () => R;
type TraceOptions = SpanOptions & {
    inheritAttributesFromParentTrace?: boolean;
};
export declare function trace<R>(fn: TraceableFunctionWithoutArgs<R>): R;
export declare function trace<R>(spanName: string, fn: TraceableFunctionWithoutArgs<R>): R;
export declare function trace<R>(options: TraceOptions, fn: TraceableFunctionWithoutArgs<R>): R;
export declare function trace<R>(spanName: string, options: TraceOptions, fn: TraceableFunctionWithoutArgs<R>): R;
export declare function withTracing<T extends unknown[], R>(fn: TraceableFunction<T, R>): TraceableFunction<T, R>;
export declare function withTracing<T extends unknown[], R>(spanName: string, fn: TraceableFunction<T, R>): TraceableFunction<T, R>;
export declare function withTracing<T extends unknown[], R>(options: TraceOptions, fn: TraceableFunction<T, R>): TraceableFunction<T, R>;
export declare function withTracing<T extends unknown[], R>(spanName: string, options: TraceOptions, fn: TraceableFunction<T, R>): TraceableFunction<T, R>;
export declare function getActiveSpan(): Span | undefined;
export declare function setAttributeOnSpan(span: Span | undefined, key: typeof monitoringAttributes[keyof typeof monitoringAttributes], value: AttributeValue): void;
export declare function setAttributeOnActiveSpan(key: typeof monitoringAttributes[keyof typeof monitoringAttributes], value: AttributeValue): void;
export {};
