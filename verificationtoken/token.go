// Package verificationtoken issues and consumes short-lived, server-signed
// Cognit tokens. Issuance must follow a server-side authorization decision.
package verificationtoken

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strings"
	"time"
	"unicode/utf8"
)

const maxTokenBytes = 8192

// ErrInvalidToken covers malformed, modified, expired, wrong-binding and
// previously consumed tokens. Callers should return the same rejection for all.
var ErrInvalidToken = errors.New("invalid verification token")

// Binding identifies the authorized application, site, session and action.
// Expected values must come from trusted server context, never token claims.
type Binding struct {
	ApplicationID string `json:"application_id"`
	SiteID        string `json:"site_id"`
	SessionID     string `json:"session_id"`
	Action        string `json:"action"`
}

// Claims are authenticated only after VerifyAndConsume succeeds. Times are
// integer Unix seconds; ExpiresAt is exclusive.
type Claims struct {
	Version int `json:"v"`
	Binding
	IssuedAt  int64  `json:"issued_at"`
	ExpiresAt int64  `json:"expires_at"`
	Nonce     string `json:"nonce"`
}

// NonceStore atomically records the first consumption of a nonce until its
// expiry. It returns true exactly once while expiresAt > now, false for replay
// or expiry, and an error for storage failures. All times are Unix seconds.
// Production implementations must coordinate every verifier across processes,
// hosts and restarts. A separate lookup followed by an insert is not sufficient.
type NonceStore interface {
	ConsumeOnce(ctx context.Context, nonce string, expiresAt, now int64) (bool, error)
}

// Config configures a Service. NonceStore is required explicitly so deployments
// must choose the scope of their replay protection. TTL defaults to 60 seconds
// and must be a whole number of seconds between 1 and 300. Clock defaults to
// time.Now; an injected clock and nonce store must be safe for concurrent use.
type Config struct {
	ApplicationSecrets map[string][]byte
	TTL                time.Duration
	NonceStore         NonceStore
	Clock              func() time.Time
}

// Service is safe for concurrent use with a concurrent-safe clock and store.
// Its private copy of the application secrets cannot be changed by the caller.
type Service struct {
	secrets map[string][]byte
	ttl     int64
	store   NonceStore
	clock   func() time.Time
}

// New validates configuration and copies server-held keys (at least 32 bytes).
func New(config Config) (*Service, error) {
	if config.TTL == 0 {
		config.TTL = 60 * time.Second
	}
	if config.TTL < time.Second || config.TTL > 300*time.Second || config.TTL%time.Second != 0 {
		return nil, errors.New("token TTL must be whole seconds between 1 and 300")
	}
	if len(config.ApplicationSecrets) == 0 {
		return nil, errors.New("at least one application secret is required")
	}
	if config.NonceStore == nil {
		return nil, errors.New("a nonce store is required")
	}
	secrets := make(map[string][]byte, len(config.ApplicationSecrets))
	for app, secret := range config.ApplicationSecrets {
		if !validIdentifier(app) || len(secret) < 32 {
			return nil, errors.New("application IDs must be non-empty UTF-8 strings and secrets at least 32 bytes")
		}
		secrets[app] = append([]byte(nil), secret...)
	}
	if config.Clock == nil {
		config.Clock = time.Now
	}
	return &Service{secrets: secrets, ttl: int64(config.TTL / time.Second), store: config.NonceStore, clock: config.Clock}, nil
}

// Issue signs a binding that the server has already authorized. The client
// must never hold the signing key or make the decision to issue a token.
func (s *Service) Issue(binding Binding) (string, error) {
	if !validBinding(binding) {
		return "", errors.New("bindings must be non-empty UTF-8 strings")
	}
	secret, ok := s.secrets[binding.ApplicationID]
	if !ok {
		return "", errors.New("unknown application")
	}
	now := s.clock().Unix()
	if now > math.MaxInt64-s.ttl {
		return "", errors.New("token expiry overflows Unix seconds")
	}
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", fmt.Errorf("generate verification nonce: %w", err)
	}
	claims := Claims{Version: 1, Binding: binding, IssuedAt: now, ExpiresAt: now + s.ttl, Nonce: base64.RawURLEncoding.EncodeToString(nonce[:])}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", fmt.Errorf("encode verification claims: %w", err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	token := "v1." + encoded + "." + base64.RawURLEncoding.EncodeToString(sign(secret, encoded))
	if len(token) > maxTokenBytes {
		return "", errors.New("verification token exceeds 8192 bytes")
	}
	return token, nil
}

// VerifyAndConsume authenticates the token and server-known expected bindings,
// then atomically consumes its nonce. Rejections never consume a nonce. Storage
// errors remain distinguishable via errors.Is and must fail the protected action.
// The caller must perform that action only after this method returns nil error.
func (s *Service) VerifyAndConsume(ctx context.Context, token string, expected Binding) (Claims, error) {
	secret, ok := s.secrets[expected.ApplicationID]
	if !ok || !validBinding(expected) || len(token) > maxTokenBytes {
		return Claims{}, ErrInvalidToken
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != "v1" {
		return Claims{}, ErrInvalidToken
	}
	signature, err := decodeSegment(parts[2])
	if err != nil || !hmac.Equal(signature, sign(secret, parts[1])) {
		return Claims{}, ErrInvalidToken
	}
	payload, err := decodeSegment(parts[1])
	if err != nil {
		return Claims{}, ErrInvalidToken
	}
	claims, err := decodeClaims(payload)
	if err != nil || claims.Version != 1 || !validBinding(claims.Binding) || !validIdentifier(claims.Nonce) {
		return Claims{}, ErrInvalidToken
	}
	now := s.clock().Unix()
	lifetime := claims.ExpiresAt - claims.IssuedAt
	if claims.IssuedAt > now || claims.ExpiresAt <= now || claims.ExpiresAt <= claims.IssuedAt || lifetime <= 0 || lifetime > s.ttl || claims.Binding != expected {
		return Claims{}, ErrInvalidToken
	}
	consumed, err := s.store.ConsumeOnce(ctx, claims.Nonce, claims.ExpiresAt, now)
	if err != nil {
		return Claims{}, fmt.Errorf("consume verification nonce: %w", err)
	}
	if !consumed {
		return Claims{}, ErrInvalidToken
	}
	return claims, nil
}

func validIdentifier(value string) bool {
	return utf8.ValidString(value) && strings.TrimSpace(value) != ""
}

func validBinding(b Binding) bool {
	return validIdentifier(b.ApplicationID) && validIdentifier(b.SiteID) && validIdentifier(b.SessionID) && validIdentifier(b.Action)
}

func sign(secret []byte, payload string) []byte {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(payload))
	return mac.Sum(nil)
}

func decodeSegment(segment string) ([]byte, error) {
	if segment == "" {
		return nil, ErrInvalidToken
	}
	// Go's base64 decoder ignores CR/LF, even in strict mode. Reject them and
	// every other character outside the unpadded URL-safe alphabet explicitly.
	for _, c := range segment {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return nil, ErrInvalidToken
		}
	}
	return base64.RawURLEncoding.Strict().DecodeString(segment)
}

func decodeClaims(payload []byte) (Claims, error) {
	if !utf8.Valid(payload) {
		return Claims{}, ErrInvalidToken
	}
	// Inspect exact, unique field names and reject nulls before decoding into
	// structs: encoding/json otherwise accepts case aliases and null scalars.
	fields := map[string]bool{
		"v": false, "application_id": false, "site_id": false,
		"session_id": false, "action": false, "issued_at": false,
		"expires_at": false, "nonce": false,
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return Claims{}, ErrInvalidToken
	}
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return Claims{}, ErrInvalidToken
		}
		name, ok := key.(string)
		seen, known := fields[name]
		if !ok || !known || seen {
			return Claims{}, ErrInvalidToken
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return Claims{}, ErrInvalidToken
		}
		fields[name] = true
	}
	if end, err := decoder.Token(); err != nil || end != json.Delim('}') {
		return Claims{}, ErrInvalidToken
	}
	if _, err := decoder.Token(); err != io.EOF {
		return Claims{}, ErrInvalidToken
	}
	for _, seen := range fields {
		if !seen {
			return Claims{}, ErrInvalidToken
		}
	}
	var claims Claims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return Claims{}, ErrInvalidToken
	}
	return claims, nil
}
