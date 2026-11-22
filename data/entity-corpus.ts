/**
 * UC#10 entity alignment / dedup — synthetic marketplace pair corpus.
 *
 * The "Reclaim Market" is a fictional second-hand marketplace that has
 * accumulated the same product under a dozen listings: copy-paste dupes,
 * typo twins, sibling models that are NOT the same product (the 12 and
 * the 12 Pro), quantity contradictions (a single and a 2-pack are two
 * SKUs), generic-name collisions ("wireless earbuds" against "wireless
 * earbuds, black" tells you nothing about WHICH earbuds), and rebrand
 * twins only a human should dare to join. Every product, brand, and
 * listing is invented on purpose — no real marketplace, no real URL.
 *
 * Alignment is exactly the data steward's job: similarity (Score) +
 * conflict & genericName (Noul) decide distinct / review / merge IN CODE,
 * and merge edges then fold into clusters — transitively, but a chain
 * never overrules a contradiction the code already called.
 */

export type EntityRecord = {
  /** stable synthetic node id — clusters are sets of these */
  id: string;
  name: string;
  brand?: string;
  model?: string;
  detail?: string;
};

export type EntityPair = {
  /** stable synthetic pair id, p01… */
  id: string;
  a: EntityRecord;
  b: EntityRecord;
};

export const entityPairs: EntityPair[] = [
  // — copy-paste dupes and typo twins: the join lane's bread and butter —
  {
    id: "p01",
    a: { id: "r01", name: "Brevona Barista 200 espresso maker", brand: "Brevona", model: "BR-200", detail: "used, box included" },
    b: { id: "r02", name: "Barista 200 espresso machine — Brevona BR200", brand: "Brevona", model: "BR200", detail: "gently used" },
  },
  {
    id: "p02",
    a: { id: "r03", name: "Kestrel TrailRunner 4 shoes size 10", brand: "Kestrel", model: "TR4", detail: "a few trails on them" },
    b: { id: "r04", name: "Kestrel Trailrunner 4 running shoes, size 10", brand: "Kestrel", model: "TR-4", detail: "lightly worn" },
  },
  {
    id: "p03",
    a: { id: "r05", name: "Velvet Static — Neon Ledger LP, 180g reissue", brand: "Hush Records", detail: "sleeve creased" },
    b: { id: "r06", name: "Neon Ledger (Velvet Static) 180 gram reissue vinyl", brand: "Hush Records", detail: "like new" },
  },
  {
    id: "p04",
    a: { id: "r07", name: "Clutch Circuit Finals 2026 jersey, team issue, M", brand: "Clutch Circuit", detail: "never worn" },
    b: { id: "r08", name: "Clutch Circuit 2026 Finals team-issue jersey medium", brand: "Clutch Circuit", detail: "tagged" },
  },
  {
    id: "p05",
    a: { id: "r09", name: "Clacktype 68 mechanical keyboard, tactile switches", brand: "Clacktype", model: "CT-68", detail: "dust cover included" },
    b: { id: "r10", name: "Clacktype 68 mech keyboard — tactile", brand: "Clacktype", model: "CT68", detail: "retailed box" },
  },
  {
    id: "p06",
    a: { id: "r11", name: "Lumen Desk Lamp 3000K brass", brand: "Lumen", model: "LM-3", detail: "mint condition" },
    b: { id: "r12", name: "Lumen Desk Lamp 3000K brass", brand: "Lumen", model: "LM-3", detail: "good condition, small dent" },
  },
  // — sibling / quantity / edition contradictions: the code FORCES these apart —
  {
    id: "p07",
    a: { id: "r13", name: "PhoneX 12, 128GB, black", brand: "PhoneX", model: "PX-12", detail: "battery 92%" },
    b: { id: "r14", name: "PhoneX 12 Pro, 128GB, black", brand: "PhoneX", model: "PX-12-PRO", detail: "battery 95%" },
  },
  {
    id: "p08",
    a: { id: "r15", name: "HypeHaus tour hoodie — single", brand: "HypeHaus", detail: "size L" },
    b: { id: "r16", name: "HypeHaus tour hoodie 2-pack", brand: "HypeHaus", detail: "sizes L + M" },
  },
  {
    id: "p09",
    a: { id: "r17", name: "Aurora commuter bike, 2024 frame", brand: "Aurora", model: "AU-C", detail: "serviced" },
    b: { id: "r18", name: "Aurora commuter bike, 2026 frame", brand: "Aurora", model: "AU-C26", detail: "new tires" },
  },
  {
    id: "p10",
    a: { id: "r19", name: "PhoneX 12, 128GB, black", brand: "PhoneX", model: "PX-12", detail: "battery 88%" },
    b: { id: "r20", name: "PhoneX 12, 256GB, black", brand: "PhoneX", model: "PX-12-256", detail: "battery 91%" },
  },
  {
    id: "p11",
    a: { id: "r21", name: "Dune novel, paperback 1990 printing", brand: "Pulp House Press", detail: "yellowed pages" },
    b: { id: "r22", name: "Dune novel, hardcover 2021 reprint", brand: "Pulp House Press", detail: "dust jacket" },
  },
  {
    id: "p12",
    a: { id: "r23", name: "QVista 34-inch ultrawide monitor, curved", brand: "QVista", model: "QV-34C", detail: "no dead pixels" },
    b: { id: "r24", name: "QVista 34-inch ultrawide monitor, flat panel", brand: "QVista", model: "QV-34F", detail: "stand included" },
  },
  // — generic-name collisions: strong-looking text, weak identity — human lane —
  {
    id: "p13",
    a: { id: "r25", name: "wireless earbuds", detail: "case with a scratch" },
    b: { id: "r26", name: "wireless earbuds, black", detail: "new tips" },
  },
  {
    id: "p14",
    a: { id: "r27", name: "running shoes", detail: "gently used" },
    b: { id: "r28", name: "running shoes, blue", detail: "a few miles" },
  },
  {
    id: "p15",
    a: { id: "r29", name: "Nortech PowerHub 7-in-1 USB-C hub", brand: "Nortech", model: "PH-7", detail: "boxed" },
    b: { id: "r30", name: "Vellex USB-C Hub 7-in-1 (OEM of the Nortech PowerHub)", brand: "Vellex", detail: "loose" },
  },
  {
    id: "p16",
    a: { id: "r31", name: "coffee grinder", detail: "hand crank" },
    b: { id: "r32", name: "coffee grinder, ceramic burr", detail: "barely used" },
  },
  // — different things that share a word or a brand: the ladder separates —
  {
    id: "p17",
    a: { id: "r33", name: "cast iron skillet 12 inch", brand: "Emberworks", detail: "seasoned" },
    b: { id: "r34", name: "cast iron skillet cleaner — chainmail scrubber", brand: "Emberworks", detail: "unused" },
  },
  {
    id: "p18",
    a: { id: "r35", name: "Brevona Grinder G1", brand: "Brevona", model: "GR-G1", detail: "full beans bin" },
    b: { id: "r36", name: "Brevona Kettle 200", brand: "Brevona", model: "KT-200", detail: "gooseneck spout" },
  },
  {
    id: "p19",
    a: { id: "r37", name: "4-person dome tent", brand: "Tarrow", model: "TR-D4", detail: "all poles present" },
    b: { id: "r38", name: "espresso maker descaling solution 500ml", brand: "Brevona", detail: "sealed" },
  },
  {
    id: "p20",
    a: { id: "r39", name: "guitar strap, woven", brand: "Strum & Co", detail: "no wear" },
    b: { id: "r40", name: "guitar tuner pedal, chrome", brand: "Clacktone", detail: "box missing" },
  },
  {
    id: "p21",
    a: { id: "r41", name: "yoga mat 6mm teal", brand: "Still Motion", detail: "cleaned" },
    b: { id: "r42", name: "resistance band set, 5 levels", brand: "Still Motion", detail: "bag included" },
  },
  // — more dupes so the shipped corpus grows a real cluster at All —
  {
    id: "p22",
    a: { id: "r02", name: "Barista 200 espresso machine — Brevona BR200", brand: "Brevona", model: "BR200", detail: "gently used" },
    b: { id: "r43", name: "Brevona Barista 200 (BR-200), refurbished", brand: "Brevona", model: "BR-200", detail: "seller refurb, 90-day" },
  },
  {
    id: "p23",
    a: { id: "r44", name: "Kestrel TrailRunner 4 trail shoes, size 10", brand: "Kestrel", model: "TR4", detail: "grippy soles" },
    b: { id: "r03", name: "Kestrel TrailRunner 4 shoes size 10", brand: "Kestrel", model: "TR4", detail: "a few trails on them" },
  },
  {
    id: "p24",
    a: { id: "r45", name: "Neon Ledger cassette, Velvet Static", brand: "Hush Records", detail: "dubbed copy" },
    b: { id: "r05", name: "Velvet Static — Neon Ledger LP, 180g reissue", brand: "Hush Records", detail: "sleeve creased" },
  },
  {
    id: "p25",
    a: { id: "r46", name: "Folding city bike, 20-inch wheels", brand: "Aurora", model: "AU-F20", detail: "basket included" },
    b: { id: "r17", name: "Aurora commuter bike, 2024 frame", brand: "Aurora", model: "AU-C", detail: "serviced" },
  },
];
