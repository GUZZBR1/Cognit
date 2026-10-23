package session

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
)

func fixture(t *testing.T) (*Engine, *MemoryStore, func(int64)) {
	t.Helper()
	var mu sync.Mutex
	now, n := int64(100), 0
	clock := func() int64 { mu.Lock(); defer mu.Unlock(); return now }
	setNow := func(v int64) { mu.Lock(); now = v; mu.Unlock() }
	ids := func() (string, error) { mu.Lock(); defer mu.Unlock(); n++; return fmt.Sprintf("opaque/id:%d", n), nil }
	store := NewMemoryStore()
	return New(store, WithClock(clock), WithIDGenerator(ids)), store, setNow
}

func TestCreateUpdateAndAssociatedReferences(t *testing.T) {
	e, _, setNow := fixture(t)
	ctx := context.Background()
	for _, ref := range []struct {
		k  ReferenceKind
		id string
	}{{Challenge, "c"}, {Result, "r"}, {Telemetry, "t"}} {
		if err := e.RegisterReference(ctx, "app", ref.k, ref.id); err != nil {
			t.Fatal(err)
		}
	}
	s, err := e.Create(ctx, "app", 200)
	if err != nil {
		t.Fatal(err)
	}
	if s.State != Active || s.AttemptState != Pending || s.CreatedAt != 100 || s.UpdatedAt != 100 {
		t.Fatalf("unexpected initial session: %+v", s)
	}
	setNow(125)
	succeeded := Succeeded
	challenge, result, telemetry := "c", "r", "t"
	s, err = e.Update(ctx, "app", s.ID, Update{AttemptState: &succeeded, ChallengeID: &challenge, ResultID: &result, TelemetryID: &telemetry})
	if err != nil {
		t.Fatal(err)
	}
	if s.UpdatedAt != 125 || s.AttemptState != Succeeded || s.ChallengeID != "c" || s.ResultID != "r" || s.TelemetryID != "t" {
		t.Fatalf("unexpected update: %+v", s)
	}
}

func TestRejectsInvalidUpdatesWithoutMutation(t *testing.T) {
	e, store, _ := fixture(t)
	ctx := context.Background()
	s, _ := e.Create(ctx, "app", 200)
	unknown := AttemptState("unknown")
	if _, err := e.Update(ctx, "app", s.ID, Update{AttemptState: &unknown}); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("got %v", err)
	}
	missing := "missing"
	if _, err := e.Update(ctx, "app", s.ID, Update{ChallengeID: &missing}); err == nil {
		t.Fatal("expected missing reference error")
	}
	after, _ := store.Get(ctx, "app", s.ID)
	if after.UpdatedAt != s.UpdatedAt || after.ChallengeID != "" || after.AttemptState != Pending {
		t.Fatalf("failed update mutated session: %+v", after)
	}
}

func TestAutomaticAndExplicitExpiry(t *testing.T) {
	e, _, setNow := fixture(t)
	ctx := context.Background()
	s, _ := e.Create(ctx, "app", 200)
	setNow(200)
	expired, err := e.Get(ctx, "app", s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if expired.State != Expired || expired.ExpiredAt == nil || *expired.ExpiredAt != 200 || expired.UpdatedAt != 200 {
		t.Fatalf("unexpected expiration: %+v", expired)
	}
	if _, err = e.Update(ctx, "app", s.ID, Update{}); !errors.Is(err, ErrExpired) {
		t.Fatalf("got %v", err)
	}
	s2, _ := e.Create(ctx, "app", 300)
	setNow(150)
	expired, err = e.Expire(ctx, "app", s2.ID)
	if err != nil {
		t.Fatal(err)
	}
	if expired.ExpiredAt == nil || *expired.ExpiredAt != 150 {
		t.Fatalf("unexpected explicit expiration: %+v", expired)
	}
	setNow(175)
	expired, _ = e.Expire(ctx, "app", s2.ID)
	if *expired.ExpiredAt != 150 {
		t.Fatalf("expiry time changed: %+v", expired)
	}
}

func TestUpdateAtExpiryBoundaryPersistsExpiry(t *testing.T) {
	ctx := context.Background()
	now := []int64{100, 199, 200}
	store := NewMemoryStore()
	e := New(store,
		WithClock(func() int64 { value := now[0]; now = now[1:]; return value }),
		WithIDGenerator(func() (string, error) { return "session", nil }),
	)
	s, err := e.Create(ctx, "app", 200)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.Update(ctx, "app", s.ID, Update{}); !errors.Is(err, ErrExpired) {
		t.Fatalf("got %v", err)
	}
	stored, err := store.Get(ctx, "app", s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.State != Expired || stored.ExpiredAt == nil || *stored.ExpiredAt != 200 {
		t.Fatalf("expiry was not persisted: %+v", stored)
	}
}

func TestAppIsolationForSessionsAndReferences(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	e := New(store, WithClock(func() int64 { return 100 }), WithIDGenerator(func() (string, error) { return "shared/id:opaque", nil }))
	e.RegisterReference(ctx, "app-b", Challenge, "shared")
	first, err := e.Create(ctx, "app-a", 200)
	if err != nil {
		t.Fatal(err)
	}
	second, err := e.Create(ctx, "app-b", 200)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != second.ID {
		t.Fatalf("fixture should reuse the opaque ID, got %q and %q", first.ID, second.ID)
	}
	if got, err := e.Get(ctx, "app-a", first.ID); err != nil || got.AppID != "app-a" {
		t.Fatalf("app-a lookup = %+v, %v", got, err)
	}
	if got, err := e.Get(ctx, "app-b", second.ID); err != nil || got.AppID != "app-b" {
		t.Fatalf("app-b lookup = %+v, %v", got, err)
	}
	shared := "shared"
	if _, err := e.Update(ctx, "app-a", first.ID, Update{ChallengeID: &shared}); err == nil {
		t.Fatal("cross-app reference accepted")
	}
	if _, err := e.Get(ctx, "other-app", first.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v", err)
	}
}

func TestConcurrentCreateAndUpdate(t *testing.T) {
	e, store, _ := fixture(t)
	ctx := context.Background()
	const n = 32
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s, err := e.Create(ctx, "app", 200)
			if err == nil {
				_, err = e.Update(ctx, "app", s.ID, Update{})
			}
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	// Concurrent store updates are serialized and every created session is retained.
	if len(store.sessions) != n {
		t.Fatalf("got %d sessions, want %d", len(store.sessions), n)
	}
}
