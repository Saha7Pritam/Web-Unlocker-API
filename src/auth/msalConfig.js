const msal = require('@azure/msal-node');

const msalConfig = {
  auth: {
    clientId     : process.env.MICROSOFT_CLIENT_ID,
    authority    : `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}`,
    clientSecret : process.env.MICROSOFT_CLIENT_SECRET,
  },
};

// Confidential client — secret stays on server, never exposed to browser
const msalClient = new msal.ConfidentialClientApplication(msalConfig);

module.exports = { msalClient };