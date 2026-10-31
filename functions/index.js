const { randomBytes } = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { logger } = require('firebase-functions');
const { HttpsError, onCall } = require('firebase-functions/v2/https');

initializeApp();

const auth = getAuth();
const db = getFirestore();
const USERS = 'ppec_user';
const LOGS = 'ppec_eye_logs';

async function requireApprovedAdmin(request) {
  const uid = request.auth && request.auth.uid;
  if (typeof uid !== 'string' || !uid) {
    throw new HttpsError('unauthenticated', 'Sign in with an approved Admin account.');
  }

  const snapshot = await db.collection(USERS).doc(uid).get();
  const profile = snapshot.exists ? snapshot.data() : null;
  if (!profile || profile.role !== 'ADMIN' || profile.status !== 'Approved') {
    throw new HttpsError('permission-denied', 'Only an approved Admin can update doctor passwords.');
  }
  return profile;
}

exports.adminSetDoctorPassword = onCall({ region: 'us-central1' }, async request => {
  const admin = await requireApprovedAdmin(request);
  const doctorUid = request.data && request.data.doctorUid;
  const password = request.data && request.data.password;
  if (typeof doctorUid !== 'string' || !doctorUid.trim()) {
    throw new HttpsError('invalid-argument', 'Doctor account is required.');
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new HttpsError('invalid-argument', 'Choose a password with 8 to 128 characters.');
  }

  const doctorRef = db.collection(USERS).doc(doctorUid);
  const doctorSnapshot = await doctorRef.get();
  if (!doctorSnapshot.exists || doctorSnapshot.data().role !== 'DOCTOR') {
    throw new HttpsError('not-found', 'Doctor profile not found.');
  }
  const doctor = doctorSnapshot.data();

  try {
    await auth.updateUser(doctorUid, { password });
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      throw new HttpsError('not-found', 'Firebase Authentication account was not found for this doctor.');
    }
    logger.error(`Failed to update Firebase Authentication password for doctor ${doctorUid}.`, error);
    throw new HttpsError('internal', 'Firebase could not update the doctor password.');
  }

  const now = new Date();
  const auditRef = db.collection(LOGS).doc(
    `LOG-${now.getTime()}-${randomBytes(4).toString('hex')}`
  );
  try {
    await db.runTransaction(async transaction => {
      const currentDoctor = await transaction.get(doctorRef);
      if (!currentDoctor.exists || currentDoctor.data().role !== 'DOCTOR') {
        throw new HttpsError('not-found', 'Doctor profile not found.');
      }
      transaction.update(doctorRef, { mustChangePassword: true });
      transaction.create(auditRef, {
        id: auditRef.id,
        timestamp: `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`,
        actorUid: request.auth.uid,
        actorName: admin.name || request.auth.token.email || 'Admin',
        actorRole: 'ADMIN',
        action: 'DOCTOR_PASSWORD_RESET',
        details: `Admin set a new password for ${doctor.name} (${doctor.email || doctor.id})`
      });
    });
  } catch (error) {
    logger.error(`Password was changed but the doctor profile could not be updated for ${doctorUid}.`, error);
    throw new HttpsError(
      'internal',
      'Password was updated, but the profile could not be marked for a required password change. Contact the administrator.'
    );
  }

  return { success: true };
});
