# Overnight backlog
goal: harden the checkout flow tests
repo: /tmp/repo

## cart-tests
- status: pending
- scope: cart unit tests
- done-when: cart reducer covered
- test: `npm test -- cart`
- prod-code: no
- note:

## login-fix
- status: pending
- scope: fix login redirect
- done-when: redirect works
- test: npm test -- login
- prod-code: yes
- note: old note

## api-tests
- status: skipped
- scope: api tests
- done-when: api covered
- test: npm test -- api
- note: blocked: no db
