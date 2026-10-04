import { describe, expect, it } from "vitest";
import { guardSpoken } from "../src/context/guard.ts";

// What the voice may say of the model's words on a call (src/context/guard.ts guardSpoken).
describe("guardSpoken", () => {
  it.each([
    "Thank you for telling me.",
    "I am glad to hear you slept well.",
    "I'm sorry to hear that. When did the swelling start?",
    "Can you tell me when the swelling started?",
    "Could you please tell me more about your symptoms?",
    "Do you remember to take your medicine every morning?",
    "Have you noticed any bruising or bleeding?",
    "How was your breathing last night when you lay down?",
    "That sounds like a rough night.",
    "Would you be comfortable taking a quiet camera measurement?",
    "I'm doing well, thank you for asking.",
  ])("says it as written: %s", (text) => {
    expect(guardSpoken(text)).toBe(text);
  });

  it.each([
    ["dosing", "You could take an extra dose of your water pill."],
    ["dosing", "Try to skip your evening pill."],
    ["a medical instruction", "Elevate your feet and rest."],
    ["a medical instruction", "Continue to monitor your symptoms and document how you feel for your care team."],
    ["a medical instruction", "You should take your pills with food."],
    ["sending her to a clinician", "It would be wise to contact your clinician today."],
    ["sending her to a clinician", "Please call your doctor about this."],
    ["sending her to a clinician, even as a question", "Have you thought about talking to your doctor?"],
    ["reassurance", "That's nothing to worry about."],
    ["reassurance", "Don't worry, that is perfectly normal."],
    ["reassurance", "You'll be fine."],
    ["reassurance", "There is no need to worry."],
    ["reassurance", "Everything sounds fine."],
    ["reassurance", "That is not serious."],
    ["diagnosis", "This sounds like heart failure."],
    ["diagnosis", "It is probably an infection."],
    ["diagnosis", "I can diagnose this for you."],
    ["what a symptom means", "That could be a sign of fluid in your lungs."],
    ["what a symptom means", "That may mean your kidneys are struggling."],
    ["what a symptom means", "That is caused by your medicine."],
    ["911, which only fixed copy says", "If it gets worse, call 911."],
    ["988, which only fixed copy says", "You can call 988 any time."],
    ["a dash", "That is hard \u2014 I am sorry."],
    ["nothing", "   "],
  ])("rejects %s: %s", (_why, text) => {
    expect(guardSpoken(text)).toBeUndefined();
  });
});
