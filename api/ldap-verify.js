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

  const { email, name, uid } = req.body || {};
  
  if (!email) {
    return res.status(400).json({ error: 'Missing email in request body' });
  }

  console.log('=== REVAMPED LDAP SEARCH ===');
  console.log('Input parameters:');
  console.log('- Email:', email);
  console.log('- Name:', name);
  console.log('- UID:', uid);

  const client = ldap.createClient({
    url: process.env.LDAP_SERVER || 'ldaps://ldap.jumpcloud.com:636',
    timeout: 30000, // Increased timeout
    connectTimeout: 30000,
    reconnect: true
  });

  try {
    // Step 1: Bind with service account
    console.log('Step 1: Binding to LDAP server...');
    await new Promise((resolve, reject) => {
      client.bind(process.env.LDAP_BIND_DN, process.env.LDAP_PASSWORD, (err) => {
        if (err) {
          console.error('LDAP bind failed:', err.message);
          reject(new Error(`LDAP bind failed: ${err.message}`));
        } else {
          console.log('✓ LDAP bind successful');
          resolve();
        }
      });
    });

    // Step 2: REVAMPED SEARCH - Multiple targeted searches for better results
    const searchStrategies = [
      // Strategy 1: Email-based search (most reliable)
      {
        name: 'Email Search',
        filter: `(|(mail=${email})(userPrincipalName=${email})(emailAddress=${email})(email=${email}))`,
        description: 'Searching by email address variations'
      },
      
      // Strategy 2: UID-based search (if uid provided)
      ...(uid ? [{
        name: 'UID Search', 
        filter: `(|(uid=${uid})(sAMAccountName=${uid})(username=${uid})(userId=${uid})(cn=${uid}))`,
        description: 'Searching by user ID variations'
      }] : []),
      
      // Strategy 3: Name-based search (if name provided)
      ...(name ? [{
        name: 'Name Search',
        filter: `(|(cn=*${name}*)(displayName=*${name}*)(givenName=*${name.split(' ')[0]}*)(sn=*${name.split(' ').slice(-1)[0]}*))`,
        description: 'Searching by name variations'
      }] : []),
      
      // Strategy 4: Broad combined search
      {
        name: 'Combined Search',
        filter: `(&(objectClass=person)(|(mail=${email})(userPrincipalName=${email})${uid ? `(uid=${uid})(sAMAccountName=${uid})` : ''}${name ? `(cn=*${name}*)` : ''}))`,
        description: 'Combined search with person filter'
      }
    ];

    console.log(`Step 2: Executing ${searchStrategies.length} search strategies...`);

    let allResults = [];
    
    for (let i = 0; i < searchStrategies.length; i++) {
      const strategy = searchStrategies[i];
      console.log(`\n--- ${strategy.name} ---`);
      console.log('Description:', strategy.description);
      console.log('Filter:', strategy.filter);
      
      try {
        const searchOptions = {
          filter: strategy.filter,
          scope: 'sub',
          attributes: [
            // Core identity attributes
            'dn', 'cn', 'displayName', 'name', 'givenName', 'sn', 'initials',
            
            // Email attributes
            'mail', 'email', 'emailAddress', 'userPrincipalName', 'internetAddress',
            
            // User ID attributes  
            'uid', 'userId', 'username', 'sAMAccountName', 'userID', 'loginName',
            
            // Employee attributes
            'employeeNumber', 'employeeId', 'empId', 'employeeType', 'employeeStatus',
            
            // Organization attributes
            'ou', 'department', 'departmentNumber', 'dept', 'division', 'company',
            'title', 'jobTitle', 'position', 'role', 'description',
            
            // Management attributes
            'manager', 'managedBy', 'supervisorName', 'directReports',
            
            // Contact attributes
            'telephoneNumber', 'phone', 'mobile', 'homePhone', 'facsimileTelephoneNumber',
            'physicalDeliveryOfficeName', 'streetAddress', 'postalAddress',
            'postalCode', 'l', 'st', 'co', 'c',
            
            // System attributes
            'objectClass', 'memberOf', 'groups', 'whenCreated', 'whenChanged',
            'accountExpires', 'passwordLastSet', 'lastLogon', 'logonCount',
            
            // Custom attributes
            'extensionAttribute1', 'extensionAttribute2', 'extensionAttribute3',
            'info', 'notes', 'comment', 'personalTitle'
          ],
          paged: true,
          sizeLimit: 50,
          timeLimit: 25
        };

        const results = await new Promise((resolve, reject) => {
          const entries = [];
          
          client.search(process.env.LDAP_BASE_DN, searchOptions, (err, search) => {
            if (err) {
              console.error(`${strategy.name} failed:`, err.message);
              resolve([]); // Continue with empty results instead of failing
              return;
            }

            search.on('searchEntry', (entry) => {
              const obj = entry.object;
              console.log(`✓ Found entry: ${obj.cn || obj.displayName || obj.mail || 'Unknown'}`);
              entries.push(obj);
            });

            search.on('searchReference', (referral) => {
              console.log('LDAP referral:', referral.uris);
            });

            search.on('error', (error) => {
              console.error(`${strategy.name} error:`, error.message);
              resolve(entries); // Return what we have so far
            });

            search.on('end', (result) => {
              console.log(`${strategy.name} completed: ${entries.length} entries found`);
              resolve(entries);
            });
          });
        });

        // Add results to our collection (avoid duplicates by DN)
        results.forEach(result => {
          if (!allResults.find(existing => existing.dn === result.dn)) {
            allResults.push(result);
          }
        });

        // If we found results with this strategy, we can be more confident
        if (results.length > 0) {
          console.log(`✓ ${strategy.name} found ${results.length} results`);
        }

      } catch (strategyError) {
        console.error(`${strategy.name} strategy failed:`, strategyError.message);
        // Continue with next strategy
      }
    }

    // Step 3: Clean up connection
    try {
      client.unbind();
      console.log('✓ LDAP connection closed');
    } catch (e) {
      console.log('Unbind warning (ignored):', e.message);
    }

    console.log(`\n=== SEARCH SUMMARY ===`);
    console.log(`Total unique entries found: ${allResults.length}`);

    // Step 4: Process and rank results
    if (!allResults || allResults.length === 0) {
      console.log('❌ No employees found with any search strategy');
      
      return res.json({
        verified: false,
        error: 'Employee not found in company directory',
        searchDetails: {
          email: email,
          name: name,
          uid: uid,
          strategiesUsed: searchStrategies.length,
          server: process.env.LDAP_SERVER,
          baseDN: process.env.LDAP_BASE_DN,
          timestamp: new Date().toISOString(),
        },
        debugging: {
          suggestion1: "Check if the email exactly matches what's in JumpCloud",
          suggestion2: "Verify the user exists in the specified organization unit",
          suggestion3: "Ensure the service account has read permissions",
          suggestion4: "Try searching in JumpCloud admin console with the same email"
        }
      });
    }

    // Step 5: Rank results by relevance
    const rankedResults = allResults.map(employee => {
      let score = 0;
      const reasons = [];

      // Email match (highest priority)
      const emailFields = [employee.mail, employee.userPrincipalName, employee.emailAddress, employee.email];
      if (emailFields.some(field => field && field.toLowerCase() === email.toLowerCase())) {
        score += 100;
        reasons.push('exact email match');
      }

      // UID match (high priority)
      if (uid) {
        const uidFields = [employee.uid, employee.sAMAccountName, employee.username, employee.userId];
        if (uidFields.some(field => field && field.toLowerCase() === uid.toLowerCase())) {
          score += 50;
          reasons.push('exact UID match');
        }
      }

      // Name match (medium priority)
      if (name) {
        const nameFields = [employee.cn, employee.displayName, employee.name];
        if (nameFields.some(field => field && field.toLowerCase().includes(name.toLowerCase()))) {
          score += 25;
          reasons.push('name match');
        }
      }

      return { employee, score, reasons };
    }).sort((a, b) => b.score - a.score);

    const bestMatch = rankedResults[0];
    console.log(`✓ Best match found with score ${bestMatch.score}: ${bestMatch.reasons.join(', ')}`);
    
    // Log all available attributes for debugging
    console.log('\n=== EMPLOYEE ATTRIBUTES FOUND ===');
    console.log('Available attributes:', Object.keys(bestMatch.employee).sort());
    console.log('Employee data sample:', JSON.stringify(bestMatch.employee, null, 2));

    // Step 6: Build comprehensive employee response
    const employee = bestMatch.employee;

    const processedEmployee = {
      id: employee.employeeNumber || employee.employeeId || employee.empId || employee.uid || employee.sAMAccountName || 'N/A',
      name: employee.displayName || employee.cn || employee.name || `${employee.givenName || ''} ${employee.sn || ''}`.trim() || 'N/A',
      email: employee.mail || employee.userPrincipalName || employee.emailAddress || employee.email || email,
      department: employee.department || employee.ou || employee.departmentNumber || employee.dept || employee.division || 'N/A',
      title: employee.title || employee.jobTitle || employee.position || employee.role || 'N/A',
      manager: employee.manager || employee.managedBy || employee.supervisorName || 'N/A',
      phone: employee.telephoneNumber || employee.phone || employee.mobile || 'N/A',
      office: employee.physicalDeliveryOfficeName || employee.l || 'N/A',
      employeeType: employee.employeeType || 'N/A',
      lastLogon: employee.lastLogon || 'N/A'
    };

    console.log('✓ Processed employee data:', processedEmployee);

    return res.json({
      verified: true,
      employee: processedEmployee,
      ldapQuery: {
        server: process.env.LDAP_SERVER,
        baseDN: process.env.LDAP_BASE_DN,
        strategiesUsed: searchStrategies.length,
        bestMatchScore: bestMatch.score,
        bestMatchReasons: bestMatch.reasons,
        timestamp: new Date().toISOString(),
        totalResults: allResults.length,
      },
      debug: {
        availableAttributes: Object.keys(employee).sort(),
        searchedEmail: email,
        searchedName: name,
        searchedUid: uid,
        allResultsCount: allResults.length,
        success: true,
      },
    });

  } catch (error) {
    console.error('\n=== LDAP ERROR OCCURRED ===');
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
