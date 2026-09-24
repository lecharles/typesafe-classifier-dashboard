export type Video = {
  id: string;
  title: string;
  description: string;
  channel: string;
  publishedAt: string; // ISO date
};

// A curated, trending-style sample of public-video metadata. Used by default so the
// analyzer runs instantly and offline; a live YouTube Data API path can replace it.
export const videos: Video[] = [
  { id: "v01", title: "I Built an AI Agent That Codes For Me (INSANE Results)", description: "Full walkthrough of an autonomous coding agent using the latest models.", channel: "Fireship", publishedAt: "2026-09-14" },
  { id: "v02", title: "The TRUTH About the New iPhone Nobody Is Telling You", description: "Hands-on review after two weeks of daily use.", channel: "MKBHD", publishedAt: "2026-09-10" },
  { id: "v03", title: "Breaking: Central Bank Announces Surprise Rate Cut", description: "Live coverage and analysis of today's decision and market reaction.", channel: "Bloomberg", publishedAt: "2026-09-18" },
  { id: "v04", title: "How Neural Networks Actually Work (Visual Explanation)", description: "A gentle, visual introduction to the math behind deep learning.", channel: "3Blue1Brown", publishedAt: "2026-08-29" },
  { id: "v05", title: "We Survived 100 Days in Hardcore Minecraft", description: "The full journey with our biggest base build yet.", channel: "PewDiePie", publishedAt: "2026-09-02" },
  { id: "v06", title: "24 Hours Eating Only Street Food in Tokyo", description: "Exploring the best hidden food stalls across the city.", channel: "Mark Wiens", publishedAt: "2026-09-06" },
  { id: "v07", title: "This ONE Habit Made Me a Millionaire (Not Clickbait)", description: "The daily routine that changed my finances forever.", channel: "Graham Stephan", publishedAt: "2026-09-12" },
  { id: "v08", title: "Rust vs Go in 2026: Which Should You Learn?", description: "A practical comparison for backend developers with benchmarks.", channel: "ThePrimeagen", publishedAt: "2026-09-08" },
  { id: "v09", title: "Election Results Live: Everything You Need to Know", description: "Rolling updates as results come in from key districts.", channel: "BBC News", publishedAt: "2026-09-20" },
  { id: "v10", title: "I Gave $100,000 to Random Strangers", description: "The reactions were absolutely priceless. Charity at the end!", channel: "MrBeast", publishedAt: "2026-09-15" },
  { id: "v11", title: "The Physics of Black Holes, Explained Simply", description: "What happens at the event horizon and why time slows down.", channel: "Kurzgesagt", publishedAt: "2026-08-22" },
  { id: "v12", title: "My Morning Routine for Maximum Productivity", description: "The exact 5am routine I follow every single day.", channel: "Ali Abdaal", publishedAt: "2026-09-04" },
  { id: "v13", title: "SHOCKING Gameplay: This New FPS Changes Everything", description: "First look at the most anticipated shooter of the year.", channel: "IGN", publishedAt: "2026-09-11" },
  { id: "v14", title: "How to Cook the Perfect Steak Every Time", description: "Chef techniques for restaurant-quality results at home.", channel: "Bon Appétit", publishedAt: "2026-08-30" },
  { id: "v15", title: "AI Just Passed the Bar Exam — Are Lawyers Doomed?", description: "Examining what the latest results mean for the profession.", channel: "CNBC", publishedAt: "2026-09-16" },
  { id: "v16", title: "Building a SaaS in 7 Days (Live Coding)", description: "From idea to first paying customer, the whole process.", channel: "Theo - t3.gg", publishedAt: "2026-09-09" },
  { id: "v17", title: "You've Been Doing Push-Ups WRONG Your Whole Life", description: "Fix these three mistakes for real chest gains.", channel: "AthleanX", publishedAt: "2026-09-01" },
  { id: "v18", title: "Sponsored: The Only Laptop You'll Need in 2026", description: "In partnership with a brand — full specs and discount code below.", channel: "Linus Tech Tips", publishedAt: "2026-09-13" },
  { id: "v19", title: "The History of the Roman Empire in 20 Minutes", description: "From founding to fall, a concise animated overview.", channel: "OverSimplified", publishedAt: "2026-08-25" },
  { id: "v20", title: "Reacting to My Old Videos (SO Cringe)", description: "Watching my first uploads for the first time in years.", channel: "Emma Chamberlain", publishedAt: "2026-09-07" },
  { id: "v21", title: "New GPU Benchmarks Are Absolutely Insane", description: "Testing the latest cards across 15 games at 4K.", channel: "Gamers Nexus", publishedAt: "2026-09-17" },
  { id: "v22", title: "How I Learned a Language in 3 Months", description: "The study system and resources that actually worked.", channel: "Xiaomanyc", publishedAt: "2026-08-28" },
  { id: "v23", title: "Markets Tumble as Tech Stocks Sell Off", description: "What's driving the drop and what analysts expect next.", channel: "Yahoo Finance", publishedAt: "2026-09-19" },
  { id: "v24", title: "Trying the World's Spiciest Ramen Challenge", description: "I regret everything. Do not attempt this at home.", channel: "Matt Stonie", publishedAt: "2026-09-03" },
  { id: "v25", title: "The Best Budget Phones You Can Buy Right Now", description: "Five great options that won't break the bank.", channel: "MKBHD", publishedAt: "2026-08-31" },
  { id: "v26", title: "Why This Startup Failed After Raising $50M", description: "A post-mortem on one of the year's biggest collapses.", channel: "Y Combinator", publishedAt: "2026-09-05" },
  { id: "v27", title: "Speedrunning This Game Broke My Brain", description: "Attempting a world record after 200 hours of practice.", channel: "GDQ", publishedAt: "2026-09-10" },
  { id: "v28", title: "10 VS Code Extensions You NEED in 2026", description: "Supercharge your workflow with these must-have tools.", channel: "Fireship", publishedAt: "2026-08-27" },
  { id: "v29", title: "Climate Summit: World Leaders Reach New Deal", description: "Coverage of the agreement and reactions from delegates.", channel: "Reuters", publishedAt: "2026-09-21" },
  { id: "v30", title: "I Tried Waking Up at 4AM for 30 Days", description: "Here's what actually happened to my body and productivity.", channel: "Matt D'Avella", publishedAt: "2026-09-06" },
  { id: "v31", title: "The Most Beautiful Piano Piece Ever Written", description: "A full performance of a timeless classical composition.", channel: "Rousseau", publishedAt: "2026-08-24" },
  { id: "v32", title: "Unboxing the Craziest Tech of the Year", description: "A pile of gadgets and my honest first impressions.", channel: "Unbox Therapy", publishedAt: "2026-09-12" },
  { id: "v33", title: "How Vaccines Are Made, Step by Step", description: "An accessible explainer on modern vaccine development.", channel: "Vox", publishedAt: "2026-08-26" },
  { id: "v34", title: "This AI Tool Will Replace Your Whole Team (Maybe)", description: "Testing the limits of the newest productivity assistant.", channel: "Two Minute Papers", publishedAt: "2026-09-15" },
  { id: "v35", title: "Full Body Workout — No Equipment Needed", description: "A 20-minute follow-along routine you can do anywhere.", channel: "Chloe Ting", publishedAt: "2026-09-02" },
  { id: "v36", title: "Ranking Every Programming Language (Tier List)", description: "A completely subjective and definitely controversial ranking.", channel: "ThePrimeagen", publishedAt: "2026-09-14" },
  { id: "v37", title: "Inside the Factory That Builds Electric Cars", description: "A rare behind-the-scenes look at modern manufacturing.", channel: "Veritasium", publishedAt: "2026-08-23" },
  { id: "v38", title: "GET RICH With This Simple Investing Strategy", description: "The index-fund approach explained for beginners.", channel: "Andrei Jikh", publishedAt: "2026-09-08" },
  { id: "v39", title: "The Funniest Gaming Moments of 2026 So Far", description: "A compilation that had me crying laughing.", channel: "VanossGaming", publishedAt: "2026-09-11" },
  { id: "v40", title: "Everything Announced at the Big Tech Keynote", description: "A full recap of the products and features revealed today.", channel: "The Verge", publishedAt: "2026-09-18" },
  { id: "v41", title: "I Visited the Most Remote Village on Earth", description: "Three flights and a two-day hike to get here.", channel: "Drew Binsky", publishedAt: "2026-08-29" },
  { id: "v42", title: "How to Negotiate Your Salary (And Actually Win)", description: "Scripts and tactics from a career coach.", channel: "HBR", publishedAt: "2026-09-05" },
  { id: "v43", title: "This Optical Illusion Will Blow Your Mind", description: "The science of why your brain gets fooled.", channel: "SmarterEveryDay", publishedAt: "2026-08-21" },
  { id: "v44", title: "Building My Dream Gaming PC (Full Build)", description: "Part list, assembly, and benchmarks in one video.", channel: "JayzTwoCents", publishedAt: "2026-09-09" },
  { id: "v45", title: "Breaking Down the Championship Final", description: "Tactical analysis of the biggest match of the season.", channel: "ESPN", publishedAt: "2026-09-20" },
  { id: "v46", title: "The Dark Side of Social Media Algorithms", description: "A documentary-style look at how feeds shape behavior.", channel: "Johnny Harris", publishedAt: "2026-09-04" },
  { id: "v47", title: "Trying 5 Viral TikTok Recipes (Honest Review)", description: "Do they actually taste good? Let's find out.", channel: "Babish", publishedAt: "2026-09-07" },
  { id: "v48", title: "Quantum Computing Explained for Beginners", description: "What qubits are and why they matter, no PhD required.", channel: "Kurzgesagt", publishedAt: "2026-08-30" },
  { id: "v49", title: "My Honest Review After 1 Year of Remote Work", description: "The pros, the cons, and what I'd change.", channel: "Ali Abdaal", publishedAt: "2026-09-13" },
  { id: "v50", title: "LEAKED: The Next Console Specs Are Wild", description: "Rumors, leaks, and what we can reasonably expect.", channel: "IGN", publishedAt: "2026-09-16" },
];
