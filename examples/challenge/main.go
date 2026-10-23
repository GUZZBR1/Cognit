package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"time"

	"github.com/GUZZBR1/Cognit/challenge"
)

func main() {
	service, err := challenge.NewService(2 * time.Minute)
	if err != nil {
		log.Fatal(err)
	}
	config := challenge.Config{
		Stimulus:    "blue square",
		Positions:   []string{"left", "center", "right"},
		Order:       []string{"blue", "green", "red"},
		DurationMS:  1500,
		Question:    "Which color was shown?",
		Distractors: []string{"black", "white"},
	}
	issued, err := service.Generate("fixture-seed-v1", config)
	if err != nil {
		log.Fatal(err)
	}
	payload, err := json.MarshalIndent(issued, "", "  ")
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("Client challenge:\n%s\n", payload)

	fmt.Print("Your answer: ")
	answer, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		log.Fatal(err)
	}
	// The submitted answer is checked against the private key held by service.
	fmt.Printf("Answer accepted: %t\n", service.ValidateAnswer(issued.ChallengeID, strings.TrimSpace(answer)))
}
