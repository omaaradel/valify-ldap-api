import ldap from 'ldapjs';

export default async function handler(req, res) {
  // simple CORS for v0.app or testing, tighten origin in production
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Missing email in request body' });

  const client = ldap.createClient({
    url: process.env.LDAP_SERVER || 'ldaps://ldap.jumpcloud.com:636'
  });

  try {
    // bind with service account
    await new Promise((resolve, reject) => {
      client.bind(process.env.LDAP_BIND_DN, process.env.LDAP_PASSWORD, (err) => err ? reject(err) : resolve());
    });

    const searchOptions = {
      filter: `(&(mail=${email})(objectClass=inetOrgPerson))`,
      scope: 'sub',
      attributes: ['cn', 'mail', 'employeeNumber', 'ou', 'title', 'manager']
    };

    const results = await new Promise((resolve, reject) => {
      const entries = [];
      client.search(process.env.LDAP_BASE_DN, searchOptions, (err, search) => {
        if (err) return reject(err);
        search.on('searchEntry', entry => entries.push(entry.object));
        search.on('error', reject);
        search.on('end', () => resolve(entries));
      });
    });

    // best effort unbind
    try { client.unbind(); } catch (e) { /* ignore */ }

    if (!results || results.length === 0) {
      return res.json({
        verified: false,
        error: 'Employee not found in company directory',
        ldapQuery: { filter: searchOptions.filter, server: process.env.LDAP_SERVER || 'ldap.jumpcloud.com' }
      });
    }

    const employee = results[0];
    return res.json({
      verified: true,
      employee: {
        name: employee.cn,
        email: employee.mail,
        employeeId: employee.employeeNumber || 'N/A',
        department: employee.ou || 'Not specified',
        title: employee.title || 'Not specified',
        manager: employee.manager || 'Not specified'
      },
      ldapQuery: {
        server: process.env.LDAP_SERVER || 'ldap.jumpcloud.com',
        filter: searchOptions.filter,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    try { client.unbind(); } catch (e) { /* ignore */ }
    console.error('LDAP Error:', error);
    return res.status(500).json({
      verified: false,
      error: 'LDAP server connection failed',
      details: error.message
    });
  }
}
