var express = require('express');
var secrets = require('./lib/secrets');
var configuration = require('./lib/configuration');
var logger = require('./lib/logger');
var util = require('util');
var crypto = require('crypto');
var User = require('./models/user');
var path = require('path');
var lessMiddleware = require('less-middleware');
var _ = require('underscore');
var statsd = require('./lib/statsd');
var cookieSession = require('cookie-session');

// `COOKIE_SECRET` is randomly generated on the first run of the server,
// then stored to a file and looked up on restart to maintain state.
// See the `secrets.js` for more information.
var COOKIE_SECRET = secrets.hydrateSecret('openbadges_cookie', configuration.get('var_path'));
var COOKIE_KEY = 'openbadges_state';

// Store sessions in cookies. The session structure is base64 encoded, a
// salty hash is created with `COOKIE_SECRET` to prevent clientside tampering.
exports.cookieSessions = function cookieSessions() {
  return cookieSession({
    secret: COOKIE_SECRET,
    key: COOKIE_KEY,
    cookie: {
      httpOnly: true,
      maxAge: (7 * 24 * 60 * 60 * 1000), //one week
      secure: false
    }
  });
};

const requestLogger = logger.middleware();
const imgPrefix = '/images/badge/';
exports.logRequests = function logRequests() {
  return function (req, res, next) {
    var ua = req.headers['user-agent'] || '';
    var heartbeat = (ua.indexOf('HTTP-Monitor') === 0);
    if (heartbeat || req.url.indexOf(imgPrefix) === 0)
      return next();
    requestLogger(req, res, next);
  };
};

exports.statsdRequests = function statsdRequests () {
  return function (req, res, next) {
    var bucket = util.format('paths%s.%s', req.path.replace(/\//g, '.'), req.method.toLowerCase());
    statsd.increment(bucket);
    return next();
  };
};


exports.findPassportUser = function() {
  return function (req, res, next) {
    if (!req.session) {
      logger.debug('could not find session');
      return next();
    }

    if (!req.session.passport) {
      return next();
    }

    User.findById(req.session.passport.user, function(err, user) {
      if (err) {
        logger.error(err, "Problem finding/creating user");
        return next(err);
      }
      req.user = res.locals.user = user;
      return next();
    });
  };
}

// exports.userFromSession = function userFromSession() {
//   return function (req, res, next) {
//     var email = '';
//     var emailRe = /^.+?\@.+?\.*$/;

//     if (!req.session) {
//       logger.debug('could not find session');
//       return next();
//     }

//     if (!req.session.emails) {
//       return next();
//     }

//     console.log("session", req.session)
//     email = req.session.emails[0];

//     if (!emailRe.test(email)) {
//       logger.warn('req.session.emails does not contain valid user: ' + email);
//       req.session = {};
//       return req.next();
//     }

//     User.findOrCreate(email, function (err, user) {
//       if (err) {
//         logger.error(err, "Problem finding/creating user");
//         return next(err);
//       }
//       req.user = res.locals.user = user;
//       return next();
//     });
//   };
// };

function whitelisted(list, input) {
  var pattern;
  for (var i = list.length; i--;) {
    pattern = list[i];
    if (RegExp('^' + list[i] + '$').test(input)) return true;
  }
  return false;
}

exports.noFrame = function noFrame(opts) {
  var list = opts.whitelist;
  return function (req, res, next) {
    if (!whitelisted(list, req.url)) res.setHeader('x-frame-options', 'DENY');
    return next();
  };
};

exports.cors = function cors(options) {
  options = options || {};
  var list = options.whitelist || [];
  if (typeof list === 'string') list = [list];
  return function (req, res, next) {
    if (!whitelisted(list, req.url)) return next();
    res.header("Access-Control-Allow-Origin", "*");
    return next();
  };
};

// #FIXME: This was pulled from connect/lib/middleware/csrf.js
//         The current version of the csrf middleware checks the token on
//         HEAD requests and it shouldn't. Until issue #409 is resolved,
//         we'll have to use this version.
// exports.csrf = function (options) {
//   options = options || {};
//   var value = options.value || defaultValue;
//   var list = options.whitelist;
//   return function (req, res, next) {

//     var token = req.session._csrf || (req.session._csrf = utils.uid(24));
//     if ('GET' == req.method || 'HEAD' == req.method || whitelisted(list, req.url)) return next();
//     var val = value(req);
//     if (val != token) {
//       logger.debug("CSRF token failure");
//       return utils.forbidden(res);
//     }
//     next();
//   };
// };

exports.notFound = function notFound() {
  return function (req, res, next) {
    res.statusCode = 404;

    if (req.accepts('html')) {
      res.render('errors/404.html', {url: req.url});
    } else if (req.accepts('json')) {
      res.send({error: 'Not found'});
    } else {
      res.type('txt').send('Not found');
    }
  }
};

exports.less = function less() {
  var src = path.join(__dirname, 'static/less');
  var config = {
    render: {
      compress: "auto",
      paths: [path.join(__dirname, "static/vendor/bootstrap/less")],
    },
    dest: path.join(__dirname, "static"),
    debug: true,
    force: true,
    preprocess: {
      path: function(pathname, req) {
        return pathname.replace(path.sep + 'css' + path.sep, path.sep);
      }
    }
  };

  return lessMiddleware(src, config);
};

exports.staticTemplateViews = function staticTemplateViews(env, viewPrefix) {
  viewPrefix = viewPrefix || '';

  function hasView(env, view) {
    try { 
      env.getTemplate(view);
      return true;
    }
    catch (e) {
      if (e.message && e.message.match(/template not found/)) 
        return false;
      throw e;
    }
  }

  return function (req, res, next) {
    var match;
    if(match = /^\/([a-zA-Z0-9\/]+\.html)$/.exec(req.path)) {
      var view = viewPrefix + match[1];
      if (hasView(env, view)) {
        return res.render(view, function(err, html) {
          if (err) return next(err);
          else return res.send(html);
        });
      }
    }
    next();
  };
};

var utils = exports.utils = {};
var pseudoRandomBytes = function(num) {
  var a = [];
  for (var i = 0; i < num; i++)
    a.push(getRandomInt(0, 255));
  return new Buffer(a);
};

utils.forbidden = function (res) {
  var body = 'Forbidden';
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Length', body.length);
  res.statusCode = 403;
  res.end(body);
};

// utils.createSecureToken = function(numBaseBytes) {
//   var randomBytes;

//   try {
//     randomBytes = crypto.randomBytes(numBaseBytes);
//   } catch (e) {
//     logger.warn('crypto.randomBytes() failed with ' + e);
//     logger.warn('falling back to pseudo-random bytes.');
//     randomBytes = pseudoRandomBytes(numBaseBytes);
//   }
//   return randomBytes.toString('base64') + '_' + Date.now().toString(32);
// };

utils.uid = function (len) {
  var buf = [];
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var charlen = chars.length;
  for (var i = 0; i < len; ++i) {
    buf.push(chars[getRandomInt(0, charlen - 1)]);
  }
  return buf.join('');
};

function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Default value function, checking the `req.body`
 * and `req.query` for the CSRF token.
 *
 * @param {IncomingMessage} req
 * @return {String}
 * @api private
 */
function defaultValue(req) {
  return (req.body && req.body._csrf)
    || (req.query && req.query._csrf)
    || (req.headers['x-csrf-token']);
}
