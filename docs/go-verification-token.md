# Go verification tokens

`verificationtoken` issues short-lived HMAC-SHA256 tokens for a request the
server has already authorized. A token binds one application, site, session,
and action, and carries `issued_at`, `expires_at`, and a random nonce. The wire
format is `v1.<base64url-json>.<base64url-hmac>`; it is a bearer credential and
must be sent only over TLS.

Create a service with an application secret of at least 32 bytes and an
explicit nonce store. The default lifetime is 60 seconds; configured lifetimes
must be whole seconds from 1 through 300. Call `Issue` only after the trusted
server has authorized the action. Call `VerifyAndConsume` with bindings
obtained from the current authenticated request and session. Perform the
protected action only when it succeeds. Invalid, expired, altered, mismatched,
and replayed tokens return `verificationtoken.ErrInvalidToken`. A nonce-store
failure returns a separate error; callers must fail closed and not perform the
action.

`InMemoryNonceStore` uses a mutex and is suitable for a single-process demo.
Its state is lost on restart and separate instances do not coordinate. A
production `NonceStore` must atomically claim a nonce across every verifier,
process, host, and restart. Use one conditional insert or compare-and-set
operation keyed by nonce, with expiry retained until the token expires. Do not
implement this as a read followed by a write. The operation returns true for
exactly one live consumption, false for a replay or expired token, and an error
on storage failure. Expired records can be removed after their expiry.

Signing secrets, issuance decisions, and expected bindings belong on the
backend. Never put application secrets or issuance authority in browser or SDK
code. The example issues a token after a server-side authorization decision,
validates it once, and demonstrates replay rejection:

```sh
go run ./examples/go-verification-token
```

This package is independent of a particular HTTP API, session store, or
database. The JSON claim representation is specific to this Go package; the
Python implementation remains its own server-side service contract.
