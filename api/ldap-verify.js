import ldap from 'ldapjs';

export default async function handler(req, res) {
  // CORS headers for v0.app
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  const { email, name } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Missing email in request body' });

  console.log('=== LDAP DEBUG START ===');
  console.log('Searching for email:', email);
  console.log('Environment variables check:');
  console.log('LDAP_SERVER:', process.env.LDAP_SERVER ? 'SET' : 'MISSING');
  console.log('LDAP_BIND_DN:', process.env.LDAP_BIND_DN ? 'SET' : 'MISSING');
  console.log('LDAP_PASSWORD:', process.env.LDAP_PASSWORD ? 'SET' : 'MISSING');
  console.log('LDAP_BASE_DN:', process.env.LDAP_BASE_DN ? 'SET' : 'MISSING');

  const client = ldap.createClient({
    url: process.env.LDAP_SERVER || 'ldaps://ldap.jumpcloud.com:636',
    timeout: 10000,
    connectTimeout: 10000
  });

  try {
    // Bind with service account
    console.log('Attempting LDAP bind...');
    await new Promise((resolve, reject) => {
      client.bind(process.env.LDAP_BIND_DN, process.env.LDAP_PASSWORD, (err) => {
        if (err) {
          console.error('LDAP bind failed:', err.message);
          reject(err);
        } else {
          console.log('LDAP bind successful');
          resolve();
        }
      });
    });

    // JumpCloud-specific search - request ALL common attributes
    const searchOptions = {
      filter: `(&(mail=${email})(objectClass=inetOrgPerson))`,
      scope: 'sub',
      // Request ALL possible JumpCloud attributes
      attributes: [
        'cn', 'displayName', 'name',           // Name attributes
        'givenName', 'sn', 'firstName', 'lastName',  // Name components  
        'mail', 'email',                       // Email attributes
        'employeeNumber', 'employeeId',        // Employee ID attributes
        'ou', 'department', 'departmentNumber', // Department attributes
        'title', 'jobTitle',                   // Job title attributes
        'manager', 'managedBy',                // Manager attributes
        'uid', 'username',                     // Username attributes
        'telephoneNumber', 'mobile',           // Phone attributes
        'description', 'notes'                 // Additional info
      ]
    };

    console.log('LDAP search filter:', searchOptions.filter);
    console.log('LDAP search base:', process.env.LDAP_BASE_DN);

    const results = await new Promise((resolve, reject) => {
      const entries = [];
      client.search(process.env.LDAP_BASE_DN, searchOptions, (err, search) => {
        if (err) {
          console.error('LDAP search failed:', err.message);
          return reject(err);
        }
        
        search.on('searchEntry', entry => {
          console.log('=== RAW LDAP ENTRY ===');
          console.log('Full object keys:', Object.keys(entry.object));
          console.log('Full object:', JSON.stringify(entry.object, null, 2));
          entries.push(entry.object);
        });
        
        search.on('error', error => {
          console.error('LDAP search error:', error);
          reject(error);
        });
        
        search.on('end', result => {
          console.log('LDAP search completed. Found entries:', entries.length);
          resolve(entries);
        });
      });
    });

    // Clean up connection
    try { client.unbind(); } catch (e) { console.log('Unbind error (ignored):', e.message); }

    if (!results || results.length === 0) {
      console.log('No LDAP entries found');
      return res.json({
        verified: false,
        error: 'Employee not found in company directory',
        searchDetails: {
          filter: searchOptions.filter,
          server: process.env.LDAP_SERVER,
          baseDN: process.env.LDAP_BASE_DN
        }
      });
    }

    const employee = results[0];
    console.log('Processing employee data...');

    // Flexible attribute mapping for JumpCloud
    const getName = () => {
      return employee.cn || 
             employee.displayName || 
             employee.name || 
             `${employee.givenName || employee.firstName || ''} ${employee.sn || employee.lastName || ''}`.trim() ||
             name || // fallback to request parameter
             'Name not available';
    };

    const getEmail = () => {
      return employee.mail || employee.email || email;
    };

    const getEmployeeId = () => {
      return employee.employeeNumber || 
             employee.employeeId || 
             employee.uid || 
             'Not provided';
    };

    const getDepartment = () => {
      return employee.ou || 
             employee.department || 
             employee.departmentNumber || 
             'Not specified';
    };

    const getTitle = () => {
      return employee.title || 
             employee.jobTitle || 
             'Not specified';
    };

    const getManager = () => {
      return employee.manager || 
             employee.managedBy || 
             'Not specified';
    };

    const employeeData = {
      name: getName(),
      email: getEmail(),
      employeeId: getEmployeeId(),
      department: getDepartment(),
      title: getTitle(),
      manager: getManager()
    };

    console.log('Final employee data:', employeeData);

    return res.json({
      verified: true,
      employee: employeeData,
      ldapQuery: {
        server: process.env.LDAP_SERVER,
        baseDN: process.env.LDAP_BASE_DN,
        filter: searchOptions.filter,
        timestamp: new Date().toISOString(),
        rawAttributes: Object.keys(employee), // For debugging
        totalResults: results.length
      },
      debug: {
        availableAttributes: Object.keys(employee),
        rawEntry: employee // Include raw data for debugging
      }
    });

  } catch (error) {
    console.error('=== LDAP ERROR ===');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    
    try { client.unbind(); } catch (e) { /* ignore */ }
    
    return res.status(500).json({
      verified: false,
      error: 'LDAP server connection failed',
      details: error.message,
      troubleshooting: {
        step1: 'Check Vercel function logs for detailed error messages',
        step2: 'Verify all environment variables are set correctly',
        step3: 'Confirm JumpCloud user has "Enable as LDAP Bind DN" checked',
        step4: 'Ensure test employee exists with the searched email address'
      }
    });
  }
}
