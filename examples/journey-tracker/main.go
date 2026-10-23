// Command journey-tracker emits local in-memory journey events and prints their timeline.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/GUZZBR1/Cognit/journey"
)

func main() {
	sessionID := flag.String("session", "", "required session reference")
	atText := flag.String("at", "", "optional RFC3339 timestamp used for each event")
	flag.Parse()

	tracker, err := journey.New(*sessionID)
	if err != nil {
		fail(err)
	}
	var at time.Time
	if *atText != "" {
		at, err = time.Parse(time.RFC3339, *atText)
		if err != nil {
			fail(fmt.Errorf("invalid -at timestamp: %w", err))
		}
	}
	for _, eventType := range flag.Args() {
		if at.IsZero() {
			_, err = tracker.Emit(eventType)
		} else {
			_, err = tracker.Emit(eventType, at)
		}
		if err != nil {
			fail(err)
		}
	}
	if err := json.NewEncoder(os.Stdout).Encode(tracker.Timeline()); err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(2)
}
