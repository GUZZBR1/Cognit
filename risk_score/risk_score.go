// Package riskscore combines available signal evidence into an advisory score.
// It does not identify people or make access decisions.
package riskscore

import (
	"math"
	"reflect"
	"strconv"
)

// SignalGroups is the canonical order used for used/missing signal lists.
var SignalGroups = []string{"perception", "timing", "mouse", "browser", "journey", "traps"}

const (
	minimumGroups     = 2
	minimumConfidence = 0.5
)

// Input contains optional evidence groups. Each group accepts a map with risk
// and confidence values, or a slice of such maps.
type Input struct {
	Perception any `json:"perception"`
	Timing     any `json:"timing"`
	Mouse      any `json:"mouse"`
	Browser    any `json:"browser"`
	Journey    any `json:"journey"`
	Traps      any `json:"traps"`
}

// Result is a deterministic, advisory summary of the supplied evidence.
type Result struct {
	RiskScore      int      `json:"risk_score"`
	Confidence     float64  `json:"confidence"`
	State          string   `json:"state"`
	UsedSignals    []string `json:"used_signals"`
	MissingSignals []string `json:"missing_signals"`
}

type groupValue struct {
	name  string
	value any
}

// ScoreRisk returns a confidence-weighted score and evidence breadth summary.
// Invalid observations are ignored. Inconclusive results always have score 0.
func ScoreRisk(input Input) Result {
	groups := []groupValue{
		{"perception", input.Perception}, {"timing", input.Timing},
		{"mouse", input.Mouse}, {"browser", input.Browser},
		{"journey", input.Journey}, {"traps", input.Traps},
	}
	used := make([]string, 0, len(groups))
	missing := make([]string, 0, len(groups))
	type aggregate struct{ risk, confidence float64 }
	values := make([]aggregate, 0, len(groups))

	for _, group := range groups {
		observations := items(group.value)
		var riskSum, confidenceSum float64
		count := 0
		for _, item := range observations {
			mapping, ok := stringMap(item)
			if !ok {
				continue
			}
			risk, riskOK := normalizedNumber(mapping["risk"])
			confidence, confidenceOK := normalizedNumber(mapping["confidence"])
			if riskOK && confidenceOK {
				riskSum += risk
				confidenceSum += confidence
				count++
			}
		}
		if count == 0 {
			missing = append(missing, group.name)
			continue
		}
		used = append(used, group.name)
		values = append(values, aggregate{riskSum / float64(count), confidenceSum / float64(count)})
	}

	result := Result{State: "inconclusive", UsedSignals: used, MissingSignals: missing}
	if len(values) < minimumGroups {
		return result
	}

	var confidenceSum, weightedRisk float64
	for _, value := range values {
		confidenceSum += value.confidence
		weightedRisk += value.risk * value.confidence
	}
	confidence := confidenceSum / float64(len(values)) * math.Min(1, float64(len(values))/3)
	if confidence < minimumConfidence || confidenceSum == 0 {
		result.Confidence = roundDigits(confidence, 4)
		return result
	}
	result.RiskScore = int(math.RoundToEven(weightedRisk / confidenceSum * 100))
	result.Confidence = roundDigits(confidence, 4)
	result.State = "scored"
	return result
}

func items(value any) []any {
	if value == nil {
		return nil
	}
	if _, ok := stringMap(value); ok {
		return []any{value}
	}
	rv := reflect.ValueOf(value)
	if rv.Kind() != reflect.Array && rv.Kind() != reflect.Slice {
		return nil
	}
	items := make([]any, rv.Len())
	for i := range items {
		items[i] = rv.Index(i).Interface()
	}
	return items
}

func stringMap(value any) (map[string]any, bool) {
	if mapping, ok := value.(map[string]any); ok {
		return mapping, true
	}
	return nil, false
}

func normalizedNumber(value any) (float64, bool) {
	var number float64
	switch v := value.(type) {
	case float64:
		number = v
	case float32:
		number = float64(v)
	case int:
		number = float64(v)
	case int8:
		number = float64(v)
	case int16:
		number = float64(v)
	case int32:
		number = float64(v)
	case int64:
		number = float64(v)
	case uint:
		number = float64(v)
	case uint8:
		number = float64(v)
	case uint16:
		number = float64(v)
	case uint32:
		number = float64(v)
	case uint64:
		number = float64(v)
	default:
		return 0, false
	}
	return number, number >= 0 && number <= 1
}

func roundDigits(value float64, digits int) float64 {
	// Formatting to a fixed number of decimal places matches Python's
	// round(value, digits) more closely than scaling and rounding the float.
	rounded, _ := strconv.ParseFloat(strconv.FormatFloat(value, 'f', digits, 64), 64)
	return rounded
}
