const { createHash, randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { logger } = require('firebase-functions');
const { HttpsError, onCall } = require('firebase-functions/v2/https');

initializeApp();

const auth = getAuth();
const db = getFirestore();
const USERS = 'ppec_user';
const CREDENTIALS = 'ppec_auth_credentials';
const LOGS = 'ppec_eye_logs';
const LOGIN_ATTEMPTS = '_ppec_login_attempts';
const DEFAULT_DOCTOR_PASSWORD = '1';
const LOGIN_ATTEMPT_LIMIT = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

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

function normalizePhone(value) {
  return typeof value === 'string' ? value.replace(/\D/g, '') : '';
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return {
    passwordSalt: salt,
    passwordHash: scryptSync(password, salt, 64).toString('hex')
  };
}

function passwordMatches(password, profile) {
  if (!profile.passwordSalt || !profile.passwordHash) return false;
  const actual = Buffer.from(scryptSync(password, profile.passwordSalt, 64).toString('hex'), 'hex');
  const expected = Buffer.from(profile.passwordHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function assertLoginNotRateLimited(accountKey, ip) {
  const refs = [
    db.collection(LOGIN_ATTEMPTS).doc(normalizeKey(`account:${accountKey}`)),
    db.collection(LOGIN_ATTEMPTS).doc(normalizeKey(`ip:${ip}`))
  ];
  const now = Date.now();
  await db.runTransaction(async transaction => {
    const snapshots = await Promise.all(refs.map(ref => transaction.get(ref)));
    if (snapshots.some(snapshot => {
      const data = snapshot.data();
      return data && data.blockedUntil > now;
    })) {
      throw new HttpsError('resource-exhausted', 'Too many sign-in attempts. Try again in 15 minutes.');
    }
  });
}

async function recordLoginFailure(accountKey, ip) {
  const refs = [
    db.collection(LOGIN_ATTEMPTS).doc(normalizeKey(`account:${accountKey}`)),
    db.collection(LOGIN_ATTEMPTS).doc(normalizeKey(`ip:${ip}`))
  ];
  const now = Date.now();
  await db.runTransaction(async transaction => {
    const snapshots = await Promise.all(refs.map(ref => transaction.get(ref)));
    snapshots.forEach((snapshot, index) => {
      const data = snapshot.data();
      const withinWindow = data && now - data.windowStartedAt < LOGIN_WINDOW_MS;
      const attempts = withinWindow ? data.attempts + 1 : 1;
      transaction.set(refs[index], {
        attempts,
        windowStartedAt: withinWindow ? data.windowStartedAt : now,
        blockedUntil: attempts >= LOGIN_ATTEMPT_LIMIT ? now + LOGIN_WINDOW_MS : 0
      });
    });
  });
}

async function requireApprovedAdmin(request) {
  const uid = request.auth && request.auth.uid;
  if (typeof uid !== 'string' || !uid) {
    throw new HttpsError('unauthenticated', 'Sign in with an approved Admin account.');
  }
  const adminSnapshot = await db.collection(USERS).doc(uid).get();
  const admin = adminSnapshot.exists ? adminSnapshot.data() : null;
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
    mustChangePassword: true,
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

async function rejectExistingDoctor(doctor, excludedProfileId = '') {
  const users = db.collection(USERS);
  const matches = await Promise.all([
    users.where('email', '==', doctor.email).limit(1).get(),
    users.where('doctorCode', '==', doctor.doctorCode).limit(1).get(),
    users.where('phone', '==', doctor.phone).limit(1).get(),
    users.where('id', '==', doctor.id).limit(1).get()
  ]);
  const containsOtherProfile = snapshot =>
    snapshot.docs.some(profileDoc => profileDoc.data().id !== excludedProfileId);
  if (containsOtherProfile(matches[0])) {
    throw new HttpsError('already-exists', 'A doctor profile already uses this email address.');
  }
  if (containsOtherProfile(matches[1])) {
    throw new HttpsError('already-exists', 'A doctor already uses this Doctor ID.');
  }
  if (containsOtherProfile(matches[2])) {
    throw new HttpsError('already-exists', 'A doctor profile already uses this phone number.');
  }
  if (containsOtherProfile(matches[3])) {
    throw new HttpsError('already-exists', 'A doctor already uses this profile ID.');
  }
}

exports.createDoctorAccount = onCall({ region: 'us-central1' }, async request => {
  const admin = await requireApprovedAdmin(request);
  const doctor = validateDoctor(request.data && request.data.doctor);
  try {
    await rejectExistingDoctor(doctor);
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    logger.error('Failed to check for duplicate doctor details.', error);
    throw new HttpsError('internal', 'Firebase could not verify the doctor details. Check Functions logs.');
  }

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
  const profile = {
    ...doctor,
    authUid: newAuthUser.uid,
    phoneKey: normalizePhone(doctor.phone)
  };
  const credentialsRef = db.collection(CREDENTIALS).doc(newAuthUser.uid);
  const initialCredentials = hashPassword(DEFAULT_DOCTOR_PASSWORD);
  const codeIndex = db.collection('_ppec_doctor_codes').doc(normalizeKey(doctor.doctorCode.toLowerCase()));
  const phoneKey = doctor.phone.replace(/\D/g, '');
  const phoneIndex = db.collection('_ppec_doctor_phones').doc(normalizeKey(phoneKey));
  const now = new Date();
  const logRef = db.collection(LOGS).doc(`LOG-${now.getTime()}-${randomBytes(4).toString('hex')}`);

  try {
    await db.runTransaction(async transaction => {
      const [codeMatch, phoneMatch, profileMatch, credentialsMatch] = await Promise.all([
        transaction.get(codeIndex),
        transaction.get(phoneIndex),
        transaction.get(profileRef),
        transaction.get(credentialsRef)
      ]);
      if (codeMatch.exists) {
        throw new HttpsError('already-exists', 'A doctor already uses this Doctor ID.');
      }
      if (phoneMatch.exists) {
        throw new HttpsError('already-exists', 'A doctor profile already uses this phone number.');
      }
      if (profileMatch.exists || credentialsMatch.exists) {
        throw new HttpsError('already-exists', 'A profile already exists for this Firebase Authentication account.');
      }

      transaction.create(codeIndex, { profileId: profile.id });
      transaction.create(phoneIndex, { profileId: profile.id });
      transaction.create(profileRef, profile);
      transaction.create(credentialsRef, initialCredentials);
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

  return { profile: { ...doctor, authUid: newAuthUser.uid } };
});

exports.updateDoctorAccount = onCall({ region: 'us-central1' }, async request => {
  const admin = await requireApprovedAdmin(request);
  const doctor = validateDoctor(request.data && request.data.doctor);
  let profileSnapshot;
  try {
    profileSnapshot = await db.collection(USERS).where('id', '==', doctor.id).limit(1).get();
  } catch (error) {
    logger.error(`Failed to load doctor profile ${doctor.id} for editing.`, error);
    throw new HttpsError('internal', 'Firebase could not load the doctor profile.');
  }
  if (profileSnapshot.empty || profileSnapshot.docs[0].data().role !== 'DOCTOR') {
    throw new HttpsError('not-found', 'Doctor profile not found.');
  }
  const profileRef = profileSnapshot.docs[0].ref;
  const previous = profileSnapshot.docs[0].data();
  try {
    await rejectExistingDoctor(doctor, doctor.id);
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    logger.error(`Failed to check duplicate details for doctor ${doctor.id}.`, error);
    throw new HttpsError('internal', 'Firebase could not verify the doctor details.');
  }

  const previousCodeIndex = db.collection('_ppec_doctor_codes')
    .doc(normalizeKey(String(previous.doctorCode || '').toLowerCase()));
  const nextCodeIndex = db.collection('_ppec_doctor_codes')
    .doc(normalizeKey(doctor.doctorCode.toLowerCase()));
  const previousPhoneIndex = db.collection('_ppec_doctor_phones')
    .doc(normalizeKey(normalizePhone(previous.phone)));
  const nextPhoneIndex = db.collection('_ppec_doctor_phones')
    .doc(normalizeKey(normalizePhone(doctor.phone)));
  const emailChanged = String(previous.email || '').toLowerCase() !== doctor.email;
  const now = new Date();
  const auditRef = db.collection(LOGS).doc(`LOG-${now.getTime()}-${randomBytes(4).toString('hex')}`);
  const updatedProfile = {
    ...doctor,
    authUid: profileRef.id,
    phoneKey: normalizePhone(doctor.phone),
    createdAt: previous.createdAt || doctor.createdAt,
    mustChangePassword: previous.mustChangePassword === true
  };

  if (emailChanged) {
    try {
      await auth.updateUser(profileRef.id, { email: doctor.email });
    } catch (error) {
      if (error.code === 'auth/email-already-exists') {
        throw new HttpsError('already-exists', 'A Firebase Authentication account already uses this email.');
      }
      logger.error(`Failed to update Firebase Authentication email for doctor ${doctor.id}.`, error);
      throw new HttpsError('internal', 'Firebase could not update the doctor email address.');
    }
  }

  try {
    await db.runTransaction(async transaction => {
      const [codeMatch, phoneMatch, latestProfile] = await Promise.all([
        transaction.get(nextCodeIndex),
        transaction.get(nextPhoneIndex),
        transaction.get(profileRef)
      ]);
      if (!latestProfile.exists) throw new HttpsError('not-found', 'Doctor profile not found.');
      if (codeMatch.exists && codeMatch.data().profileId !== doctor.id) {
        throw new HttpsError('already-exists', 'A doctor already uses this Doctor ID.');
      }
      if (phoneMatch.exists && phoneMatch.data().profileId !== doctor.id) {
        throw new HttpsError('already-exists', 'A doctor profile already uses this phone number.');
      }

      if (previousCodeIndex.path !== nextCodeIndex.path) {
        transaction.delete(previousCodeIndex);
      }
      if (previousPhoneIndex.path !== nextPhoneIndex.path) {
        transaction.delete(previousPhoneIndex);
      }
      transaction.set(nextCodeIndex, { profileId: doctor.id });
      transaction.set(nextPhoneIndex, { profileId: doctor.id });
      transaction.update(profileRef, updatedProfile);
      transaction.create(auditRef, {
        id: auditRef.id,
        timestamp: `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`,
        actorName: admin.name || request.auth.token.email,
        actorRole: 'ADMIN',
        action: 'DOCTOR_PROFILE_UPDATED',
        details: `Admin updated profile for ${doctor.name} (${doctor.doctorCode})`
      });
    });
  } catch (error) {
    if (emailChanged) {
      try {
        await auth.updateUser(profileRef.id, { email: previous.email });
      } catch (rollbackError) {
        logger.error(`Could not restore Firebase Authentication email for doctor ${doctor.id}.`, rollbackError);
      }
    }
    if (error instanceof HttpsError) throw error;
    logger.error(`Failed to update doctor profile ${doctor.id}.`, error);
    throw new HttpsError('internal', 'Firebase could not save the doctor profile.');
  }

  return { profile: updatedProfile };
});

exports.deleteDoctorAccount = onCall({ region: 'us-central1' }, async request => {
  const admin = await requireApprovedAdmin(request);
  const doctorId = requiredText(request.data && request.data.doctorId, 'Doctor ID', 40);
  let doctorSnapshot;
  try {
    doctorSnapshot = await db.collection(USERS).where('id', '==', doctorId).limit(1).get();
  } catch (error) {
    logger.error(`Failed to load doctor profile ${doctorId} for deletion.`, error);
    throw new HttpsError('internal', 'Firebase could not load the doctor profile.');
  }
  if (doctorSnapshot.empty || doctorSnapshot.docs[0].data().role !== 'DOCTOR') {
    throw new HttpsError('not-found', 'Doctor profile not found.');
  }

  const profileRef = doctorSnapshot.docs[0].ref;
  const doctor = doctorSnapshot.docs[0].data();
  const credentialRef = db.collection(CREDENTIALS).doc(profileRef.id);
  const codeIndexRef = db.collection('_ppec_doctor_codes')
    .doc(normalizeKey(String(doctor.doctorCode || '').toLowerCase()));
  const phoneIndexRef = db.collection('_ppec_doctor_phones')
    .doc(normalizeKey(normalizePhone(doctor.phone)));
  const audit = createServerAudit(
    request.auth.uid,
    admin,
    'DOCTOR_DELETED',
    `Admin deleted account for ${doctor.name} (${doctor.doctorCode}). Historical bookings and audit records were retained.`
  );

  try {
    await db.runTransaction(async transaction => {
      transaction.delete(profileRef);
      transaction.delete(credentialRef);
      transaction.delete(codeIndexRef);
      transaction.delete(phoneIndexRef);
      transaction.create(audit.ref, audit.data);
    });
  } catch (error) {
    logger.error(`Failed to delete Firestore profile ${doctorId}.`, error);
    throw new HttpsError('internal', 'Firebase could not delete the doctor profile.');
  }

  try {
    await auth.deleteUser(profileRef.id);
    return { success: true, authDeleted: true };
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      return { success: true, authDeleted: true };
    }
    logger.error(`Doctor profile ${doctorId} was deleted but its Firebase Auth account could not be deleted.`, error);
    return { success: true, authDeleted: false };
  }
});

function validateBooking(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpsError('invalid-argument', 'Booking details are required.');
  }
  const booking = {
    id: requiredText(input.id, 'Booking ID', 128),
    date: requiredText(input.date, 'Booking date', 10),
    bed: requiredText(input.bed, 'Operating bed', 40),
    startHour: Number(input.startHour),
    durationMinutes: Number(input.durationMinutes),
    duration: Number(input.duration),
    surgeryType: requiredText(input.surgeryType, 'Surgery type', 100),
    eyeSide: requiredText(input.eyeSide, 'Eye side', 10),
    patientLink: typeof input.patientLink === 'string' ? input.patientLink.slice(0, 1000) : '',
    patientName: requiredText(input.patientName, 'Patient name', 200),
    patientPhone: requiredText(input.patientPhone, 'Patient phone', 40),
    totalFee: Number(input.totalFee),
    doctorId: requiredText(input.doctorId, 'Doctor ID', 40),
    doctorName: requiredText(input.doctorName, 'Doctor name', 200),
    status: requiredText(input.status, 'Booking status', 40),
    notes: typeof input.notes === 'string' ? input.notes.slice(0, 3000) : '',
    paidStatus: input.paidStatus === 'PAID' ? 'PAID' : 'UNPAID',
    paidDate: typeof input.paidDate === 'string' ? input.paidDate : ''
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(booking.date)
    || !['A Zeiss', 'B Leica'].includes(booking.bed)
    || !Number.isFinite(booking.startHour)
    || !Number.isFinite(booking.durationMinutes)
    || !Number.isFinite(booking.duration)
    || booking.durationMinutes <= 0
    || booking.durationMinutes > 360
    || Math.abs(booking.duration - booking.durationMinutes / 60) > 0.001
    || !Number.isFinite(booking.totalFee)
    || booking.totalFee < 0
    || !['RE', 'LE', 'BE'].includes(booking.eyeSide)
    || !['Confirmed', 'In Surgery', 'Completed'].includes(booking.status)
    || (booking.paidStatus === 'PAID' && !/^\d{4}-\d{2}-\d{2}$/.test(booking.paidDate))
    || (booking.paidStatus === 'UNPAID' && booking.paidDate !== '')) {
    throw new HttpsError('invalid-argument', 'Booking information is invalid.');
  }
  const dayOfWeek = new Date(`${booking.date}T12:00:00Z`).getUTCDay();
  const endHour = booking.startHour + booking.duration;
  const validMorningSlot = booking.startHour >= 8 && endHour <= 11;
  const validAfternoonSlot = booking.startHour >= 14 && endHour <= 17;
  if (dayOfWeek === 0
    || !Number.isInteger(booking.startHour * 2)
    || !(validMorningSlot || validAfternoonSlot)) {
    throw new HttpsError('invalid-argument', 'Choose a valid Monday–Saturday operating-room time slot.');
  }
  return booking;
}

function createServerAudit(actorUid, actor, action, details) {
  const now = new Date();
  const timestamp = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`;
  const ref = db.collection(LOGS).doc(`LOG-${now.getTime()}-${randomBytes(4).toString('hex')}`);
  return {
    ref,
    data: {
      id: ref.id,
      timestamp,
      actorUid,
      actorName: actor.name || actor.email || 'Unknown user',
      actorRole: actor.role,
      action,
      details
    }
  };
}

exports.saveBooking = onCall({ region: 'us-central1' }, async request => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before saving a booking.');

  const actorSnapshot = await db.collection(USERS).doc(uid).get();
  const actor = actorSnapshot.exists ? actorSnapshot.data() : null;
  if (!actor || actor.status !== 'Approved' || !['ADMIN', 'DOCTOR'].includes(actor.role)) {
    throw new HttpsError('permission-denied', 'An approved account is required to save bookings.');
  }

  const booking = validateBooking(request.data && request.data.booking);
  const isAdmin = actor.role === 'ADMIN';
  if (!isAdmin && booking.doctorId !== actor.id) {
    throw new HttpsError('permission-denied', 'Doctors can only save their own bookings.');
  }

  const bookingRef = db.collection('ppec_eye_bookings').doc(booking.id);
  const occupancyRef = db.collection('ppec_eye_occupancy').doc(booking.id);
  const occupancyQuery = db.collection('ppec_eye_occupancy').where('date', '==', booking.date);
  const doctorQuery = isAdmin
    ? db.collection(USERS).where('id', '==', booking.doctorId).limit(1)
    : null;

  try {
    await db.runTransaction(async transaction => {
      const readRefs = [
        transaction.get(bookingRef),
        transaction.get(occupancyQuery)
      ];
      if (doctorQuery) readRefs.push(transaction.get(doctorQuery));
      const [existingSnapshot, occupancySnapshot, doctorSnapshot] = await Promise.all(readRefs);
      const existing = existingSnapshot.exists ? existingSnapshot.data() : null;

      if (existing && !isAdmin && existing.doctorId !== actor.id) {
        throw new HttpsError('permission-denied', 'Doctors can only update their own bookings.');
      }
      if (existing && !isAdmin) {
        if (existing.paidStatus !== booking.paidStatus || existing.paidDate !== booking.paidDate) {
          throw new HttpsError('permission-denied', 'Only an Admin can update payout status.');
        }
        const allowedDoctorChanges = new Set([
          'date', 'bed', 'startHour', 'durationMinutes', 'duration', 'surgeryType',
          'eyeSide', 'patientLink', 'patientName', 'patientPhone', 'status', 'notes', 'totalFee'
        ]);
        const changedKeys = Object.keys(booking).filter(key =>
          JSON.stringify(booking[key]) !== JSON.stringify(existing[key])
        );
        if (changedKeys.some(key => !allowedDoctorChanges.has(key))) {
          throw new HttpsError('permission-denied', 'Doctors cannot change payout or ownership fields.');
        }
      }
      if (!existing && !isAdmin && booking.paidStatus !== 'UNPAID') {
        throw new HttpsError('permission-denied', 'New bookings must start with an unpaid payout status.');
      }

      if (isAdmin) {
        if (doctorSnapshot.empty && !existing) {
          throw new HttpsError('failed-precondition', 'The selected doctor profile was not found.');
        }
        const assignedDoctor = doctorSnapshot.empty ? null : doctorSnapshot.docs[0];
        if (!assignedDoctor || assignedDoctor.data().role !== 'DOCTOR'
          || (!existing && assignedDoctor.data().status !== 'Approved')) {
          throw new HttpsError('failed-precondition', 'The selected doctor is not approved.');
        }
      }

      const conflict = occupancySnapshot.docs.find(occupiedDoc => {
        const occupied = occupiedDoc.data();
        if (occupiedDoc.id === booking.id || occupied.bed !== booking.bed) return false;
        const occupiedStart = Number(occupied.startHour);
        const occupiedEnd = occupiedStart + Number(occupied.duration);
        return booking.startHour < occupiedEnd
          && booking.startHour + booking.duration > occupiedStart;
      });
      if (conflict) {
        throw new HttpsError('already-exists', 'This bed and time are already occupied. Choose another available slot.');
      }

      const action = existing
        ? (existing.paidStatus !== booking.paidStatus || existing.paidDate !== booking.paidDate
          ? 'PAID_SETTLEMENT'
          : 'MODIFIED')
        : 'CREATED';
      const audit = createServerAudit(
        uid,
        actor,
        action,
        `${action === 'CREATED' ? 'Created' : action === 'MODIFIED' ? 'Updated' : 'Updated payout for'} booking ${booking.id} on ${booking.date} at ${booking.bed}`
      );

      transaction.set(bookingRef, booking);
      transaction.set(occupancyRef, {
        id: booking.id,
        date: booking.date,
        bed: booking.bed,
        startHour: booking.startHour,
        durationMinutes: booking.durationMinutes,
        duration: booking.duration
      });
      transaction.create(audit.ref, audit.data);
    });
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    logger.error('Failed to save booking transaction.', error);
    throw new HttpsError('internal', 'Firebase could not save the booking. Check Functions logs.');
  }
  return { success: true };
});

exports.syncEmailPasswordForPhoneLogin = onCall({ region: 'us-central1' }, async request => {
  const uid = request.auth && request.auth.uid;
  const password = request.data && request.data.password;
  const email = request.auth && request.auth.token && request.auth.token.email;
  if (!uid || !email) {
    throw new HttpsError('unauthenticated', 'Sign in with the account email before syncing phone sign-in.');
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
    throw new HttpsError('invalid-argument', 'The email account password is invalid.');
  }

  const profileRef = db.collection(USERS).doc(uid);
  const profileSnapshot = await profileRef.get();
  const profile = profileSnapshot.exists ? profileSnapshot.data() : null;
  if (!profile || profile.status !== 'Approved'
    || !['ADMIN', 'DOCTOR'].includes(profile.role)
    || String(profile.email || '').toLowerCase() !== String(email).toLowerCase()) {
    throw new HttpsError('permission-denied', 'An approved profile linked to this email is required.');
  }

  await db.collection(CREDENTIALS).doc(uid).set(hashPassword(password));
  return { success: true };
});

exports.deleteBooking = onCall({ region: 'us-central1' }, async request => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before deleting a booking.');
  const actorSnapshot = await db.collection(USERS).doc(uid).get();
  const actor = actorSnapshot.exists ? actorSnapshot.data() : null;
  if (!actor || actor.status !== 'Approved' || !['ADMIN', 'DOCTOR'].includes(actor.role)) {
    throw new HttpsError('permission-denied', 'An approved account is required to delete bookings.');
  }

  const bookingId = requiredText(request.data && request.data.bookingId, 'Booking ID', 128);
  const bookingRef = db.collection('ppec_eye_bookings').doc(bookingId);
  const occupancyRef = db.collection('ppec_eye_occupancy').doc(bookingId);
  await db.runTransaction(async transaction => {
    const [bookingSnapshot] = await Promise.all([transaction.get(bookingRef)]);
    if (!bookingSnapshot.exists) throw new HttpsError('not-found', 'Booking not found.');
    const booking = bookingSnapshot.data();
    if (actor.role !== 'ADMIN' && booking.doctorId !== actor.id) {
      throw new HttpsError('permission-denied', 'Doctors can only cancel their own bookings.');
    }

    const audit = createServerAudit(
      uid,
      actor,
      'DELETED',
      `Cancelled booking ${bookingId} on ${booking.date} at ${booking.bed}`
    );
    transaction.delete(bookingRef);
    transaction.delete(occupancyRef);
    transaction.create(audit.ref, audit.data);
  });
  return { success: true };
});

exports.syncBookingOccupancy = onCall({ region: 'us-central1' }, async request => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in as Admin to prepare the room availability feed.');
  const adminSnapshot = await db.collection(USERS).doc(uid).get();
  const admin = adminSnapshot.exists ? adminSnapshot.data() : null;
  if (!admin || admin.role !== 'ADMIN' || admin.status !== 'Approved') {
    throw new HttpsError('permission-denied', 'Only an approved Admin can prepare the room availability feed.');
  }

  const [bookingsSnapshot, usersSnapshot, occupancySnapshot] = await Promise.all([
    db.collection('ppec_eye_bookings').get(),
    db.collection(USERS).where('role', '==', 'DOCTOR').get(),
    db.collection('ppec_eye_occupancy').get()
  ]);
  const doctorUids = new Map(usersSnapshot.docs.map(doctorDoc => [
    doctorDoc.data().id,
    doctorDoc.id
  ]));
  const existingOccupancies = new Map(occupancySnapshot.docs.map(occupancyDoc => [
    occupancyDoc.id,
    occupancyDoc.data()
  ]));
  const desiredOccupancies = bookingsSnapshot.docs
    .map(bookingDoc => ({ id: bookingDoc.id, ...bookingDoc.data() }))
    .filter(booking => booking.id && booking.date && booking.bed
      && doctorUids.has(booking.doctorId))
    .map(booking => ({
      id: booking.id,
      date: booking.date,
      bed: booking.bed,
      startHour: Number(booking.startHour),
      durationMinutes: Number(booking.durationMinutes),
      duration: Number(booking.duration)
    }));
  const desiredIds = new Set(desiredOccupancies.map(occupancy => occupancy.id));
  const changes = [
    ...desiredOccupancies.filter(occupancy => {
      const current = existingOccupancies.get(occupancy.id);
      return !current || current.ownerUid
        || Object.keys(occupancy).some(key => current[key] !== occupancy[key]);
    }).map(occupancy => ({ id: occupancy.id, data: occupancy })),
    ...occupancySnapshot.docs
      .filter(occupancyDoc => !desiredIds.has(occupancyDoc.id))
      .map(occupancyDoc => ({ id: occupancyDoc.id, delete: true }))
  ];

  for (let offset = 0; offset < changes.length; offset += 400) {
    const batch = db.batch();
    changes.slice(offset, offset + 400).forEach(change => {
      const ref = db.collection('ppec_eye_occupancy').doc(change.id);
      if (change.delete) batch.delete(ref);
      else batch.set(ref, change.data);
    });
    await batch.commit();
  }
  return { synchronized: desiredOccupancies.length };
});

const resetUserPassword = onCall({ region: 'us-central1' }, async request => {
  const admin = await requireApprovedAdmin(request);
  const profileId = requiredText(
    request.data && (request.data.userId || request.data.doctorId),
    'User ID',
    40
  );
  const password = request.data && request.data.password;
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new HttpsError('invalid-argument', 'Choose a password with at least 8 characters.');
  }
  const profileSnapshot = await db.collection(USERS).where('id', '==', profileId).limit(1).get();
  if (profileSnapshot.empty || !['ADMIN', 'DOCTOR'].includes(profileSnapshot.docs[0].data().role)) {
    throw new HttpsError('not-found', 'User profile not found.');
  }
  const profileRef = profileSnapshot.docs[0].ref;
  const profile = profileSnapshot.docs[0].data();

  const credentialRef = db.collection(CREDENTIALS).doc(profileRef.id);
  const audit = createServerAudit(
    request.auth.uid,
    admin,
    'USER_PASSWORD_RESET',
    `Set a new password for ${profile.name} (${profile.email || profile.id})`
  );
  await db.runTransaction(async transaction => {
    transaction.set(credentialRef, hashPassword(password));
    transaction.update(profileRef, { mustChangePassword: false });
    transaction.create(audit.ref, audit.data);
  });
  try {
    await auth.updateUser(profileRef.id, { password });
  } catch (error) {
    logger.error(`Application password changed but Firebase Auth password sync failed for user ${profileId}.`, error);
    throw new HttpsError('internal', 'The application password was changed, but Firebase Authentication could not be synchronized. Contact the administrator.');
  }
  return {
    phone: profile.phone || '',
    email: profile.email || ''
  };
});

exports.resetUserPassword = resetUserPassword;
exports.resetDoctorPassword = resetUserPassword;

exports.loginWithPhonePassword = onCall({ region: 'us-central1' }, async request => {
  const identifier = requiredText(
    request.data && (request.data.identifier || request.data.phone),
    'Phone number or email',
    254
  );
  const password = request.data && request.data.password;
  const isEmail = identifier.includes('@');
  const accountKey = isEmail ? identifier.toLowerCase() : normalizePhone(identifier);
  if ((isEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(accountKey))
    || (!isEmail && (accountKey.length < 6 || accountKey.length > 20))
    || typeof password !== 'string'
    || !password
    || password.length > 128) {
    throw new HttpsError('invalid-argument', 'Enter a valid phone number or email and password.');
  }

  const ip = request.rawRequest && request.rawRequest.ip || 'unknown';
  await assertLoginNotRateLimited(accountKey, ip);

  const profiles = await db.collection(USERS).get();
  const match = profiles.docs.find(profileDoc => {
    const profile = profileDoc.data();
    return isEmail
      ? String(profile.email || '').trim().toLowerCase() === accountKey
      : normalizePhone(profile.phone) === accountKey;
  });
  if (!match) {
    await recordLoginFailure(accountKey, ip);
    throw new HttpsError('unauthenticated', 'Phone/email or password is incorrect.');
  }

  let profile = match.data();
  if (!['ADMIN', 'DOCTOR'].includes(profile.role) || profile.status !== 'Approved') {
    await recordLoginFailure(accountKey, ip);
    throw new HttpsError('unauthenticated', 'Phone/email or password is incorrect, or the account is not approved.');
  }

  const credentialsRef = db.collection(CREDENTIALS).doc(match.id);
  const credentialsSnapshot = await credentialsRef.get();
  if (!credentialsSnapshot.exists) {
    if (profile.role !== 'DOCTOR' || password !== DEFAULT_DOCTOR_PASSWORD) {
      await recordLoginFailure(accountKey, ip);
      throw new HttpsError('unauthenticated', 'Phone/email or password is incorrect.');
    }
    const initialPassword = hashPassword(DEFAULT_DOCTOR_PASSWORD);
    await db.runTransaction(async transaction => {
      const [latestProfileSnapshot, latestCredentialsSnapshot] = await Promise.all([
        transaction.get(match.ref),
        transaction.get(credentialsRef)
      ]);
      const latestProfile = latestProfileSnapshot.data();
      if (latestCredentialsSnapshot.exists) {
        if (!passwordMatches(password, latestCredentialsSnapshot.data())) {
          throw new HttpsError('unauthenticated', 'Phone/email or password is incorrect.');
        }
        profile = latestProfile;
        return;
      }
      profile = {
        ...latestProfile,
        phoneKey: normalizePhone(latestProfile.phone),
        mustChangePassword: true
      };
      transaction.create(credentialsRef, initialPassword);
      transaction.update(match.ref, {
        phoneKey: normalizePhone(latestProfile.phone),
        mustChangePassword: true
      });
    });
  } else if (!passwordMatches(password, credentialsSnapshot.data())) {
    await recordLoginFailure(accountKey, ip);
    throw new HttpsError('unauthenticated', 'Phone/email or password is incorrect.');
  }

  const customToken = await auth.createCustomToken(match.id);
  return {
    customToken,
    mustChangePassword: profile.mustChangePassword === true
  };
});

exports.changePhonePassword = onCall({ region: 'us-central1' }, async request => {
  const uid = request.auth && request.auth.uid;
  const newPassword = request.data && request.data.newPassword;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before changing your password.');
  if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
    throw new HttpsError('invalid-argument', 'Choose a password with at least 8 characters.');
  }

  const profileRef = db.collection(USERS).doc(uid);
  const profileSnapshot = await profileRef.get();
  if (!profileSnapshot.exists) throw new HttpsError('permission-denied', 'Approved user profile not found.');
  const profile = profileSnapshot.data();
  if (!['ADMIN', 'DOCTOR'].includes(profile.role) || profile.status !== 'Approved') {
    throw new HttpsError('permission-denied', 'Only approved users can change their password.');
  }

  await db.runTransaction(async transaction => {
    transaction.set(db.collection(CREDENTIALS).doc(uid), hashPassword(newPassword));
    transaction.update(profileRef, { mustChangePassword: false });
  });
  try {
    await auth.updateUser(uid, { password: newPassword });
  } catch (error) {
    logger.error(`Phone password was updated but Firebase Auth password sync failed for ${uid}.`, error);
    throw new HttpsError('internal', 'Phone password changed, but email password sync failed. Contact the Admin.');
  }
  return { success: true };
});
