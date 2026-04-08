require('dotenv').config();

const express    = require('express');
const nodemailer = require('nodemailer');
const session    = require('express-session');
const path       = require('path');

const app = express();

// ─── Variables d'environnement ────────────────────────────────────────────────
const APP_USERNAME     = process.env.APP_USERNAME     || 'admin';
const APP_PASSWORD     = process.env.APP_PASSWORD     || 'salsify2024';
const SENDER_EMAIL     = process.env.GMAIL_USER       || 'abderrahman_boubrahim@ext.carrefour.com';
const SENDER_PASSWORD  = process.env.GMAIL_PASSWORD   || '';
const SESSION_SECRET   = process.env.SESSION_SECRET   || 'salsify-secret-change-me';

// ─── Middlewares ──────────────────────────────────────────────────────────────
app.set('trust proxy', 1); // nécessaire derrière le proxy Render
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000, // session 8h
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

// ─── Protection de toutes les routes suivantes ────────────────────────────────
app.use(requireAuth);
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Config serveur (email pré-configuré ?) ──────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    gmailConfigured: !!(SENDER_EMAIL && SENDER_PASSWORD),
    gmailUser: SENDER_EMAIL || ''
  });
});

// ─── Test connexion email ─────────────────────────────────────────────────────
app.post('/api/test-connection', async (req, res) => {
  const email    = req.body.email    || SENDER_EMAIL;
  const password = req.body.password || SENDER_PASSWORD;
  if (!email || !password) return res.status(400).json({ success: false, message: 'Identifiants manquants.' });
  try {
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: email, pass: password } });
    await transporter.verify();
    res.json({ success: true, message: 'Connexion Gmail réussie ✅' });
  } catch (err) {
    res.status(400).json({ success: false, message: 'Erreur de connexion : ' + err.message });
  }
});

// ─── Envoi des emails ─────────────────────────────────────────────────────────
app.post('/api/send-emails', async (req, res) => {
  const senderEmail    = req.body.senderEmail    || SENDER_EMAIL;
  const senderPassword = req.body.senderPassword || SENDER_PASSWORD;
  const { suppliers }  = req.body;

  if (!senderEmail || !senderPassword || !suppliers?.length) {
    return res.status(400).json({ success: false, message: 'Données manquantes.' });
  }

  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: senderEmail, pass: senderPassword } });
  const results = [];

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
      await transporter.sendMail({
        from: senderEmail,
        to: emails.join(', '),
        cc: (ccs || []).length ? ccs.join(', ') : undefined,
        subject,
        text: body
      });
      results.push({ nom_fournisseur, emails, status: 'success' });
    } catch (err) {
      results.push({ nom_fournisseur, emails, status: 'error', error: err.message });
    }
  }

  res.json({ success: true, results });
});

// ─── Démarrage ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n✅ Serveur démarré sur http://localhost:${PORT}`);
  if (SENDER_EMAIL)  console.log(`   Email pré-configuré : ${SENDER_EMAIL}`);
  if (!SENDER_EMAIL) console.log(`   Email : à configurer dans l'interface`);
  console.log(`   Login : ${APP_USERNAME} / (mot de passe défini)\n`);
});
