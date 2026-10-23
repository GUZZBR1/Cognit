package verificationtoken

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const testNow int64 = 1_800_000_000

var testSecret = []byte("test-only-secret-key-with-at-least-32-bytes")
var testBinding = Binding{ApplicationID: "app-1", SiteID: "site-1", SessionID: "session-1", Action: "submit-answer"}

type storeFunc func(context.Context, string, int64, int64) (bool, error)

func (f storeFunc) ConsumeOnce(ctx context.Context, nonce string, expiresAt, now int64) (bool, error) {
	return f(ctx, nonce, expiresAt, now)
}

var _ NonceStore = storeFunc(nil)

func testService(t *testing.T, store NonceStore, clock func() time.Time) *Service {
	t.Helper()
	if clock == nil {
		clock = func() time.Time { return time.Unix(testNow, 0) }
	}
	s, err := New(Config{
		ApplicationSecrets: map[string][]byte{"app-1": testSecret, "app-2": testSecret},
		NonceStore:         store,
		Clock:              clock,
	})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func issue(t *testing.T, s *Service) string {
	t.Helper()
	token, err := s.Issue(testBinding)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func assertInvalid(t *testing.T, s *Service, token string, expected Binding) {
	t.Helper()
	claims, err := s.VerifyAndConsume(context.Background(), token, expected)
	if !errors.Is(err, ErrInvalidToken) || claims != (Claims{}) {
		t.Fatalf("expected invalid token and zero claims, got %+v, %v", claims, err)
	}
}

func signedPayload(payload []byte) string {
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	return "v1." + encoded + "." + base64.RawURLEncoding.EncodeToString(sign(testSecret, encoded))
}

func TestIssueAndConsume(t *testing.T) {
	s := testService(t, &InMemoryNonceStore{}, nil)
	token := issue(t, s)
	claims, err := s.VerifyAndConsume(context.Background(), token, testBinding)
	if err != nil {
		t.Fatal(err)
	}
	if claims.Binding != testBinding || claims.Version != 1 || claims.IssuedAt != testNow || claims.ExpiresAt != testNow+60 {
		t.Fatalf("unexpected claims: %+v", claims)
	}
	nonce, err := base64.RawURLEncoding.DecodeString(claims.Nonce)
	if err != nil || len(nonce) != 32 {
		t.Fatalf("expected 32-byte random nonce, got %q, %v", claims.Nonce, err)
	}
	assertInvalid(t, s, token, testBinding)
	second, err := s.VerifyAndConsume(context.Background(), issue(t, s), testBinding)
	if err != nil || second.Nonce == claims.Nonce {
		t.Fatalf("independently issued token must have fresh nonce: %+v, %v", second, err)
	}
}

func TestBindingsDoNotBurnValidToken(t *testing.T) {
	cases := map[string]Binding{
		"application with same secret": {"app-2", "site-1", "session-1", "submit-answer"},
		"unknown application":          {"unknown", "site-1", "session-1", "submit-answer"},
		"site":                         {"app-1", "site-2", "session-1", "submit-answer"},
		"session":                      {"app-1", "site-1", "session-2", "submit-answer"},
		"action":                       {"app-1", "site-1", "session-1", "delete-account"},
		"empty expected field":         {"app-1", "", "session-1", "submit-answer"},
		"blank expected field":         {"app-1", "site-1", "session-1", " \t"},
	}
	for name, binding := range cases {
		t.Run(name, func(t *testing.T) {
			s := testService(t, &InMemoryNonceStore{}, nil)
			token := issue(t, s)
			assertInvalid(t, s, token, binding)
			if _, err := s.VerifyAndConsume(context.Background(), token, testBinding); err != nil {
				t.Fatalf("wrong binding consumed valid token: %v", err)
			}
		})
	}
}

func TestTimeValidation(t *testing.T) {
	for _, offset := range []int64{-1, 0, 59, 60, 61} {
		t.Run(fmt.Sprint(offset), func(t *testing.T) {
			now := testNow
			s := testService(t, &InMemoryNonceStore{}, func() time.Time { return time.Unix(now, 0) })
			token := issue(t, s)
			now += offset
			if offset < 0 || offset >= 60 {
				assertInvalid(t, s, token, testBinding)
			} else if _, err := s.VerifyAndConsume(context.Background(), token, testBinding); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestMalformedTokensNeverReachStore(t *testing.T) {
	s := testService(t, storeFunc(func(context.Context, string, int64, int64) (bool, error) {
		t.Fatal("invalid token reached nonce store")
		return false, nil
	}), nil)
	token := issue(t, s)
	parts := strings.Split(token, ".")
	alphabet := "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	index := strings.IndexByte(alphabet, parts[2][len(parts[2])-1])
	noncanonicalSignature := parts[2][:len(parts[2])-1] + string(alphabet[index^1])
	changedSignature := "A" + parts[2][1:]
	if parts[2][0] == 'A' {
		changedSignature = "B" + parts[2][1:]
	}
	cases := map[string]string{
		"empty":                  "",
		"malformed":              "not-a-token",
		"extra segment":          token + ".extra",
		"version":                "v2." + parts[1] + "." + parts[2],
		"empty payload":          "v1.." + parts[2],
		"empty signature":        "v1." + parts[1] + ".",
		"modified payload":       "v1.A" + parts[1][1:] + "." + parts[2],
		"modified signature":     "v1." + parts[1] + "." + changedSignature,
		"padded signature":       token + "=",
		"noncanonical signature": "v1." + parts[1] + "." + noncanonicalSignature,
		"newline signature":      token + "\n",
		"oversized":              strings.Repeat("x", maxTokenBytes+1),
		"signed invalid JSON":    signedPayload([]byte("{")),
		"signed invalid UTF-8":   signedPayload([]byte{'{', '"', 0xff, '"', ':', '1', '}'}),
		"array":                  signedPayload([]byte("[]")),
		"null":                   signedPayload([]byte("null")),
	}
	// Even correctly signed noncanonical or non-URL-safe payloads are invalid.
	for name, payload := range map[string]string{"padded payload": parts[1] + "=", "newline payload": parts[1] + "\n", "invalid alphabet": "a+b/"} {
		cases[name] = "v1." + payload + "." + base64.RawURLEncoding.EncodeToString(sign(testSecret, payload))
	}
	for name, token := range cases {
		t.Run(name, func(t *testing.T) { assertInvalid(t, s, token, testBinding) })
	}
}

func TestInvalidSignedClaimsNeverReachStore(t *testing.T) {
	s := testService(t, storeFunc(func(context.Context, string, int64, int64) (bool, error) {
		t.Fatal("invalid claims reached nonce store")
		return false, nil
	}), nil)
	valid := Claims{Version: 1, Binding: testBinding, IssuedAt: testNow, ExpiresAt: testNow + 60, Nonce: "test-nonce"}
	raw, err := json.Marshal(valid)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	for field := range fields {
		for _, value := range []string{"missing", "null", "true", "[]", "{}"} {
			t.Run(field+"/"+value, func(t *testing.T) {
				mutated := make(map[string]json.RawMessage, len(fields))
				for k, v := range fields {
					mutated[k] = v
				}
				if value == "missing" {
					delete(mutated, field)
				} else {
					mutated[field] = json.RawMessage(value)
				}
				payload, err := json.Marshal(mutated)
				if err != nil {
					t.Fatal(err)
				}
				assertInvalid(t, s, signedPayload(payload), testBinding)
			})
		}
	}
	cases := map[string]string{
		"extra field":         strings.TrimSuffix(string(raw), "}") + `,"extra":1}`,
		"duplicate field":     strings.TrimSuffix(string(raw), "}") + `,"v":1}`,
		"case alias":          strings.Replace(string(raw), `"action"`, `"Action"`, 1),
		"trailing JSON":       string(raw) + `{}`,
		"fractional version":  strings.Replace(string(raw), `"v":1`, `"v":1.0`, 1),
		"wrong version":       strings.Replace(string(raw), `"v":1`, `"v":2`, 1),
		"blank nonce":         strings.Replace(string(raw), `"test-nonce"`, `"  "`, 1),
		"empty nonce":         strings.Replace(string(raw), `"test-nonce"`, `""`, 1),
		"fractional time":     strings.Replace(string(raw), `"issued_at":1800000000`, `"issued_at":1800000000.0`, 1),
		"string time":         strings.Replace(string(raw), `"issued_at":1800000000`, `"issued_at":"1800000000"`, 1),
		"exponent time":       strings.Replace(string(raw), `"issued_at":1800000000`, `"issued_at":18e8`, 1),
		"out of range time":   strings.Replace(string(raw), `"issued_at":1800000000`, `"issued_at":9223372036854775808`, 1),
		"oversized lifetime":  strings.Replace(string(raw), `"expires_at":1800000060`, `"expires_at":1800000061`, 1),
		"zero lifetime":       strings.Replace(string(raw), `"expires_at":1800000060`, `"expires_at":1800000000`, 1),
		"negative lifetime":   strings.Replace(string(raw), `"expires_at":1800000060`, `"expires_at":1799999999`, 1),
		"overflowed lifetime": strings.Replace(string(raw), `"issued_at":1800000000`, `"issued_at":-9223372036854775808`, 1),
	}
	for _, field := range []string{"application_id", "site_id", "session_id", "action"} {
		for _, value := range []string{`""`, `" \t"`, `1`} {
			mutated := make(map[string]json.RawMessage, len(fields))
			for k, v := range fields {
				mutated[k] = v
			}
			mutated[field] = json.RawMessage(value)
			payload, err := json.Marshal(mutated)
			if err != nil {
				t.Fatal(err)
			}
			cases[field+"/"+value] = string(payload)
		}
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) { assertInvalid(t, s, signedPayload([]byte(payload)), testBinding) })
	}
}

func TestConcurrentVerifiersConsumeExactlyOnce(t *testing.T) {
	store := &InMemoryNonceStore{}
	issuer := testService(t, store, nil)
	token := issue(t, issuer)
	const count = 64
	var accepted, rejected, unexpected atomic.Int32
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < count; i++ {
		verifier := testService(t, store, nil)
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := verifier.VerifyAndConsume(context.Background(), token, testBinding)
			switch {
			case err == nil:
				accepted.Add(1)
			case errors.Is(err, ErrInvalidToken):
				rejected.Add(1)
			default:
				unexpected.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()
	if accepted.Load() != 1 || rejected.Load() != count-1 || unexpected.Load() != 0 {
		t.Fatalf("accepted=%d rejected=%d unexpected=%d", accepted.Load(), rejected.Load(), unexpected.Load())
	}
}

func TestNonceStoreFailureAndCancellationFailClosed(t *testing.T) {
	backendError := errors.New("backend unavailable")
	for _, accepted := range []bool{false, true} {
		s := testService(t, storeFunc(func(_ context.Context, nonce string, expiresAt, now int64) (bool, error) {
			if nonce == "" || expiresAt != testNow+60 || now != testNow {
				t.Fatalf("wrong nonce arguments: %q, %d, %d", nonce, expiresAt, now)
			}
			return accepted, backendError
		}), nil)
		claims, err := s.VerifyAndConsume(context.Background(), issue(t, s), testBinding)
		if !errors.Is(err, backendError) || errors.Is(err, ErrInvalidToken) || claims != (Claims{}) {
			t.Fatalf("backend failure must remain visible with zero claims: %+v, %v", claims, err)
		}
	}
	s := testService(t, &InMemoryNonceStore{}, nil)
	token := issue(t, s)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.VerifyAndConsume(ctx, token, testBinding); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected canceled operation, got %v", err)
	}
	if _, err := s.VerifyAndConsume(context.Background(), token, testBinding); err != nil {
		t.Fatalf("canceled operation consumed token: %v", err)
	}
}

func TestConfigurationAndIssuance(t *testing.T) {
	for name, config := range map[string]Config{
		"no keys":      {NonceStore: &InMemoryNonceStore{}},
		"no store":     {ApplicationSecrets: map[string][]byte{"app-1": testSecret}},
		"short key":    {ApplicationSecrets: map[string][]byte{"app-1": []byte("short")}, NonceStore: &InMemoryNonceStore{}},
		"blank app":    {ApplicationSecrets: map[string][]byte{" ": testSecret}, NonceStore: &InMemoryNonceStore{}},
		"invalid app":  {ApplicationSecrets: map[string][]byte{"\xff": testSecret}, NonceStore: &InMemoryNonceStore{}},
		"negative TTL": {ApplicationSecrets: map[string][]byte{"app-1": testSecret}, NonceStore: &InMemoryNonceStore{}, TTL: -time.Second},
		"short TTL":    {ApplicationSecrets: map[string][]byte{"app-1": testSecret}, NonceStore: &InMemoryNonceStore{}, TTL: time.Millisecond},
		"fraction TTL": {ApplicationSecrets: map[string][]byte{"app-1": testSecret}, NonceStore: &InMemoryNonceStore{}, TTL: 1500 * time.Millisecond},
		"long TTL":     {ApplicationSecrets: map[string][]byte{"app-1": testSecret}, NonceStore: &InMemoryNonceStore{}, TTL: 301 * time.Second},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := New(config); err == nil {
				t.Fatal("invalid config accepted")
			}
		})
	}
	for _, ttl := range []time.Duration{0, time.Second, 300 * time.Second} {
		if _, err := New(Config{ApplicationSecrets: map[string][]byte{"app-1": testSecret}, NonceStore: &InMemoryNonceStore{}, TTL: ttl}); err != nil {
			t.Fatalf("valid TTL %v rejected: %v", ttl, err)
		}
	}
	s := testService(t, &InMemoryNonceStore{}, nil)
	for _, binding := range []Binding{
		{}, {"unknown", "site-1", "session-1", "action"},
		{"app-1", " \t", "session-1", "action"}, {"app-1", "site-1", "session-1", "\xff"},
		{"app-1", "site-1", "session-1", strings.Repeat("x", maxTokenBytes)},
	} {
		if token, err := s.Issue(binding); err == nil || token != "" {
			t.Fatalf("invalid binding issued token: %q, %v", token, err)
		}
	}
	overflow := testService(t, &InMemoryNonceStore{}, func() time.Time { return time.Unix(math.MaxInt64, 0) })
	if _, err := overflow.Issue(testBinding); err == nil {
		t.Fatal("expiry overflow accepted")
	}
}

func TestApplicationSecretsAreCopied(t *testing.T) {
	key := append([]byte(nil), testSecret...)
	keys := map[string][]byte{"app-1": key}
	s, err := New(Config{ApplicationSecrets: keys, NonceStore: &InMemoryNonceStore{}})
	if err != nil {
		t.Fatal(err)
	}
	token := issue(t, s)
	key[0] ^= 0xff
	delete(keys, "app-1")
	if _, err := s.VerifyAndConsume(context.Background(), token, testBinding); err != nil {
		t.Fatalf("caller mutation changed service secrets: %v", err)
	}
}

func TestPythonIssuedToken(t *testing.T) {
	// Generated by verification_token.py with testSecret, testNow and a fixed
	// nonce_factory. Python sorts JSON keys; verification signs the raw segment.
	const token = "v1.eyJhY3Rpb24iOiJzdWJtaXQtYW5zd2VyIiwiYXBwbGljYXRpb25faWQiOiJhcHAtMSIsImV4cGlyZXNfYXQiOjE4MDAwMDAwNjAsImlzc3VlZF9hdCI6MTgwMDAwMDAwMCwibm9uY2UiOiJweXRob24tZml4dHVyZS1ub25jZSIsInNlc3Npb25faWQiOiJzZXNzaW9uLTEiLCJzaXRlX2lkIjoic2l0ZS0xIiwidiI6MX0.HFfMIyeElbeHDSdBZCUnZ4OHCKwEz73GQ8ikKaPTw_k"
	s := testService(t, &InMemoryNonceStore{}, nil)
	claims, err := s.VerifyAndConsume(context.Background(), token, testBinding)
	if err != nil || claims.Nonce != "python-fixture-nonce" {
		t.Fatalf("Python token rejected: %+v, %v", claims, err)
	}
	assertInvalid(t, s, token, testBinding)
}
