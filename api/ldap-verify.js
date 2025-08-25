import ldap from 'ldapjs';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, name } = req.body || {};

  if (!email) {
    return res.status(400).json({ error: 'Missing email in request body' });
  }

  console.log('=== LDAP SEARCH DEBUG ===');
  console.log('Searching for email:', email);
  console.log('Environment check:');
  console.log('LDAP_SERVER:', process.env.LDAP_SERVER ? 'SET' : 'MISSING');
  console.log('LDAP_BIND_DN:', process.env.LDAP_BIND_DN ? 'SET' : 'MISSING');
  console.log('LDAP_PASSWORD:', process.env.LDAP_PASSWORD ? 'SET' : 'MISSING');
  console.log('LDAP_BASE_DN:', process.env.LDAP_BASE_DN ? 'SET' : 'MISSING');

  const client = ldap.createClient({
    url: process.env.LDAP_SERVER || 'ldaps://ldap.jumpcloud.com:636',
    timeout: 15000,
    connectTimeout: 15000,
  });

  try {
    // Step 1: Bind with service account
    console.log('Step 1: Attempting LDAP bind...');
    await new Promise((resolve, reject) => {
      client.bind(process.env.LDAP_BIND_DN, process.env.LDAP_PASSWORD, (err) => {
        if (err) {
          console.error('LDAP bind failed:', err.message);
          reject(new Error(`LDAP bind failed: ${err.message}`));
        } else {
          console.log('LDAP bind successful');
          resolve();
        }
      });
    });

    // Step 2: Search for user
    const searchOptions = {
      filter: `(mail=${email})`,
      scope: 'sub',
      // Request ALL possible attributes
      attributes: [
        'cn', 'displayName', 'name', 'fullName', 'givenName', 'sn', 'firstName', 'lastName',
        'mail', 'email', 'emailAddress', 'employeeNumber', 'employeeId', 'empId',
        'ou', 'department', 'departmentNumber', 'dept', 'title', 'jobTitle', 'position',
        'manager', 'managedBy', 'supervisorName', 'uid', 'username', 'userId',
        'telephoneNumber', 'phone', 'mobile', 'description', 'notes', 'comment',
      ],
    };
    console.log('Step 2: LDAP search starting...');
    console.log('Filter:', searchOptions.filter);
    console.log('Base DN:', process.env.LDAP_BASE_DN);

    const results = await new Promise((resolve, reject) => {
      const entries = [];
      client.search(process.env.LDAP_BASE_DN, searchOptions, (err, search) => {
        if (err) {
          console.error('LDAP search initiation failed:', err.message);
          return reject(new Error(`LDAP search failed: ${err.message}`));
        }
        search.on('searchEntry', (entry) => {
          console.log('=== FOUND LDAP ENTRY ===');
          const obj = entry.object;
          console.log('Available attributes:', Object.keys(obj));
          console.log('Raw entry data:', JSON.stringify(obj, null, 2));
          entries.push(obj);
        });
        search.on('searchReference', (referral) => {
          console.log('LDAP referral:', referral.uris);
        });
        search.on('error', (error) => {
          console.error('LDAP search error:', error.message);
          reject(new Error(`LDAP search error: ${error.message}`));
        });
        search.on('end', (result) => {
          console.log('LDAP search completed');
          console.log('Search result status:', result.status);
          console.log('Total entries found:', entries.length);
          resolve(entries);
        });
      });
    });

    // Step 3: Clean up connection
    try {
      client.unbind();
      console.log('LDAP connection closed');
    } catch (e) {
      console.log('Unbind warning (ignored):', e.message);
    }

    // Step 4: Process results
    if (!results || results.length === 0) {
      console.log('No employee found with email:', email);
      return res.json({
        verified: false,
        error: 'Employee not found in company directory',
        searchDetails: {
          email: email,
          filter: searchOptions.filter,
          server: process.env.LDAP_SERVER,
          baseDN: process.env.LDAP_BASE_DN,
          timestamp: new Date().toISOString(),
        },
      });
    }

    // Step 5: Safe attribute extraction
    const employee = results[0];
    console.log('Processing employee attributes...');

    // Safe getter functions that handle undefined/null values
    const safeName = () => {
      const candidates = [
        employee.cn,
        employee.displayName,
        employee.name,
        employee.fullName,
        `${employee.givenName || employee.firstName || ''} ${employee.sn || employee.lastName || ''}`.trim(),
        name, // fallback to request parameter
        'Name not available',
      ];
      for (const candidate of candidates) {
        if (candidate && typeof candidate === 'string' && candidate.trim()) {
          return candidate.trim();
        }
      }
      return 'Name not available';
    };

    const safeEmail = () => {
      return employee.mail || employee.email || employee.emailAddress || email || 'Email not available';
    };

    const safeEmployeeId = () => {
      return employee.employeeNumber || employee.employeeId || employee.empId || employee.uid || 'Not provided';
    };

    const safeDepartment = () => {
      return employee.ou || employee.department || employee.departmentNumber || employee.dept || 'Not specified';
    };

    const safeTitle = () => {
      return employee.title || employee.jobTitle || employee.position || 'Not specified';
    };

    const safeManager = () => {
      return employee.manager || employee.managedBy || employee.supervisorName || 'Not specified';
    };

    const finalEmployeeData = {
      name: safeName(),
      email: safeEmail(),
      employeeId: safeEmployeeId(),
      department: safeDepartment(),
      title: safeTitle(),
      manager: safeManager(),
    };

    console.log('Final processed employee data:', finalEmployeeData);
    return res.json({
      verified: true,
      employee: finalEmployeeData,
      ldapQuery: {
        server: process.env.LDAP_SERVER,
        baseDN: process.env.LDAP_BASE_DN,
        filter: searchOptions.filter,
        timestamp: new Date().toISOString(),
        totalResults: results.length,
      },
      debug: {
        availableAttributes: Object.keys(employee),
        searchedEmail: email,
        success: true,
      },
    });
  } catch (error) {
    console.error('=== LDAP ERROR OCCURRED ===');
    console.error('Error type:', error.constructor.name);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);

    // Ensure client is cleaned up
    try {
      client.unbind();
    } catch (e) {
      /* ignore */
    }
    return res.status(500).json({
      verified: false,
      error: 'LDAP server connection failed',
      details: error.message,
      timestamp: new Date().toISOString(),
      troubleshooting: {
        step1: 'Check Vercel function logs for detailed error messages',
        step2: 'Verify LDAP credentials in JumpCloud console',
        step3: 'Confirm service account has "Enable as LDAP Bind DN" permission',
        step4: 'Test LDAP connection with external tools',
        step5: 'Check if email exists in JumpCloud user directory',
      },
    });
  }
}
