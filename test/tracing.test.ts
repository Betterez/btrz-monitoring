import "../src/types/global.types";

import assert from "node:assert/strict";
import {afterEach, before, beforeEach, describe, it} from "node:test";
import * as sinon from "sinon";
import {
  __enableTestMode,
  __getActiveOtlpSdkInstance,
  monitoringAttributes,
  initializeTracing,
  trace,
  withTracing,
  getActiveSpan,
  setAttributeOnSpan,
  setAttributeOnActiveSpan,
} from "../src/tracing";
import {InMemorySpanExporter, SimpleSpanProcessor} from "@opentelemetry/sdk-trace-base";
import {ATTR_EXCEPTION_MESSAGE, ATTR_EXCEPTION_STACKTRACE, ATTR_CODE_FUNCTION_NAME} from "@opentelemetry/semantic-conventions";
import {ATTR_ARTIFACT_VERSION} from "@opentelemetry/semantic-conventions/incubating";
import {Link, SpanKind, SpanStatusCode, TraceFlags, trace as otlpTrace} from "@opentelemetry/api";

describe("Tracing instrumentation", () => {
  let spanExporter: InMemorySpanExporter;
  let spanProcessor: SimpleSpanProcessor;

  before(() => {
    const testDependencies = __enableTestMode();
    spanExporter = testDependencies.spanExporter;
    spanProcessor = testDependencies.spanProcessor;

    // When running tests in "watch" mode, the tracing instrumentation must be initialized only once (during the
    // first test run) or a stack overflow will eventually occur.
    if (!global.__btrz_monitoring__didInitializeTracing) {
      global.__btrz_monitoring__didInitializeTracing = true;
      initializeTracing({
        serviceName: "btrz-monitoring-tests",
        traceDestinationUrl: "http://localhost:4317"
      });
    }
  });

  afterEach(() => {
    spanExporter.reset();
    sinon.restore();
  });

  async function getSpans() {
    await spanProcessor.forceFlush();
    return spanExporter.getFinishedSpans();
  }

  describe("initializeTracing()", () => {
    it("should return a shutdownTracing() function which gracefully shuts down the tracing instrumentation", async () => {
      const {shutdownTracing} = initializeTracing({
        serviceName: "btrz-monitoring-tests",
        traceDestinationUrl: "http://localhost:4317"
      });

      assert.equal(typeof shutdownTracing, "function");

      const sdk = __getActiveOtlpSdkInstance()!;
      const sdkShutdownStub = sinon.stub(sdk, "shutdown").resolves();

      await shutdownTracing();
      assert.equal(sdkShutdownStub.calledOnce, true);
    });

    it("should return a shutdownTracing() function that swallows any errors which occur when shutting down the tracing instrumentation", async () => {
      const {shutdownTracing} = initializeTracing({
        serviceName: "btrz-monitoring-tests",
        traceDestinationUrl: "http://localhost:4317"
      });

      const sdk = __getActiveOtlpSdkInstance()!;
      sinon.stub(sdk, "shutdown").rejects(new Error("Some error"));

      await shutdownTracing();
      // If no rejection occurred, the test has passed.
    });
  });

  describe("trace()", () => {
    describe("when tracing a synchronous non-arrow function", () => {
      function syncFn() {
        let i = 0;
        while (i < 100000) {
          i++;
        }
        return "syncFn return value";
      }

      it("should generate a single span which has ended", async () => {
        trace(syncFn);
        const spans = await getSpans();
        assert.equal(spans.length, 1);
        assert.equal(spans[0].ended, true);
      });

      it("should generate a span which is named after the function that is being traced", async () => {
        trace(syncFn);
        const spans = await getSpans();
        assert.equal(spans[0].name, "syncFn");
      });

      it("should allow the user to provide a custom name for the span", async () => {
        trace("my-span-name", syncFn);
        const spans = await getSpans();
        assert.equal(spans[0].name, "my-span-name");
      });

      it("should allow the user to provide options which affect the properties of the span", async () => {
        trace({kind: SpanKind.PRODUCER}, syncFn);
        const spans = await getSpans();
        assert.equal(spans[0].kind, SpanKind.PRODUCER);
      });

      it("should allow the user to provide both a span name as well as options which affect the properties of the span", async () => {
        trace("my-span-name", {kind: SpanKind.PRODUCER}, syncFn);
        const spans = await getSpans();
        assert.equal(spans[0].name, "my-span-name");
        assert.equal(spans[0].kind, SpanKind.PRODUCER);
      });

      it("should add an attribute to the span with the name of the function", async () => {
        trace(syncFn);
        const spans = await getSpans();
        assert.equal(spans[0].attributes[ATTR_CODE_FUNCTION_NAME], "syncFn");
      });

      it("should generate a span with a status code that indicates that the function returned successfully", async () => {
        trace(syncFn);
        const spans = await getSpans();
        assert.equal(spans[0].status.code, SpanStatusCode.OK);
      });

      it("should return the same return value as the function being traced", async () => {
        const result = trace(syncFn);
        assert.equal(result, "syncFn return value");
      });

      describe("when the function throws an error", () => {
        const thrownError = new Error("Error from syncFnWhichThrows");

        function syncFnWhichThrows() {
          throw thrownError;
        }

        it("should generate a single span which has ended", async () => {
          try {
            trace(syncFnWhichThrows);
          } catch { }

          const spans = await getSpans();
          assert.equal(spans.length, 1);
          assert.equal(spans[0].ended, true);
        });

        it("should generate a span with an 'error' status code, and the message contained in the original error", async () => {
          try {
            trace(syncFnWhichThrows);
          } catch { }

          const spans = await getSpans();
          assert.equal(spans[0].status.code, SpanStatusCode.ERROR);
          assert.equal(spans[0].status.message, "Error from syncFnWhichThrows");
        });

        it("should add an attribute to the span containing the message from the original error", async () => {
          try {
            trace(syncFnWhichThrows);
          } catch { }

          const spans = await getSpans();
          assert.equal(spans[0].attributes[ATTR_EXCEPTION_MESSAGE], "Error from syncFnWhichThrows");
        });

        it("should add an attribute to the span containing the stack trace from the original error", async () => {
          try {
            trace(syncFnWhichThrows);
          } catch { }

          const spans = await getSpans();
          assert.equal(spans[0].attributes[ATTR_EXCEPTION_STACKTRACE], thrownError.stack);
        });

        it("should throw the error originally thrown by the function being traced", async () => {
          try {
            trace(syncFnWhichThrows);
            assert.fail("Expected an error to be thrown");
          } catch (error){
            assert.equal(error, thrownError);
          }
        });
      });
    });

    describe("when tracing a synchronous arrow function", () => {
      const syncArrowFn = () => {
        let i = 0;
        while (i < 100000) {
          i++;
        }
        return "syncArrowFn return value";
      };

      it("should generate a span which is named after the function", async () => {
        trace(syncArrowFn);
        const spans = await getSpans();
        assert.equal(spans[0].name, "syncArrowFn");
      });

      it("should add an attribute to the span with the name of the function", async () => {
        trace(syncArrowFn);
        const spans = await getSpans();
        assert.equal(spans[0].attributes[ATTR_CODE_FUNCTION_NAME], "syncArrowFn");
      });

      describe("when the function being traced is anonymous", () => {
        it("should generate a span with the name of the calling function", async () => {
          function callingFunction() {
            trace(() => "anonymous arrow function return value");
          }

          callingFunction();
          const spans = await getSpans();
          assert.equal(spans[0].name, "callingFunction");
        });

        it("should add an attribute to the span with the name of the calling function", async () => {
          function callingFunction() {
            trace(() => "anonymous arrow function return value");
          }

          callingFunction();
          const spans = await getSpans();
          assert.equal(spans[0].attributes[ATTR_CODE_FUNCTION_NAME], "callingFunction");
        });

        it("should generate a span with the name of the calling function when the calling function is an arrow function that has been assigned to a variable", async () => {
          const callingFunction = () => {
            trace(() => "anonymous arrow function return value");
          }

          callingFunction();
          const spans = await getSpans();
          assert.equal(spans[0].name, "callingFunction");
        });

        it("should add an attribute to the span with the name of the calling function when the calling function is an arrow function that has been assigned to a variable", async () => {
          const callingFunction = () => {
            trace(() => "anonymous arrow function return value");
          }

          callingFunction();
          const spans = await getSpans();
          assert.equal(spans[0].attributes[ATTR_CODE_FUNCTION_NAME], "callingFunction");
        });

        it("should not add an attribute to the span with the name of the function when called within an anonymous function expression", async () => {
          (function () {
            trace(() => "anonymous arrow function return value");
          })();

          const spans = await getSpans();
          assert.equal(spans[0].attributes[ATTR_CODE_FUNCTION_NAME], undefined);
        });

        it("should give the span the name 'unnamed trace' when called within an anonymous function expression", async () => {
          (function () {
            trace(() => "anonymous arrow function return value");
          })();

          const spans = await getSpans();
          assert.equal(spans[0].name, "unnamed trace");
        });

        it("should not add an attribute to the span with the name of the function when called within an anonymous arrow function expression", async () => {
          (() => {
            trace(() => "anonymous arrow function return value");
          })();

          const spans = await getSpans();
          assert.equal(spans[0].attributes[ATTR_CODE_FUNCTION_NAME], undefined);
        });

        it("should give the span the name 'unnamed trace' when called within an anonymous arrow function expression", async () => {
          (() => {
            trace(() => "anonymous arrow function return value");
          })();

          const spans = await getSpans();
          assert.equal(spans[0].name, "unnamed trace");
        });
      });
    });

    describe("when tracing a function which returns a promise-like object", () => {
      function fnReturningPromiseLike() {
        const randomDelay = Math.random() * 5;

        return {
          then(resolve: (...args: any[]) => unknown, reject: (...args: any[]) => unknown) {
            setTimeout(resolve, randomDelay);
          }
        };
      }

      it("should generate a single span which has ended", async () => {
        await trace(fnReturningPromiseLike);
        const spans = await getSpans();
        assert.equal(spans.length, 1);
        assert.equal(spans[0].ended, true);
      });

      describe("when the function rejects", () => {
        const thrownError = new Error("Error from fnReturningPromiseLikeWithRejection");
        const rejectWith = (value: any) => {
          return {
            then(resolve: (...args: any[]) => unknown, reject: (...args: any[]) => unknown) {
              reject(value);
            }
          };
        }

        function fnReturningPromiseLikeWithRejection() {
          const randomDelay = Math.random() * 5;

          return {
            then(resolve: (...args: any[]) => unknown, reject: (...args: any[]) => unknown) {
              setTimeout(() => {
                try {
                  return reject(thrownError);
                } catch (error) {
                  return rejectWith(error);
                }
              }, randomDelay);
            }
          };
        }

        it("should generate a single span which has ended", async () => {
          try {
            await trace(fnReturningPromiseLikeWithRejection);
          } catch { }

          const spans = await getSpans();
          assert.equal(spans.length, 1);
          assert.equal(spans[0].ended, true);
        });

        it("should generate a span with an 'error' status code, and the message contained in the original error", async () => {
          try {
            await trace(fnReturningPromiseLikeWithRejection);
          } catch { }

          const spans = await getSpans();
          assert.equal(spans[0].status.code, SpanStatusCode.ERROR);
          assert.equal(spans[0].status.message, "Error from fnReturningPromiseLikeWithRejection");
        });

        it("should add an attribute to the span containing the message from the original error", async () => {
          try {
            await trace(fnReturningPromiseLikeWithRejection);
          } catch { }

          const spans = await getSpans();
          assert.equal(spans[0].attributes[ATTR_EXCEPTION_MESSAGE], "Error from fnReturningPromiseLikeWithRejection");
        });

        it("should add an attribute to the span containing the stack trace from the original error", async () => {
          try {
            await trace(fnReturningPromiseLikeWithRejection);
          } catch { }

          const spans = await getSpans();
          assert.equal(spans[0].attributes[ATTR_EXCEPTION_STACKTRACE], thrownError.stack);
        });

        it("should reject with the error originally thrown by the function being traced", async () => {
          try {
            await trace(fnReturningPromiseLikeWithRejection);
            assert.fail("Expected an error to be thrown");
          } catch (error){
            assert.equal(error, thrownError);
          }
        });
      });
    });

    describe("when tracing an asynchronous arrow function", () => {
      let unhandledRejectionDidOccur: boolean;

      beforeEach(() => {
        unhandledRejectionDidOccur = false;
        process.on("unhandledRejection", unhandledRejectionListener);
      });

      afterEach(() => {
        process.off("unhandledRejection", unhandledRejectionListener);
      });

      function unhandledRejectionListener() {
        unhandledRejectionDidOccur = true;
      }

      it("should not cause an unhandled rejection when the function being traced rejects", async () => {
        const thrownError = new Error("Some error");

        try {
          await trace(async () => {
            throw thrownError;
          });
          assert.fail("Expected function to reject");
        } catch (error) {

          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(error, thrownError);
          assert.equal(unhandledRejectionDidOccur, false);
        }
      });
    });

    describe("when tracing an asynchronous non-arrow function", () => {
      async function asyncFn() {
        const randomDelay = Math.random() * 5;
        await new Promise((resolve) => setTimeout(resolve, randomDelay));
        return "asyncFn return value";
      }

      it("should generate a single span which has ended", async () => {
        await trace(asyncFn);
        const spans = await getSpans();
        assert.equal(spans.length, 1);
        assert.equal(spans[0].ended, true);
      });

      it("should generate a span with a status code that indicates that the function resolved successfully", async () => {
        await trace(asyncFn);
        const spans = await getSpans();
        assert.equal(spans[0].status.code, SpanStatusCode.OK);
      });

      it("should resolve with the same value as the function being traced", async () => {
        const result = await trace(asyncFn);
        assert.equal(result, "asyncFn return value");
      });

      describe("when the function rejects", () => {
        const thrownError = new Error("Error from asyncFnWhichThrows");

        async function asyncFnWhichThrows() {
          throw thrownError;
        }

        it("should generate a single span which has ended", async () => {
          try {
            await trace(asyncFnWhichThrows);
          } catch { }

          const spans = await getSpans();
          assert.equal(spans.length, 1);
          assert.equal(spans[0].ended, true);
        });

        it("should generate a span with an 'error' status code, and the message contained in the original error", async () => {
          try {
            await trace(asyncFnWhichThrows);
          } catch { }

          const spans = await getSpans();
          assert.equal(spans[0].status.code, SpanStatusCode.ERROR);
          assert.equal(spans[0].status.message, "Error from asyncFnWhichThrows");
        });

        it("should reject with the error originally thrown by the function being traced", async () => {
          try {
            await trace(asyncFnWhichThrows);
            assert.fail("Expected an error to be thrown");
          } catch (error){
            assert.equal(error, thrownError);
          }
        });
      });
    });

    describe("when multiple nested calls to trace() are made", () => {
      it("should correctly nest spans", async () => {
        trace("first trace", () => {
          trace("second trace", () => {});
          trace("third trace", () => {});
        });

        const spans = await getSpans();
        assert.equal(spans.length, 3);

        const firstSpan = spans.find(span => span.name === "first trace")!;
        const secondSpan = spans.find(span => span.name === "second trace")!;
        const thirdSpan = spans.find(span => span.name === "third trace")!;
        assert.equal(firstSpan.parentSpanContext, undefined);
        assert.equal(secondSpan.parentSpanContext?.spanId, firstSpan.spanContext().spanId);
        assert.equal(thirdSpan.parentSpanContext?.spanId, firstSpan.spanContext().spanId);
      });
    });

    describe("when the 'inheritAttributesFromParentTrace' flag is used", () => {
      it("should copy attributes from the parent span to the child span", async () => {
        const parentSpanAttributes = {
          [ATTR_ARTIFACT_VERSION]: "1.0"
        };

        trace("first trace", {attributes: parentSpanAttributes}, () => {
          trace("second trace", {inheritAttributesFromParentTrace: true}, () => {});
        });

        const spans = await getSpans();
        const secondSpan = spans.find(span => span.name === "second trace")!;
        assert.equal(secondSpan.attributes[ATTR_ARTIFACT_VERSION], parentSpanAttributes[ATTR_ARTIFACT_VERSION]);
      });

      it("should not fail when the parent span does not have an 'attributes' property (which can occur when the parent span is non-recording)", async () => {
        trace("first trace", () => {
          const activeSpan = otlpTrace.getActiveSpan();
          delete (activeSpan as any).attributes;
          trace("second trace", {inheritAttributesFromParentTrace: true}, () => {});
        });

        const spans = await getSpans();
        const secondSpan = spans.find(span => span.name === "second trace")!;
        assert.deepEqual(secondSpan.attributes, {});
      });

      it("should copy links from the parent span to the child span", async () => {
        const parentSpanLinks: Link[] = [{
          attributes: {},
          context: {
            traceId: "2",
            spanId: "3",
            traceFlags: TraceFlags.SAMPLED
          }
        }];

        trace("first trace", {links: parentSpanLinks}, () => {
          trace("second trace", {inheritAttributesFromParentTrace: true}, () => {});
        });

        const spans = await getSpans();
        const secondSpan = spans.find(span => span.name === "second trace")!;
        assert.deepEqual(secondSpan.links, parentSpanLinks);
      });

      it("should not fail when the parent span does not have a 'links' property (which can occur when the parent span is non-recording)", async () => {
        trace("first trace", () => {
          const activeSpan = otlpTrace.getActiveSpan();
          delete (activeSpan as any).links;
          trace("second trace", {inheritAttributesFromParentTrace: true}, () => {});
        });

        const spans = await getSpans();
        const secondSpan = spans.find(span => span.name === "second trace")!;
        assert.deepEqual(secondSpan.links, []);
      });

      it("should copy the 'kind' property from the parent span to the child span", async () => {
        const parentSpanKind = SpanKind.CONSUMER;

        trace("first trace", {kind: parentSpanKind}, () => {
          trace("second trace", {inheritAttributesFromParentTrace: true}, () => {});
        });

        const spans = await getSpans();
        const secondSpan = spans.find(span => span.name === "second trace")!;
        assert.equal(secondSpan.kind, parentSpanKind);
      });

      it("should not fail when the parent span does not have a 'kind' property", async () => {
        trace("first trace", () => {
          const activeSpan = otlpTrace.getActiveSpan();
          delete (activeSpan as any).kind;
          trace("second trace", {inheritAttributesFromParentTrace: true}, () => {});
        });

        const spans = await getSpans();
        const secondSpan = spans.find(span => span.name === "second trace")!;
        assert.equal(secondSpan.kind, SpanKind.INTERNAL);
      });

      it("should not copy any attributes or links when the span has no parent", async () => {
        trace("only trace", {inheritAttributesFromParentTrace: true}, () => {});

        const spans = await getSpans();
        assert.equal(spans.length, 1);
        const {[ATTR_CODE_FUNCTION_NAME]: _ignoredFunctionName, ...attributesWithoutFunctionName} = spans[0].attributes;
        assert.deepEqual(attributesWithoutFunctionName, {});
        assert.deepEqual(spans[0].links, []);
        assert.equal(spans[0].kind, SpanKind.INTERNAL);
      });

      it("should set the 'kind' property to 'INTERNAL' when the span has no parent", async () => {
        trace("only trace", {inheritAttributesFromParentTrace: true}, () => {});

        const spans = await getSpans();
        assert.equal(spans.length, 1);
        assert.equal(spans[0].kind, SpanKind.INTERNAL);
      });
    });
  });

  describe("withTracing()", () => {
    it("should accept a function as a parameter, and return a new function which traces the execution of the original function", async () => {
      let originalFnWasCalled = false;

      function originalFn() {
        originalFnWasCalled = true;
      }

      const tracedFn = withTracing(originalFn);

      assert.equal(originalFnWasCalled, false);
      tracedFn();
      assert.equal(originalFnWasCalled, true);

      const spans = await getSpans();
      assert.equal(spans.length, 1);
      assert.equal(spans[0].ended, true);
    });

    it("should return a function which has the same argument length as the original function", () => {
      function originalFn(arg1: string, arg2: string, arg3: number) {
        return arg1 + arg2 + arg3;
      }

      assert.equal(originalFn.length, 3);
      const tracedFn = withTracing(originalFn);
      assert.equal(tracedFn.length, originalFn.length);
    });

    it("should allow the traced function to maintain the same 'this' binding as the original function via an explicit call to .bind(...)", () => {
      class SomeClass {
        someProperty: string;

        constructor() {
          this.someProperty = "some value";
        }

        originalFn() {
          return this.someProperty;
        }
      }

      const someInstance = new SomeClass();

      assert.equal(someInstance.originalFn(), someInstance.someProperty);
      const tracedFn = withTracing(someInstance.originalFn.bind(someInstance));
      assert.equal(tracedFn(), someInstance.someProperty);
    });

    it("should return a function which has the same name as the original function", () => {
      function originalFn() {
      }

      assert.equal(originalFn.name, "originalFn");
      const tracedFn = withTracing(originalFn);
      assert.equal(tracedFn.name, "originalFn");
    });

    it("should generate a span which is named after the function that is being traced", async () => {
      function originalFn() {
      }

      const tracedFn = withTracing(originalFn);
      tracedFn();

      const spans = await getSpans();
      assert.equal(spans[0].name, "originalFn");
    });

    it("should omit the word 'bound' from the function name when the function being traced has been explicitly bound", async () => {
      function originalFn() {
      }

      const tracedFn = withTracing(originalFn.bind({}));
      tracedFn();

      const spans = await getSpans();
      assert.equal(spans[0].name, "originalFn");
    });

    it("should allow the user to provide a custom name for the span", async () => {
      function originalFn() {
      }

      const tracedFn = withTracing("my-span-name", originalFn);
      tracedFn();

      const spans = await getSpans();
      assert.equal(spans[0].name, "my-span-name");
    });

    it("should allow the user to provide options which affect the properties of the span", async () => {
      function originalFn() {
      }

      const tracedFn = withTracing({kind: SpanKind.PRODUCER}, originalFn);
      tracedFn();

      const spans = await getSpans();
      assert.equal(spans[0].kind, SpanKind.PRODUCER);
    });

    it("should allow the user to provide both a span name as well as options which affect the properties of the span", async () => {
      function originalFn() {
      }

      const tracedFn = withTracing("my-span-name", {kind: SpanKind.PRODUCER}, originalFn);
      tracedFn();

      const spans = await getSpans();
      assert.equal(spans[0].name, "my-span-name");
      assert.equal(spans[0].kind, SpanKind.PRODUCER);
    });

    describe("when the function being traced is anonymous", () => {
      it("should generate a span with the name of the calling function", async () => {
        let tracedFn;

        function callingFunction() {
          tracedFn = withTracing(() => "anonymous arrow function return value");
        }

        callingFunction();
        tracedFn!();

        const spans = await getSpans();
        assert.equal(spans[0].name, "callingFunction");
      });

      it("should give the span the name 'unnamed trace' when the calling function is an anonymous function expression", async () => {
        let tracedFn;

        (function () {
          tracedFn = withTracing(() => "anonymous arrow function return value");
        })();

        tracedFn!();
        const spans = await getSpans();
        assert.equal(spans[0].name, "unnamed trace");
      });
    });
  });

  describe("getActiveSpan()", () => {
    it("should return the active span", async () => {
      let activeSpan: ReturnType<typeof getActiveSpan>;

      trace("some-span-name", () => {
        activeSpan = getActiveSpan();
      });

      assert.ok(activeSpan);
      assert.equal((activeSpan as any).name, "some-span-name");
    });

    it("should return undefined if there is no active span", async () => {
      const activeSpan = getActiveSpan();
      assert.equal(activeSpan, undefined);
    });
  });

  describe("setAttributeOnSpan()", () => {
    it("should do nothing if no span is provided", async () => {
      setAttributeOnSpan(undefined, monitoringAttributes.ATTR_BTRZ_ACCOUNT_ID, "66d8a8e0530153052b3953ef");

      const spans = await getSpans();
      assert.ok(Array.isArray(spans));
      assert.equal(spans.length, 0);
    });

    it("should set the value of the requested attribute on the provided span", async () => {
      trace("some-span-name", () => {
        const span = getActiveSpan();
        setAttributeOnSpan(span, monitoringAttributes.ATTR_BTRZ_ACCOUNT_ID, "66d8a8e0530153052b3953ea");
      });

      const spans = await getSpans();
      assert.ok(Array.isArray(spans));
      assert.equal(spans.length, 1);
      assert.equal(spans[0].attributes[monitoringAttributes.ATTR_BTRZ_ACCOUNT_ID], "66d8a8e0530153052b3953ea");
    });
  });

  describe("setAttributeOnActiveSpan()", () => {
    it("should do nothing if there is no active span", async () => {
      setAttributeOnActiveSpan(monitoringAttributes.ATTR_BTRZ_ACCOUNT_ID, "66d8a8e0530153052b3953e1");

      const spans = await getSpans();
      assert.ok(Array.isArray(spans));
      assert.equal(spans.length, 0);
    });

    it("should set the value of the requested attribute on the active span", async () => {
      trace("some-span-name", () => {
        setAttributeOnActiveSpan(monitoringAttributes.ATTR_BTRZ_ACCOUNT_ID, "66d8a8e0530153052b3953e2");
      });

      const spans = await getSpans();
      assert.ok(Array.isArray(spans));
      assert.equal(spans.length, 1);
      assert.equal(spans[0].attributes[monitoringAttributes.ATTR_BTRZ_ACCOUNT_ID], "66d8a8e0530153052b3953e2");
    });
  });
});
