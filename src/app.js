'use strict';
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const config = require('./config');
const { get } = require('./db');
const { loadUser } = require('./lib/auth');
const { PUBLIC_DIR } = require('./lib/uploads');
const COUNTRIES = require('./data/countries.json');
const mw = require('./middleware');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.root, 'views'));
  if (config.isProd) app.set('view cache', true);

  app.use(compression());
  app.use(mw.securityHeaders());

  /* ---------- Static files ---------- */
  const countriesJs = `window.MTS_COUNTRIES=${JSON.stringify(COUNTRIES)};`;
  app.get('/static/js/countries.js', (req, res) => {
    res.type('application/javascript').set('Cache-Control', 'public, max-age=86400').send(countriesJs);
  });
  app.use('/static', express.static(path.join(config.root, 'public'), { maxAge: config.isProd ? '7d' : 0 }));
  app.use('/assets', express.static(path.join(config.root, 'assets'), { maxAge: config.isProd ? '7d' : 0 }));
  app.use('/uploads', express.static(PUBLIC_DIR, { maxAge: '30d', dotfiles: 'deny', fallthrough: true }));
  app.get('/index.html', (req, res) => res.redirect(301, '/'));
  app.get('/favicon.ico', (req, res) => res.redirect(301, '/static/img/favicon.png'));
  // Uptime/health check; also tells whether data survives redeploys (Railway volume attached).
  app.get('/healthz', (req, res) => {
    get('SELECT 1');
    // mail: which transport sends verification codes ("off" until the keys are set); never any secret.
    res.set('Cache-Control', 'no-store').json({ ok: true, storage: config.ephemeralStorage ? 'ephemeral' : 'persistent', version: config.commit || 'dev', mail: require('./lib/mail').transportName() });
  });
  app.get('/robots.txt', (req, res) => res.type('text').send('User-agent: *\nDisallow: /account\nDisallow: /seller\nDisallow: /api\nDisallow: /files\n'));

  /* ---------- Request pipeline ---------- */
  app.use(cookieParser());
  app.use(express.urlencoded({ extended: true, limit: '1mb', parameterLimit: 2000 }));
  app.use(express.json({ limit: '1mb' }));
  // Express 5 leaves req.body undefined when no parser ran (multer fills it on upload routes).
  app.use((req, res, next) => {
    if (req.body === undefined) req.body = {};
    next();
  });
  app.use(mw.originCheck);
  app.use(loadUser);
  app.use(mw.flash);
  app.use(mw.locals);
  app.use(mw.requireEmailVerification);
  app.use(mw.requireProfileCompletion);

  /* ---------- Routes ---------- */
  app.use(require('./routes/home'));
  app.use(require('./routes/auth'));
  app.use(require('./routes/services'));
  app.use('/store', require('./routes/store'));
  app.use('/account', require('./routes/account'));
  app.use('/provider', require('./routes/provider'));
  app.use('/seller', require('./routes/seller'));
  app.use('/seller', require('./routes/admin'));
  app.use('/api', require('./routes/api'));
  app.use('/files', require('./routes/files'));

  app.use(mw.notFound);
  app.use(mw.errorHandler);
  return app;
}

module.exports = { createApp };
