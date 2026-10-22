package main

import (
	"fmt"
	"log"

	"github.com/GUZZBR1/Cognit/go/decisionpolicy"
)

func main() {
	policy := decisionpolicy.Policy{
		MinimumConfidence: 0.8,
		RequiredSignals:   []string{"browser_automation"},
		Rules: []decisionpolicy.Rule{
			{Outcome: decisionpolicy.Allow, MinScore: 0, MaxScore: 24.99},
			{Outcome: decisionpolicy.Challenge, MinScore: 25, MaxScore: 49.99},
			{Outcome: decisionpolicy.Restrict, MinScore: 50, MaxScore: 74.99},
			{Outcome: decisionpolicy.Block, MinScore: 75, MaxScore: 100},
		},
	}
	assessment := decisionpolicy.Assessment{
		Score:      floatPtr(32),
		Confidence: floatPtr(0.92),
		Signals:    map[string]any{"browser_automation": false},
	}
	result, err := decisionpolicy.Decide(assessment, policy)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("%s (%s)\n", result.Outcome, result.Reason)
}

func floatPtr(v float64) *float64 { return &v }
