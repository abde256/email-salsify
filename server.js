'use strict';
require('dotenv').config();

const express    = require('express');
const nodemailer = require('nodemailer');
const session    = require('express-session');
const path       = require('path');

const app = express();

// ─── Variables d'environnement ────────────────────────────────────────────────
const APP_USERNAME    = process.env.APP_USERNAME    || 'admin';
const APP_PASSWORD    = process.env.APP_PASSWORD    || 'salsify2024';
const SENDER_EMAIL    = process.env.SENDER_EMAIL    || process.env.GMAIL_USER     || '';
const SENDER_PASSWORD = process.env.SENDER_PASSWORD || process.env.GMAIL_PASSWORD  || '';
const SESSION_SECRET  = process.env.SESSION_SECRET  || 'salsify-secret-change-me';

// ─── Middlewares ──────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  if (req.path === '/login' || req.path === '/api/login') return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Non authentifié' });
  res.redirect('/login');
}

// ─── Routes publiques ─────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === APP_USERNAME && password === APP_PASSWORD) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'Identifiants incorrects.' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ─── Protection ───────────────────────────────────────────────────────────────
app.use(requireAuth);
app.use(express.static(path.join(__dirname)));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ─── Gmail / Google Workspace — port 465 SSL (plus fiable que 587 STARTTLS) ──
// Compatible avec tout domaine hébergé sur Google Workspace (ext.carrefour.com…)
// Nécessite un mot de passe d'application Google (pas le mot de passe habituel).
function createTransport(email, appPassword) {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,                    // SSL direct — évite les blocages STARTTLS
    auth: { user: email, pass: appPassword },
    connectionTimeout: 30_000,
    greetingTimeout:   20_000,
    socketTimeout:     60_000,
  });
}

// ─── Envoi avec 3 tentatives (backoff exponentiel) ────────────────────────────
async function sendWithRetry(transporter, mailOptions, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await transporter.sendMail(mailOptions);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastError;
}

// ─── Message d'erreur convivial ────────────────────────────────────────────────
function friendlyError(msg) {
  const m = msg || '';
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|timeout/i.test(m))
    return 'Délai de connexion dépassé — vérifiez votre mot de passe d\'application Google.';
  if (/authentication|credentials|invalid.*login|535|534|Username and Password not accepted/i.test(m))
    return 'Authentification échouée — utilisez un mot de passe d\'application Google (16 caractères).';
  if (/certificate|TLS|SSL/i.test(m))
    return 'Erreur SSL — vérifiez que votre compte Google autorise l\'accès SMTP.';
  if (/ENOTFOUND|getaddrinfo/i.test(m))
    return 'Impossible de joindre smtp.gmail.com — vérifiez la connexion réseau du serveur.';
  if (/421|450|452/i.test(m))
    return 'Gmail temporairement indisponible — réessayez dans quelques minutes.';
  return m;
}

// ─── Config serveur ────────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => {
  res.json({
    senderConfigured: !!(SENDER_EMAIL && SENDER_PASSWORD),
    senderEmail:      SENDER_EMAIL || '',
  });
});

// ─── Test connexion ────────────────────────────────────────────────────────────
app.post('/api/test-connection', async (req, res) => {
  const email    = req.body.email    || SENDER_EMAIL;
  const password = req.body.password || SENDER_PASSWORD;

  if (!email || !password)
    return res.status(400).json({ success: false, message: 'Email et mot de passe requis.' });

  try {
    const transporter = createTransport(email, password);
    await transporter.verify();
    res.json({ success: true, message: 'Connexion Gmail réussie ✅' });
  } catch (err) {
    res.status(400).json({ success: false, message: friendlyError(err.message), raw: err.message });
  }
});

// ─── Envoi des emails ─────────────────────────────────────────────────────────
app.post('/api/send-emails', async (req, res) => {
  const email    = req.body.senderEmail    || SENDER_EMAIL;
  const password = req.body.senderPassword || SENDER_PASSWORD;
  const { suppliers } = req.body;

  if (!email || !password || !suppliers?.length)
    return res.status(400).json({ success: false, message: 'Données manquantes.' });

  const transporter = createTransport(email, password);
  const results     = [];

  for (const supplier of suppliers) {
    const { nom_fournisseur, emails, ccs, eans } = supplier;
    const eanList = eans.map(e => `• ${e}`).join('\n');

    const subject = `${nom_fournisseur} Mise en ligne bloquée : fiches produits en attente de partage à finaliser pour Carrefour.fr dans Salsify`;

    const body = `Bonjour,

Nous sommes actuellement dans l'attente de la complétion et de l'enrichissement des fiches produits pour les EAN mentionnés ci-dessous sur la plateforme Salsify.

Ces références, à fort enjeu et à caractère innovant, nécessitent une mise à jour rapide. À défaut d'action de votre part, leur mise en ligne sur Carrefour.fr ne pourra être envisagée, ce qui limiterait leur visibilité et leur potentiel de performance.

Pour rappel, les visuels attendus dans Salsify doivent impérativement respecter les critères suivants :

• Photos du produit emballé : vue de face (parallèle) et vue de dos (avec liste d'ingrédients lisible)
• Visuel détouré sur fond blanc ou transparent
• Format « produit emballé »
• Résolution minimale de 1500 pixels sur l'un des côtés (format JPEG)
• Poids maximal : 2 Mo

EAN en attente de traitement :

${eanList}

Nous vous remercions de bien vouloir partager et finaliser l'ensemble de ces fiches produits dans les meilleurs délais sur Salsify, en vue de leur intégration sur Carrefour.fr.

Pour toute question technique relative à la plateforme Salsify, vous pouvez contacter leur support à l'adresse suivante :
📧 help.sxm@salsify.com

Je reste également à votre disposition au 01.64.50.87.43.

Merci par avance pour votre réactivité et votre collaboration.

Excellente journée à vous.`;

    try {
      await sendWithRetry(transporter, {
        from:    email,
        to:      emails.join(', '),
        cc:      (ccs || []).length ? ccs.join(', ') : undefined,
        subject,
        text:    body,
      });
      results.push({ nom_fournisseur, emails, status: 'success' });
    } catch (err) {
      results.push({ nom_fournisseur, emails, status: 'error', error: friendlyError(err.message) });
    }
  }

  res.json({ success: true, results });
});

// ─── Démarrage ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n✅ Serveur démarré sur http://localhost:${PORT}`);
  if (SENDER_EMAIL)  console.log(`   Email : ${SENDER_EMAIL}`);
  if (!SENDER_EMAIL) console.log(`   Email : à configurer dans l'interface`);
  console.log(`   Login : ${APP_USERNAME}\n`);
});
