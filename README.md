# Veto Agent

An MLH Builders Week implementation of **The Veto Agent (Token Vault & Asynchronous Authorization)**. A signed-in user connects GitHub, reads one designated demo issue through Auth0 Token Vault, and asks the assistant to close it. The backend waits for a real Auth0 CIBA decision outside the conversation before making the permitted GitHub write.

**Current verification:** 19 state-machine tests, TypeScript/Vite build and lint pass. Auth0 login was verified in the browser. Live Token Vault exchange, out-of-band CIBA approval and GitHub issue closure require tenant/account configuration and have not yet been verified. No mock approval or personal-access-token fallback is used. Do not represent this project as a completed live integration until the end-to-end flow has been verified.

**Live setup blocker (2026-11-12):** the tenant dashboard disables the CIBA Email channel and labels it “Subscription add-on is required”. No paid upgrade was purchased. A dedicated `Veto CIBA Approval` application was created, but the unsaved CIBA/channel changes were discarded. [Disposable demo issue #1](https://github.com/guraove/auth0-veto-agent/issues/1) remains open. Token Vault/GitHub OAuth setup has not been completed. A Guardian push alternative would require a supported tenant configuration and the owner's explicit approval and phone enrollment.

## Run

Node.js 24+, npm. Copy `.env.example` to `.env`, set your Auth0 domain, SPA client and API audience, then `npm ci` and `npm run dev`. UI: http://localhost:5173, backend: http://127.0.0.1:3001. Run `npm test`, `npm run build`, and `npm run lint`.

Keep all confidential client secrets in `.env`; only `VITE_` variables enter the browser bundle. `.env` is ignored. The UI intentionally disables external actions until the required server configuration exists.

## Auth0 and GitHub configuration

1. Register an Auth0 SPA. Allow `http://localhost:5173` for callbacks, logout and web origins. Register an RS256 Custom API and authorize the SPA for user-delegated access. Set the same identifier as both audience variables. Do not grant machine access to this API.
2. Add a **Custom API Client** from that API's **Add Application** control. This is the Token Vault client linked to this API identifier. Confirm the Token Vault grant is enabled. Copy its credentials to the server-only `TOKEN_VAULT_*` variables.
3. Create a dedicated GitHub OAuth application (callback `https://YOUR_AUTH0_DOMAIN/login/callback`) and a supported Auth0 GitHub connection, using it for **Connected Accounts / Token Vault**. Configure `VITE_GITHUB_CONNECTION`. The Connect GitHub button uses the Auth0 React SDK's `connectAccountWithRedirect` with `read:user` and `public_repo`. GitHub's OAuth scope can cover other public repositories; this application's server permits only its fixed demo repository and issue number. No private-repository scope is requested.
4. Create a confidential first-party OIDC application for CIBA, with client secret POST authentication and the CIBA grant. Authorize user-delegated access to this API, and register the API's RAR authorization details type `github_issue_close`. Set its credentials in `CIBA_*`. The existing access token is never accepted as an approval.
5. Enable a supported CIBA notification channel. For Guardian push, enable Guardian MFA and enroll the user; use requested expiry <=300 seconds. For email, enable the supported email CIBA channel and template, use a verified user email and requested expiry >300 seconds. Auth0 may require an eligible plan or add-on. This project does not buy an add-on or bypass entitlement checks.
6. Create one disposable public test issue in your own demo repo. Set `GITHUB_DEMO_REPO` and `GITHUB_DEMO_ISSUE_NUMBER`. The backend accepts no caller-supplied target. It rejects pull requests and already closed issues before requesting approval.

## End-to-end verification

Sign in, connect GitHub, read the demo issue, then send “Close the demo issue”. The assistant requests `/bc-authorize` with the verified user's subject and an immutable RAR operation containing the repository, issue number and unique proposal ID. It returns `pending`; the browser has no approval endpoint or approval button. Approve or deny only through Auth0's Guardian/email channel. The server observes Auth0's poll interval and handles `authorization_pending`, `slow_down`, denial and expiry.

On approval, the backend verifies the new access token's RS256 signature, issuer, audience, expiry and user subject, and compares the token endpoint's returned `authorization_details` against the exact pending operation. Only then does it exchange the current caller's API token through Token Vault and PATCH the designated GitHub issue. Credentials, provider tokens and `auth_req_id` stay server-side. An uncertain write response is terminal; no automatic write retry is made.

## Boundaries

This is a deterministic tool-driven assistant, with the single supported command shown in the UI; it does not call an LLM. It is a single-process localhost demo. Proposals are held in memory, so a restart cancels continuity rather than replaying an action. Production work needs a durable encrypted store, distributed transaction/locking, rate limits, abuse controls and deployment hardening. A user's explicit out-of-band approval remains mandatory.

Tests cover pending, poll throttling, denial, expiry, subject mismatch, modified RAR operation, invalid JWT, concurrent polls, replay and ambiguous network failures. They test an injected state machine; they do not substitute for a live Auth0/GitHub integration test.

Official references: [Token Vault access-token exchange](https://auth0.com/docs/secure/call-apis-on-users-behalf/token-vault/access-token-exchange-with-token-vault), [Token Vault configuration](https://auth0.com/docs/secure/call-apis-on-users-behalf/token-vault/configure-token-vault), [CIBA configuration](https://auth0.com/docs/get-started/applications/configure-client-initiated-backchannel-authentication), [CIBA user authorization and RAR](https://auth0.com/docs/get-started/authentication-and-authorization-flow/client-initiated-backchannel-authentication-flow/user-authorization-with-ciba).
