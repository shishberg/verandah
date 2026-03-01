package internal

import (
	"regexp"
	"testing"
)

func TestGenerateNameFormat(t *testing.T) {
	// Name should match adjective-noun pattern, allowing multi-word nouns like "thorny-devil".
	pattern := regexp.MustCompile(`^[a-z]+(-[a-z]+)+$`)

	for range 100 {
		name := GenerateName()
		if !pattern.MatchString(name) {
			t.Errorf("GenerateName() = %q, does not match pattern %s", name, pattern)
		}
	}
}

func TestGenerateNameUniqueness(t *testing.T) {
	// Generate many names and check they aren't all the same.
	seen := make(map[string]struct{})
	for range 100 {
		name := GenerateName()
		seen[name] = struct{}{}
	}

	if len(seen) < 2 {
		t.Errorf("GenerateName() produced only %d unique names in 100 calls, expected variety", len(seen))
	}
}

func TestGenerateUniqueNameSuccess(t *testing.T) {
	// With no existing names, should always succeed.
	name, err := GenerateUniqueName(nil)
	if err != nil {
		t.Fatalf("GenerateUniqueName(nil) returned error: %v", err)
	}

	pattern := regexp.MustCompile(`^[a-z]+(-[a-z]+)+$`)
	if !pattern.MatchString(name) {
		t.Errorf("GenerateUniqueName(nil) = %q, does not match pattern %s", name, pattern)
	}
}

func TestGenerateUniqueNameAvoidsExisting(t *testing.T) {
	existing := []string{"cheeky-quokka", "bold-wombat"}
	name, err := GenerateUniqueName(existing)
	if err != nil {
		t.Fatalf("GenerateUniqueName() returned error: %v", err)
	}
	for _, e := range existing {
		if name == e {
			t.Errorf("GenerateUniqueName() returned existing name %q", name)
		}
	}
}

func TestGenerateUniqueNameCollisionError(t *testing.T) {
	// Build a list of all possible names to guarantee collision.
	var allNames []string
	for _, adj := range adjectives {
		for _, noun := range nouns {
			allNames = append(allNames, adj+"-"+noun)
		}
	}

	_, err := GenerateUniqueName(allNames)
	if err == nil {
		t.Error("GenerateUniqueName() with all possible names should return error, got nil")
	}
}
