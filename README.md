# Cognit

## Signed verification tokens

`verification_token.py` provides a framework-neutral server-side token issuer
and verifier. Configure one random secret of at least 32 bytes per application
on the server; never send these secrets to a client. After the server confirms
that a session is authorized for an action, call `VerificationTokenService.issue`
with the application, site, session, and action IDs. Send the resulting token to
the trusted verification service.

The verifier must supply the expected application, site, session, and action
from its own server-side context. `verify_and_consume` checks the HMAC-SHA256
signature, claim bindings, issue and expiry times, then atomically consumes the
nonce. A token is accepted once. The default in-memory nonce store is safe for
concurrent requests in one process; deployments with multiple processes or
hosts must inject a shared store with an atomic `consume_once` operation.

Tokens expire after 60 seconds by default; the configured lifetime can be at
most five minutes. Run the standard-library tests with:

```sh
python -m unittest
```
