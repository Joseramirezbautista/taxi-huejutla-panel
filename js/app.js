import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.0.0/firebase-app.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.0.0/firebase-firestore.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.0.0/firebase-auth.js';
import { getStorage } from 'https://www.gstatic.com/firebasejs/10.0.0/firebase-storage.js';

const firebaseConfig = {
  apiKey: "AIzaSyD2j_rGW0l0Boplo7bATx6ywFjAHhhcBHI",
  authDomain: "taxi-huejutla.firebaseapp.com",
  projectId: "taxi-huejutla",
  storageBucket: "taxi-huejutla.firebasestorage.app",
  messagingSenderId: "704815846259",
  appId: "1:704815846259:web:f7da2d477cfd6157742b06"
};

const app     = initializeApp(firebaseConfig);
const db      = getFirestore(app);
const auth    = getAuth(app);
const storage = getStorage(app);

export { app, db, auth, storage };
