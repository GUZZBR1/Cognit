// Package journey records allowlisted events in an in-memory session timeline.
package journey

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	Navigation = "navigation"
	Action     = "action"
	Challenge  = "challenge"
	Attempt    = "attempt"
	Retry      = "retry"
)

var (
	ErrMissingSession   = errors.New("session ID must be a non-empty string")
	ErrInvalidEventType = errors.New("unsupported journey event type")
	ErrInvalidTimestamp = errors.New("timestamp must be a valid timezone-aware time")
)

// Event is an immutable snapshot of an emitted event. Timestamps are UTC.
type Event struct {
	SessionID string    `json:"session_id"`
	EventType string    `json:"event_type"`
	Timestamp time.Time `json:"timestamp"`
	Sequence  uint64    `json:"sequence"`
}

// Tracker stores events for exactly one caller-provided session reference.
type Tracker struct {
	sessionID string
	mu        sync.RWMutex
	events    []Event
}

// New creates a tracker bound to a required, non-blank session ID.
func New(sessionID string) (*Tracker, error) {
	if strings.TrimSpace(sessionID) == "" {
		return nil, ErrMissingSession
	}
	return &Tracker{sessionID: sessionID}, nil
}

// Emit appends an allowlisted event. With no timestamp, the current time is used.
// A supplied zero time is rejected because it does not identify a meaningful instant.
func (t *Tracker) Emit(eventType string, timestamps ...time.Time) (Event, error) {
	if !allowed(eventType) {
		return Event{}, fmt.Errorf("%w: %q", ErrInvalidEventType, eventType)
	}
	if len(timestamps) > 1 {
		return Event{}, fmt.Errorf("%w: expected at most one timestamp", ErrInvalidTimestamp)
	}
	at := time.Now()
	if len(timestamps) == 1 {
		at = timestamps[0]
		if at.IsZero() {
			return Event{}, ErrInvalidTimestamp
		}
	}

	t.mu.Lock()
	defer t.mu.Unlock()
	event := Event{
		SessionID: t.sessionID,
		EventType: eventType,
		Timestamp: at.UTC(),
		Sequence:  uint64(len(t.events)),
	}
	t.events = append(t.events, event)
	return event, nil
}

// Timeline returns a copy ordered by timestamp and then emission sequence.
func (t *Tracker) Timeline() []Event {
	t.mu.RLock()
	defer t.mu.RUnlock()
	result := append([]Event(nil), t.events...)
	sort.Slice(result, func(i, j int) bool {
		if result[i].Timestamp.Equal(result[j].Timestamp) {
			return result[i].Sequence < result[j].Sequence
		}
		return result[i].Timestamp.Before(result[j].Timestamp)
	})
	return result
}

func allowed(eventType string) bool {
	switch eventType {
	case Navigation, Action, Challenge, Attempt, Retry:
		return true
	default:
		return false
	}
}
