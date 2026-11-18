'use strict';
const nodemailer = require('nodemailer');

/**
 * Sender e-post via SMTP dersom SMTP_HOST er satt. Hvis ikke brukes en
 * "simulert" transport som ikke sender noe, men lar appen logge utsendelsen
 * (nyttig ved testing og før SMTP er konfigurert).
 */
function createMailer(env = process.env) {
  const configured = !!env.SMTP_HOST;
  const transport = configured
    ? nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT || 587),
        secure: String(env.SMTP_SECURE || '').toLowerCase() === 'true',
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      })
    : nodemailer.createTransport({ jsonTransport: true });

  const from = env.MAIL_FROM || env.SMTP_USER || 'styret@skytterlag.invalid';

  return {
    configured,
    from,
    async send({ to, cc, subject, text, attachments, replyTo, fromName }) {
      const info = await transport.sendMail({
        from: fromName ? { name: fromName, address: from } : from,
        to, cc, subject, text, attachments, replyTo,
      });
      return { status: configured ? 'sendt' : 'simulert', info };
    },
  };
}

module.exports = { createMailer };
