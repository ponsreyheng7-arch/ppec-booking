# PPEC Operating Room Booking

## Project layout

- `public/index.html` is the browser application served locally and by Firebase Hosting.
- `functions/index.js` contains the Admin-only doctor password update endpoint.
- `firestore.rules` protects private booking, profile, audit-log, and sanitized room-occupancy data.
- `server.js` serves the page locally for development.

## Run locally

From the project directory:

```powershell
npm start
```

Open `http://127.0.0.1:8000/`. Sign-in and data storage still use the configured live Firebase project; local hosting does not emulate Firebase.

## One-time Firebase setup

1. In Firebase Console, open the `ppec-booking` project. Initialize Firebase Authentication and Cloud Firestore, and enable the **Email/Password** sign-in provider.
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

5. Firestore rules protect direct booking, payout, audit, and profile access. Admin password resets use a callable Cloud Function because the Firebase client SDK cannot change another user's password.
6. From the Admin account, use **Approve New Surgeon Account** to create doctors. Enter an initial password of at least 8 characters. Doctors sign in with their email and password. Admins can set a temporary password from the doctor profile editor.

To let Admins set a temporary password directly, upgrade the Firebase project to the Blaze plan, then deploy the password reset Function:

```powershell
npm.cmd install --prefix functions
firebase.cmd deploy --only functions:adminSetDoctorPassword --project ppec-booking
```

### Password reset email troubleshooting

- In Firebase Console, confirm **Authentication > Sign-in method > Email/Password** is enabled and **Authentication > Templates > Password reset** has an active sender/template.
- Use the exact email address on the user's Firebase Authentication account, not just an email written in their Firestore profile. Check Inbox, Spam/Junk, and any mail filters.
- The login page intentionally does not confirm whether an account exists. If Firebase has Email Enumeration Protection enabled, it may accept the request without sending email when no Authentication account matches.
- If Firebase reports an unauthorized domain, add the app's hostname in **Authentication > Settings > Authorized domains**.

## Sign-in and data behavior

- Users sign in with their Firebase Authentication email and password. Phone-number/password sign-in is not supported without a trusted backend; phone numbers remain profile/contact information.
- Admins can create doctor accounts directly through the Firebase client SDK, then save the profile and audit entry in Firestore. The app creates the Authentication user in a separate Firebase app instance so the Admin session stays signed in.
- Doctors can change their own password from the account header. Admins can set a temporary password from the doctor profile editor; the doctor is required to change it at next sign-in. This privileged operation runs through the `adminSetDoctorPassword` Cloud Function and is authorized only for approved Admins.
- An Admin can delete a doctor's Firestore app profile directly. This blocks app access but does not delete the Firebase Authentication account; historical bookings and audit records are retained.
- Booking data is stored in `ppec_eye_bookings`. Doctors can read their own booking details; other doctors' schedule entries are represented by a separate occupancy-only collection without patient or surgeon details.
- User profiles are stored in `ppec_user`; audit entries are stored in `ppec_eye_logs`. Passwords are managed by Firebase Authentication and are never stored in Firestore.
- Booking, payout, deletion, and audit writes use a direct Firestore batch; booking conflicts are checked against the occupancy collection. Deploy Firestore rules before testing these actions.
- Doctor account creation and profile edits use the Firebase client SDK and Firestore security rules. Only Admin password updates require the deployed Cloud Function.
- Doctors can read the occupancy-only feed, which shows occupied beds and times without exposing patient or surgeon identifiers. An Admin login synchronizes older bookings into this feed.
- Do not test with real patient information until Authentication, Firestore rules, and the app have been verified.

## Existing Firebase data

Existing Firebase Auth accounts must have a matching UID-keyed, approved `ppec_user` profile. A deleted app profile does not delete its Firebase Authentication account; clean up such Auth accounts separately in the Firebase Console if needed.

Existing accounts that relied on phone/password sign-in must use their email and Firebase Authentication password. If they do not know that password, use the login page's reset-link action or the Firebase Console to reset it.
