package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const testKey = "0123456789abcdef0123456789abcdef"
const testSigningSecret = "independent-signing-secret-0123456789abcdef"

func testServer(t *testing.T, cfg Config) *Server {
	t.Helper()
	if cfg.ApplicationKeys == nil {
		cfg.ApplicationKeys = map[string]string{testKey: "app-a"}
	}
	if cfg.Window == 0 {
		cfg.Window = time.Minute
	}
	if cfg.SigningSecret == "" {
		cfg.SigningSecret = testSigningSecret
	}
	s, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func request(t *testing.T, h http.Handler, method, path, key, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if key != "" {
		r.Header.Set("Authorization", "Bearer "+key)
	}
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func data(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var v map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode response: %v (%s)", err, w.Body.String())
	}
	return v
}
func post(t *testing.T, h http.Handler, path, body string) *httptest.ResponseRecorder {
	return request(t, h, http.MethodPost, path, testKey, body)
}

func TestVerificationFlowAndTokenBindings(t *testing.T) {
	s := testServer(t, Config{})
	created := post(t, s, "/v0/sessions", `{"site_id":"site-a"}`)
	if created.Code != 201 {
		t.Fatalf("create: got %d: %s", created.Code, created.Body)
	}
	sessionID := data(t, created)["session_id"].(string)
	path := "/v0/sessions/" + sessionID
	pending := post(t, s, path+"/verify", "")
	if pending.Code != 200 {
		t.Fatalf("verify pending: %d", pending.Code)
	}
	if _, exists := data(t, pending)["token"]; exists {
		t.Fatal("pending session exposed a token")
	}
	challengeResponse := post(t, s, path+"/challenge", `{"challenge_type":"choice"}`)
	if challengeResponse.Code != 200 {
		t.Fatalf("challenge: %d: %s", challengeResponse.Code, challengeResponse.Body)
	}
	challengeID := data(t, challengeResponse)["challenge_id"].(string)
	result := post(t, s, path+"/result", `{"challenge_id":"`+challengeID+`","answer":"blue","reaction_time_ms":900}`)
	if result.Code != 200 || data(t, result)["state"] != "succeeded" {
		t.Fatalf("result: %d: %s", result.Code, result.Body)
	}
	verification := post(t, s, path+"/verify", "")
	token, ok := data(t, verification)["token"].(string)
	if !ok || token == "" {
		t.Fatalf("successful verify did not return token: %s", verification.Body)
	}
	validate := func(site, action string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"token": token, "site_id": site, "session_id": sessionID, "action": action})
		return post(t, s, "/v0/tokens/validate", string(body))
	}
	if got := validate("site-a", "wrong-action"); got.Code != 400 || data(t, got)["error"].(map[string]any)["code"] != "invalid_token" {
		t.Fatalf("wrong action accepted: %d %s", got.Code, got.Body)
	}
	if got := validate("site-b", "default"); got.Code != 404 {
		t.Fatalf("wrong site accepted: %d %s", got.Code, got.Body)
	}
	if got := validate("site-a", "default"); got.Code != 200 || data(t, got)["valid"] != true {
		t.Fatalf("valid token rejected: %d %s", got.Code, got.Body)
	}
	if got := validate("site-a", "default"); got.Code != 400 || data(t, got)["error"].(map[string]any)["code"] != "invalid_token" {
		t.Fatalf("token replay accepted: %d %s", got.Code, got.Body)
	}
}

func TestBearerAuthAndPerApplicationQuota(t *testing.T) {
	secondKey := strings.Repeat("b", 32)
	otherAppKey := strings.Repeat("c", 32)
	s := testServer(t, Config{
		SessionLimit:    1,
		ApplicationKeys: map[string]string{testKey: "app-a", secondKey: "app-a", otherAppKey: "app-b"},
	})
	unauthorized := request(t, s, http.MethodPost, "/v0/sessions", "", `{"site_id":"site-a"}`)
	if unauthorized.Code != 401 || data(t, unauthorized)["error"].(map[string]any)["code"] != "unauthorized" {
		t.Fatalf("expected unauthorized response: %d %s", unauthorized.Code, unauthorized.Body)
	}
	if got := post(t, s, "/v0/sessions", `{"site_id":"site-a"}`); got.Code != 201 {
		t.Fatalf("first request: %d %s", got.Code, got.Body)
	}
	limited := post(t, s, "/v0/sessions", `{"site_id":"site-a"}`)
	if limited.Code != 429 || limited.Header().Get("Retry-After") == "" {
		t.Fatalf("expected rate limit and Retry-After: %d %s", limited.Code, limited.Body)
	}
	if data(t, limited)["error"].(map[string]any)["code"] != "rate_limited" {
		t.Fatalf("wrong rate limit body: %s", limited.Body)
	}
	if got := request(t, s, http.MethodPost, "/v0/sessions", otherAppKey, `{"site_id":"site-a"}`); got.Code != 201 {
		t.Fatalf("another application inherited the quota: %d %s", got.Code, got.Body)
	}
	if got := request(t, s, http.MethodPost, "/v0/sessions", secondKey, `{"site_id":"site-a"}`); got.Code != 429 {
		t.Fatalf("rotated key bypassed its application's quota: %d %s", got.Code, got.Body)
	}
}

func TestMalformedAndUnknownRequestFieldsAreRejected(t *testing.T) {
	s := testServer(t, Config{})
	for _, body := range []string{`{`, `{"site_id":"site-a","unexpected":true}`} {
		w := post(t, s, "/v0/sessions", body)
		if w.Code != 400 || data(t, w)["error"].(map[string]any)["code"] != "invalid_request" {
			t.Fatalf("body %q: expected invalid_request, got %d %s", body, w.Code, w.Body)
		}
	}
}

func TestErrorResponsesUseJSONEnvelope(t *testing.T) {
	s := testServer(t, Config{})
	for _, tc := range []struct {
		method, path, key, body string
		status                  int
		code                    string
	}{
		{http.MethodGet, "/v0/sessions", testKey, "", 405, "invalid_request"},
		{http.MethodPost, "/v0/sessions", "wrong-key", `{}`, 401, "unauthorized"},
		{http.MethodPost, "/v0/sessions", testKey, `{}`, 400, "invalid_request"},
		{http.MethodPost, "/v0/sessions/missing/verify", testKey, "", 404, "not_found"},
		{http.MethodPost, "/v0/sessions/missing/unknown", testKey, "", 404, "not_found"},
		{http.MethodPost, "/unknown", testKey, "", 404, "not_found"},
	} {
		got := request(t, s, tc.method, tc.path, tc.key, tc.body)
		if got.Code != tc.status || got.Header().Get("Content-Type") != "application/json" {
			t.Fatalf("%s %s: %d %s", tc.method, tc.path, got.Code, got.Body)
		}
		err := data(t, got)["error"].(map[string]any)
		if err["code"] != tc.code || err["message"] == "" || err["request_id"] == "" {
			t.Fatalf("invalid error envelope: %#v", err)
		}
	}
}

func TestSuccessfulResultReplayCannotMintAnotherToken(t *testing.T) {
	s := testServer(t, Config{})
	created := post(t, s, "/v0/sessions", `{"site_id":"site-a"}`)
	id := data(t, created)["session_id"].(string)
	path := "/v0/sessions/" + id
	challenge := post(t, s, path+"/challenge", `{"challenge_type":"choice"}`)
	challengeID := data(t, challenge)["challenge_id"].(string)
	body := `{"challenge_id":"` + challengeID + `","answer":"blue"}`
	if got := post(t, s, path+"/result", body); got.Code != 200 {
		t.Fatalf("initial result: %d %s", got.Code, got.Body)
	}
	token := data(t, post(t, s, path+"/verify", ""))["token"].(string)
	validation, _ := json.Marshal(map[string]string{"token": token, "site_id": "site-a", "session_id": id, "action": "default"})
	if got := post(t, s, "/v0/tokens/validate", string(validation)); got.Code != 200 {
		t.Fatalf("consume: %d %s", got.Code, got.Body)
	}
	for _, answer := range []string{"blue", "red"} {
		replay := post(t, s, path+"/result", `{"challenge_id":"`+challengeID+`","answer":"`+answer+`"}`)
		if replay.Code != 400 || data(t, replay)["error"].(map[string]any)["code"] != "invalid_request" {
			t.Errorf("replayed result: %d %s", replay.Code, replay.Body)
		}
	}
	if got := post(t, s, path+"/challenge", `{"challenge_type":"choice"}`); got.Code != 400 {
		t.Errorf("completed attempt received a new challenge: %d %s", got.Code, got.Body)
	}
	verified := data(t, post(t, s, path+"/verify", ""))
	if verified["attempt_state"] != "succeeded" || verified["token"] != token {
		t.Fatalf("completed attempt changed: %#v", verified)
	}
	if got := post(t, s, "/v0/tokens/validate", string(validation)); got.Code != 400 {
		t.Fatalf("consumed token accepted after result replay: %d %s", got.Code, got.Body)
	}
}

func TestMultipleBearerKeysUseStableTokenSignature(t *testing.T) {
	secondKey := strings.Repeat("b", 32)
	s := testServer(t, Config{ApplicationKeys: map[string]string{testKey: "app-a", secondKey: "app-a"}})
	x := &Session{ID: "test-session", App: "app-a", Site: "site-a"}
	token := s.issue(x, "default")
	for i := 0; i < 1000; i++ {
		if _, err := s.tokens.Verify(token); err != nil {
			t.Fatalf("token signature changed at iteration %d: %v", i, err)
		}
	}
	rotated := testServer(t, Config{ApplicationKeys: map[string]string{secondKey: "app-a"}})
	if _, err := rotated.tokens.Verify(token); err != nil {
		t.Fatalf("bearer rotation changed token signature: %v", err)
	}
	otherSecret := testServer(t, Config{SigningSecret: strings.Repeat("s", 32)})
	if _, err := otherSecret.tokens.Verify(token); err == nil {
		t.Fatal("token accepted with a different signing secret")
	}
}

func TestSessionTTLValidation(t *testing.T) {
	for _, tc := range []struct {
		name, body  string
		status, ttl int
	}{
		{"omitted", `{"site_id":"site-a"}`, 201, 600},
		{"minimum", `{"site_id":"site-a","ttl_seconds":1}`, 201, 1},
		{"maximum", `{"site_id":"site-a","ttl_seconds":1800}`, 201, 1800},
		{"zero", `{"site_id":"site-a","ttl_seconds":0}`, 400, 0},
		{"negative", `{"site_id":"site-a","ttl_seconds":-1}`, 400, 0},
		{"too_large", `{"site_id":"site-a","ttl_seconds":1801}`, 400, 0},
		{"null", `{"site_id":"site-a","ttl_seconds":null}`, 400, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := testServer(t, Config{})
			before := time.Now()
			w := post(t, s, "/v0/sessions", tc.body)
			if w.Code != tc.status {
				t.Fatalf("got %d, want %d: %s", w.Code, tc.status, w.Body)
			}
			if tc.status == 201 {
				expires, err := time.Parse(time.RFC3339Nano, data(t, w)["expires_at"].(string))
				if err != nil || expires.Before(before.Add(time.Duration(tc.ttl)*time.Second)) || expires.After(time.Now().Add(time.Duration(tc.ttl)*time.Second)) {
					t.Fatalf("invalid expiry: %v (%v)", expires, err)
				}
			}
		})
	}
}

func TestApplicationAndQuotaIsolation(t *testing.T) {
	rotatedKey, otherKey := strings.Repeat("b", 32), strings.Repeat("c", 32)
	s := testServer(t, Config{SessionLimit: 1, ApplicationKeys: map[string]string{
		testKey: "app-a", rotatedKey: "app-a", otherKey: "app-b",
	}})
	created := post(t, s, "/v0/sessions", `{"site_id":"site-a"}`)
	id := data(t, created)["session_id"].(string)
	if got := request(t, s, http.MethodPost, "/v0/sessions", rotatedKey, `{"site_id":"site-a"}`); got.Code != 429 {
		t.Fatalf("same app bypassed quota using another key: %d %s", got.Code, got.Body)
	}
	if got := request(t, s, http.MethodPost, "/v0/sessions", otherKey, `{"site_id":"site-a"}`); got.Code != 201 {
		t.Fatalf("other app shared exhausted quota: %d %s", got.Code, got.Body)
	}
	for _, operation := range []string{"challenge", "result", "verify"} {
		got := request(t, s, http.MethodPost, "/v0/sessions/"+id+"/"+operation, otherKey, `{}`)
		if got.Code != 404 {
			t.Fatalf("other app accessed %s: %d %s", operation, got.Code, got.Body)
		}
	}
}

func TestFailedAttemptIsTerminalAndBrowserDecisionRejected(t *testing.T) {
	s := testServer(t, Config{})
	id := data(t, post(t, s, "/v0/sessions", `{"site_id":"site-a"}`))["session_id"].(string)
	path := "/v0/sessions/" + id
	challenge := data(t, post(t, s, path+"/challenge", `{"challenge_type":"choice"}`))["challenge_id"].(string)
	for _, decision := range []string{`"accepted":true`, `"state":"succeeded"`, `"decision":"allow"`} {
		got := post(t, s, path+"/result", `{"challenge_id":"`+challenge+`","answer":"red",`+decision+`}`)
		if got.Code != 400 {
			t.Fatalf("browser decision accepted: %d %s", got.Code, got.Body)
		}
	}
	wrong := post(t, s, path+"/result", `{"challenge_id":"`+challenge+`","answer":"red"}`)
	if wrong.Code != 200 || data(t, wrong)["accepted"] != false || data(t, wrong)["state"] != "failed" {
		t.Fatalf("wrong answer succeeded: %d %s", wrong.Code, wrong.Body)
	}
	if got := post(t, s, path+"/result", `{"challenge_id":"`+challenge+`","answer":"blue"}`); got.Code != 400 {
		t.Fatalf("failed attempt succeeded on retry: %d %s", got.Code, got.Body)
	}
	if got := post(t, s, path+"/challenge", `{"challenge_type":"choice"}`); got.Code != 400 {
		t.Fatalf("failed attempt received a new challenge: %d %s", got.Code, got.Body)
	}
	verified := data(t, post(t, s, path+"/verify", ""))
	if verified["attempt_state"] != "failed" || verified["token"] != nil {
		t.Fatalf("failed attempt changed or exposed token: %#v", verified)
	}
}

func TestConcurrentResultAndTokenReplay(t *testing.T) {
	s := testServer(t, Config{})
	id := data(t, post(t, s, "/v0/sessions", `{"site_id":"site-a"}`))["session_id"].(string)
	path := "/v0/sessions/" + id
	challenge := data(t, post(t, s, path+"/challenge", `{"challenge_type":"choice"}`))["challenge_id"].(string)
	concurrentPosts := func(path, body string) {
		t.Helper()
		var wg sync.WaitGroup
		statuses := make(chan int, 16)
		for i := 0; i < cap(statuses); i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				statuses <- post(t, s, path, body).Code
			}()
		}
		wg.Wait()
		close(statuses)
		succeeded := 0
		for status := range statuses {
			if status == 200 {
				succeeded++
			} else if status != 400 {
				t.Errorf("unexpected status: %d", status)
			}
		}
		if succeeded != 1 {
			t.Fatalf("got %d successes, want exactly one", succeeded)
		}
	}
	concurrentPosts(path+"/result", `{"challenge_id":"`+challenge+`","answer":"blue"}`)
	token := data(t, post(t, s, path+"/verify", ""))["token"].(string)
	body, _ := json.Marshal(map[string]string{"token": token, "site_id": "site-a", "session_id": id, "action": "default"})
	concurrentPosts("/v0/tokens/validate", string(body))
}

func TestSessionAndChallengeExpiry(t *testing.T) {
	for _, resource := range []string{"session", "challenge"} {
		t.Run(resource, func(t *testing.T) {
			s := testServer(t, Config{})
			id := data(t, post(t, s, "/v0/sessions", `{"site_id":"site-a"}`))["session_id"].(string)
			path := "/v0/sessions/" + id
			challenge := data(t, post(t, s, path+"/challenge", `{"challenge_type":"choice"}`))["challenge_id"].(string)
			x, _ := s.sessions.Get(id)
			if resource == "session" {
				x.Expires = time.Now().Add(-time.Second)
			} else {
				x.Challenge.Expires = time.Now().Add(-time.Second)
			}
			s.sessions.Put(x)
			got := post(t, s, path+"/result", `{"challenge_id":"`+challenge+`","answer":"blue"}`)
			if got.Code != 400 || data(t, got)["error"].(map[string]any)["code"] != "expired" {
				t.Fatalf("expired %s accepted: %d %s", resource, got.Code, got.Body)
			}
			verified := data(t, post(t, s, path+"/verify", ""))
			if verified["attempt_state"] != "failed" || verified["token"] != nil {
				t.Fatalf("expired attempt exposed token: %#v", verified)
			}
		})
	}
}
