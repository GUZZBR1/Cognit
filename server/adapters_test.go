package server_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cognit-verify/cognit/server"
)

type trackedSessions struct {
	server.SessionStore
	reads, writes int
}

func (s *trackedSessions) Get(id string) (*server.Session, bool) {
	s.reads++
	return s.SessionStore.Get(id)
}
func (s *trackedSessions) Put(session *server.Session) {
	s.writes++
	s.SessionStore.Put(session)
}

type customChallenges struct{ requested string }

func (c *customChallenges) Generate(kind string) *server.ChallengeRecord {
	c.requested = kind
	expires := time.Now().Add(time.Minute)
	return &server.ChallengeRecord{
		ID: "custom-challenge", Type: kind, Answer: "private-answer", Expires: expires,
		Presentation: server.ChallengePresentation{
			ID: "custom-challenge", Stimulus: "Custom stimulus", Question: "Custom question",
			Choices: []string{"left", "right"}, Order: []string{"right", "left"}, DurationMS: 60000, Expires: expires,
		},
	}
}

type customPolicy struct {
	called bool
	allow  bool
}

func (p *customPolicy) Accept(s server.Session, c server.ChallengeRecord, r server.SubmittedResult) bool {
	p.called = true
	return p.allow && s.App == "custom-app" && c.Answer == "private-answer" && r.Answer == "policy-input" && r.Reaction == 42
}

type trackedTokens struct {
	server.TokenService
	issued, verified, consumed int
}

func (s *trackedTokens) Issue(c server.TokenClaims) string {
	s.issued++
	return s.TokenService.Issue(c)
}
func (s *trackedTokens) Verify(token string) (server.TokenClaims, error) {
	s.verified++
	return s.TokenService.Verify(token)
}
func (s *trackedTokens) Consume(nonce string) bool {
	s.consumed++
	return s.TokenService.Consume(nonce)
}

func TestAllDomainAdaptersAreInjectable(t *testing.T) {
	for _, allow := range []bool{true, false} {
		name := "deny"
		if allow {
			name = "allow"
		}
		t.Run(name, func(t *testing.T) {
			key := strings.Repeat("k", 32)
			sessions := &trackedSessions{SessionStore: server.NewMemorySessions()}
			challenges, policy := &customChallenges{}, &customPolicy{allow: allow}
			memoryTokens, err := server.NewMemoryTokens(strings.Repeat("s", 32))
			if err != nil {
				t.Fatal(err)
			}
			tokens := &trackedTokens{TokenService: memoryTokens}
			handler, err := server.NewWithAdapters(server.Config{ApplicationKeys: map[string]string{key: "custom-app"}}, server.Adapters{
				Sessions: sessions, Challenges: challenges, Policy: policy, Tokens: tokens,
			})
			if err != nil {
				t.Fatal(err)
			}
			post := func(path, body string, status int) map[string]any {
				t.Helper()
				req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
				req.Header.Set("Authorization", "Bearer "+key)
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, req)
				if response.Code != status {
					t.Fatalf("%s: got %d, want %d: %s", path, response.Code, status, response.Body)
				}
				var data map[string]any
				if err := json.Unmarshal(response.Body.Bytes(), &data); err != nil {
					t.Fatal(err)
				}
				return data
			}
			created := post("/v0/sessions", `{"site_id":"custom-site"}`, 201)
			id := created["session_id"].(string)
			path := "/v0/sessions/" + id
			challenge := post(path+"/challenge", `{"challenge_type":"custom"}`, 200)
			if challenges.requested != "custom" || challenge["stimulus"] != "Custom stimulus" || challenge["answer"] != nil {
				t.Fatalf("challenge adapter not used or answer exposed: %#v", challenge)
			}
			result := post(path+"/result", `{"challenge_id":"custom-challenge","answer":"policy-input","reaction_time_ms":42}`, 200)
			if !policy.called || result["accepted"] != allow {
				t.Fatalf("policy adapter not used: %#v", result)
			}
			verified := post(path+"/verify", "", 200)
			if allow {
				token, ok := verified["token"].(string)
				if !ok || token == "" {
					t.Fatalf("token adapter did not issue token: %#v", verified)
				}
				body, _ := json.Marshal(map[string]string{"token": token, "site_id": "custom-site", "session_id": id, "action": "default"})
				post("/v0/tokens/validate", string(body), 200)
				if tokens.issued != 1 || tokens.verified != 1 || tokens.consumed != 1 {
					t.Fatalf("token adapter calls: issue=%d verify=%d consume=%d", tokens.issued, tokens.verified, tokens.consumed)
				}
			} else if tokens.issued != 0 || verified["token"] != nil {
				t.Fatalf("policy denial issued a token: %#v", verified)
			}
			if sessions.reads == 0 || sessions.writes == 0 {
				t.Fatalf("session adapter unused: reads=%d writes=%d", sessions.reads, sessions.writes)
			}
		})
	}
}

func TestMemoryTokensRejectInvalidSignaturesAndExpiry(t *testing.T) {
	tokens, err := server.NewMemoryTokens(strings.Repeat("s", 32))
	if err != nil {
		t.Fatal(err)
	}
	claims := server.TokenClaims{App: "app", Site: "site", Session: "session", Action: "default", Nonce: "nonce", Expires: time.Now().Add(time.Minute).Unix()}
	token := tokens.Issue(claims)
	if got, err := tokens.Verify(token); err != nil || got != claims {
		t.Fatalf("valid claims failed: %#v %v", got, err)
	}
	claims.Expires = time.Now().Add(-time.Second).Unix()
	for _, invalid := range []string{"", "v1.invalid.invalid", token + "corrupted", tokens.Issue(claims)} {
		if _, err := tokens.Verify(invalid); err == nil {
			t.Fatalf("invalid token accepted: %q", invalid)
		}
	}
	for _, secret := range []string{"", "too-short"} {
		if _, err := server.NewMemoryTokens(secret); err == nil {
			t.Fatal("missing or short signing secret accepted")
		}
	}
}

func TestMemoryTokensConsumeAtomically(t *testing.T) {
	tokens, err := server.NewMemoryTokens(strings.Repeat("s", 32))
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan bool, 16)
	for i := 0; i < cap(results); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- tokens.Consume("same-nonce")
		}()
	}
	wg.Wait()
	close(results)
	consumed := 0
	for success := range results {
		if success {
			consumed++
		}
	}
	if consumed != 1 {
		t.Fatalf("nonce consumed %d times, want one", consumed)
	}
}
