// Package server implements a single-process reference verification API.
package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Config holds application credentials and process-local request limits.
type Config struct {
	ApplicationKeys                                                    map[string]string // bearer key -> application ID
	SigningSecret                                                      string            // independent HMAC secret, at least 32 bytes
	SessionLimit, ChallengeLimit, ResultLimit, VerifyLimit, TokenLimit int
	Window, TokenTTL                                                   time.Duration
}

// Session is the server-owned state for one application verification attempt.
type Session struct {
	ID, App, Site, State string
	Expires              time.Time
	Attempt              string
	Challenge            *ChallengeRecord
	Token                string
}

// ChallengeRecord keeps the private expected answer separate from public presentation data.
type ChallengeRecord struct {
	ID, Type, Answer string
	Expires          time.Time
	Presentation     ChallengePresentation
}

// TokenClaims binds a token to trusted server-side application context.
type TokenClaims struct {
	App, Site, Session, Action string
	Expires                    int64
	Nonce                      string
}
type quota struct {
	Start time.Time
	Count int
}

// SessionStore persists session snapshots. Get returns a detached copy; Put saves it.
// Implementations must make Get/Put safe for concurrent use.
type SessionStore interface {
	Get(string) (*Session, bool)
	Put(*Session)
}

// MemorySessions is a thread-safe, process-local SessionStore.
type MemorySessions struct {
	mu     sync.Mutex
	values map[string]*Session
}

func NewMemorySessions() *MemorySessions { return &MemorySessions{values: map[string]*Session{}} }
func (m *MemorySessions) Get(id string) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.values[id]
	return cloneSession(s), ok
}
func (m *MemorySessions) Put(s *Session) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.values[s.ID] = cloneSession(s)
}

func cloneSession(s *Session) *Session {
	if s == nil {
		return nil
	}
	copy := *s
	if s.Challenge != nil {
		challenge := *s.Challenge
		challenge.Presentation.Choices = append([]string(nil), challenge.Presentation.Choices...)
		challenge.Presentation.Order = append([]string(nil), challenge.Presentation.Order...)
		copy.Challenge = &challenge
	}
	return &copy
}

// Server routes the v0 HTTP API.
type Server struct {
	cfg        Config
	mux        *http.ServeMux
	mu         sync.Mutex
	sessions   SessionStore
	challenges ChallengeProvider
	policy     DecisionPolicy
	tokens     TokenService
	quotas     map[string]*quota
}

// New creates a server using in-memory state and token replay protection.
func New(cfg Config) (*Server, error) {
	return NewWithAdapters(cfg, Adapters{})
}

// NewWithAdapters accepts domain adapters; omitted adapters use process-local defaults.
// One Server serializes domain operations. Shared adapters across servers require
// their own atomic session transitions in addition to atomic token consumption.
func NewWithAdapters(cfg Config, adapters Adapters) (*Server, error) {
	if len(cfg.ApplicationKeys) == 0 {
		return nil, errors.New("at least one application key is required")
	}
	for key, app := range cfg.ApplicationKeys {
		if len(key) < 32 || strings.TrimSpace(app) == "" {
			return nil, errors.New("application keys must be at least 32 bytes and map to an app")
		}
	}
	if cfg.Window <= 0 {
		cfg.Window = time.Minute
	}
	if cfg.TokenTTL <= 0 {
		cfg.TokenTTL = time.Minute
	}
	if cfg.TokenTTL > 5*time.Minute {
		return nil, errors.New("token TTL must be at most five minutes")
	}
	for _, limit := range []*int{&cfg.SessionLimit, &cfg.ChallengeLimit, &cfg.ResultLimit, &cfg.VerifyLimit, &cfg.TokenLimit} {
		if *limit <= 0 {
			*limit = 60
		}
	}
	keys := make(map[string]string, len(cfg.ApplicationKeys))
	for key, app := range cfg.ApplicationKeys {
		keys[key] = app
	}
	cfg.ApplicationKeys = keys
	if adapters.Sessions == nil {
		adapters.Sessions = NewMemorySessions()
	}
	if adapters.Challenges == nil {
		adapters.Challenges = SampleChallenges{}
	}
	if adapters.Policy == nil {
		adapters.Policy = AnswerPolicy{}
	}
	if adapters.Tokens == nil {
		tokens, err := NewMemoryTokens(cfg.SigningSecret)
		if err != nil {
			return nil, err
		}
		adapters.Tokens = tokens
	}
	s := &Server{cfg: cfg, mux: http.NewServeMux(), sessions: adapters.Sessions, challenges: adapters.Challenges, policy: adapters.Policy, tokens: adapters.Tokens, quotas: map[string]*quota{}}
	s.mux.HandleFunc("/v0/sessions", s.create)
	s.mux.HandleFunc("/v0/sessions/", s.sessionRoute)
	s.mux.HandleFunc("/v0/tokens/validate", s.validate)
	s.mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		s.fail(w, 404, "not_found", "resource not found")
	})
	return s, nil
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

func (s *Server) auth(w http.ResponseWriter, r *http.Request, op string, limit int) (string, bool) {
	if r.Method != http.MethodPost {
		s.fail(w, 405, "invalid_request", "POST is required")
		return "", false
	}
	parts := strings.SplitN(r.Header.Get("Authorization"), " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		s.fail(w, 401, "unauthorized", "invalid application credential")
		return "", false
	}
	app, ok := s.cfg.ApplicationKeys[parts[1]]
	if !ok {
		s.fail(w, 401, "unauthorized", "invalid application credential")
		return "", false
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	key := app + ":" + op
	q := s.quotas[key]
	if q == nil || now.Sub(q.Start) >= s.cfg.Window {
		q = &quota{Start: now}
		s.quotas[key] = q
	}
	if q.Count >= limit {
		remaining := s.cfg.Window - now.Sub(q.Start)
		retry := int(remaining.Seconds())
		if retry < 1 {
			retry = 1
		}
		w.Header().Set("Retry-After", fmt.Sprint(retry))
		s.fail(w, 429, "rate_limited", "request quota exceeded")
		return "", false
	}
	q.Count++
	return app, true
}

func (s *Server) create(w http.ResponseWriter, r *http.Request) {
	app, ok := s.auth(w, r, "session", s.cfg.SessionLimit)
	if !ok {
		return
	}
	var in struct {
		Site string          `json:"site_id"`
		TTL  json.RawMessage `json:"ttl_seconds"`
	}
	if !s.decode(w, r, &in) {
		return
	}
	ttl := 600
	if in.TTL != nil && (string(in.TTL) == "null" || json.Unmarshal(in.TTL, &ttl) != nil || ttl < 1 || ttl > 1800) {
		s.fail(w, 400, "invalid_request", "invalid session request")
		return
	}
	if strings.TrimSpace(in.Site) == "" {
		s.fail(w, 400, "invalid_request", "invalid session request")
		return
	}
	x := &Session{ID: randomID(), App: app, Site: in.Site, State: "active", Attempt: "pending", Expires: time.Now().Add(time.Duration(ttl) * time.Second)}
	s.mu.Lock()
	s.sessions.Put(x)
	s.mu.Unlock()
	s.json(w, 201, map[string]any{"session_id": x.ID, "state": x.State, "attempt_state": x.Attempt, "expires_at": x.Expires})
}

func (s *Server) sessionRoute(w http.ResponseWriter, r *http.Request) {
	tail := strings.TrimPrefix(r.URL.Path, "/v0/sessions/")
	parts := strings.Split(tail, "/")
	if len(parts) != 2 || parts[0] == "" {
		s.fail(w, 404, "not_found", "resource not found")
		return
	}
	op := parts[1]
	limits := map[string]int{"challenge": s.cfg.ChallengeLimit, "result": s.cfg.ResultLimit, "verify": s.cfg.VerifyLimit}
	limit, valid := limits[op]
	if !valid {
		s.fail(w, 404, "not_found", "resource not found")
		return
	}
	app, ok := s.auth(w, r, op, limit)
	if !ok {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	x, ok := s.sessions.Get(parts[0])
	if !ok || x.App != app {
		s.fail(w, 404, "not_found", "session not found")
		return
	}
	defer func() { s.sessions.Put(x) }()
	if !time.Now().Before(x.Expires) {
		x.State = "expired"
	}
	switch op {
	case "challenge":
		s.challenge(w, r, x)
	case "result":
		s.result(w, r, x)
	case "verify":
		response := map[string]any{"session_id": x.ID, "state": x.State, "attempt_state": x.Attempt}
		if x.State == "active" && x.Attempt == "succeeded" && x.Token != "" {
			response["token"] = x.Token
		}
		s.json(w, 200, response)
	}
}

func (s *Server) challenge(w http.ResponseWriter, r *http.Request, x *Session) {
	if x.State != "active" {
		s.fail(w, 400, "expired", "session is expired")
		return
	}
	if x.Attempt != "pending" {
		s.fail(w, 400, "invalid_request", "verification attempt is complete")
		return
	}
	var in struct {
		Type string `json:"challenge_type"`
	}
	if !s.decode(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Type) == "" {
		s.fail(w, 400, "invalid_request", "invalid challenge request")
		return
	}
	c := s.challenges.Generate(in.Type)
	x.Challenge = c
	s.json(w, 200, c.Presentation)
}

func (s *Server) result(w http.ResponseWriter, r *http.Request, x *Session) {
	var in SubmittedResult
	if !s.decode(w, r, &in) {
		return
	}
	if in.ChallengeID == "" || in.Answer == "" || in.Reaction < 0 {
		s.fail(w, 400, "invalid_request", "invalid result request")
		return
	}
	if x.Attempt != "pending" {
		s.fail(w, 400, "invalid_request", "verification attempt is complete")
		return
	}
	c := x.Challenge
	if c == nil || c.ID != in.ChallengeID {
		s.fail(w, 404, "not_found", "challenge not found")
		return
	}
	if !time.Now().Before(c.Expires) || x.State != "active" {
		x.Attempt = "failed"
		s.fail(w, 400, "expired", "challenge or session expired")
		return
	}
	accepted := s.policy.Accept(*x, *c, in)
	if accepted {
		x.Attempt = "succeeded"
		x.Token = s.issue(x, "default")
	} else {
		x.Attempt = "failed"
	}
	s.json(w, 200, map[string]any{"result_id": randomID(), "accepted": accepted, "state": x.Attempt})
}

func (s *Server) validate(w http.ResponseWriter, r *http.Request) {
	app, ok := s.auth(w, r, "token", s.cfg.TokenLimit)
	if !ok {
		return
	}
	var in struct {
		Token   string `json:"token"`
		Site    string `json:"site_id"`
		Session string `json:"session_id"`
		Action  string `json:"action"`
	}
	if !s.decode(w, r, &in) {
		return
	}
	if in.Token == "" || in.Site == "" || in.Session == "" || in.Action == "" {
		s.fail(w, 400, "invalid_request", "invalid token request")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	x, exists := s.sessions.Get(in.Session)
	if !exists || x.App != app || x.Site != in.Site || !time.Now().Before(x.Expires) || x.Attempt != "succeeded" || x.Token == "" {
		s.fail(w, 404, "not_found", "verification token not found")
		return
	}
	claims, err := s.tokens.Verify(in.Token)
	if err != nil || claims.App != app || claims.Site != in.Site || claims.Session != x.ID || claims.Action != in.Action || in.Token != x.Token {
		s.fail(w, 400, "invalid_token", "invalid verification token")
		return
	}
	if !s.tokens.Consume(claims.Nonce) {
		s.fail(w, 400, "invalid_token", "invalid verification token")
		return
	}
	s.json(w, 200, map[string]any{"valid": true, "action": claims.Action, "expires_at": time.Unix(claims.Expires, 0)})
}

func (s *Server) issue(x *Session, action string) string {
	c := TokenClaims{App: x.App, Site: x.Site, Session: x.ID, Action: action, Expires: time.Now().Add(s.cfg.TokenTTL).Unix(), Nonce: randomID()}
	return s.tokens.Issue(c)
}
func (s *Server) decode(w http.ResponseWriter, r *http.Request, v any) bool {
	d := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	d.DisallowUnknownFields()
	if d.Decode(v) != nil {
		s.fail(w, 400, "invalid_request", "invalid JSON body")
		return false
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		s.fail(w, 400, "invalid_request", "invalid JSON body")
		return false
	}
	return true
}
func (s *Server) json(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func (s *Server) fail(w http.ResponseWriter, status int, code, message string) {
	s.json(w, status, map[string]any{"error": map[string]string{"code": code, "message": message, "request_id": randomID()}})
}
func randomID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		sum := sha256.Sum256([]byte(time.Now().String()))
		return hex.EncodeToString(sum[:16])
	}
	return hex.EncodeToString(b)
}
