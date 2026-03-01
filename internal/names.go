package internal

import (
	"fmt"
	"math/rand/v2"
	"strings"
)

var adjectives = []string{
	// Australian slang (overrepresented)
	"cheeky", "bonza", "ripper", "dodgy", "stoked",
	"grouse", "hectic", "gnarly", "chuffed", "breezy",
	"sturdy", "scrappy", "plucky", "keen", "ace",
	"brash", "swift", "bold", "steady", "sharp",
	// General-purpose
	"quick", "lazy", "clever", "calm", "bright",
	"witty", "gentle", "fierce", "quiet", "loud",
	"happy", "brave", "wise", "cool", "warm",
	"snappy", "lively", "nimble", "peppy", "zesty",
	"fuzzy", "sleek", "gritty", "crafty", "deft",
}

var nouns = []string{
	// Australian animals (overrepresented)
	"quokka", "wombat", "platypus", "kookaburra", "echidna",
	"bilby", "numbat", "dugong", "cassowary", "galah",
	"budgie", "dingo", "wallaby", "bandicoot", "taipan",
	"goanna", "thorny-devil", "lyrebird", "magpie", "cockatoo",
	// General-purpose animals
	"falcon", "otter", "badger", "heron", "fox",
	"hawk", "panda", "raven", "cobra", "crane",
	"moose", "robin", "tiger", "viper", "whale",
	"bison", "finch", "gecko", "lemur", "newt",
	"sloth", "squid", "trout", "wren", "yak",
}

// GenerateName returns a random adjective-noun name.
func GenerateName() string {
	adj := adjectives[rand.IntN(len(adjectives))]
	noun := nouns[rand.IntN(len(nouns))]
	return adj + "-" + noun
}

// GenerateUniqueName generates a random name that is not in the existing list.
// It retries up to 5 times on collision and returns an error if all attempts collide.
func GenerateUniqueName(existing []string) (string, error) {
	existingSet := make(map[string]struct{}, len(existing))
	for _, name := range existing {
		existingSet[strings.ToLower(name)] = struct{}{}
	}

	for range 5 {
		name := GenerateName()
		if _, found := existingSet[name]; !found {
			return name, nil
		}
	}

	return "", fmt.Errorf("failed to generate unique name after 5 attempts")
}
