# PPEC Operating Room Booking

## Project layout

- `public/index.html` is the browser application served locally and by Firebase Hosting.
- `functions/index.js` contains trusted phone/email password authentication and account-management functions.
- `firestore.rules` protects private booking, profile, audit-log, and sanitized room-occupancy data.
- `server.js` serves the page locally for development.

## Run locally

From the project directory:

```powershell
npm start
```

Open `http://127.0.0.1:8000/`. Sign-in and data storage still use the configured live Firebase project; local hosting does not emulate Firebase.

## One-time Firebase setup

1. In Firebase Console, open the `ppec-booking` project. Make sure Firebase Authentication and Cloud Firestore are initialized.
2. Select a Firebase Blaze billing plan for Cloud Functions, then install the Firebase CLI and sign in:

   ```powershell
   npm.cmd install --global firebase-tools
   firebase.cmd login
   ```

3. Ensure each user has an approved profile document in `ppec_user` whose document ID is their Firebase Authentication UID. Profiles need `email`, `phone`, `name`, `role` (`ADMIN` or `DOCTOR`), `status: "Approved"`, and application `id`.
4. Deploy Firestore rules and Hosting to enable direct Firebase booking storage:

   ```powershell
   firebase.cmd deploy --only firestore:rules,hosting --project ppec-booking
   ```

5. Firestore rules protect direct booking, payout, and audit access. The phone/email login and account-administration endpoints run through Cloud Functions.
6. To enable phone/email password sign-in, doctor account management, and synchronized self-service password changes, deploy Cloud Functions. This requires Firebase Blaze:

   ```powershell
   npm.cmd install --prefix functions
   firebase.cmd deploy --only functions --project ppec-booking
   ```

7. From the Admin account, use **Approve New Surgeon Account** to create doctors. New doctors use temporary password `1`, can sign in with phone or email, and must change it at first sign-in. Admins can edit doctor profiles, set a password from the edit-profile popup, and remove app profiles.

Passwords are stored as salted hashes in a server-only Firestore collection; Firebase Authentication holds a separate random password. Never store plain-text passwords in user profiles.

## Sign-in and data behavior

- Users can sign in using either their registered phone number or email with the same application password. This custom sign-in requires the deployed Cloud Functions.
- Admins can create and edit doctor profile details, including the negotiated share. New accounts receive temporary password `1` and must change it at first sign-in. For existing accounts, Admins can enter a new password in the edit-profile popup; that password takes effect immediately.
- Doctors can change their own password from the account header. This uses a Cloud Function to update both Firebase Authentication and the phone/email credential store.
- An Admin can set a new password for a doctor from the edit-profile popup. This requires deployed Cloud Functions. An Admin can also delete a doctor's Firestore app profile directly. This blocks app access but does not delete the Firebase Authentication account; historical bookings and audit records are retained.
- Booking data is stored in `ppec_eye_bookings`. Doctors can read their own booking details; other doctors' schedule entries are represented by a separate occupancy-only collection without patient or surgeon details.
- User profiles are stored in `ppec_user`; audit entries are stored in `ppec_eye_logs`. Passwords are managed by Firebase Authentication and are never stored in Firestore.
- Booking, payout, deletion, and audit writes use a direct Firestore batch; booking conflicts are checked against the occupancy collection. Deploy Firestore rules before testing these actions.
- Doctor account creation and profile edits run through trusted Cloud Functions; Admin password resets and self-service password changes also use Functions to keep Firebase Authentication and phone/email credentials synchronized. Doctor profile deletion is a direct Firestore batch and does not remove the Firebase Authentication account.
- Doctors can read the occupancy-only feed, which shows occupied beds and times without exposing patient or surgeon identifiers. An Admin login synchronizes older bookings into this feed.
- Do not test with real patient information until Authentication, Firestore rules, and the app have been verified.

## Existing Firebase data

Existing Firebase Auth accounts must have a matching UID-keyed, approved `ppec_user` profile. A deleted app profile does not delete its Firebase Authentication account; clean up such Auth accounts separately in the Firebase Console if needed.
