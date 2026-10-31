# PPEC Operating Room Booking

## Project layout

- `public/index.html` is the browser application served locally and by Firebase Hosting.
- `firestore.rules` protects private booking, profile, audit-log, and sanitized room-occupancy data.
- `server.js` serves the page locally for development.

## Run locally

From the project directory:

```powershell
npm start
```

Open `http://127.0.0.1:8000/`. Sign-in and data storage still use the configured live Firebase project; local hosting does not emulate Firebase.

## One-time Firebase setup

1. In Firebase Console, open the `ppec-booking` project. Initialize Firebase Authentication and Cloud Firestore, and enable the **Email/Password** and **Phone** sign-in providers. Configure the app's hosted domain as an authorized domain for reCAPTCHA.
2. Install the Firebase CLI and sign in:

   ```powershell
   npm.cmd install --global firebase-tools
   firebase.cmd login
   ```

3. Ensure each user has an approved profile document in `ppec_user` whose document ID is their Firebase Authentication UID. Profiles need `email`, `phone`, `name`, `role` (`ADMIN` or `DOCTOR`), `status: "Approved"`, and application `id`.
4. Deploy Firestore rules and Hosting to enable direct Firebase booking storage:

   ```powershell
   firebase.cmd deploy --only firestore:rules,hosting --project ppec-booking
   ```

5. Firestore rules protect direct booking, payout, audit, and profile access.
6. From the Admin account, use **Approve New Surgeon Account** to create doctors. Enter an initial password of at least 8 characters. Doctors sign in with their phone number and password. An Admin can assist with a password change only when the user enters their current password.

### Existing account migration

- Firebase Authentication's Email/Password provider remains enabled internally. The app maps a phone number to `phone-<digits>@ppec-booking.firebaseapp.com` for Firebase Authentication; users enter only their phone number in the app.
- Before existing Admin and Doctor accounts can sign in with a phone number, update each Firebase Authentication account's email in Firebase Console to match that alias. Remove spaces, punctuation, and the leading `+` when forming `<digits>`. Keep the profile's `email` field as its contact email.
- New Doctor accounts created by the app use this alias automatically. A user's phone number must contain 8 to 15 digits after normalization.
- Phone SMS verification uses Cambodian E.164 formatting (`0979956921` becomes `+855979956921`). Enable Phone sign-in, authorize the hosting domain, and allow Cambodia in the SMS region policy. Firebase must also have a billing account/plan enabled for SMS verification (`auth/billing-not-enabled`); real SMS usage may incur charges. Firebase fictional test phone numbers can be used during development instead of sending real SMS.

## Sign-in and data behavior

- Users sign in with their phone number and Firebase Authentication password. The app normalizes the phone number by removing non-digit characters and converts it to an internal Firebase email alias; users do not enter an email to sign in.
- Admins can create doctor accounts directly through the Firebase client SDK, then save the profile and audit entry in Firestore. The app creates the Authentication user in a separate Firebase app instance so the Admin session stays signed in. Contact email remains profile information.
- Any signed-in user can open **My Profile** from the account header and change their own password. New passwords must be 8 to 128 characters and are confirmed before saving.
- Admins can help another approved Admin or Doctor change their password from **My Profile** after that user enters their current password to verify the change. The app uses a separate in-memory Firebase Auth session and never saves passwords in Firestore.
- **Forgot password? Send SMS code** on the login screen verifies a phone already linked to the account's existing Firebase UID, then lets the account owner set a new password without a Cloud Function. This app does not provide an in-app phone-linking control; accounts without a linked phone cannot use SMS recovery.
- An Admin can delete a doctor's Firestore app profile directly. This blocks app access but does not delete the Firebase Authentication account; historical bookings and audit records are retained.
- Booking data is stored in `ppec_eye_bookings`. Doctors can read their own booking details; other doctors' schedule entries are represented by a separate occupancy-only collection without patient or surgeon details.
- User profiles are stored in `ppec_user`; audit entries are stored in `ppec_eye_logs`. Passwords are managed by Firebase Authentication and are never stored in Firestore.
- Booking, payout, deletion, and audit writes use a direct Firestore batch; booking conflicts are checked against the occupancy collection. Deploy Firestore rules before testing these actions.
- Doctor account creation, profile edits, and password changes use the Firebase client SDK and Firestore security rules.
- Admin-assisted password changes use the Firebase client SDK and do not call a Cloud Function.
- Doctors can read the occupancy-only feed, which shows occupied beds and times without exposing patient or surgeon identifiers. An Admin login synchronizes older bookings into this feed.
- Do not test with real patient information until Authentication, Firestore rules, and the app have been verified.

## Existing Firebase data

Existing Firebase Auth accounts must have a matching UID-keyed, approved `ppec_user` profile. A deleted app profile does not delete its Firebase Authentication account; clean up such Auth accounts separately in the Firebase Console if needed.

Existing Firebase Authentication accounts must be migrated to the phone alias described above before phone sign-in will work. Before using SMS password recovery, each account must also have its profile phone linked as a Firebase Phone provider on that same UID. Accounts without a linked phone cannot use **Forgot password? Send SMS code**. Admin-assisted password changes still require the user's current password.
