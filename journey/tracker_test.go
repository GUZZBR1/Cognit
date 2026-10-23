package journey

import (
	"errors"
	"testing"
	"time"
)

func TestNewRequiresSession(t *testing.T) {
	for _, session := range []string{"", "  \t"} {
		if _, err := New(session); !errors.Is(err, ErrMissingSession) {
			t.Fatalf("New(%q) error = %v, want ErrMissingSession", session, err)
		}
	}
}

func TestEmitAllowlistAndSequence(t *testing.T) {
	tracker, err := New("session-1")
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2025, 1, 2, 3, 4, 5, 0, time.FixedZone("offset", 2*60*60))
	allowedTypes := []string{Navigation, Action, Challenge, Attempt, Retry}
	for index, eventType := range allowedTypes {
		event, err := tracker.Emit(eventType, at)
		if err != nil {
			t.Fatalf("Emit(%q): %v", eventType, err)
		}
		if event.Sequence != uint64(index) || event.SessionID != "session-1" {
			t.Fatalf("unexpected emitted event: %+v", event)
		}
		if event.Timestamp.Location() != time.UTC || !event.Timestamp.Equal(at) {
			t.Fatalf("timestamp was not normalized to UTC: %v", event.Timestamp)
		}
	}
	if _, err := tracker.Emit("other", at); !errors.Is(err, ErrInvalidEventType) {
		t.Fatalf("invalid event error = %v, want ErrInvalidEventType", err)
	}
}

func TestTimelineSortsByTimestampThenSequence(t *testing.T) {
	tracker, _ := New("session-1")
	base := time.Date(2025, 1, 2, 3, 4, 5, 0, time.UTC)
	inputs := []struct {
		typeName string
		at       time.Time
	}{
		{Action, base.Add(time.Minute)},
		{Navigation, base},
		{Retry, base},
	}
	for _, input := range inputs {
		if _, err := tracker.Emit(input.typeName, input.at); err != nil {
			t.Fatal(err)
		}
	}
	timeline := tracker.Timeline()
	want := []string{Navigation, Retry, Action}
	for i, event := range timeline {
		if event.EventType != want[i] {
			t.Fatalf("timeline[%d] = %q, want %q", i, event.EventType, want[i])
		}
	}
	if timeline[0].Sequence != 1 || timeline[1].Sequence != 2 {
		t.Fatalf("equal timestamps did not preserve emission sequence: %+v", timeline[:2])
	}
	// Returned timelines are snapshots and cannot mutate stored events.
	timeline[0].EventType = "changed"
	if tracker.Timeline()[0].EventType != Navigation {
		t.Fatal("mutating timeline snapshot changed tracker state")
	}
}

func TestTrackersKeepSessionsIsolated(t *testing.T) {
	first, _ := New("first")
	second, _ := New("second")
	if _, err := first.Emit(Action); err != nil {
		t.Fatal(err)
	}
	if len(second.Timeline()) != 0 {
		t.Fatal("one tracker's event appeared in another session")
	}
}

func TestEmitRejectsInvalidTimestamps(t *testing.T) {
	tracker, _ := New("session")
	if _, err := tracker.Emit(Action, time.Time{}); !errors.Is(err, ErrInvalidTimestamp) {
		t.Fatalf("zero timestamp error = %v, want ErrInvalidTimestamp", err)
	}
	if _, err := tracker.Emit(Action, time.Now(), time.Now()); !errors.Is(err, ErrInvalidTimestamp) {
		t.Fatalf("multiple timestamp error = %v, want ErrInvalidTimestamp", err)
	}
}
