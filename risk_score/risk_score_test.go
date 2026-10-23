package riskscore

import (
	"encoding/json"
	"math"
	"os"
	"reflect"
	"testing"
)

func TestPythonReferenceFixtures(t *testing.T) {
	data, err := os.ReadFile("testdata/python_references.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name     string `json:"name"`
		Input    Input  `json:"input"`
		Expected Result `json:"expected"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			if got := ScoreRisk(tc.Input); !reflect.DeepEqual(got, tc.Expected) {
				t.Fatalf("ScoreRisk() = %#v, want Python reference %#v", got, tc.Expected)
			}
		})
	}
}

func TestEmptyAndInvalidInputsAreInconclusive(t *testing.T) {
	for name, input := range map[string]Input{
		"empty":        {},
		"invalid":      {Perception: map[string]any{"risk": 2, "confidence": 1}, Timing: "bad"},
		"single group": {Perception: map[string]any{"risk": 1, "confidence": 1}},
	} {
		t.Run(name, func(t *testing.T) {
			got := ScoreRisk(input)
			if got.State != "inconclusive" || got.RiskScore != 0 {
				t.Fatalf("must remain advisory/inconclusive, got %#v", got)
			}
		})
	}
}

func TestInvalidNumberTypesAndNonFiniteValuesAreRejected(t *testing.T) {
	input := Input{
		Perception: []any{
			map[string]any{"risk": true, "confidence": 1.0},
			map[string]any{"risk": 0.2, "confidence": "0.8"},
			map[string]any{"risk": 0.2, "confidence": 1.1},
			map[string]any{"risk": math.NaN(), "confidence": 1.0},
			map[string]any{"risk": math.Inf(1), "confidence": 1.0},
		},
		Timing: map[string]any{"risk": 0.3, "confidence": 1.0},
	}
	got := ScoreRisk(input)
	if !reflect.DeepEqual(got.UsedSignals, []string{"timing"}) || got.State != "inconclusive" {
		t.Fatalf("invalid entries must be discarded: %#v", got)
	}
}

func TestScoreAndConfidenceAreBounded(t *testing.T) {
	got := ScoreRisk(Input{
		Perception: map[string]any{"risk": 1, "confidence": 1},
		Timing:     map[string]any{"risk": 1, "confidence": 1},
		Mouse:      map[string]any{"risk": 1, "confidence": 1},
		Browser:    map[string]any{"risk": 1, "confidence": 1},
		Journey:    map[string]any{"risk": 1, "confidence": 1},
		Traps:      map[string]any{"risk": 1, "confidence": 1},
	})
	if got.RiskScore != 100 || got.Confidence != 1 || got.State != "scored" {
		t.Fatalf("unexpected bounded maximum: %#v", got)
	}
}
