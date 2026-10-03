import { describe, expect, it } from "vitest";
import { CRISIS_PHRASES, screenMessage, tokenize, URGENT_PHRASES, type SafetyKind } from "../src/safety/screen.ts";

const kindOf = (text: string) => screenMessage(text)?.kind;

describe("phrase lists", () => {
  it("cover every phrase the team listed, with its kind", () => {
    for (const phrase of [
      "kill myself",
      "end my life",
      "want to die",
      "don't want to be here anymore",
      "don't want to live",
      "better off without me",
      "no reason to live",
      "suicide",
      "suicidal",
    ]) {
      expect(kindOf(phrase)).toBe("crisis");
    }
    for (const phrase of [
      "chest pain",
      "chest hurts",
      "chest is tight",
      "can't breathe",
      "cannot breathe",
      "can't catch my breath",
      "fell down",
      "I fell",
      "had a fall",
      "fainted",
      "passed out",
      "blacked out",
      "won't stop bleeding",
      "bleeding a lot",
      "coughing up blood",
      "face drooping",
      "slurred speech",
      "can't move my arm",
      "worst headache",
    ]) {
      expect(kindOf(phrase)).toBe("urgent_symptom");
    }
  });

  it("have no repeats and no overlap between crisis and urgent", () => {
    expect(new Set(CRISIS_PHRASES).size).toBe(CRISIS_PHRASES.length);
    expect(new Set(URGENT_PHRASES).size).toBe(URGENT_PHRASES.length);
    expect(CRISIS_PHRASES.filter((p) => URGENT_PHRASES.includes(p))).toEqual([]);
    // No phrase is another one in disguise once normalized ("cannot breathe" is "can't breathe").
    const forms = [...CRISIS_PHRASES, ...URGENT_PHRASES].map((p) => tokenize(p).map((t) => t.word).join(" "));
    expect(new Set(forms).size).toBe(forms.length);
  });
});

describe("every listed phrase hits with its kind", () => {
  const all: [string, SafetyKind][] = [
    ...CRISIS_PHRASES.map((p): [string, SafetyKind] => [p, "crisis"]),
    ...URGENT_PHRASES.map((p): [string, SafetyKind] => [p, "urgent_symptom"]),
  ];

  it.each(all)("%s, inside a sentence", (phrase, kind) => {
    expect(screenMessage(`Oh dear, ${phrase} this morning!`)).toEqual({ kind, matched: phrase });
  });

  it.each(all)("%s, shouting with no punctuation", (phrase, kind) => {
    expect(screenMessage(phrase.toUpperCase())).toEqual({ kind, matched: phrase });
  });
});

describe("realistic messages that hit", () => {
  it.each<[string, SafetyKind, string]>([
    ["I just want to die", "crisis", "want to die"],
    ["Sometimes I think everyone would be better off without me.", "crisis", "better off without me"],
    ["I don't want to live anymore", "crisis", "don't want to live"],
    ["I do not want to be here anymore", "crisis", "don't want to be here anymore"],
    ["I've been having suicidal thoughts", "crisis", "suicidal"],
    ["I keep thinking about suicide", "crisis", "suicide"],
    ["I want to end my life", "crisis", "end my life"],
    ["I'm going to kill myself", "crisis", "kill myself"],
    ["Honestly there's no reason to live since Bob died", "crisis", "no reason to live"],
    ["I feel like hurting myself... I want to hurt myself", "crisis", "want to hurt myself"],
    ["My chest hurts and my left arm feels heavy", "urgent_symptom", "chest hurts"],
    ["I have chest pains again", "urgent_symptom", "chest pain"],
    ["I fell in the bathroom and can't get up", "urgent_symptom", "I fell"],
    ["Fell down the stairs this morning, I'm ok I think", "urgent_symptom", "fell down"],
    ["I had a fall yesterday", "urgent_symptom", "had a fall"],
    ["I fainted at church", "urgent_symptom", "fainted"],
    ["I passed out in the kitchen", "urgent_symptom", "passed out"],
    ["My nose won't stop bleeding", "urgent_symptom", "won't stop bleeding"],
    ["I'm coughing up blood", "urgent_symptom", "coughing up blood"],
    ["It's the worst headache of my life", "urgent_symptom", "worst headache"],
    ["No, I can't breathe", "urgent_symptom", "can't breathe"],
    ["no i cant breathe", "urgent_symptom", "can't breathe"],
    ["I... can't... breathe", "urgent_symptom", "can't breathe"],
    ["No fever but chest pain", "urgent_symptom", "chest pain"],
    ["No I fell this morning", "urgent_symptom", "I fell"],
    ["whats the point of living", "crisis", "point of living"],
    ["not great. honestly I don't see the point in going on", "crisis", "point in going on"],
    ["I've been thinking about ending it all", "crisis", "ending it all"],
    ["I'm going to take all my pills at once", "crisis", "all my pills at once"],
    ["I wish I could go to sleep and not wake up", "crisis", "not wake up"],
    ["I KEEP THINKING ABOUT KILLING MYSELF", "crisis", "killing myself"],
    ["took a tumble on the porch steps", "urgent_symptom", "took a tumble"],
    ["my face feels droopy on one side", "urgent_symptom", "face feels droopy"],
    ["I didn't fall but I fainted", "urgent_symptom", "fainted"],
  ])("%s", (text, kind, matched) => {
    expect(screenMessage(text)).toEqual({ kind, matched });
  });
});

describe("typos and spelled-out forms", () => {
  it.each<[string, SafetyKind, string]>([
    ["i dont want to live", "crisis", "don't want to live"],
    ["I don’t want to live", "crisis", "don't want to live"],
    ["i do not want to live", "crisis", "don't want to live"],
    ["i wanna die", "crisis", "want to die"],
    ["im suicidal", "crisis", "suicidal"],
    ["thinking about sucide", "crisis", "suicide"],
    ["i want to kill my self", "crisis", "kill myself"],
    ["dont want to be here any more", "crisis", "don't want to be here anymore"],
    ["i want to self-harm", "crisis", "self harm"],
    ["i cant breathe", "urgent_symptom", "can't breathe"],
    ["I can’t breathe", "urgent_symptom", "can't breathe"],
    ["i can not breathe", "urgent_symptom", "can't breathe"],
    ["cant breath", "urgent_symptom", "can't breathe"],
    ["I cannot catch my breath", "urgent_symptom", "can't catch my breath"],
    ["chest   is    tight!!!", "urgent_symptom", "chest is tight"],
    ["my cut will not stop bleeding", "urgent_symptom", "won't stop bleeding"],
    ["it wont stop bleeding", "urgent_symptom", "won't stop bleeding"],
    ["bleeding alot", "urgent_symptom", "bleeding a lot"],
    ["I feinted", "urgent_symptom", "fainted"],
    ["I keep passing out", "urgent_symptom", "passed out"],
    ["I have fallen and I can't get up", "urgent_symptom", "I've fallen"],
    ["worst hedache ever", "urgent_symptom", "worst headache"],
    ["i want to kil myself", "crisis", "kill myself"],
    ["my chesst hurts real bad", "urgent_symptom", "chest hurts"],
  ])("%s", (text, kind, matched) => {
    expect(screenMessage(text)).toEqual({ kind, matched });
  });
});

describe("negations don't hit", () => {
  it.each([
    "no chest pain today",
    "No chest pain, just tired",
    "I haven't had any chest pain",
    "I have not had any chest pain",
    "never had chest pain",
    "my chest is fine, not chest pain at all",
    "I didn't fall",
    "I did not fall down, I sat down",
    "I haven't had a fall",
    "Never fainted in my life",
    "I'm not suicidal, just sad",
    "I’m not suicidal",
    "I don't want to die, I want to see my grandkids grow up",
    "no need to call 911",
    "not bleeding a lot, just a scratch",
    "breathing is fine, no trouble at all",
    "didn't pass out or anything, just a little lightheaded getting up",
    "I haven't fallen since the spring, knock on wood",
  ])("%s", (text) => {
    expect(screenMessage(text)).toBeUndefined();
  });
});

describe("idioms and everyday words don't hit", () => {
  it.each([
    "I'm dying to see the grandkids",
    "I could kill for a coffee",
    "My phone died again",
    "I fell asleep in my chair",
    "I fell behind on my crossword",
    "I fell for one of those scam calls",
    "I fell in love with that show",
    "The leaves fell down all over the yard",
    "My glasses fell down behind the couch",
    "I passed out the cookies at church",
    "The TV blacked out during the game",
    "We had a fall festival at the center",
    "I nearly killed myself laughing at that show",
    "I hurt myself gardening, just a scrape",
    "I nearly fainted when I saw the price of eggs",
    "I want to take my life savings and go on a cruise",
    "Bob died three years ago",
    "My breathing is fine today",
    "the bleeding stopped",
    "Did the Tigers win last night?",
    "this crossword is killing me",
    "I'm killing myself trying to finish this quilt",
    "I take all my pills every morning with breakfast",
    "I'd rather not wake up early tomorrow",
    "Sarah would not wake up for her alarm",
    "the whole point of living in Florida is the weather",
    "I fell last year and broke my wrist, that's why I use the cane",
  ])("%s", (text) => {
    expect(screenMessage(text)).toBeUndefined();
  });
});

describe("priority and empty input", () => {
  it.each([
    ["I can't breathe and I want to die", "want to die"],
    ["My chest hurts. I don't want to live anymore", "don't want to live"],
    ["I fell, I think I'm suicidal", "suicidal"],
  ])("crisis beats urgent: %s", (text, matched) => {
    expect(screenMessage(text)).toEqual({ kind: "crisis", matched });
  });

  it.each(["", "   ", "\n\t", "\u{1F600}\u{1F44D}", "❤️❤️", "...", "?!"])("is undefined for %j", (text) => {
    expect(screenMessage(text)).toBeUndefined();
  });

  it("is undefined for an ordinary message", () => {
    expect(kindOf("My granddaughter is visiting on Sunday, I'm baking")).toBeUndefined();
    expect(kindOf("Should I stop taking my aspirin?")).toBeUndefined();
  });
});

describe("phrases added after the first content eval", () => {
  it.each<[string, SafetyKind]>([
    ["it feels like an elephant sitting on my chest", "urgent_symptom"],
    ["there's a weight on my chest this morning", "urgent_symptom"],
    ["my chest feels heavy", "urgent_symptom"],
    ["bad chess pain since breakfast", "urgent_symptom"],
    ["I'm short of breath right now", "urgent_symptom"],
    ["im so short of breath", "urgent_symptom"],
    ["cut my hand and there's blood everywhere", "urgent_symptom"],
    ["me duele el pecho", "urgent_symptom"],
    ["no puedo respirar bien", "urgent_symptom"],
    ["me caí en el baño", "urgent_symptom"],
    ["nobody would notice if I was gone", "crisis"],
    ["honestly no one would miss me", "crisis"],
    ["ya no quiero vivir", "crisis"],
    ["a veces quiero morir", "crisis"],
  ])("%s", (text, kind) => {
    expect(screenMessage(text)?.kind).toBe(kind);
  });

  it.each([
    "I was short of breath years ago but I'm fine now",
    "the chess club meets on Tuesday",
    "my granddaughter will notice if the cookies are gone",
  ])("still doesn't hit: %s", (text) => {
    expect(screenMessage(text)).toBeUndefined();
  });
});
