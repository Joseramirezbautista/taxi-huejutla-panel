import { app, auth, db } from './app.js';
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
} from 'https://www.gstatic.com/firebasejs/10.0.0/firebase-auth.js';
import {
  collection, query, where, getDocs,
  doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.0.0/firebase-firestore.js';
import {
  getFunctions,
  httpsCallable,
} from 'https://www.gstatic.com/firebasejs/10.0.0/firebase-functions.js';

const SESSION_KEY = 'taxi_admin_session';
const FIREBASE_API_KEY = 'AIzaSyD2j_rGW0l0Boplo7bATx6ywFjAHhhcBHI';

function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}

function setSession(data) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ ...data, loginAt: new Date().toISOString() }));
}

function getFns() {
  return getFunctions(app, 'us-central1');
}

export const Auth = {
  isLoggedIn() {
    return !!getSession() && !!auth.currentUser;
  },

  getCurrentUser() {
    return getSession();
  },

  async login(usuario, password) {
    try {
      const cred = await signInWithEmailAndPassword(auth, usuario, password);
      const user = cred.user;

      // Verificar que existe en admins
      const adminSnap = await getDoc(doc(db, 'admins', user.uid));
      const esSuperadmin = user.uid === 'VREc7Pqk0vgSH9PlR2acYWUjnFI2';
      const isAdmin = adminSnap.exists() || esSuperadmin;

      if (!isAdmin) {
        await signOut(auth);
        return { ok: false, msg: 'No tienes permisos de administrador' };
      }

      const adminData = adminSnap.exists() ? adminSnap.data() : {};

      if (adminData.activo === false) {
        await signOut(auth);
        return { ok: false, msg: 'Tu cuenta fue desactivada. Contacta a un administrador.' };
      }

      const mfaEnabled = adminData.mfaEnabled ?? false;

      if (mfaEnabled) {
        // No guardar sesión todavía — esperar verificación TOTP
        return { ok: true, mfaPending: true };
      }

      setSession({
        uid: user.uid,
        usuario,
        nombre: adminData.nombre || 'Administrador',
        rol: adminData.rol || 'admin',
        permisos: adminData.permisos || null,
      });
      return { ok: true };
    } catch (e) {
      if (e.code === 'auth/invalid-credential' || e.code === 'auth/wrong-password' || e.code === 'auth/user-not-found') {
        return { ok: false, msg: 'Usuario o contraseña incorrectos' };
      }
      return { ok: false, msg: e.code || e.message || 'Error al iniciar sesión' };
    }
  },

  async verificarMfa(code, usuario) {
    try {
      const user = auth.currentUser;
      if (!user) return { ok: false, msg: 'Sesión expirada, recarga la página' };

      const verificar = httpsCallable(getFns(), 'verificarTotp');
      await verificar({ code });

      const adminSnap = await getDoc(doc(db, 'admins', user.uid));
      const adminData = adminSnap.exists() ? adminSnap.data() : {};

      setSession({
        uid: user.uid,
        usuario,
        nombre: adminData.nombre || 'Administrador',
        rol: adminData.rol || 'admin',
        permisos: adminData.permisos || null,
      });
      return { ok: true };
    } catch (e) {
      await signOut(auth);
      if (e.code === 'functions/permission-denied') {
        return { ok: false, msg: 'Código incorrecto' };
      }
      if (e.code === 'functions/not-found') {
        return { ok: false, msg: '2FA no configurado' };
      }
      return { ok: false, msg: 'Error al verificar código' };
    }
  },

  async cambiarPassword(uid, passwordActual, passwordNueva) {
    const user = auth.currentUser;
    if (!user) return { ok: false, msg: 'No hay sesión activa' };
    try {
      const cred = EmailAuthProvider.credential(user.email, passwordActual);
      await reauthenticateWithCredential(user, cred);
      await updatePassword(user, passwordNueva);
      return { ok: true };
    } catch (e) {
      if (e.code === 'auth/wrong-password' || e.code === 'auth/invalid-credential') {
        return { ok: false, msg: 'La contraseña actual es incorrecta' };
      }
      if (e.code === 'auth/weak-password') {
        return { ok: false, msg: 'La nueva contraseña debe tener al menos 6 caracteres' };
      }
      return { ok: false, msg: e.message || 'Error al cambiar contraseña' };
    }
  },

  async verificarPasswordActual(password) {
    const user = auth.currentUser;
    if (!user) return { ok: false, msg: 'No hay sesión activa' };
    try {
      const cred = EmailAuthProvider.credential(user.email, password);
      await reauthenticateWithCredential(user, cred);
      return { ok: true };
    } catch (e) {
      if (e.code === 'auth/wrong-password' || e.code === 'auth/invalid-credential') {
        return { ok: false, msg: 'Contraseña incorrecta' };
      }
      return { ok: false, msg: e.message || 'Error al verificar' };
    }
  },

  async logout() {
    localStorage.removeItem(SESSION_KEY);
    await signOut(auth);
    const isInPages = window.location.pathname.includes('/pages/');
    window.location.href = isInPages ? 'login.html' : 'pages/login.html';
  },

  protect() {
    if (!getSession()) {
      const isInPages = window.location.pathname.includes('/pages/');
      window.location.href = isInPages ? 'login.html' : 'pages/login.html';
      return;
    }
    onAuthStateChanged(auth, (user) => {
      if (!user) {
        localStorage.removeItem(SESSION_KEY);
        const isInPages = window.location.pathname.includes('/pages/');
        window.location.href = isInPages ? 'login.html' : 'pages/login.html';
      }
    });
  },

  // ===== GESTIÓN DE ADMINS =====
  async listarAdmins() {
    try {
      const snap = await getDocs(collection(db, 'admins'));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch { return []; }
  },

  async crearAdmin({ nombre, usuario, password, rol = 'admin', permisos = null }) {
    try {
      const authRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: usuario, password, returnSecureToken: false }),
        }
      );
      const authData = await authRes.json();
      if (!authRes.ok) {
        const msg = authData.error?.message;
        if (msg === 'EMAIL_EXISTS')  return { ok: false, msg: 'El correo ya está registrado' };
        if (msg === 'INVALID_EMAIL') return { ok: false, msg: 'Correo electrónico inválido' };
        if (msg === 'WEAK_PASSWORD') return { ok: false, msg: 'Contraseña muy débil (mínimo 6 caracteres)' };
        return { ok: false, msg: msg || 'Error al crear cuenta' };
      }
      const newUid = authData.localId;
      const data = { nombre, usuario, uid: newUid, rol, activo: true, creadoEn: serverTimestamp() };
      if (rol === 'personalizado') data.permisos = permisos || {};
      await setDoc(doc(db, 'admins', newUid), data);
      return { ok: true, id: newUid };
    } catch (e) {
      return { ok: false, msg: e.message || 'Error al crear usuario' };
    }
  },

  async actualizarPermisos(uid, { rol, permisos }) {
    try {
      const data = { rol };
      data.permisos = rol === 'personalizado' ? (permisos || {}) : deleteField();
      await updateDoc(doc(db, 'admins', uid), data);
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: e.message || 'Error al actualizar permisos' };
    }
  },

  async desactivarAdmin(uid) {
    await updateDoc(doc(db, 'admins', uid), { activo: false });
    return { ok: true };
  },

  async reactivarAdmin(uid) {
    await updateDoc(doc(db, 'admins', uid), { activo: true });
    return { ok: true };
  },

  async eliminarAdmin(uid) {
    await deleteDoc(doc(db, 'admins', uid));
    return { ok: true };
  },

  // ===== ALTA MANUAL DE CLIENTE/TAXISTA (sin pasar por SMS) =====
  async crearUsuarioApp({ tipo, nombre, telefono, password, direccion, vehiculo }) {
    try {
      const telefonoLimpio = telefono.replace(/\s+/g, '');
      const email = `${telefonoLimpio}@taxihuejutla.com`;

      const authRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, returnSecureToken: false }),
        }
      );
      const authData = await authRes.json();
      if (!authRes.ok) {
        const msg = authData.error?.message;
        if (msg === 'EMAIL_EXISTS')  return { ok: false, msg: 'Ese número de teléfono ya está registrado' };
        if (msg === 'WEAK_PASSWORD') return { ok: false, msg: 'Contraseña muy débil (mínimo 6 caracteres)' };
        if (msg === 'INVALID_EMAIL') return { ok: false, msg: 'El teléfono ingresado no es válido' };
        return { ok: false, msg: msg || 'Error al crear cuenta' };
      }

      const uid = authData.localId;

      if (tipo === 'cliente') {
        await setDoc(doc(db, 'clientes', uid), {
          nombre,
          telefono: telefonoLimpio,
          direccion: direccion?.direccion || '',
          exterior: direccion?.exterior || '',
          colonia: direccion?.colonia || '',
          cp: direccion?.cp || '',
          activo: true,
          bloqueado: false,
          calificaciones: 5.0,
          viajes: 0,
          fechaRegistro: serverTimestamp(),
          creadoPorAdmin: true,
        });
      } else {
        await setDoc(doc(db, 'taxistas', uid), {
          nombre,
          telefono: telefonoLimpio,
          vehiculo: {
            marca:  vehiculo?.marca  || '',
            modelo: vehiculo?.modelo || '',
            año:    vehiculo?.anio   || '',
            color:  vehiculo?.color  || '',
            placas: vehiculo?.placas || '',
            tipo:   vehiculo?.tipo   || '',
          },
          estado: 'disponible',
          activo: true,
          calificacion: 5.0,
          viajes: 0,
          fechaRegistro: serverTimestamp(),
          creadoPorAdmin: true,
          pagoFechaFinPrueba: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
          pagoEstado: 'prueba',
        });
      }

      return { ok: true, uid, telefono: telefonoLimpio };
    } catch (e) {
      return { ok: false, msg: e.message || 'Error al crear usuario' };
    }
  },

  getFns,
};
