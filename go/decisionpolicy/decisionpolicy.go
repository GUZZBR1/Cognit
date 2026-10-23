// Package decisionpolicy maps an advisory score to a caller-configured outcome.
// It contains no default thresholds or dependency on a risk scoring library.
package decisionpolicy

import (
	"errors"
	"fmt"
	"math"
	"strings"
)

type Outcome string

const (
	Allow     Outcome = "ALLOW"
	Challenge Outcome = "CHALLENGE"
	Restrict  Outcome = "RESTRICT"
	Block     Outcome = "BLOCK"
	Unknown   Outcome = "UNKNOWN"
)

func (o Outcome) valid() bool {
	switch o {
	case Allow, Challenge, Restrict, Block, Unknown:
		return true
	default:
		return false
	}
}

// Rule is an inclusive score band. Rules are evaluated in slice order.
type Rule struct {
	Outcome  Outcome
	MinScore float64
	MaxScore float64
}

// Policy contains only caller-supplied decision criteria.
type Policy struct {
	Rules             []Rule
	MinimumConfidence float64
	RequiredSignals   []string
}

// Validate rejects malformed policy configuration before evaluation.
func (p Policy) Validate() error {
	if !finiteRange(p.MinimumConfidence, 0, 1) {
		return errors.New("minimum confidence must be finite and between 0 and 1")
	}
	for i, rule := range p.Rules {
		if !rule.Outcome.valid() {
			return fmt.Errorf("rule %d has invalid outcome", i)
		}
		if !finiteRange(rule.MinScore, 0, 100) || !finiteRange(rule.MaxScore, 0, 100) || rule.MinScore > rule.MaxScore {
			return fmt.Errorf("rule %d must have a finite score band from 0 to 100", i)
		}
	}
	seen := make(map[string]struct{}, len(p.RequiredSignals))
	for _, signal := range p.RequiredSignals {
		if strings.TrimSpace(signal) == "" {
			return errors.New("required signal names must not be empty")
		}
		if _, ok := seen[signal]; ok {
			return fmt.Errorf("duplicate required signal %q", signal)
		}
		seen[signal] = struct{}{}
	}
	return nil
}

type Result struct {
	Outcome Outcome
	Reason  string
}

// Assessment contains the caller's score, confidence, and signal evidence.
// Nil score or confidence indicates missing data.
type Assessment struct {
	Score      *float64
	Confidence *float64
	Signals    map[string]any
}

// Decide evaluates an assessment against a policy.
// Signal values may be any evidence; a false value is present, while nil is invalid.
func Decide(assessment Assessment, policy Policy) (Result, error) {
	if err := policy.Validate(); err != nil {
		return Result{}, err
	}
	unknown := func(reason string) (Result, error) { return Result{Outcome: Unknown, Reason: reason}, nil }
	if assessment.Score == nil || !finiteRange(*assessment.Score, 0, 100) {
		return unknown("missing_or_invalid_score")
	}
	if assessment.Confidence == nil || !finiteRange(*assessment.Confidence, 0, 1) {
		return unknown("missing_or_invalid_confidence")
	}
	if *assessment.Confidence < policy.MinimumConfidence {
		return unknown("insufficient_confidence")
	}
	if assessment.Signals == nil {
		return unknown("missing_signals")
	}
	for _, name := range policy.RequiredSignals {
		value, present := assessment.Signals[name]
		if !present || value == nil {
			return unknown("insufficient_signals")
		}
	}
	for _, rule := range policy.Rules {
		if rule.MinScore <= *assessment.Score && *assessment.Score <= rule.MaxScore {
			return Result{Outcome: rule.Outcome, Reason: "policy_rule_matched"}, nil
		}
	}
	return unknown("no_policy_rule_matched")
}

func finiteRange(value, minimum, maximum float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && minimum <= value && value <= maximum
}
