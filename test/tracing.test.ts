import _ from "lodash";
import {expect} from "chai";
import {__enableTestMode, initializeTracing, trace, withTracing} from "../src/tracing";
import {InMemorySpanExporter, SimpleSpanProcessor} from "@opentelemetry/sdk-trace-base";
import {ATTR_ARTIFACT_VERSION, ATTR_CODE_FUNCTION_NAME} from "@opentelemetry/semantic-conventions/incubating";
import {Link, SpanKind, SpanStatusCode, TraceFlags} from "@opentelemetry/api";

describe("Tracing instrumentation", () => {
  let spanExporter: InMemorySpanExporter;
  let spanProcessor: SimpleSpanProcessor;

  before(() => {
    const testDependencies = __enableTestMode();
    spanExporter = testDependencies.spanExporter;
    spanProcessor = testDependencies.spanProcessor;

    initializeTracing({
      serviceName: "btrz-monitoring-tests",
      traceDestinationUrl: "http://localhost:4317"
    });
  });

  afterEach(() => {
    spanExporter.reset();
  });

  async function getSpans() {
    await spanProcessor.forceFlush();
    return spanExporter.getFinishedSpans();
  }

  describe("trace()", () => {
    context("when tracing a synchronous non-arrow function", () => {
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
        expect(spans).to.have.length(1);
        expect(spans[0].ended).to.be.true;
      });

      it("should generate a span which is named after the function that is being traced", async () => {
        trace(syncFn);
        const spans = await getSpans();
        expect(spans[0].name).to.equal("syncFn");
      });

      it("should allow the user to provide a custom name for the span", async () => {
        trace("my-span-name", syncFn);
        const spans = await getSpans();
        expect(spans[0].name).to.equal("my-span-name");
      });

      it("should allow the user to provide options which affect the properties of the span", async () => {
        trace({kind: SpanKind.PRODUCER}, syncFn);
        const spans = await getSpans();
        expect(spans[0].kind).to.equal(SpanKind.PRODUCER);
      });

      it("should allow the user to provide both a span name as well as options which affect the properties of the span", async () => {
        trace("my-span-name", {kind: SpanKind.PRODUCER}, syncFn);
        const spans = await getSpans();
        expect(spans[0].name).to.equal("my-span-name");
        expect(spans[0].kind).to.equal(SpanKind.PRODUCER);
      });

      it("should add an attribute to the span with the name of the function", async () => {
        trace(syncFn);
        const spans = await getSpans();
        expect(spans[0]).to.deep.contain({
          attributes: {
            [ATTR_CODE_FUNCTION_NAME]: "syncFn"
          }
        });
      });

      it("should generate a span with a status code that indicates that the function returned successfully", async () => {
        trace(syncFn);
        const spans = await getSpans();
        expect(spans[0]).to.deep.contain({
          status: {
            code: SpanStatusCode.OK
          }
        });
      });

      it("should return the same return value as the function being traced", async () => {
        const result = trace(syncFn);
        expect(result).to.equal("syncFn return value");
      });

      context("when the function throws an error", () => {
        const thrownError = new Error("Error from syncFnWhichThrows");

        function syncFnWhichThrows() {
          throw thrownError;
        }

        it("should generate a single span which has ended", async () => {
          try {
            trace(syncFnWhichThrows);
          } catch { }

          const spans = await getSpans();
          expect(spans).to.have.length(1);
          expect(spans[0].ended).to.be.true;
        });

        it("should generate a span with an 'error' status code, and the message contained in the original error", async () => {
          try {
            trace(syncFnWhichThrows);
          } catch { }

          const spans = await getSpans();
          expect(spans[0]).to.deep.contain({
            status: {
              code: SpanStatusCode.ERROR,
              message: "Error from syncFnWhichThrows"
            }
          });
        });

        it("should throw the error originally thrown by the function being traced", async () => {
          try {
            trace(syncFnWhichThrows);
            expect.fail("Expected an error to be thrown");
          } catch (error){
            expect(error).to.equal(thrownError);
          }
        });
      });
    });

    context("when tracing a synchronous arrow function", () => {
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
        expect(spans[0].name).to.equal("syncArrowFn");
      });

      it("should add an attribute to the span with the name of the function", async () => {
        trace(syncArrowFn);
        const spans = await getSpans();
        expect(spans[0]).to.deep.contain({
          attributes: {
            [ATTR_CODE_FUNCTION_NAME]: "syncArrowFn"
          }
        });
      });

      context("when the function being traced is anonymous", () => {
        it("should generate a span with the name of the calling function", async () => {
          function callingFunction() {
            trace(() => "anonymous arrow function return value");
          }

          callingFunction();
          const spans = await getSpans();
          expect(spans[0].name).to.equal("callingFunction");
        });

        it("should add an attribute to the span with the name of the calling function", async () => {
          function callingFunction() {
            trace(() => "anonymous arrow function return value");
          }

          callingFunction();
          const spans = await getSpans();
          expect(spans[0].attributes[ATTR_CODE_FUNCTION_NAME]).to.equal("callingFunction");
        });

        it("should generate a span with the name of the calling function when the calling function is an arrow function that has been assigned to a variable", async () => {
          const callingFunction = () => {
            trace(() => "anonymous arrow function return value");
          }

          callingFunction();
          const spans = await getSpans();
          expect(spans[0].name).to.equal("callingFunction");
        });

        it("should add an attribute to the span with the name of the calling function when the calling function is an arrow function that has been assigned to a variable", async () => {
          const callingFunction = () => {
            trace(() => "anonymous arrow function return value");
          }

          callingFunction();
          const spans = await getSpans();
          expect(spans[0].attributes[ATTR_CODE_FUNCTION_NAME]).to.equal("callingFunction");
        });

        it("should not add an attribute to the span with the name of the function when called within an anonymous function expression", async () => {
          (function () {
            trace(() => "anonymous arrow function return value");
          })();

          const spans = await getSpans();
          expect(spans[0].attributes[ATTR_CODE_FUNCTION_NAME]).to.be.undefined;
        });

        it("should give the span the name 'unnamed trace' when called within an anonymous function expression", async () => {
          (function () {
            trace(() => "anonymous arrow function return value");
          })();

          const spans = await getSpans();
          expect(spans[0].name).to.be.equal("unnamed trace");
        });

        it("should not add an attribute to the span with the name of the function when called within an anonymous arrow function expression", async () => {
          (() => {
            trace(() => "anonymous arrow function return value");
          })();

          const spans = await getSpans();
          expect(spans[0].attributes[ATTR_CODE_FUNCTION_NAME]).to.be.undefined;
        });

        it("should give the span the name 'unnamed trace' when called within an anonymous arrow function expression", async () => {
          (() => {
            trace(() => "anonymous arrow function return value");
          })();

          const spans = await getSpans();
          expect(spans[0].name).to.be.equal("unnamed trace");
        });
      });
    });

    context("when tracing a function which returns a promise-like object", () => {
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
        expect(spans).to.have.length(1);
        expect(spans[0].ended).to.be.true;
      });

      context("when the function rejects", () => {
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
          expect(spans).to.have.length(1);
          expect(spans[0].ended).to.be.true;
        });

        it("should generate a span with an 'error' status code, and the message contained in the original error", async () => {
          try {
            await trace(fnReturningPromiseLikeWithRejection);
          } catch { }

          const spans = await getSpans();
          expect(spans[0]).to.deep.contain({
            status: {
              code: SpanStatusCode.ERROR,
              message: "Error from fnReturningPromiseLikeWithRejection"
            }
          });
        });

        it("should reject with the error originally thrown by the function being traced", async () => {
          try {
            await trace(fnReturningPromiseLikeWithRejection);
            expect.fail("Expected an error to be thrown");
          } catch (error){
            expect(error).to.equal(thrownError);
          }
        });
      });
    });

    context("when tracing an asynchronous non-arrow function", () => {
      async function asyncFn() {
        const randomDelay = Math.random() * 5;
        await new Promise((resolve) => setTimeout(resolve, randomDelay));
        return "asyncFn return value";
      }

      it("should generate a single span which has ended", async () => {
        await trace(asyncFn);
        const spans = await getSpans();
        expect(spans).to.have.length(1);
        expect(spans[0].ended).to.be.true;
      });

      it("should generate a span with a status code that indicates that the function resolved successfully", async () => {
        await trace(asyncFn);
        const spans = await getSpans();
        expect(spans[0]).to.deep.contain({
          status: {
            code: SpanStatusCode.OK
          }
        });
      });

      it("should resolve with the same value as the function being traced", async () => {
        const result = await trace(asyncFn);
        expect(result).to.equal("asyncFn return value");
      });

      context("when the function rejects", () => {
        const thrownError = new Error("Error from asyncFnWhichThrows");

        async function asyncFnWhichThrows() {
          throw thrownError;
        }

        it("should generate a single span which has ended", async () => {
          try {
            await trace(asyncFnWhichThrows);
          } catch { }

          const spans = await getSpans();
          expect(spans).to.have.length(1);
          expect(spans[0].ended).to.be.true;
        });

        it("should generate a span with an 'error' status code, and the message contained in the original error", async () => {
          try {
            await trace(asyncFnWhichThrows);
          } catch { }

          const spans = await getSpans();
          expect(spans[0]).to.deep.contain({
            status: {
              code: SpanStatusCode.ERROR,
              message: "Error from asyncFnWhichThrows"
            }
          });
        });

        it("should reject with the error originally thrown by the function being traced", async () => {
          try {
            await trace(asyncFnWhichThrows);
            expect.fail("Expected an error to be thrown");
          } catch (error){
            expect(error).to.equal(thrownError);
          }
        });
      });
    });

    context("when multiple nested calls to trace() are made", () => {
      it("should correctly nest spans", async () => {
        trace("first trace", () => {
          trace("second trace", () => {});
          trace("third trace", () => {});
        });

        const spans = await getSpans();
        expect(spans).to.have.length(3);

        const firstSpan = spans.find(span => span.name === "first trace")!;
        const secondSpan = spans.find(span => span.name === "second trace")!;
        const thirdSpan = spans.find(span => span.name === "third trace")!;
        expect(firstSpan.parentSpanContext).to.be.undefined;
        expect(secondSpan.parentSpanContext?.spanId).to.equal(firstSpan.spanContext().spanId);
        expect(thirdSpan.parentSpanContext?.spanId).to.equal(firstSpan.spanContext().spanId);
      });
    });

    context("when the 'inheritAttributesFromParentTrace' flag is used", () => {
      it("should copy attributes from the parent span to the child span", async () => {
        const parentSpanAttributes = {
          [ATTR_ARTIFACT_VERSION]: "1.0"
        };

        trace("first trace", {attributes: parentSpanAttributes}, () => {
          trace("second trace", {inheritAttributesFromParentTrace: true}, () => {});
        });

        const spans = await getSpans();
        const secondSpan = spans.find(span => span.name === "second trace")!;
        expect(secondSpan.attributes).to.deep.contain(parentSpanAttributes);
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
        expect(secondSpan.links).to.deep.equal(parentSpanLinks);
      });

      it("should copy the 'kind' property from the parent span to the child span", async () => {
        const parentSpanKind = SpanKind.CONSUMER;

        trace("first trace", {kind: parentSpanKind}, () => {
          trace("second trace", {inheritAttributesFromParentTrace: true}, () => {});
        });

        const spans = await getSpans();
        const secondSpan = spans.find(span => span.name === "second trace")!;
        expect(secondSpan.kind).to.equal(parentSpanKind);
      });

      it("should not copy any attributes or links when the span has no parent", async () => {
        trace("only trace", {inheritAttributesFromParentTrace: true}, () => {});

        const spans = await getSpans();
        expect(spans).to.have.length(1);
        expect(_.omit(spans[0].attributes, ATTR_CODE_FUNCTION_NAME)).to.eql({});
        expect(spans[0].links).to.eql([]);
        expect(spans[0].kind).to.eql(SpanKind.INTERNAL);
      });

      it("should set the 'kind' property to 'INTERNAL' when the span has no parent", async () => {
        trace("only trace", {inheritAttributesFromParentTrace: true}, () => {});

        const spans = await getSpans();
        expect(spans).to.have.length(1);
        expect(spans[0].kind).to.eql(SpanKind.INTERNAL);
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

      expect(originalFnWasCalled).to.be.false;
      tracedFn();
      expect(originalFnWasCalled).to.be.true;

      const spans = await getSpans();
      expect(spans).to.have.length(1);
      expect(spans[0].ended).to.be.true;
    });

    it("should return a function which has the same argument length as the original function", () => {
      function originalFn(arg1: string, arg2: string, arg3: number) {
        return arg1 + arg2 + arg3;
      }

      expect(originalFn.length).to.equal(3);
      const tracedFn = withTracing(originalFn);
      expect(tracedFn.length).to.equal(originalFn.length);
    });

    it("should return a function which has the same name as the original function", () => {
      function originalFn() {
      }

      expect(originalFn.name).to.equal("originalFn");
      const tracedFn = withTracing(originalFn);
      expect(tracedFn.name).to.equal("originalFn");
    });

    it("should generate a span which is named after the function that is being traced", async () => {
      function originalFn() {
      }

      const tracedFn = withTracing(originalFn);
      tracedFn();

      const spans = await getSpans();
      expect(spans[0].name).to.equal("originalFn");
    });

    it("should allow the user to provide a custom name for the span", async () => {
      function originalFn() {
      }

      const tracedFn = withTracing("my-span-name", originalFn);
      tracedFn();

      const spans = await getSpans();
      expect(spans[0].name).to.equal("my-span-name");
    });

    it("should allow the user to provide options which affect the properties of the span", async () => {
      function originalFn() {
      }

      const tracedFn = withTracing({kind: SpanKind.PRODUCER}, originalFn);
      tracedFn();

      const spans = await getSpans();
      expect(spans[0].kind).to.equal(SpanKind.PRODUCER);
    });

    it("should allow the user to provide both a span name as well as options which affect the properties of the span", async () => {
      function originalFn() {
      }

      const tracedFn = withTracing("my-span-name", {kind: SpanKind.PRODUCER}, originalFn);
      tracedFn();

      const spans = await getSpans();
      expect(spans[0].name).to.equal("my-span-name");
      expect(spans[0].kind).to.equal(SpanKind.PRODUCER);
    });

    context("when the function being traced is anonymous", () => {
      it("should generate a span with the name of the calling function", async () => {
        let tracedFn;

        function callingFunction() {
          tracedFn = withTracing(() => "anonymous arrow function return value");
        }

        callingFunction();
        tracedFn!();

        const spans = await getSpans();
        expect(spans[0].name).to.equal("callingFunction");
      });

      it("should give the span the name 'unnamed trace' when the calling function is an anonymous function expression", async () => {
        let tracedFn;

        (function () {
          tracedFn = withTracing(() => "anonymous arrow function return value");
        })();

        tracedFn!();
        const spans = await getSpans();
        expect(spans[0].name).to.be.equal("unnamed trace");
      });
    });
  });
});
