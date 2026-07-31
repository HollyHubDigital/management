# CP DEVICE Environment Variables

## Admin + Backend Vercel Project

This project hosts the backend APIs, admin Control Interface, APK/profile downloads, WebSocket relay, and GitHub-backed persistence.

Required:

```env
CP_DEVICE_ADMIN_USERNAME=admin
CP_DEVICE_ADMIN_PASSWORD=replace-with-strong-admin-password
CP_DEVICE_ADMIN_TOKEN=replace-with-long-random-legacy-token
CP_DEVICE_ENROLLMENT_SECRET=replace-with-long-random-enrollment-secret
USER_INTERFACE_ORIGIN=https://android-device-management.vercel.app
ADMIN_ORIGIN=https://admin-device-management.vercel.app
DATA_DIR=.cp-device-data
```

GitHub persistence:

```env
GITHUB_TOKEN=github_pat_or_fine_grained_token
GITHUB_OWNER=your-github-owner
GITHUB_REPO=your-private-state-repo
GITHUB_BRANCH=main
GITHUB_DATA_PATH=cp-device/state.json
```

Signup notification:

```env
WEB3FORMS_ACCESS_KEY=your-web3forms-access-key
```

Payment provider secrets. Keep these only in backend/admin Vercel env, never in frontend:

```env
PAYSTACK_SECRET_KEY=sk_live_xxx
PAYSTACK_WEBHOOK_SECRET=xxx
FLUTTERWAVE_SECRET_KEY=FLWSECK_xxx
FLUTTERWAVE_WEBHOOK_SECRET=xxx
SQUAD_SECRET_KEY=xxx
SQUAD_WEBHOOK_SECRET=xxx
STRIPE_SECRET_KEY=sk_live_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
PAYONEER_API_KEY=xxx
PAYONEER_WEBHOOK_SECRET=xxx
```

Android signing/build env, only needed in build machine/CI:

```env
CP_DEVICE_KEYSTORE=release.keystore
CP_DEVICE_KEYSTORE_PASSWORD=replace-in-production
CP_DEVICE_KEY_ALIAS=cp-device
CP_DEVICE_KEY_PASSWORD=replace-in-production
```

## User-Interface Vercel Project

The user project is a static frontend. It must not contain secret keys.

Runtime public config in `config.js`:

```js
window.CP_DEVICE_CONFIG = {
  API_BASE_URL: "https://admin-device-management.vercel.app"
};
```

If you later add a build system, expose only a public backend URL such as:

```env
NEXT_PUBLIC_CP_DEVICE_API_BASE=https://admin-device-management.vercel.app
```

Do not add `GITHUB_TOKEN`, payment secret keys, or admin credentials to the User-Interface project.

## Deployment split

- Keep `src/`, `public/index.html`, `public/app.js`, `android-agent/`, `artifacts/`, and backend logic in the admin/backend repo.
- Push `User-Interface/` to the separate user frontend repo.
- User devices enrolled through `User-Interface` are saved in the same backend store and appear in admin `/api/state`.

## Apple iPhone MDM production requirements

Add these to the admin/backend Vercel project only when enabling real iPhone MDM command processing:

```env
APPLE_MDM_APNS_TOPIC=com.apple.mgmt.External.your-topic
APPLE_MDM_PUSH_CERTIFICATE=base64_encoded_mdm_push_certificate
APPLE_MDM_PUSH_PRIVATE_KEY=base64_encoded_private_key
APPLE_MDM_IDENTITY_CERTIFICATE_UUID=production-identity-certificate-uuid
```

The User-Interface project must not store these Apple MDM secrets. The user frontend only downloads the profile from the admin/backend API and uses the same subscription checks before queuing supported iPhone MDM commands.