// Small text helpers shared by every module that writes words a person reads.

// British English lists have no comma before the last "and" or "or", which is the house style
// ("a, b and c"); en-US would add one.
const AND = new Intl.ListFormat("en-GB", { style: "long", type: "conjunction" });
const OR = new Intl.ListFormat("en-GB", { style: "long", type: "disjunction" });

/** "", "a", "a and b", "a, b and c". */
export const andList = (items: readonly string[]): string => AND.format(items);

/** "", "a", "a or b", "a, b or c". */
export const orList = (items: readonly string[]): string => OR.format(items);
