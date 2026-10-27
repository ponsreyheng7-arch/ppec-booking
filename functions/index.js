const { createHash, randomBytes } = require('node:crypto');
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

function requiredText(value, field, maxLength = 200) {
  if (typeof value !== 'string') {
    throw new HttpsError('invalid-argument', `${field} is required.`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw new HttpsError('invalid-argument', `${field} is required and must be at most ${maxLength} characters.`);
  }
  return trimmed;
}

function normalizeKey(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function requireApprovedAdmin(request) {
  const adminEmail = request.auth && request.auth.token.email;
  if (typeof adminEmail !== 'string' || !adminEmail) {
    throw new HttpsError('unauthenticated', 'Sign in with an approved Admin account.');
  }

  const matches = await db.collection(USERS)
    .where('email', '==', adminEmail.toLowerCase())
    .limit(1)
    .get();
  const admin = matches.docs[0] && matches.docs[0].data();
  if (!admin || admin.role !== 'ADMIN' || admin.status !== 'Approved') {
    throw new HttpsError('permission-denied', 'Only an approved Admin can create doctor accounts.');
  }
  return admin;
}

function validateDoctor(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpsError('invalid-argument', 'Doctor details are required.');
  }

  const email = requiredText(input.email, 'Email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpsError('invalid-argument', 'Enter a valid doctor email address.');
  }

  const phone = requiredText(input.phone, 'Phone number', 30);
  if (!/^[+\d][\d\s()-]{5,29}$/.test(phone)) {
    throw new HttpsError('invalid-argument', 'Enter a valid doctor phone number.');
  }

  const sharePct = Number(input.sharePct);
  if (!Number.isFinite(sharePct) || sharePct < 1 || sharePct > 100) {
    throw new HttpsError('invalid-argument', 'Surgeon share must be between 1 and 100.');
  }

  const status = input.status;
  if (status !== 'Approved' && status !== 'Suspended') {
    throw new HttpsError('invalid-argument', 'Choose Approved or Suspended status.');
  }

  return {
    id: requiredText(input.id, 'Profile ID', 40),
    role: 'DOCTOR',
    name: requiredText(input.name, 'Doctor name'),
    doctorCode: requiredText(input.doctorCode, 'Doctor ID', 40),
    phone,
    email,
    mustChangePassword: false,
    licenseNumber: requiredText(input.licenseNumber, 'Medical license number'),
    licenseAuthority: requiredText(input.licenseAuthority, 'Licensing authority'),
    clinic: requiredText(input.clinic, 'Clinic or hospital'),
    capabilities: requiredText(input.capabilities, 'Qualified procedures', 500),
    sharePct,
    paymentMethod: requiredText(input.paymentMethod, 'Payout method', 200),
    status,
    createdAt: new Date().toISOString().slice(0, 10),
    avatar: 'https://placehold.co/120x120/0d9488/ffffff?text=DR'
  };
}

async function rejectExistingDoctor(doctor) {
  const users = db.collection(USERS);
  const matches = await Promise.all([
    users.where('email', '==', doctor.email).limit(1).get(),
    users.where('doctorCode', '==', doctor.doctorCode).limit(1).get(),
    users.where('phone', '==', doctor.phone).limit(1).get(),
    users.where('id', '==', doctor.id).limit(1).get()
  ]);
  if (matches[0].size) {
    throw new HttpsError('already-exists', 'A doctor profile already uses this email address.');
  }
  if (matches[1].size) {
    throw new HttpsError('already-exists', 'A doctor already uses this Doctor ID.');
  }
  if (matches[2].size) {
    throw new HttpsError('already-exists', 'A doctor profile already uses this phone number.');
  }
  if (matches[3].size) {
    throw new HttpsError('already-exists', 'A doctor already uses this profile ID.');
  }
}

exports.createDoctorAccount = onCall({ region: 'us-central1' }, async request => {
  const admin = await requireApprovedAdmin(request);
  const doctor = validateDoctor(request.data && request.data.doctor);
  await rejectExistingDoctor(doctor);

  let newAuthUser;
  try {
    newAuthUser = await auth.createUser({
      email: doctor.email,
      password: randomBytes(32).toString('base64url')
    });
  } catch (error) {
    if (error.code === 'auth/email-already-exists') {
      throw new HttpsError('already-exists', 'A Firebase Authentication account already uses this email.');
    }
    logger.error('Failed to create Firebase Authentication account for doctor.', error);
    throw new HttpsError('internal', 'Firebase could not create the doctor account.');
  }

  const profileRef = db.collection(USERS).doc(newAuthUser.uid);
  const profile = { ...doctor, authUid: newAuthUser.uid };
  const codeIndex = db.collection('_ppec_doctor_codes').doc(normalizeKey(doctor.doctorCode.toLowerCase()));
  const phoneKey = doctor.phone.replace(/\D/g, '');
  const phoneIndex = db.collection('_ppec_doctor_phones').doc(normalizeKey(phoneKey));
  const now = new Date();
  const logRef = db.collection(LOGS).doc(`LOG-${now.getTime()}-${randomBytes(4).toString('hex')}`);

  try {
    await db.runTransaction(async transaction => {
      const [codeMatch, phoneMatch, profileMatch] = await Promise.all([
        transaction.get(codeIndex),
        transaction.get(phoneIndex),
        transaction.get(profileRef)
      ]);
      if (codeMatch.exists) {
        throw new HttpsError('already-exists', 'A doctor already uses this Doctor ID.');
      }
      if (phoneMatch.exists) {
        throw new HttpsError('already-exists', 'A doctor profile already uses this phone number.');
      }
      if (profileMatch.exists) {
        throw new HttpsError('already-exists', 'A profile already exists for this Firebase Authentication account.');
      }

      transaction.create(codeIndex, { profileId: profile.id });
      transaction.create(phoneIndex, { profileId: profile.id });
      transaction.create(profileRef, profile);
      transaction.create(logRef, {
        id: logRef.id,
        timestamp: `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`,
        actorName: admin.name || request.auth.token.email,
        actorRole: 'ADMIN',
        action: 'DOCTOR_APPROVED',
        details: `Admin created profile for ${doctor.name} (${doctor.doctorCode})`
      });
    });
  } catch (error) {
    try {
      await auth.deleteUser(newAuthUser.uid);
    } catch (rollbackError) {
      logger.error('Could not roll back the new Auth account after profile creation failed.', rollbackError);
    }
    if (error instanceof HttpsError) throw error;
    logger.error('Failed to save doctor profile and audit log.', error);
    throw new HttpsError('internal', 'Firebase could not save the doctor profile.');
  }

  return { profile };
});
