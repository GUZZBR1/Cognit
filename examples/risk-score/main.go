// Command risk-score demonstrates the advisory score with a local JSON fixture.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/GUZZBR1/Cognit/risk_score"
)

func main() {
	path := "examples/risk-score/fixture.json"
	if len(os.Args) > 1 {
		path = os.Args[1]
	}
	file, err := os.Open(path)
	if err != nil {
		fatal(err)
	}
	defer file.Close()
	var input riskscore.Input
	if err := json.NewDecoder(file).Decode(&input); err != nil {
		fatal(err)
	}
	if err := json.NewEncoder(os.Stdout).Encode(riskscore.ScoreRisk(input)); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
