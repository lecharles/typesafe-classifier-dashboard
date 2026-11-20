/**
 * UC#9 Twitch-style chat filter — synthetic live-chat corpus.
 *
 * A fictional esports grand-final stream (the "Clutch Circuit Finals") with
 * a scroll of chat messages: real viewer hype, gentle teasing, crude-but-
 * harmless gripes, personal attacks, follow-for-follow bots, giveaway-scam
 * link droppers, and spoilers for outcomes the stream has not shown yet.
 * Every user, handle, and message is invented on purpose — no real channel,
 * no real slur, no real link. The filter's job is exactly the mod's job:
 * allow / hold / block decided IN CODE from typed classifier answers.
 */

export type ChatMessage = {
  /** stable synthetic id, c01… */
  id: string;
  /** the handle that typed it — mods act on USERS, so it rides the state */
  user: string;
  /** the message body as it appears in chat */
  message: string;
};

export const chatMessages: ChatMessage[] = [
  { id: "c01", user: "pokedash", message: "gg that clutch was INSANE, what a read" },
  { id: "c02", user: "mossyfern", message: "first time here, love the vibes, subbed" },
  { id: "c03", user: "kappa_kris", message: "Kappa Kappa Kappa" },
  { id: "c04", user: "tiltproof", message: "streamer tilted again lol so funny" },
  { id: "c05", user: "botladder_9", message: "GET 1000 FREE FOLLOWERS ➜ visit follow-4real.example and enter your login NOW" },
  { id: "c06", user: "quietromi", message: "should've pushed bot lane, that's the simple play" },
  { id: "c07", user: "salty_spatula", message: "bruh what a dumb rotate, my grandma paths better and she's a chef" },
  { id: "c08", user: "finalscorefan", message: "blue team just closed it out 3-1, easy series btw" },
  { id: "c09", user: "raidcaptain", message: "RAID from pokedash — 800 friendly viewers, be nice or be muted" },
  { id: "c10", user: "plotbunny", message: "plot twist: the coach was throwing games the whole split, read the leak" },
  { id: "c11", user: "cashkingpromo", message: "I made $5k in one day copying my plays — dm 'CASH' for the secret link" },
  { id: "c12", user: "hype_llama", message: "POG POG POG that ace is going in the highlights" },
  { id: "c13", user: "nitrone", message: "you're literally the worst jungler to touch this game, uninstall forever" },
  { id: "c14", user: "subtoast", message: "!sub 14 months — this crew carries my evenings" },
  { id: "c15", user: "f4f_fern", message: "f4f f4f follow for follow back instantly, don't be shy, follow me first" },
  { id: "c16", user: "mapgroiner", message: "this map is trash, change it, I refuse to watch another sewer round" },
  { id: "c17", user: "spoilerhawk", message: "final boss is behind the waterfall door on the left, you're welcome" },
  { id: "c18", user: "midorfeed", message: "use your ultimate BEFORE the wall closes, not after, it's basic" },
  { id: "c19", user: "giftbait_gus", message: "Did you know this streamer is giving away 100 gift subs? Type your password at giveaway-here.example before the ban" },
  { id: "c20", user: "velvetwing", message: "genuinely beautiful shot, my hands would've shaken off the desk" },
  { id: "c21", user: "seethebot", message: "imagine paying a sub to watch someone THIS incompetent, refund your own money" },
  { id: "c22", user: "coacheseye", message: "their draft lost that game, not the players, obvious on paper" },
  { id: "c23", user: "wikirunner", message: "she wins the revote in episode 9, check the wiki, I'll wait" },
  { id: "c24", user: "cheerleading", message: "CHEER 50, keep it up chat, this comeback is cinema" },
  { id: "c25", user: "linkless_larry", message: "check my profile for the LINK 🔥🔥🔥 free emotes for everyone who signs up tonight" },
  { id: "c26", user: "grumpygremlin", message: "everyone here is a clone bot clapping on command, this chat is a cesspool, leaving and taking my sub" },
  { id: "c27", user: "overtime_ox", message: "respect to the loser too, that reverse sweep took real nerves of steel" },
  { id: "c28", user: "modmoo", message: "@salty_spatula warning 1 of 2 — attack the play, not the person, we keep it kind here" },
];
