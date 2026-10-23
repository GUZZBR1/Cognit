package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"
)

// Adapters provides the four server-owned verification domains.
type Adapters struct {
	Sessions   SessionStore
	Challenges ChallengeProvider
	Policy     DecisionPolicy
	Tokens     TokenService
}

// ChallengePresentation contains only data safe to send to the browser.
type ChallengePresentation struct {
	ID         string    `json:"challenge_id"`
	Stimulus   string    `json:"stimulus"`
	Question   string    `json:"question"`
	Choices    []string  `json:"choices"`
	Order      []string  `json:"order"`
	DurationMS int       `json:"duration_ms"`
	Expires    time.Time `json:"expires_at"`
}

// ChallengeProvider creates a private answer and its public presentation.
type ChallengeProvider interface {
	Generate(challengeType string) *ChallengeRecord
}

// SubmittedResult is untrusted evidence, never a browser-supplied decision.
type SubmittedResult struct {
	ChallengeID string `json:"challenge_id"`
	Answer      string `json:"answer"`
	Reaction    int    `json:"reaction_time_ms"`
}

// DecisionPolicy makes the final decision using server-owned context.
type DecisionPolicy interface {
	Accept(Session, ChallengeRecord, SubmittedResult) bool
}

// TokenService signs and verifies bound tokens and atomically consumes a nonce.
// Consume returns true exactly once per nonce, including concurrent calls.
// A failed binding check must never consume a nonce.
type TokenService interface {
	Issue(TokenClaims) string
	Verify(token string) (TokenClaims, error)
	Consume(nonce string) bool
}

// SampleChallenges is a stateless, process-local demonstration challenge adapter.
// Its fixed answer demonstrates the protocol; it is not a production challenge.
type SampleChallenges struct{}

func (SampleChallenges) Generate(challengeType string) *ChallengeRecord {
	id := randomID()
	expires := time.Now().Add(2 * time.Minute)
	return &ChallengeRecord{
		ID: id, Type: challengeType, Answer: "blue", Expires: expires,
		Presentation: ChallengePresentation{
			ID: id, Stimulus: "Choose the blue tile", Question: "Which tile is blue?",
			Choices: []string{"red", "blue", "green"}, Order: []string{"red", "blue", "green"},
			DurationMS: 120000, Expires: expires,
		},
	}
}

// AnswerPolicy compares the submitted answer with the private expected answer.
type AnswerPolicy struct{}

func (AnswerPolicy) Accept(_ Session, challenge ChallengeRecord, result SubmittedResult) bool {
	return result.Answer == challenge.Answer
}

// MemoryTokens uses a dedicated signing secret and process-local replay tracking.
type MemoryTokens struct {
	secret   []byte
	mu       sync.Mutex
	consumed map[string]bool
}

func NewMemoryTokens(signingSecret string) (*MemoryTokens, error) {
	if len(signingSecret) < 32 {
		return nil, errors.New("a dedicated signing secret of at least 32 bytes is required")
	}
	return &MemoryTokens{secret: []byte(signingSecret), consumed: map[string]bool{}}, nil
}

func (m *MemoryTokens) Issue(c TokenClaims) string {
	b, _ := json.Marshal(c)
	payload := base64.RawURLEncoding.EncodeToString(b)
	mac := hmac.New(sha256.New, m.secret)
	_, _ = mac.Write([]byte(payload))
	return "v1." + payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (m *MemoryTokens) Verify(token string) (TokenClaims, error) {
	var c TokenClaims
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != "v1" {
		return c, errors.New("invalid token")
	}
	mac := hmac.New(sha256.New, m.secret)
	_, _ = mac.Write([]byte(parts[1]))
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(sig, mac.Sum(nil)) {
		return c, errors.New("invalid token")
	}
	b, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || json.Unmarshal(b, &c) != nil || c.Expires <= time.Now().Unix() || c.Nonce == "" {
		return c, errors.New("invalid token")
	}
	return c, nil
}

func (m *MemoryTokens) Consume(nonce string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if nonce == "" || m.consumed[nonce] {
		return false
	}
	m.consumed[nonce] = true
	return true
}
