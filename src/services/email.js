const twilio = require("twilio");
const { env } = require("../config/env");

function getTwilioClient() {
  if (!env.twilioAccountSid || !env.twilioAuthToken || !env.twilioVerifySid) {
    return null;
  }

  return twilio(env.twilioAccountSid, env.twilioAuthToken);
}

async function sendPasswordResetEmail({ toEmail }) {
  const client = getTwilioClient();

  if (!client) {
    throw new Error("Twilio Verify environment variables are missing");
  }

  await client.verify.v2
    .services(env.twilioVerifySid)
    .verifications.create({ to: toEmail, channel: "email" });
}

async function verifyPasswordResetEmailCode({ toEmail, code }) {
  const client = getTwilioClient();

  if (!client) {
    throw new Error("Twilio Verify environment variables are missing");
  }

  const check = await client.verify.v2
    .services(env.twilioVerifySid)
    .verificationChecks.create({ to: toEmail, code });

  return check.status === "approved";
}

module.exports = { sendPasswordResetEmail, verifyPasswordResetEmailCode };
