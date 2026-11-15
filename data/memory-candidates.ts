/**
 * UC#6 memory curator LIVE demo corpus — synthetic request/answer pairs a
 * conversation agent might consider writing to long-term memory. Every
 * exchange is invented on purpose: durable preferences, evergreen
 * knowledge, one-off noise, volatile facts, and pairs carrying private
 * data the PII floor must catch whatever the reuse ladder says.
 */

export type MemoryCandidate = {
  id: string;
  request: string;
  answer?: string;
};

export const memoryCandidates: MemoryCandidate[] = [
  {
    id: "m01",
    request: "From now on, always use pnpm instead of npm in this repo.",
    answer: "Understood — pnpm for installs and scripts from here on.",
  },
  {
    id: "m02",
    request: "I'm a night shift nurse; when I ask about scheduling, assume UTC.",
    answer: "Got it — UTC is your reference timezone for schedule questions.",
  },
  {
    id: "m03",
    request: "What's 17 times 23?",
    answer: "391.",
  },
  {
    id: "m04",
    request: "My card number is 4111 1111 1111 1111 — save my billing details.",
    answer: "I can't store card numbers; please use the secure billing page.",
  },
  {
    id: "m05",
    request: "What's the price of BTC right now?",
    answer: "Bitcoin is trading around $112,400 at the moment.",
  },
  {
    id: "m06",
    request: "Remember that our team's deploy freeze starts every Friday at 15:00.",
    answer: "Noted — Friday 15:00 deploy freeze for the team.",
  },
  {
    id: "m07",
    request: "Which version of Node is latest?",
    answer: "Node 25 is the current latest release line.",
  },
  {
    id: "m08",
    request: "I live at 42 Maple Street, Apt 3B, Portland — always ship my reorder there.",
    answer: "I won't persist your home address; use your saved addresses instead.",
  },
  {
    id: "m09",
    request: "Summarize this meeting notes file for me.",
    answer: "The notes cover three agenda items and two action owners.",
  },
  {
    id: "m10",
    request: "When I say 'the dashboard', I always mean the classifier dashboard on port 8094.",
    answer: "Understood — 'the dashboard' resolves to the classifier dashboard on :8094.",
  },
  {
    id: "m11",
    request: "How many employees does Apple have?",
    answer: "Around 164,000 as of the most recent annual report.",
  },
  {
    id: "m12",
    request: "My diabetes medication changed to metformin 500mg — keep it in mind for diet questions.",
    answer: "I won't save medication details to memory; your doctor and secure health tools can.",
  },
  {
    id: "m13",
    request: "Is the conference room still booked for 3pm?",
    answer: "Yes, Room B is still reserved until 15:00 today.",
  },
  {
    id: "m14",
    request: "I prefer terse answers with code first and prose after — applies to all sessions.",
    answer: "Acknowledged — code-first, terse explanations from now on.",
  },
];
