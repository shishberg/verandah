// Australian-biased adjective-noun name generator.
// Adjectives lean towards Australian slang; nouns lean towards Australian animals.

const ADJECTIVES = [
  "ace", "beaut", "bonzer", "breezy", "bright", "brisk", "cheeky", "chipper",
  "choice", "clever", "cool", "corker", "cranky", "crisp", "crook", "dapper",
  "deadly", "dinky", "drongo", "fair", "flash", "grouse", "gutsy", "happy",
  "heaps", "keen", "larrikin", "lively", "lucky", "mad", "mental", "mint",
  "nifty", "no-worries", "ocker", "plucky", "proper", "quick", "rad", "ratbag",
  "ripper", "rotten", "salty", "sharp", "sick", "slick", "smashing", "snappy",
  "solid", "spicy", "stoked", "stroppy", "sweet", "true-blue", "wicked", "wild",
  "wonky", "zappy", "zippy",
];

const NOUNS = [
  "bandicoot", "barramundi", "bat", "bilby", "brolga", "budgie", "cassowary",
  "cockatoo", "croc", "dingo", "dugong", "echidna", "emu", "falcon", "fox",
  "galah", "gecko", "goanna", "ibis", "jackal", "kelpie", "koala", "kookaburra",
  "lorikeet", "magpie", "numbat", "ocelot", "owl", "pademelon", "penguin",
  "platypus", "possum", "potoroo", "python", "quokka", "quoll", "raven",
  "shark", "skink", "taipan", "thylacine", "wallaby", "wombat", "yabby",
];

/** Generate a random adjective-noun name. */
export function generateName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
}

/**
 * Generate a name that is not in the existing list.
 * Retries up to 5 times. Throws if all attempts collide.
 */
export function generateUniqueName(existing: string[]): string {
  const set = new Set(existing);
  for (let i = 0; i < 5; i++) {
    const name = generateName();
    if (!set.has(name)) {
      return name;
    }
  }
  throw new Error("failed to generate unique name after 5 attempts");
}

// Exported for testing.
export { ADJECTIVES, NOUNS };
