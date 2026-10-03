import { readFileSync, writeFileSync, existsSync } from "node:fs";

// Free-text medication names -> RxNorm codes through NLM RxNav.
// We only accept RxNav's normalized name match (search=2). Its approximate
// search guesses ("blood pressure pill" -> an unrelated product), and a wrong
// code is worse than no code.

export const RXNAV_BASE_URL = "https://rxnav.nlm.nih.gov/REST";

export type RxNavMatch = { rxcui: string; term: string } | null;

/** Strip schedule text such as ", 1 daily" so "lisinopril 10 mg, 1 daily" can still match. */
export function cleanDrugTerm(name: string): string {
  return name
    .split(/[,;(]/)[0]!
    .replace(/\b(\d+\s*(x|times)?\s*(daily|a day|per day))\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export class RxNavCache {
  readonly #entries: Map<string, RxNavMatch>;
  readonly #path: string | undefined;

  constructor(entries: Record<string, RxNavMatch> = {}, path?: string) {
    this.#entries = new Map(Object.entries(entries));
    this.#path = path;
  }

  static load(path: string): RxNavCache {
    const entries = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, RxNavMatch>) : {};
    return new RxNavCache(entries, path);
  }

  /** Cached result only: `undefined` means never looked up, `null` means looked up and not found. */
  get(name: string): RxNavMatch | undefined {
    return this.#entries.get(cleanDrugTerm(name));
  }

  async lookup(name: string, fetchImpl: typeof fetch = fetch): Promise<RxNavMatch> {
    const term = cleanDrugTerm(name);
    const cached = this.#entries.get(term);
    if (cached !== undefined) return cached;
    const url = `${RXNAV_BASE_URL}/rxcui.json?name=${encodeURIComponent(term)}&search=2`;
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`RxNav returned ${response.status} for "${term}"`);
    const body = (await response.json()) as { idGroup?: { rxnormId?: string[] } };
    const rxcui = body.idGroup?.rxnormId?.[0];
    const match: RxNavMatch = rxcui ? { rxcui, term } : null;
    this.#entries.set(term, match);
    return match;
  }

  save(): void {
    if (!this.#path) throw new Error("RxNavCache has no path to save to");
    const sorted = Object.fromEntries([...this.#entries.entries()].sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(this.#path, JSON.stringify(sorted, null, 2) + "\n");
  }
}
