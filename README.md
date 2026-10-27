# PPEC Operating Room Booking

## Project layout

- `public/index.html` is the browser application served locally and by Firebase Hosting.
- `functions/index.js` contains the trusted Firebase Cloud Functions backend.
- `server.js` serves the public page locally for development.

## Run locally

From the project directory, run:

```powershell
npm start
```

Open `http://127.0.0.1:8000/`.

## Deploy to Firebase

The Firebase project is configured as `ppec-booking`. Before deploying:

1. In Firebase Console, enable **Authentication → Email/Password** and create each user's Auth account.
2. Create the Firestore database if it does not exist.
3. For each Admin/Doctor, create a document in `ppec_user` whose **Document ID is that account's Firebase Authentication UID**. Add `id` (application ID such as `ADMIN-01` or `DOC-04`), `email` (same as Auth), `name`, `phone`, `role` (`ADMIN` or `DOCTOR`), and `status` (`Approved`). Doctor profiles should also contain their normal scheduling/profile fields. Do not put passwords in Firestore.
4. Publish `firestore.rules` using **Firestore Database → Rules** in Firebase Console. Login and database access do not require Cloud Functions or Blaze.
5. To host online, install Firebase CLI, sign in, and deploy Hosting/rules:

   ```powershell
   npm.cmd install --global firebase-tools
   firebase login
   firebase deploy --only firestore:rules,hosting
   ```

The Admin's Add Doctor form creates the Firebase Authentication account through a temporary secondary client session, writes its UID-keyed Firestore profile, and sends a password setup email. The Admin remains signed in. This workflow does not require Cloud Functions or Blaze. Never put a service-account key in the browser app.

## Add a doctor

1. Sign in to the app as Admin and open **Approve New Surgeon Account**.
2. Fill in the Doctor's details and email, then save. The app creates their Authentication account and profile at `ppec_user/{Auth UID}` and emails them a password setup link.
3. The Doctor sets their password from that email and signs in with the same email address.

No default/shared password is used, and passwords must never be stored in Firestore.
"# ppec-booking" 
