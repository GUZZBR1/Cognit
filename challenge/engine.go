// Package challenge provides deterministic challenge generation and
// server-side answer validation.
package challenge

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// AlgorithmVersion identifies the cross-language generation algorithm.
const AlgorithmVersion = 1

// Config is the version-1 input used to generate a challenge.
type Config struct {
	Stimulus    string   `json:"stimulus"`
	Positions   []string `json:"positions"`
	Order       []string `json:"order"`
	DurationMS  int      `json:"duration_ms"`
	Question    string   `json:"question"`
	Distractors []string `json:"distractors"`
}

// Challenge is safe to return to a client. The expected answer is never part
// of this value; it is retained privately by Service.
type Challenge struct {
	ChallengeID string   `json:"challenge_id"`
	Stimulus    string   `json:"stimulus"`
	Question    string   `json:"question"`
	Choices     []string `json:"choices"`
	Order       []string `json:"order"`
	DurationMS  int      `json:"duration_ms"`
}

var (
	ErrInvalidConfig = errors.New("invalid challenge config")
	ErrInvalidTTL    = errors.New("challenge ttl must be positive")
)

type answerState struct {
	answer    string
	expiresAt time.Time
}

// Service owns challenge answer keys and their expiration state.
type Service struct {
	mu      sync.Mutex
	answers map[string]answerState
	ttl     time.Duration
	now     func() time.Time
}

// NewService creates an in-memory challenge service with the given lifetime.
func NewService(ttl time.Duration) (*Service, error) {
	return NewServiceWithClock(ttl, time.Now)
}

// NewServiceWithClock creates a service using now for issuance and validation
// timestamps. It is useful when callers need a controlled clock.
func NewServiceWithClock(ttl time.Duration, now func() time.Time) (*Service, error) {
	if ttl <= 0 {
		return nil, ErrInvalidTTL
	}
	if now == nil {
		return nil, errors.New("clock must not be nil")
	}
	return &Service{answers: make(map[string]answerState), ttl: ttl, now: now}, nil
}

// Generate returns deterministic public challenge data and stores its answer
// and expiration in this service instance.
func (s *Service) Generate(seed string, config Config) (Challenge, error) {
	if strings.TrimSpace(seed) == "" {
		return Challenge{}, fmt.Errorf("%w: seed must be non-empty", ErrInvalidConfig)
	}
	if !utf8.ValidString(seed) {
		return Challenge{}, fmt.Errorf("%w: seed must be valid UTF-8", ErrInvalidConfig)
	}
	if err := validateConfig(config); err != nil {
		return Challenge{}, err
	}
	configJSON, err := canonicalConfig(config)
	if err != nil {
		return Challenge{}, err
	}
	seedBytes := []byte(seed)
	idInput := append([]byte("cognit-challenge-id-v1\x00"), seedBytes...)
	idInput = append(idInput, 0)
	idInput = append(idInput, configJSON...)
	digest := sha256.Sum256(idInput)
	challengeID := hex.EncodeToString(digest[:])[:24]

	rngInput := append([]byte("cognit-challenge-v1\x00"), seedBytes...)
	rngInput = append(rngInput, 0)
	rngInput = append(rngInput, configJSON...)
	key := sha256.Sum256(rngInput)
	rng := seededShuffle{key: key}
	positionIndex, err := rng.randbelow(uint64(len(config.Positions)))
	if err != nil {
		return Challenge{}, err
	}
	answer := config.Positions[positionIndex]
	choices := append([]string{answer}, config.Distractors...)
	if err := rng.shuffle(choices); err != nil {
		return Challenge{}, err
	}
	order := append([]string{}, config.Order...)
	if err := rng.shuffle(order); err != nil {
		return Challenge{}, err
	}

	public := Challenge{
		ChallengeID: challengeID,
		Stimulus:    config.Stimulus,
		Question:    config.Question,
		Choices:     choices,
		Order:       order,
		DurationMS:  config.DurationMS,
	}
	s.mu.Lock()
	issuedAt := s.now()
	for id, state := range s.answers {
		if !issuedAt.Before(state.expiresAt) {
			delete(s.answers, id)
		}
	}
	s.answers[challengeID] = answerState{answer: answer, expiresAt: issuedAt.Add(s.ttl)}
	s.mu.Unlock()
	return public, nil
}

// ValidateAnswer accepts only the correct answer for a known, unexpired ID.
// Expiration occurs at expiresAt (now >= expiresAt).
func (s *Service) ValidateAnswer(challengeID, submittedAnswer string) bool {
	if challengeID == "" || submittedAnswer == "" {
		return false
	}
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	state, ok := s.answers[challengeID]
	if !ok {
		return false
	}
	if !now.Before(state.expiresAt) {
		delete(s.answers, challengeID)
		return false
	}
	return submittedAnswer == state.answer
}

func validateConfig(config Config) error {
	if strings.TrimSpace(config.Stimulus) == "" || strings.TrimSpace(config.Question) == "" {
		return fmt.Errorf("%w: stimulus and question must be non-empty", ErrInvalidConfig)
	}
	if !utf8.ValidString(config.Stimulus) || !utf8.ValidString(config.Question) {
		return fmt.Errorf("%w: stimulus and question must be valid UTF-8", ErrInvalidConfig)
	}
	if config.DurationMS <= 0 {
		return fmt.Errorf("%w: duration_ms must be positive", ErrInvalidConfig)
	}
	if err := validateStrings(config.Positions, "positions", 1); err != nil {
		return err
	}
	if err := validateStrings(config.Order, "order", 0); err != nil {
		return err
	}
	if err := validateStrings(config.Distractors, "distractors", 1); err != nil {
		return err
	}
	positions := make(map[string]struct{}, len(config.Positions))
	for _, value := range config.Positions {
		positions[value] = struct{}{}
	}
	for _, value := range config.Distractors {
		if _, exists := positions[value]; exists {
			return fmt.Errorf("%w: distractors must not overlap positions", ErrInvalidConfig)
		}
	}
	return nil
}

func validateStrings(values []string, name string, min int) error {
	if len(values) < min {
		return fmt.Errorf("%w: %s must contain at least %d item(s)", ErrInvalidConfig, name, min)
	}
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%w: %s must contain non-empty strings", ErrInvalidConfig, name)
		}
		if !utf8.ValidString(value) {
			return fmt.Errorf("%w: %s must contain valid UTF-8 strings", ErrInvalidConfig, name)
		}
		if _, exists := seen[value]; exists {
			return fmt.Errorf("%w: %s must not contain duplicates", ErrInvalidConfig, name)
		}
		seen[value] = struct{}{}
	}
	return nil
}

// canonicalConfig mirrors Python json.dumps(..., ensure_ascii=False,
// separators=(",", ":"), sort_keys=True) for the supported config values.
func canonicalConfig(config Config) ([]byte, error) {
	quote := func(value string) (string, error) {
		var output strings.Builder
		encoder := json.NewEncoder(&output)
		encoder.SetEscapeHTML(false)
		err := encoder.Encode(value)
		if err != nil {
			return "", err
		}
		encoded := strings.TrimSuffix(output.String(), "\n")
		return strings.NewReplacer(`\u2028`, "\u2028", `\u2029`, "\u2029").Replace(encoded), nil
	}
	stringArray := func(values []string) (string, error) {
		parts := make([]string, len(values))
		for index, value := range values {
			encoded, err := quote(value)
			if err != nil {
				return "", err
			}
			parts[index] = encoded
		}
		return "[" + strings.Join(parts, ",") + "]", nil
	}
	fields := make([]string, 0, 6)
	for _, field := range []struct {
		name  string
		value any
	}{
		{"distractors", config.Distractors},
		{"duration_ms", config.DurationMS},
		{"order", config.Order},
		{"positions", config.Positions},
		{"question", config.Question},
		{"stimulus", config.Stimulus},
	} {
		key, err := quote(field.name)
		if err != nil {
			return nil, err
		}
		var value string
		switch typed := field.value.(type) {
		case []string:
			value, err = stringArray(typed)
		case string:
			value, err = quote(typed)
		case int:
			value = strconv.Itoa(typed)
		default:
			return nil, fmt.Errorf("unsupported canonical config value %T", field.value)
		}
		if err != nil {
			return nil, err
		}
		fields = append(fields, key+":"+value)
	}
	return []byte("{" + strings.Join(fields, ",") + "}"), nil
}

type seededShuffle struct {
	key     [sha256.Size]byte
	counter uint64
}

func (r *seededShuffle) uint64() uint64 {
	input := make([]byte, len(r.key)+8)
	copy(input, r.key[:])
	binary.BigEndian.PutUint64(input[len(r.key):], r.counter)
	r.counter++
	block := sha256.Sum256(input)
	return binary.BigEndian.Uint64(block[:8])
}

func (r *seededShuffle) randbelow(upper uint64) (uint64, error) {
	if upper == 0 {
		return 0, errors.New("upper bound must be positive")
	}
	// 2^64 modulo upper is computed without representing 2^64.
	remainder := (uint64(0) - upper) % upper
	for {
		value := r.uint64()
		if remainder == 0 || value < uint64(0)-remainder {
			return value % upper, nil
		}
	}
}

func (r *seededShuffle) shuffle(values []string) error {
	for index := len(values) - 1; index > 0; index-- {
		swap, err := r.randbelow(uint64(index + 1))
		if err != nil {
			return err
		}
		values[index], values[swap] = values[swap], values[index]
	}
	return nil
}
