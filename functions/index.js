const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");
const { getFirestore } = require("firebase-admin/firestore");
const { authenticator } = require("otplib");

// Se configura una sola vez con:
//   firebase functions:secrets:set GOOGLE_MAPS_API_KEY
// (correrlo desde una terminal propia — nunca pegues la key en un mensaje
// ni en un comando compartido). Nunca se hardcodea en el código fuente.
const GOOGLE_MAPS_API_KEY = defineSecret("GOOGLE_MAPS_API_KEY");

initializeApp();

const SUPER_ADMIN_UID = "VREc7Pqk0vgSH9PlR2acYWUjnFI2";

async function isAdminUid(uid) {
  if (uid === SUPER_ADMIN_UID) return true;
  const snap = await getFirestore().collection("admins").doc(uid).get();
  return snap.exists;
}

exports.enviarNotificacion = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Se requiere autenticación");
  }
  const { token, titulo, cuerpo, data } = request.data;
  if (!token || !titulo) {
    throw new HttpsError("invalid-argument", "Faltan parámetros");
  }
  await getMessaging().send({
    token,
    notification: { title: titulo, body: cuerpo ?? "" },
    data: data ?? {},
    android: {
      priority: "high",
      notification: { sound: "notificacion_taxi", channelId: "taxista_llego" },
    },
  });
  return { ok: true };
});

exports.generarSecretoTotp = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Se requiere autenticación");
  const uid = request.auth.uid;

  if (!(await isAdminUid(uid))) throw new HttpsError("permission-denied", "No autorizado");

  const secret = authenticator.generateSecret();
  await getFirestore().collection("_secrets").doc(uid).set({
    totpSecret: secret,
    updatedAt: new Date(),
  });

  const email = request.auth.token?.email || uid;
  const uri = authenticator.keyuri(email, "Taxi Admin", secret);
  return { uri };
});

exports.verificarTotp = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Se requiere autenticación");
  const { code } = request.data;
  const uid = request.auth.uid;

  const secretSnap = await getFirestore().collection("_secrets").doc(uid).get();
  const secret = secretSnap.data()?.totpSecret;
  if (!secret) throw new HttpsError("not-found", "2FA no configurado");

  const isValid = authenticator.verify({ token: code, secret });
  if (!isValid) throw new HttpsError("permission-denied", "Código incorrecto");

  return { ok: true };
});

exports.activarMfa = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Se requiere autenticación");
  const { code } = request.data;
  const uid = request.auth.uid;

  if (!(await isAdminUid(uid))) throw new HttpsError("permission-denied", "No autorizado");

  const secretSnap = await getFirestore().collection("_secrets").doc(uid).get();
  const secret = secretSnap.data()?.totpSecret;
  if (!secret) throw new HttpsError("not-found", "Primero genera el código QR");

  const isValid = authenticator.verify({ token: code, secret });
  if (!isValid) throw new HttpsError("permission-denied", "Código incorrecto");

  // Si es super admin, crear documento en admins si no existe
  const adminRef = getFirestore().collection("admins").doc(uid);
  const adminSnap = await adminRef.get();
  if (!adminSnap.exists) {
    await adminRef.set({
      uid,
      usuario: request.auth.token?.email || uid,
      nombre: "Administrador",
      rol: "admin",
      activo: true,
      mfaEnabled: true,
    });
  } else {
    await adminRef.update({ mfaEnabled: true });
  }

  return { ok: true };
});

// ── Ruta real para el simulador de viajes (página Pruebas) ──────────────────
// Llama a Directions API del lado del servidor — la API key nunca llega al
// navegador del admin. Devuelve la polyline decodificada más distancia y
// duración reales, para que el panel interpole puntos espaciados de forma
// uniforme en el tiempo (simulación a intervalos fijos y precisos).
exports.obtenerRutaSimulada = onCall(
  { secrets: [GOOGLE_MAPS_API_KEY] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Se requiere autenticación");
    }
    if (!(await isAdminUid(request.auth.uid))) {
      throw new HttpsError("permission-denied", "No autorizado");
    }

    const { origen, destino } = request.data || {};
    if (
      !origen || !destino ||
      typeof origen.lat !== "number" || typeof origen.lng !== "number" ||
      typeof destino.lat !== "number" || typeof destino.lng !== "number"
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Faltan coordenadas de origen/destino"
      );
    }

    const params = new URLSearchParams({
      origin: `${origen.lat},${origen.lng}`,
      destination: `${destino.lat},${destino.lng}`,
      key: GOOGLE_MAPS_API_KEY.value(),
      language: "es",
    });

    const res = await fetch(
      `https://maps.googleapis.com/maps/api/directions/json?${params}`
    );
    const json = await res.json();
    const route = (json.routes || [])[0];
    if (!route) {
      throw new HttpsError(
        "not-found",
        "No se encontró una ruta entre esos puntos"
      );
    }
    const leg = route.legs[0];

    return {
      puntos: decodePolyline(route.overview_polyline.points),
      distanciaMetros: leg.distance.value,
      duracionSegundos: leg.duration.value,
    };
  }
);

function decodePolyline(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}
