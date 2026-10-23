package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log"

	"github.com/GUZZBR1/Cognit/verificationtoken"
)

func main() {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		log.Fatal(err)
	}

	service, err := verificationtoken.New(verificationtoken.Config{
		ApplicationSecrets: map[string][]byte{"demo-app": secret},
		NonceStore:         &verificationtoken.InMemoryNonceStore{},
	})
	if err != nil {
		log.Fatal(err)
	}

	// In an application, reach this point only after the backend has authorized
	// this app, site, session, and action using trusted server-side state.
	binding := verificationtoken.Binding{
		ApplicationID: "demo-app",
		SiteID:        "example-site",
		SessionID:     "session-123",
		Action:        "submit-order",
	}
	token, err := service.Issue(binding)
	if err != nil {
		log.Fatal(err)
	}

	claims, err := service.VerifyAndConsume(context.Background(), token, binding)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("first use accepted for action %q; expires at %d\n", claims.Action, claims.ExpiresAt)

	_, err = service.VerifyAndConsume(context.Background(), token, binding)
	if !errors.Is(err, verificationtoken.ErrInvalidToken) {
		log.Fatalf("expected replay rejection, got %v", err)
	}
	fmt.Println("replay rejected")
}
