// How a place's machine is named in the tasks view. One rule earns a test: a folder whose
// server we cannot name must never be called "This Mac" — choosing it would then look like
// running on the Mac while the work goes to a server.

import { describe, expect, it } from "vitest";
import type { Machine } from "../../store/conversationsStore";
import { placeMachine } from "./PlaceMark";

const base: Machine = {
  id: "m-base",
  label: "Base",
  host: "base.tail",
  port: 22,
  user: "alex",
  identityFile: null,
  addedAt: 0,
  addresses: [],
};

describe("placeMachine", () => {
  it("calls a local folder This Mac", () => {
    expect(placeMachine(null, [base])).toEqual({ kind: "local", name: "This Mac", target: null });
  });

  it("names a paired server, with its ssh target", () => {
    expect(placeMachine("m-base", [base])).toEqual({
      kind: "remote",
      name: "Base",
      target: "alex@base.tail:22",
    });
  });

  it("never folds an unpaired server back into This Mac", () => {
    expect(placeMachine("m-gone", [base])).toEqual({
      kind: "unknown",
      name: "Unknown server",
      target: null,
    });
  });
});
