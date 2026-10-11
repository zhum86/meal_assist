// Firebase web app config (Project settings → General → Your apps → SDK setup and configuration → Config).
// These values identify the project and are safe to publish; access is controlled by firestore.rules.
// Set to null to run without cloud sync.
window.FIREBASE_CONFIG = {
  apiKey: 'AIzaSyCzSD4T4qRbhYNfkfsFHQzbJ4FQHHWz6iE',
  authDomain: 'meal-assist-87781.firebaseapp.com',
  projectId: 'meal-assist-87781',
  storageBucket: 'meal-assist-87781.firebasestorage.app',
  messagingSenderId: '749243384257',
  appId: '1:749243384257:web:8ce454e73a20b664ceaf40',
};

// New families can only be made while this is true AND firestore.rules allows "create"
// on families/{code}. Both are off: the family already exists, so nobody else can add one.
window.ALLOW_CREATE_FAMILY = false;
