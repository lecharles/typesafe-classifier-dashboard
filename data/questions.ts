import type { Question } from "@/lib/schema";

/** Playground default questions — one of each primitive. */
export const PLAYGROUND_QUESTIONS: Record<string, Question> = {
  topic: {
    type: "choice",
    instructions: "What is the primary topic of the text?",
    criteria: {
      technology: "software, hardware, science, or engineering",
      business: "finance, work, sales, or markets",
      personal: "personal life, relationships, or opinions",
      entertainment: "media, sports, games, or culture",
      other: "none of the above",
    },
  },
  sentiment: {
    type: "score",
    instructions: "Rate the overall sentiment of the text.",
    criteria: ["very negative", "negative", "neutral", "positive", "very positive"],
  },
  is_urgent: {
    type: "noul",
    instructions: "Does the text express urgency or ask for a fast response?",
    criteria: { true: "expresses urgency", false: "no urgency" },
  },
};

/** Email triage questions. */
export const EMAIL_QUESTIONS: Record<string, Question> = {
  category: {
    type: "choice",
    instructions: "Classify the support email into one category.",
    criteria: {
      billing: "payments, invoices, refunds, pricing",
      bug: "something is broken or not working",
      feature_request: "asking for a new capability or improvement",
      complaint: "expressing frustration or dissatisfaction",
      praise: "positive feedback or thanks",
      other: "anything else (general questions, etc.)",
    },
  },
  is_urgent: {
    type: "noul",
    instructions: "Does the sender need a fast / same-day response?",
    criteria: { true: "time-sensitive", false: "can wait" },
  },
  priority: {
    type: "score",
    instructions: "How high should support prioritize this?",
    criteria: ["trivial", "low", "medium", "high", "critical"],
  },
};

/** YouTube video questions. */
export const YOUTUBE_QUESTIONS: Record<string, Question> = {
  category: {
    type: "choice",
    instructions: "Classify the video by its main content category.",
    criteria: {
      tech: "technology, gadgets, programming, AI",
      news: "news, politics, current events",
      entertainment: "comedy, music, movies, celebrities",
      education: "tutorials, science, how-to, explainers",
      gaming: "video games, gameplay, esports",
      lifestyle: "vlogs, travel, food, fitness, fashion",
      business: "finance, entrepreneurship, marketing",
      other: "none of the above",
    },
  },
  clickbait: {
    type: "score",
    instructions: "How clickbaity is the title?",
    criteria: ["not at all", "slightly", "moderately", "very", "extremely"],
  },
  title_sentiment: {
    type: "score",
    instructions: "Rate the emotional tone of the title.",
    criteria: ["very negative", "negative", "neutral", "positive", "very positive"],
  },
  is_promotional: {
    type: "noul",
    instructions: "Is the video primarily promotional or an advertisement?",
    criteria: { true: "promotional", false: "not promotional" },
  },
  is_news: {
    type: "noul",
    instructions: "Is this video reporting news or current events?",
    criteria: { true: "news", false: "not news" },
  },
};
