import assert from "node:assert/strict";
import test from "node:test";

import { reduceWithShadow, reducer } from "../reducer.ts";
import { makeInitialState } from "../markets.ts";

const FIXED_NOW = 1735660800000;

test("reduceWithShadow preserves live reducer output for tick", () => {
  const state = makeInitialState(FIXED_NOW);
  const action = { type: "TICK" as const, now: FIXED_NOW + 750 };

  const live = reducer(state, action);
  const traced = reduceWithShadow(state, action);

  assert.deepEqual(traced.nextState, live);
  assert.ok(traced.shadowTrace);
  assert.equal(traced.shadowTrace?.kind, "tick");
  assert.equal(traced.shadowTrace?.markets.length, state.marketOrder.length);
});

test("reduceWithShadow emits ordered book-operation trace", () => {
  const state = makeInitialState(FIXED_NOW);
  const traced = reduceWithShadow(state, { type: "TICK", now: FIXED_NOW + 750 });
  const firstMarketTrace = traced.shadowTrace?.markets[0];

  assert.ok(firstMarketTrace);
  assert.ok(firstMarketTrace!.phaseVisits.length >= firstMarketTrace!.steps.length);
  assert.ok(firstMarketTrace!.steps.length > 0);
  assert.equal(firstMarketTrace!.steps[0].label, "sync_desk");
  assert.equal(firstMarketTrace!.steps[0].stepIndex, 0);
  assert.equal(firstMarketTrace!.steps[0].phaseIndex, 1);
  assert.equal(firstMarketTrace!.phaseVisits[0].label, "age_cancel");
  assert.equal(firstMarketTrace!.phaseVisits[0].phaseIndex, 0);
  assert.equal(firstMarketTrace!.phaseVisits[1].label, "sync_desk");
  assert.equal(firstMarketTrace!.phaseVisits[1].stepIndex, 0);
  assert.ok(
    firstMarketTrace!.phaseVisits.every((visit, index) => visit.phaseIndex === index),
  );
  assert.ok(
    firstMarketTrace!.steps.every((step, index) => step.stepIndex === index),
  );
  assert.ok(
    firstMarketTrace!.steps.every((step) =>
      step.commands.every((command) =>
        command.kind === "cancel" ||
        command.kind === "submit_limit" ||
        command.kind === "submit_market",
      ),
    ),
  );
  assert.ok(
    firstMarketTrace!.phaseVisits.every((visit) => !visit.bookChanged || visit.traceEmitted),
  );
});
