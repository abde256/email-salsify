require('dotenv').config();

const express    = require('express');
const nodemailer = require('nodemailer');
const session    = require('express-session');
const path       = require('path');
const https      = require('https');

const app = express();

// ─── Variables d'environnement ────────────────────────────────────────────────
const APP_USERNAME    = process.env.APP_USERNAME    || 'admin';
const APP_PASSWORD    = process.env.APP_PASSWORD    || 'salsify2024';
const SENDER_EMAIL    = process.env.SENDER_EMAIL    || process.env.GMAIL_USER    || '';
const SENDER_PASSWORD = process.env.SENDER_PASSWORD || process.env.GMAIL_PASSWORD || '';
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

// ─── Détection SMTP automatique ───────────────────────────────────────────────
function getSmtpConfig(email, password, custom = {}) {
  const timeouts = {
    connectionTimeout: 30_000,
    greetingTimeout:   15_000,
    socketTimeout:     45_000,
  };

  // 1) Brevo SMTP relay (recommandé — bypass toutes restrictions corporate)
  if (custom.provider === 'brevo') {
    return {
      ...timeouts,
      host: 'smtp-relay.brevo.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: email, pass: password },
      tls: { rejectUnauthorized: false },
    };
  }

  // 2) Config hôte explicite (UI personnalisée ou variables d'env)
  const envHost = process.env.SMTP_HOST;
  const host    = custom.host || envHost;
  if (host) {
    const port   = parseInt(custom.port   || process.env.SMTP_PORT   || '587');
    const secure = (custom.secure === true || custom.secure === 'true' ||
                    process.env.SMTP_SECURE === 'true');
    return {
      ...timeouts,
      host, port, secure,
      requireTLS: !secure,
      auth: { user: email, pass: password },
      tls: { rejectUnauthorized: false },
    };
  }

  const domain = (email.split('@')[1] || '').toLowerCase();

  // 3) Gmail / Google Workspace (gmail.com ET domaines perso hébergés sur Google)
  if (custom.provider === 'gmail' || ['gmail.com', 'googlemail.com'].includes(domain)) {
    return {
      ...timeouts,
      service: 'gmail',
      auth: { user: email, pass: password },
    };
  }

  // 4) Microsoft personnel
  if (['outlook.com', 'hotmail.com', 'live.com', 'live.fr',
       'outlook.fr', 'hotmail.fr', 'msn.com'].includes(domain)) {
    return {
      ...timeouts,
      host: 'smtp-mail.outlook.com', port: 587, secure: false,
      requireTLS: true,
      auth: { user: email, pass: password },
      tls: { rejectUnauthorized: false },
    };
  }

  // 5) Défaut : Office 365 (utilisé par la majorité des entreprises — dont Carrefour)
  return {
    ...timeouts,
    host: 'smtp.office365.com', port: 587, secure: false,
    requireTLS: true,
    auth: { user: email, pass: password },
    tls: { rejectUnauthorized: false },
  };
}

// ─── Brevo HTTP API (contourne tout blocage SMTP — utilise HTTPS port 443) ───
function brevoRequest(method, path, apiKey, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.brevo.com',
      port: 443,
      path,
      method,
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, status: res.statusCode, body: data });
        } else {
          reject(new Error(`Brevo API ${res.statusCode}: ${data}`));
        }
      });
    });
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error('Brevo API timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function sendViaBrevoAPI(apiKey, fromEmail, toEmails, ccEmails, subject, textContent) {
  await brevoRequest('POST', '/v3/smtp/email', apiKey, {
    sender:      { email: fromEmail },
    to:          toEmails.map(e => ({ email: e })),
    cc:          ccEmails?.length ? ccEmails.map(e => ({ email: e })) : undefined,
    subject,
    textContent,
  });
}

// ─── Envoi avec 3 tentatives (backoff exponentiel) ────────────────────────────
async function sendMailWithRetry(transporter, mailOptions, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await transporter.sendMail(mailOptions);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 2000 * attempt)); // 2s, 4s
      }
    }
  }
  throw lastError;
}

// ─── Message d'erreur convivial ────────────────────────────────────────────────
function friendlyError(msg) {
  const m = msg || '';
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|timeout/i.test(m))
    return 'Délai de connexion dépassé — vérifiez le serveur SMTP, le port, ou utilisez un mot de passe d\'application.';
  if (/authentication|credentials|invalid.*login|535|534|Username and Password not accepted/i.test(m))
    return 'Authentification échouée — utilisez un mot de passe d\'application (pas votre mot de passe habituel).';
  if (/certificate|TLS|SSL/i.test(m))
    return 'Erreur TLS/SSL — essayez de changer le port ou le type de chiffrement.';
  if (/ENOTFOUND|getaddrinfo/i.test(m))
    return 'Serveur SMTP introuvable — vérifiez le nom d\'hôte SMTP.';
  if (/421|450|452/i.test(m))
    return 'Serveur SMTP temporairement indisponible — réessayez dans quelques minutes.';
  return m;
}

// ─── Config serveur ────────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => {
  const domain = (SENDER_EMAIL.split('@')[1] || '').toLowerCase();
  let detectedProvider = 'office365';
  if (['gmail.com', 'googlemail.com'].includes(domain)) detectedProvider = 'gmail';
  else if (['outlook.com', 'hotmail.com', 'live.com', 'live.fr', 'outlook.fr', 'hotmail.fr'].includes(domain)) detectedProvider = 'outlook';
  else if (process.env.SMTP_HOST) detectedProvider = 'custom';

  res.json({
    senderConfigured: !!(SENDER_EMAIL && SENDER_PASSWORD),
    senderEmail:      SENDER_EMAIL || '',
    detectedProvider,
    smtpHost: process.env.SMTP_HOST || '',
    smtpPort: process.env.SMTP_PORT || '587',
  });
});

// ─── Test connexion ────────────────────────────────────────────────────────────
app.post('/api/test-connection', async (req, res) => {
  const email    = req.body.email    || SENDER_EMAIL;
  const password = req.body.password || SENDER_PASSWORD;
  const custom   = req.body.smtpConfig || {};

  if (!email || !password)
    return res.status(400).json({ success: false, message: 'Email et mot de passe requis.' });

  // Brevo : tester la clé API via GET /v3/account (HTTPS, jamais bloqué)
  if (custom.provider === 'brevo') {
    try {
      await brevoRequest('GET', '/v3/account', password, null);
      res.json({ success: true, message: 'Connexion Brevo réussie via API ✅' });
    } catch (err) {
      const msg = err.message.includes('401') || err.message.includes('403')
        ? 'Clé API Brevo invalide — vérifiez la clé v3 dans Brevo → Paramètres → Clés API.'
        : friendlyError(err.message);
      res.status(400).json({ success: false, message: msg, raw: err.message });
    }
    return;
  }

  // SMTP standard
  try {
    const config      = getSmtpConfig(email, password, custom);
    const transporter = nodemailer.createTransport(config);
    await transporter.verify();
    const provider = config.service || config.host;
    res.json({ success: true, message: `Connexion réussie via ${provider} ✅` });
  } catch (err) {
    res.status(400).json({ success: false, message: friendlyError(err.message), raw: err.message });
  }
});

// ─── Envoi des emails ─────────────────────────────────────────────────────────
app.post('/api/send-emails', async (req, res) => {
  const senderEmail    = req.body.senderEmail    || SENDER_EMAIL;
  const senderPassword = req.body.senderPassword || SENDER_PASSWORD;
  const custom         = req.body.smtpConfig     || {};
  // Pour Brevo : fromEmail est l'adresse qui apparaît chez le destinataire
  // senderEmail est le login Brevo (compte API), différent du from
  const fromAddress    = req.body.fromEmail || senderEmail;
  const { suppliers }  = req.body;

  if (!senderEmail || !senderPassword || !suppliers?.length)
    return res.status(400).json({ success: false, message: 'Données manquantes.' });

  const isBrevo     = custom.provider === 'brevo';
  const config      = isBrevo ? null : getSmtpConfig(senderEmail, senderPassword, custom);
  const transporter = isBrevo ? null : nodemailer.createTransport(config);
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
      if (isBrevo) {
        // API HTTP Brevo — port 443, jamais bloqué par les hébergeurs cloud
        await sendViaBrevoAPI(senderPassword, fromAddress, emails, ccs || [], subject, body);
      } else {
        await sendMailWithRetry(transporter, {
          from:  fromAddress,
          to:    emails.join(', '),
          cc:    (ccs || []).length ? ccs.join(', ') : undefined,
          subject,
          text:  body,
        });
      }
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
  if (process.env.SMTP_HOST) console.log(`   SMTP  : ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587}`);
  console.log(`   Login : ${APP_USERNAME} / (mot de passe défini)\n`);
});
