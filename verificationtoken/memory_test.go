package verificationtoken

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
)

func TestInMemoryNonceStoreConformance(t *testing.T) {
	testNonceStoreConformance(t, func() NonceStore { return &InMemoryNonceStore{} })
}

// Reuse this contract suite for additional adapters. Distributed adapters also
// need equivalent tests against independent clients/processes and real storage.
func testNonceStoreConformance(t *testing.T, factory func() NonceStore) {
	t.Helper()
	ctx := context.Background()
	t.Run("first use and independent nonce", func(t *testing.T) {
		store := factory()
		for _, step := range []struct {
			nonce   string
			expires int64
			now     int64
			want    bool
		}{
			{"one", 10, 1, true},
			{"one", 20, 2, false}, // Replay must not extend retention.
			{"two", 10, 2, true},
			{"one", 9, 3, false}, // Replay must not shorten retention.
			{"one", 20, 9, false},
			{"one", 20, 10, true}, // Original retention ends exactly at 10.
			{"one", 20, 10, false},
		} {
			got, err := store.ConsumeOnce(ctx, step.nonce, step.expires, step.now)
			if err != nil || got != step.want {
				t.Fatalf("ConsumeOnce(%q, %d, %d) = %v, %v; want %v", step.nonce, step.expires, step.now, got, err, step.want)
			}
		}
	})
	t.Run("expiry does not reserve nonce", func(t *testing.T) {
		store := factory()
		for _, expiry := range []int64{9, 10} {
			got, err := store.ConsumeOnce(ctx, "one", expiry, 10)
			if got || err != nil {
				t.Fatalf("expired nonce accepted: %v, %v", got, err)
			}
		}
		if got, err := store.ConsumeOnce(ctx, "one", 20, 10); !got || err != nil {
			t.Fatalf("expired attempt reserved nonce: %v, %v", got, err)
		}
	})
	t.Run("cancellation", func(t *testing.T) {
		store := factory()
		canceled, cancel := context.WithCancel(ctx)
		cancel()
		if got, err := store.ConsumeOnce(canceled, "one", 10, 1); got || !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled consume = %v, %v", got, err)
		}
		if got, err := store.ConsumeOnce(ctx, "one", 10, 1); !got || err != nil {
			t.Fatalf("canceled attempt reserved nonce: %v, %v", got, err)
		}
	})
	t.Run("atomic concurrent consumption", func(t *testing.T) {
		store := factory()
		var accepted, failed atomic.Int32
		var wg sync.WaitGroup
		start := make(chan struct{})
		for i := 0; i < 64; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				got, err := store.ConsumeOnce(ctx, "one", 10, 1)
				if err != nil {
					failed.Add(1)
				}
				if got {
					accepted.Add(1)
				}
			}()
		}
		close(start)
		wg.Wait()
		if accepted.Load() != 1 || failed.Load() != 0 {
			t.Fatalf("accepted=%d storage errors=%d", accepted.Load(), failed.Load())
		}
	})
}

func TestInMemoryNonceStorePrunesExpiredEntries(t *testing.T) {
	store := &InMemoryNonceStore{}
	if _, err := store.ConsumeOnce(context.Background(), "expired", 2, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ConsumeOnce(context.Background(), "live", 10, 2); err != nil {
		t.Fatal(err)
	}
	if _, retained := store.consumed["expired"]; retained {
		t.Fatal("expired entry retained")
	}
	if len(store.consumed) != 1 {
		t.Fatalf("expected one live entry, got %d", len(store.consumed))
	}
}
