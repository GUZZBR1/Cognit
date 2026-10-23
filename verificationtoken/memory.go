package verificationtoken

import (
	"context"
	"sync"
)

// InMemoryNonceStore is a mutex-protected, process-local demo adapter. Its zero
// value is ready to use. State is lost on restart; never use independent copies
// across production verifiers. Expired entries are pruned on each call.
type InMemoryNonceStore struct {
	mu       sync.Mutex
	consumed map[string]int64
}

var _ NonceStore = (*InMemoryNonceStore)(nil)

// ConsumeOnce records nonce until expiresAt if it is live and not yet consumed.
// A replay cannot extend or shorten the original entry's retention.
func (s *InMemoryNonceStore) ConsumeOnce(ctx context.Context, nonce string, expiresAt, now int64) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return false, err
	}
	for key, expiry := range s.consumed {
		if expiry <= now {
			delete(s.consumed, key)
		}
	}
	if !validIdentifier(nonce) || expiresAt <= now {
		return false, nil
	}
	if _, exists := s.consumed[nonce]; exists {
		return false, nil
	}
	if s.consumed == nil {
		s.consumed = make(map[string]int64)
	}
	s.consumed[nonce] = expiresAt
	return true, nil
}
