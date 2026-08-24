import { describe, expect, it } from "vitest";

import { applyResourceOrder, moveResource, nudgeResource } from "./resourceOrder";

const id = (value: { id: string }) => value.id;
const items = (...ids: string[]) => ids.map((value) => ({ id: value }));

describe("applyResourceOrder", () => {
  it("returns the source order when nothing has been arranged", () => {
    expect(applyResourceOrder(items("a", "b", "c"), id, undefined).map(id)).toEqual(["a", "b", "c"]);
    expect(applyResourceOrder(items("a", "b", "c"), id, []).map(id)).toEqual(["a", "b", "c"]);
  });

  it("applies a saved arrangement", () => {
    expect(applyResourceOrder(items("a", "b", "c"), id, ["c", "a", "b"]).map(id))
      .toEqual(["c", "a", "b"]);
  });

  it("puts anything the arrangement has never seen at the end, in source order", () => {
    // `new` is a thread created since the operator last touched this list.
    expect(applyResourceOrder(items("a", "new", "b"), id, ["b", "a"]).map(id))
      .toEqual(["b", "a", "new"]);
  });

  it("keeps several unseen items in their source order rather than shuffling them", () => {
    expect(applyResourceOrder(items("x", "a", "y"), id, ["a"]).map(id)).toEqual(["a", "x", "y"]);
  });

  it("ignores a saved id that no longer exists instead of leaving a gap", () => {
    expect(applyResourceOrder(items("a", "b"), id, ["deleted", "b", "a"]).map(id))
      .toEqual(["b", "a"]);
  });

  it("is always a permutation: nothing is invented and nothing is lost", () => {
    const source = items("a", "b", "c");
    const result = applyResourceOrder(source, id, ["c", "ghost"]);
    expect(result).toHaveLength(3);
    expect([...result].map(id).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("moveResource", () => {
  it("drops below the target when dragging downward", () => {
    expect(moveResource(["a", "b", "c", "d"], "a", "c")).toEqual(["b", "c", "a", "d"]);
  });

  it("drops above the target when dragging upward", () => {
    expect(moveResource(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"]);
  });

  it("leaves the list alone for a no-op or an unknown id", () => {
    expect(moveResource(["a", "b"], "a", "a")).toEqual(["a", "b"]);
    expect(moveResource(["a", "b"], "ghost", "a")).toEqual(["a", "b"]);
    expect(moveResource(["a", "b"], "a", "ghost")).toEqual(["a", "b"]);
  });
});

describe("nudgeResource", () => {
  it("moves one step in each direction", () => {
    expect(nudgeResource(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(nudgeResource(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  });

  it("stops at the ends rather than wrapping around", () => {
    expect(nudgeResource(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(nudgeResource(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
  });

  it("ignores a row that is not in the list", () => {
    expect(nudgeResource(["a", "b"], "ghost", 1)).toEqual(["a", "b"]);
  });
});
