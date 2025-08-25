import ldap from "ldapjs";

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  const client = ldap.createClient({
    url: process.env.LDAP_URL,
    tlsOptions: {
      rejectUnauthorized: false, // allow self-signed certs
    },
  });

  const bindDN = process.env.LDAP_BIND_DN;
  const bindPassword = process.env.LDAP_BIND_PASSWORD;
  const searchBase = process.env.LDAP_SEARCH_BASE;

  client.bind(bindDN, bindPassword, (err) => {
    if (err) {
      return res.status(500).json({ error: "LDAP bind failed", details: err.message });
    }

    // ✅ NEW: Try multiple attributes to match the username/email
    const possibleAttrs = ["uid", "cn", "mail", "sAMAccountName"];
    const orFilters = possibleAttrs.map(attr => `(${attr}=${username})`).join("");

    const searchFilter = `(|${orFilters})`; 
    // This means: (uid=username OR cn=username OR mail=username OR sAMAccountName=username)

    const opts = {
      filter: searchFilter,
      scope: "sub",
      attributes: ["dn", "cn", "uid", "mail", "sAMAccountName"],
    };

    client.search(searchBase, opts, (err, searchRes) => {
      if (err) {
        return res.status(500).json({ error: "LDAP search failed", details: err.message });
      }

      let user = null;

      searchRes.on("searchEntry", (entry) => {
        user = entry.object;
      });

      searchRes.on("end", () => {
        if (!user) {
          return res.status(401).json({ error: "User not found" });
        }

        client.bind(user.dn, password, (err) => {
          if (err) {
            return res.status(401).json({ error: "Invalid credentials" });
          }

          res.status(200).json({ success: true, user });
        });
      });
    });
  });
}
