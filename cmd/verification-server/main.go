package main

import (
	"log"
	"net/http"
	"os"

	"github.com/GUZZBR1/Cognit/server"
)

func main() {
	key := os.Getenv("COGNIT_APP_KEY")
	if key == "" {
		log.Fatal("set COGNIT_APP_KEY to an opaque secret of at least 32 bytes")
	}
	s, err := server.New(server.Config{
		ApplicationKeys: map[string]string{key: "demo-app"},
		SigningSecret:   os.Getenv("COGNIT_SIGNING_SECRET"),
	})
	if err != nil {
		log.Fatal(err)
	}
	addr := os.Getenv("ADDR")
	if addr == "" {
		addr = ":8080"
	}
	log.Printf("Cognit verification API listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, s))
}
