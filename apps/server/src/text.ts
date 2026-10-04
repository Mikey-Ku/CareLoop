// Small text helpers shared by every module that writes words a person reads.

// British English lists have no comma before the last "and" or "or", which is the house style
// ("a, b and c"); en-US would add one.
const AND = new Intl.ListFormat("en-GB", { style: "long", type: "conjunction" });
const OR = new Intl.ListFormat("en-GB", { style: "long", type: "disjunction" });

/** "", "a", "a and b", "a, b and c". */
export const andList = (items: readonly string[]): string => AND.format(items);

/** "", "a", "a or b", "a, b or c". */
export const orList = (items: readonly string[]): string => OR.format(items);

/** Long dashes softened: each en or em dash (U+2013, U+2014), with the spaces around it, becomes ", ". */
export function softenDashes(text: string): string {
  return text.replace(/\s*[\u2013\u2014]\s*/g, ", ");
}
