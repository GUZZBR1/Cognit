package challenge

import (
	"encoding/json"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestAlgorithmV1GoldenFixture(t *testing.T) {
	data, err := os.ReadFile("../fixtures/challenge-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		AlgorithmVersion int       `json:"algorithm_version"`
		Seed             string    `json:"seed"`
		Config           Config    `json:"config"`
		ExpectedAnswer   string    `json:"expected_answer"`
		PublicChallenge  Challenge `json:"public_challenge"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.AlgorithmVersion != AlgorithmVersion {
		t.Fatalf("fixture version = %d, want %d", fixture.AlgorithmVersion, AlgorithmVersion)
	}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	service, err := NewServiceWithClock(time.Minute, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	got, err := service.Generate(fixture.Seed, fixture.Config)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, fixture.PublicChallenge) {
		t.Fatalf("challenge differs from algorithm-v1 fixture:\n got: %#v\nwant: %#v", got, fixture.PublicChallenge)
	}
	if !service.ValidateAnswer(got.ChallengeID, fixture.ExpectedAnswer) {
		t.Fatal("fixture answer was not accepted")
	}
	serialized, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if string(serialized) == "" || containsSecretField(serialized) {
		t.Fatalf("public challenge JSON contains a private-answer field: %s", serialized)
	}
}

func TestGenerationIsDeterministicAndSeedsCanVary(t *testing.T) {
	service, _ := NewService(time.Minute)
	config := fixtureConfig()
	first, err := service.Generate("same-seed", config)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.Generate("same-seed", config)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("same inputs differ:\n%#v\n%#v", first, second)
	}
	seen := make(map[string]bool)
	for index := 0; index < 100; index++ {
		challenge, err := service.Generate("seed-"+strconv.Itoa(index), config)
		if err != nil {
			t.Fatal(err)
		}
		seen[strings.Join(challenge.Choices, ",")+"|"+strings.Join(challenge.Order, ",")] = true
	}
	if len(seen) < 2 {
		t.Fatal("different seeds did not produce any variants")
	}
}

func TestValidationRejectsWrongUnknownAndExpired(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	service, err := NewServiceWithClock(time.Second, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	challenge, err := service.Generate("fixture-seed-v1", fixtureConfig())
	if err != nil {
		t.Fatal(err)
	}
	if service.ValidateAnswer(challenge.ChallengeID, "wrong") {
		t.Fatal("wrong answer was accepted")
	}
	if service.ValidateAnswer("unknown-id", "right") {
		t.Fatal("unknown challenge was accepted")
	}
	now = now.Add(time.Second)
	if service.ValidateAnswer(challenge.ChallengeID, "right") {
		t.Fatal("expired challenge was accepted at the expiration boundary")
	}
}

func TestInvalidConfigsAreRejected(t *testing.T) {
	service, _ := NewService(time.Minute)
	config := fixtureConfig()
	config.Distractors = append(config.Distractors, config.Positions[0])
	if _, err := service.Generate("seed", config); err == nil {
		t.Fatal("overlapping distractor was accepted")
	}
}

func TestCanonicalConfigMatchesPythonJSONRules(t *testing.T) {
	config := Config{
		Stimulus:    "café <>&\u2028",
		Positions:   []string{"à gauche"},
		Order:       []string{},
		DurationMS:  10,
		Question:    "où?",
		Distractors: []string{"autre"},
	}
	got, err := canonicalConfig(config)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"distractors":["autre"],"duration_ms":10,"order":[],"positions":["à gauche"],"question":"où?","stimulus":"café <>&` + "\u2028" + `"}`
	if string(got) != want {
		t.Fatalf("canonical config differs:\n got: %s\nwant: %s", got, want)
	}
	service, _ := NewService(time.Minute)
	public, err := service.Generate("seed", config)
	if err != nil {
		t.Fatal(err)
	}
	serialized, err := json.Marshal(public)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(serialized), `"order":[]`) {
		t.Fatalf("empty order must serialize as an empty array: %s", serialized)
	}
}

func fixtureConfig() Config {
	return Config{
		Stimulus:    "blue square",
		Positions:   []string{"left", "center", "right"},
		Order:       []string{"blue", "green", "red"},
		DurationMS:  1500,
		Question:    "Which color was shown?",
		Distractors: []string{"black", "white"},
	}
}

func containsSecretField(data []byte) bool {
	text := string(data)
	for _, key := range []string{`"position"`, `"answer"`, `"expected_answer"`, `"correct_answer"`} {
		if strings.Contains(text, key) {
			return true
		}
	}
	return false
}
