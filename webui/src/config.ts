// Cookies must be `Secure` in any real deployment (TLS-terminated). Locally,
// without TLS in front, a real browser silently refuses to send a Secure
// cookie over plain http:// — curl doesn't enforce this, which is why a
// broken config can look fine in curl-only testing and then fail in an
// actual browser. Set COOKIE_SECURE=true explicitly once TLS is in front of
// this app in any non-local environment.
export const cookieSecure = process.env.COOKIE_SECURE === 'true';
