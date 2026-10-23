package main

import (
	"context"
	"fmt"
	"log"

	"github.com/GUZZBR1/Cognit/go/session"
)

func main() {
	ctx := context.Background()
	engine := session.New(session.NewMemoryStore())
	created, err := engine.Create(ctx, "demo-app", 1<<62)
	if err != nil {
		log.Fatal(err)
	}
	state := session.Succeeded
	updated, err := engine.Update(ctx, "demo-app", created.ID, session.Update{AttemptState: &state})
	if err != nil {
		log.Fatal(err)
	}
	loaded, err := engine.Get(ctx, "demo-app", updated.ID)
	if err != nil {
		log.Fatal(err)
	}
	expired, err := engine.Expire(ctx, "demo-app", loaded.ID)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("created=%s updated=%s loaded=%s expired=%s\n", created.State, updated.AttemptState, loaded.State, expired.State)
}
