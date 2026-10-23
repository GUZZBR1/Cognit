// Package session provides a small app-scoped session runtime.
package session

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"
)

type State string
type AttemptState string
type ReferenceKind string

const (
	Active  State = "active"
	Expired State = "expired"

	Pending   AttemptState = "pending"
	Succeeded AttemptState = "succeeded"
	Failed    AttemptState = "failed"

	Challenge ReferenceKind = "challenge"
	Result    ReferenceKind = "result"
	Telemetry ReferenceKind = "telemetry"
)

var (
	ErrNotFound       = errors.New("session does not exist for app")
	ErrExpired        = errors.New("session is expired")
	ErrDuplicate      = errors.New("session id already exists for app")
	ErrInvalidExpiry  = errors.New("expiresAt must be later than the current time")
	ErrInvalidPayload = errors.New("invalid session update")
)

// Timestamps are Unix epoch milliseconds, matching the TypeScript runtime.
type Session struct {
	ID           string       `json:"id"`
	AppID        string       `json:"appId"`
	State        State        `json:"state"`
	AttemptState AttemptState `json:"attemptState"`
	CreatedAt    int64        `json:"createdAt"`
	UpdatedAt    int64        `json:"updatedAt"`
	ExpiresAt    int64        `json:"expiresAt"`
	ExpiredAt    *int64       `json:"expiredAt,omitempty"`
	ChallengeID  string       `json:"challengeId,omitempty"`
	ResultID     string       `json:"resultId,omitempty"`
	TelemetryID  string       `json:"telemetryId,omitempty"`
}

type ReferenceRequirement struct {
	Kind ReferenceKind
	ID   string
}

type Update struct {
	AttemptState *AttemptState
	ChallengeID  *string
	ResultID     *string
	TelemetryID  *string
}

// Store implementations must make Create atomic with respect to the (appID, ID)
// key, Get atomic as a snapshot, and Update atomic across lookup, callback,
// reference checks, and commit. Update must not commit when its callback or
// reference validation returns an error. Reference registration and checks must
// be safe for concurrent callers and scoped by app and kind.
type Store interface {
	Create(context.Context, Session) error
	Get(context.Context, string, string) (Session, error)
	Update(context.Context, string, string, []ReferenceRequirement, func(*Session) error) (Session, error)
	RegisterReference(context.Context, string, ReferenceKind, string) error
}

type Engine struct {
	store Store
	now   func() int64
	newID func() (string, error)
}

type Option func(*Engine)

func WithClock(now func() int64) Option                  { return func(e *Engine) { e.now = now } }
func WithIDGenerator(next func() (string, error)) Option { return func(e *Engine) { e.newID = next } }

func New(store Store, options ...Option) *Engine {
	e := &Engine{store: store, now: func() int64 { return time.Now().UnixMilli() }, newID: randomID}
	for _, option := range options {
		option(e)
	}
	return e
}

func (e *Engine) RegisterReference(ctx context.Context, appID string, kind ReferenceKind, id string) error {
	if !identifier(appID) || !identifier(id) || !validKind(kind) {
		return ErrInvalidPayload
	}
	return e.store.RegisterReference(ctx, appID, kind, id)
}

func (e *Engine) Create(ctx context.Context, appID string, expiresAt int64) (Session, error) {
	if !identifier(appID) {
		return Session{}, fmt.Errorf("appId is required")
	}
	now := e.now()
	if expiresAt <= now {
		return Session{}, ErrInvalidExpiry
	}
	id, err := e.newID()
	if err != nil {
		return Session{}, err
	}
	if !identifier(id) {
		return Session{}, fmt.Errorf("session id is required")
	}
	s := Session{ID: id, AppID: appID, State: Active, AttemptState: Pending, CreatedAt: now, UpdatedAt: now, ExpiresAt: expiresAt}
	if err := e.store.Create(ctx, s); err != nil {
		return Session{}, err
	}
	return clone(s), nil
}

func (e *Engine) Get(ctx context.Context, appID, id string) (Session, error) {
	return e.store.Update(ctx, appID, id, nil, func(s *Session) error { e.expireIfDue(s); return nil })
}

func (e *Engine) Update(ctx context.Context, appID, id string, update Update) (Session, error) {
	if !identifier(appID) || !identifier(id) {
		return Session{}, ErrNotFound
	}
	// Resolve and persist lazy expiry first, so a rejected update still observes the
	// same expiry transition as Get.
	current, err := e.Get(ctx, appID, id)
	if err != nil {
		return Session{}, err
	}
	if current.State != Active {
		return Session{}, ErrExpired
	}
	refs := make([]ReferenceRequirement, 0, 3)
	for _, ref := range []struct {
		kind  ReferenceKind
		value *string
	}{{Challenge, update.ChallengeID}, {Result, update.ResultID}, {Telemetry, update.TelemetryID}} {
		if ref.value == nil {
			continue
		}
		if !identifier(*ref.value) {
			return Session{}, ErrInvalidPayload
		}
		refs = append(refs, ReferenceRequirement{Kind: ref.kind, ID: *ref.value})
	}
	if update.AttemptState != nil && *update.AttemptState != Pending && *update.AttemptState != Succeeded && *update.AttemptState != Failed {
		return Session{}, ErrInvalidPayload
	}
	expired := false
	updated, err := e.store.Update(ctx, appID, id, refs, func(s *Session) error {
		e.expireIfDue(s)
		if s.State != Active {
			expired = true
			return nil
		}
		if update.AttemptState != nil {
			s.AttemptState = *update.AttemptState
		}
		if update.ChallengeID != nil {
			s.ChallengeID = *update.ChallengeID
		}
		if update.ResultID != nil {
			s.ResultID = *update.ResultID
		}
		if update.TelemetryID != nil {
			s.TelemetryID = *update.TelemetryID
		}
		s.UpdatedAt = e.now()
		return nil
	})
	if err != nil {
		return Session{}, err
	}
	if expired {
		return Session{}, ErrExpired
	}
	return updated, nil
}

func (e *Engine) Expire(ctx context.Context, appID, id string) (Session, error) {
	return e.store.Update(ctx, appID, id, nil, func(s *Session) error {
		if s.State == Active {
			now := e.now()
			s.State = Expired
			s.ExpiredAt = &now
			s.UpdatedAt = now
		}
		return nil
	})
}

func (e *Engine) expireIfDue(s *Session) {
	now := e.now()
	if s.State == Active && now >= s.ExpiresAt {
		s.State = Expired
		s.ExpiredAt = &now
		s.UpdatedAt = now
	}
}

func identifier(s string) bool       { return s != "" }
func validKind(k ReferenceKind) bool { return k == Challenge || k == Result || k == Telemetry }
func clone(s Session) Session {
	if s.ExpiredAt != nil {
		t := *s.ExpiredAt
		s.ExpiredAt = &t
	}
	return s
}

func randomID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// MemoryStore is a concurrency-safe in-memory Store implementation.
type MemoryStore struct {
	// The single mutex makes all session and reference operations linearizable.
	mu         sync.Mutex
	sessions   map[scope]Session
	references map[referenceScope]map[string]struct{}
}

type scope struct{ appID, id string }
type referenceScope struct {
	appID string
	kind  ReferenceKind
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{sessions: make(map[scope]Session), references: make(map[referenceScope]map[string]struct{})}
}

func (m *MemoryStore) Create(ctx context.Context, s Session) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	key := scope{s.AppID, s.ID}
	if _, exists := m.sessions[key]; exists {
		return ErrDuplicate
	}
	m.sessions[key] = clone(s)
	return nil
}

func (m *MemoryStore) Get(ctx context.Context, appID, id string) (Session, error) {
	if err := ctx.Err(); err != nil {
		return Session{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[scope{appID, id}]
	if !ok {
		return Session{}, ErrNotFound
	}
	return clone(s), nil
}

func (m *MemoryStore) Update(ctx context.Context, appID, id string, refs []ReferenceRequirement, fn func(*Session) error) (Session, error) {
	if err := ctx.Err(); err != nil {
		return Session{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	key := scope{appID, id}
	s, ok := m.sessions[key]
	if !ok {
		return Session{}, ErrNotFound
	}
	next := clone(s)
	if err := fn(&next); err != nil {
		return Session{}, err
	}
	if next.State != Expired {
		for _, ref := range refs {
			if _, ok := m.references[referenceScope{appID, ref.Kind}][ref.ID]; !ok {
				return Session{}, fmt.Errorf("%s reference does not exist for app", ref.Kind)
			}
		}
	}
	m.sessions[key] = clone(next)
	return clone(next), nil
}

func (m *MemoryStore) RegisterReference(ctx context.Context, appID string, kind ReferenceKind, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	key := referenceScope{appID, kind}
	if m.references[key] == nil {
		m.references[key] = make(map[string]struct{})
	}
	m.references[key][id] = struct{}{}
	return nil
}
