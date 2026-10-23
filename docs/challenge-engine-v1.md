# Challenge engine algorithm v1

The Go package `challenge` ports `challenge_generator.py` algorithm version 1.
The committed `fixtures/challenge-v1.json` records a Python-generated golden
case. Its `expected_answer` field is test-only and must not be sent to clients.

For version 1, config JSON uses UTF-8, compact separators, and lexicographically
sorted property names. The challenge ID is the first 24 lowercase hex
characters of SHA-256 over `cognit-challenge-id-v1\0`, the UTF-8 seed, another
NUL, and canonical config JSON. The random stream key uses the same inputs with
`cognit-challenge-v1\0`. Each 64-bit random value is the first eight bytes of
SHA-256(key || unsigned-64-bit-big-endian-counter). Bounded values use rejection
sampling, then Fisher-Yates shuffles position choices and order.

`Service` stores expected answers in memory and rejects them once their
configured TTL has elapsed. The clock may be injected with
`NewServiceWithClock` for deterministic expiry tests. The seed should remain
server-side; it is not included in the public challenge.

Run the example with `go run ./examples/challenge`.
