package decisionpolicy

import (
	"math"
	"testing"
)

func ptr(v float64) *float64 { return &v }

func testPolicy() Policy {
	return Policy{MinimumConfidence: .7, RequiredSignals: []string{"browser"}, Rules: []Rule{
		{Outcome: Allow, MinScore: 0, MaxScore: 24.99},
		{Outcome: Challenge, MinScore: 25, MaxScore: 49.99},
		{Outcome: Restrict, MinScore: 50, MaxScore: 74.99},
		{Outcome: Block, MinScore: 75, MaxScore: 100},
	}}
}

func TestOutcomesAndInclusiveBoundaries(t *testing.T) {
	policy := testPolicy()
	for _, tc := range []struct {
		score float64
		want  Outcome
	}{
		{0, Allow}, {24.99, Allow}, {25, Challenge}, {49.99, Challenge},
		{50, Restrict}, {74.99, Restrict}, {75, Block}, {100, Block},
	} {
		assessment := Assessment{Score: ptr(tc.score), Confidence: ptr(.7), Signals: map[string]any{"browser": false}}
		got, err := Decide(assessment, policy)
		if err != nil || got.Outcome != tc.want {
			t.Errorf("score %v: got %#v, %v; want %s", tc.score, got, err, tc.want)
		}
	}
}

func TestUnknownForInvalidInsufficientOrUnmatchedEvidence(t *testing.T) {
	policy := testPolicy()
	for _, tc := range []struct {
		name              string
		score, confidence *float64
		signals           map[string]any
		wantReason        string
	}{
		{"missing score", nil, ptr(.8), map[string]any{"browser": true}, "missing_or_invalid_score"},
		{"invalid score", ptr(math.NaN()), ptr(.8), map[string]any{"browser": true}, "missing_or_invalid_score"},
		{"missing confidence", ptr(10), nil, map[string]any{"browser": true}, "missing_or_invalid_confidence"},
		{"invalid confidence", ptr(10), ptr(math.Inf(1)), map[string]any{"browser": true}, "missing_or_invalid_confidence"},
		{"confidence too low", ptr(10), ptr(.69), map[string]any{"browser": true}, "insufficient_confidence"},
		{"missing map", ptr(10), ptr(.8), nil, "missing_signals"},
		{"missing signal", ptr(10), ptr(.8), map[string]any{}, "insufficient_signals"},
		{"nil signal", ptr(10), ptr(.8), map[string]any{"browser": nil}, "insufficient_signals"},
		{"no matching rule", ptr(10), ptr(.8), map[string]any{"browser": true}, "no_policy_rule_matched"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := policy
			if tc.name == "no matching rule" {
				p.Rules = []Rule{{Outcome: Allow, MinScore: 20, MaxScore: 30}}
			}
			assessment := Assessment{Score: tc.score, Confidence: tc.confidence, Signals: tc.signals}
			got, err := Decide(assessment, p)
			if err != nil || got.Outcome != Unknown || got.Reason != tc.wantReason {
				t.Fatalf("got %#v, %v; want UNKNOWN/%s", got, err, tc.wantReason)
			}
		})
	}
}

func TestInvalidInputsAndPolicyValidation(t *testing.T) {
	for _, score := range []float64{-1, 101, math.Inf(-1)} {
		assessment := Assessment{Score: ptr(score), Confidence: ptr(.8), Signals: map[string]any{"browser": true}}
		got, _ := Decide(assessment, testPolicy())
		if got.Outcome != Unknown {
			t.Errorf("score %v got %s", score, got.Outcome)
		}
	}
	for _, policy := range []Policy{
		{MinimumConfidence: math.NaN()},
		{MinimumConfidence: 0, Rules: []Rule{{Outcome: Outcome("INVALID"), MinScore: 0, MaxScore: 1}}},
		{MinimumConfidence: 0, Rules: []Rule{{Outcome: Allow, MinScore: 2, MaxScore: 1}}},
		{MinimumConfidence: 0, RequiredSignals: []string{"x", "x"}},
	} {
		if _, err := Decide(Assessment{Score: ptr(1), Confidence: ptr(1), Signals: map[string]any{}}, policy); err == nil {
			t.Errorf("expected invalid policy error: %#v", policy)
		}
	}
}

func TestNoImplicitThreshold(t *testing.T) {
	p := Policy{MinimumConfidence: 0}
	got, err := Decide(Assessment{Score: ptr(50), Confidence: ptr(1), Signals: map[string]any{}}, p)
	if err != nil || got.Outcome != Unknown || got.Reason != "no_policy_rule_matched" {
		t.Fatalf("got %#v, %v", got, err)
	}
}

func TestExplicitUnknownRuleOutcome(t *testing.T) {
	p := Policy{MinimumConfidence: 0, Rules: []Rule{{Outcome: Unknown, MinScore: 10, MaxScore: 20}}}
	got, err := Decide(Assessment{Score: ptr(15), Confidence: ptr(1), Signals: map[string]any{}}, p)
	if err != nil || got.Outcome != Unknown || got.Reason != "policy_rule_matched" {
		t.Fatalf("got %#v, %v; want explicit UNKNOWN rule match", got, err)
	}
}
